import AppError from "../errors/AppError.js";
import { createToken, verifyToken } from "../utils/authToken.js";
import catchAsync from "../utils/catchAsync.js";
import { generateOTP } from "../utils/commonMethod.js";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { sendEmail } from "../utils/sendEmail.js";
import { User } from "../model/user.model.js";
import crypto from "node:crypto";
import { verifyGoogleIdToken } from "../utils/googleAuth.js";

const issueAuthTokens = (user) => {
  const jwtPayload = {
    _id: user._id,
    email: user.email,
    role: user.role,
  };
  const accessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    process.env.JWT_ACCESS_EXPIRES_IN
  );
  const refreshToken = createToken(
    jwtPayload,
    process.env.JWT_REFRESH_SECRET,
    process.env.JWT_REFRESH_EXPIRES_IN
  );

  user.refreshToken = refreshToken;
  return { accessToken, refreshToken };
};

const toAuthResponse = (user, accessToken, extra = {}) => {
  const userObj = user.toObject();
  delete userObj.googleId;
  userObj.accessToken = accessToken;
  return Object.assign(userObj, extra);
};

// Register (Admin only? but we can allow self-registration too)
export const register = catchAsync(async (req, res) => {
  const { name, email, password, confirmPassword, userId, location } = req.body;

  if (!email || !password) {
    throw new AppError(httpStatus.FORBIDDEN, "Please fill in all fields");
  }

  if (password !== confirmPassword) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Password and confirm password do not match"
    );
  }

  const checkUser = await User.findOne({ email });
  if (checkUser) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Email already exists, please try another email"
    );
  }

  const otp = generateOTP(4);

  const user = await User.create({
    userId,
    name,
    email,
    password,
    textPassword: password,
    verificationInfo: { token: otp, verified: false },
    location,
  });

  await sendEmail({
    email: user.email,
    subject: "Verify your email",
    message: `Your OTP for email verification is: ${otp}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to your email for verification",
    data: { _id: user._id, email: user.email },
  });
});

// Verify signup OTP - marks the account verified and issues tokens (like login)
export const verifySignupOtp = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email and OTP are required");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (user.verificationInfo.verified) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email is already verified");
  }

  if (!user.verificationInfo.token || user.verificationInfo.token !== otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }

  user.verificationInfo.verified = true;
  user.verificationInfo.token = "";

  const { accessToken } = issueAuthTokens(user);
  await user.save();

  const userObj = toAuthResponse(user, accessToken);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Email verified successfully",
    data: userObj,
  });
});

// Resend signup OTP
export const resendSignupOtp = catchAsync(async (req, res) => {
  const { email } = req.body;
  if (!email) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email is required");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (user.verificationInfo.verified) {
    throw new AppError(httpStatus.BAD_REQUEST, "Email is already verified");
  }

  const otp = generateOTP(4);
  user.verificationInfo.token = otp;
  await user.save();

  await sendEmail({
    email: user.email,
    subject: "Verify your email",
    message: `Your OTP for email verification is: ${otp}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP resent to your email",
    data: null,
  });
});

export const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError(httpStatus.BAD_REQUEST, "Please provide email and password");
  }

  const user = await User.findOne({ email }).select("+password");
  if (!user) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid credentials");
  }

  const isMatch = await User.isPasswordMatched(password, user.password);
  if (!isMatch) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid credentials");
  }

  if (!user.verificationInfo.verified) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Please verify your email before logging in"
    );
  }

  const { accessToken } = issueAuthTokens(user);
  await user.save();

  const userObj = toAuthResponse(user, accessToken);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Login successful",
    data: userObj,
  });
});

export const googleLogin = catchAsync(async (req, res) => {
  const { idToken } = req.body;
  if (!idToken || typeof idToken !== "string") {
    throw new AppError(httpStatus.BAD_REQUEST, "Google ID token is required");
  }

  let googleProfile;
  try {
    googleProfile = await verifyGoogleIdToken(idToken);
  } catch (_) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Google authentication could not be verified"
    );
  }

  const { googleId, email, name, picture } = googleProfile;
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let user = await User.findOne({ googleId }).select("+googleId");
  if (!user) {
    user = await User.findOne({
      email: { $regex: `^${escapedEmail}$`, $options: "i" },
    }).select("+googleId");
  }

  let isNewUser = false;
  if (user) {
    if (user.googleId && user.googleId !== googleId) {
      throw new AppError(
        httpStatus.CONFLICT,
        "This email is already linked to another Google account"
      );
    }

    user.googleId = googleId;
    user.verificationInfo.verified = true;
    user.verificationInfo.token = "";
    if (!user.avatar?.url && picture) {
      user.avatar = { public_id: "", url: picture };
    }
  } else {
    isNewUser = true;
    user = new User({
      name,
      email,
      googleId,
      password: crypto.randomBytes(32).toString("hex"),
      verificationInfo: { verified: true, token: "" },
      avatar: { public_id: "", url: picture },
    });
  }

  const { accessToken } = issueAuthTokens(user);
  await user.save();

  const userObj = toAuthResponse(user, accessToken, { isNewUser });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: isNewUser
      ? "Google account created successfully"
      : "Google login successful",
    data: userObj,
  });
});

export const logout = catchAsync(async (req, res) => {
  req.user.refreshToken = "";
  await req.user.save();
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Logged out successfully",
    data: null,
  });
});

export const refreshToken = catchAsync(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Refresh token required");
  }
  const decoded = verifyToken(refreshToken, process.env.JWT_REFRESH_SECRET);
  const user = await User.findById(decoded._id);
  if (!user || user.refreshToken !== refreshToken) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid refresh token");
  }
  const jwtPayload = {
    _id: user._id,
    email: user.email,
    role: user.role,
  };
  const newAccessToken = createToken(
    jwtPayload,
    process.env.JWT_ACCESS_SECRET,
    process.env.JWT_ACCESS_EXPIRES_IN
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Token refreshed",
    data: { accessToken: newAccessToken },
  });
});

// Forgot password - send OTP
export const forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }
  const otp = generateOTP();
  user.password_reset_token = otp;
  await user.save();

  await sendEmail({
    email: user.email,
    subject: "Password Reset OTP",
    message: `Your OTP for password reset is: ${otp}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to your email",
    data: null,
  });
});

// Verify OTP
export const verifyOTP = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  const user = await User.findOne({ email });
  if (!user || user.password_reset_token !== otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }
  // OTP matched, but we don't reset password yet; we can issue a temporary token
  // Instead, we'll just return success and let frontend proceed to reset password
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP verified",
    data: { verified: true },
  });
});

// Reset password
export const resetPassword = catchAsync(async (req, res) => {
  const { email, otp, newPassword, confirmPassword } = req.body;
  if (newPassword !== confirmPassword) {
    throw new AppError(httpStatus.BAD_REQUEST, "Passwords do not match");
  }
  const user = await User.findOne({ email }).select("+password");
  if (!user || user.password_reset_token !== otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid OTP");
  }
  user.password = newPassword;
  user.textPassword = newPassword;
  user.password_reset_token = "";
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password reset successfully",
    data: null,
  });
});

// Change password (while logged in)
export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.user._id).select("+password");
  const isMatch = await User.isPasswordMatched(currentPassword, user.password);
  if (!isMatch) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Current password is incorrect");
  }
  if (newPassword !== confirmPassword) {
    throw new AppError(httpStatus.BAD_REQUEST, "Passwords do not match");
  }
  user.password = newPassword;
  user.textPassword = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed successfully",
    data: null,
  });
});
