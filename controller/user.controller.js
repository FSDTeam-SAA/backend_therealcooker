import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { uploadOnCloudinary } from "../utils/commonMethod.js";
import AppError from "../errors/AppError.js";
import sendResponse from "../utils/sendResponse.js";
import catchAsync from "../utils/catchAsync.js";
import { Account } from "../model/account.model.js";
import { dateFilter, escapeRegex, pageOptions } from "../utils/reporting.js";

const parsePagination = (query) => {
  const page = Math.max(Number(query.page) || 1, 1);
  const limit = Math.max(Number(query.limit) || 8, 1);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

const parseCoordinate = (value, fieldName, min, max) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${fieldName} must be a valid number`,
    );
  }

  if (parsedValue < min || parsedValue > max) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${fieldName} must be between ${min} and ${max}`,
    );
  }

  return parsedValue;
};

const parseRadius = (value) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "defaultRadius must be a positive number",
    );
  }

  return parsedValue;
};

// Get user profile
export const getProfile = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token",
  );
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile fetched successfully",
    data: user,
  });
});

// Update profile
export const updateProfile = catchAsync(async (req, res) => {
  const { name, phone, bio, gender, dob, address, profession, country, city } = req.body;

  const userId = req.user._id;

  // Find user
  const user = await User.findById(userId).select(
    "-password -refreshToken -verificationInfo -password_reset_token",
  );
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  // Update only provided fields
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone;
  if (bio !== undefined) user.bio = bio;
  if (gender !== undefined) user.gender = gender;
  if (dob !== undefined) user.dob = dob;
  for (const [key, value] of Object.entries({ profession, country, city })) if (value !== undefined) user[key] = value;
  if (address !== undefined) user.address = address;

  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    if (!user.avatar) {
      user.avatar = { public_id: "", url: "" };
    }
    user.avatar.public_id = result.public_id;
    user.avatar.url = result.secure_url;
  }

  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Profile updated successfully",
    data: user,
  });
});

// Change user password
export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = await User.findById(req.user._id).select("+password");
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (newPassword !== confirmPassword) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "New password and confirm password do not match",
    );
  }

  if (!(await User.isPasswordMatched(currentPassword, user.password))) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Current password is incorrect",
    );
  }

  user.password = newPassword;
  await user.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password changed successfully",
    data: user,
  });
});

export const deleteOwnAccount = catchAsync(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findByIdAndDelete(userId);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account and all associated data deleted successfully",
    data: null,
  });
});

export const createUserByAdmin = catchAsync(async (req, res) => {
  const { name, userId, password, latitude, longitude, defaultRadius } =
    req.body;

  if (
    !name ||
    !userId ||
    !password ||
    latitude === undefined ||
    latitude === null ||
    latitude === "" ||
    longitude === undefined ||
    longitude === null ||
    longitude === ""
  ) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "name, userId, password, latitude and longitude are required",
    );
  }

  const existingUser = await User.findOne({ userId });
  if (existingUser) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId already exists");
  }

  const parsedLatitude = parseCoordinate(latitude, "latitude", -90, 90);
  const parsedLongitude = parseCoordinate(longitude, "longitude", -180, 180);

  const userData = {
    name,
    userId,
    password,
    location: {
      latitude: parsedLatitude,
      longitude: parsedLongitude,
    },
    defaultRadius:
      defaultRadius !== undefined ? parseRadius(defaultRadius) : 100,
    verificationInfo: { token: "", verified: true },
  };

  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    userData.avatar = {
      public_id: result.public_id,
      url: result.secure_url,
    };
  }

  const createdUser = await User.create(userData);
  const responseUser = await User.findById(createdUser._id).select(
    "-password -refreshToken -verificationInfo -password_reset_token",
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "User created by admin successfully",
    data: responseUser,
  });
});

export const getUsersForAdmin = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageOptions(req.query);
  const searchTerm = req.query.search?.trim();

  const filter = { role: "user", ...dateFilter(req.query) };
  if (req.query.user) filter._id = req.query.user;
  if (req.query.verified === "true") filter["verificationInfo.verified"] = true;
  if (req.query.kyc === "completed") filter["kyc.status"] = "completed";
  if (req.query.bank || req.query.linked === "true") {
    filter._id = { $in: await Account.distinct("user", { isActive: true, ...(req.query.bank ? { bankName: req.query.bank } : { accountType: "bank" }) }) };
  }

  if (searchTerm) {
    filter.$or = [
      { name: { $regex: escapeRegex(searchTerm), $options: "i" } },
      { userId: { $regex: escapeRegex(searchTerm), $options: "i" } },
      { email: { $regex: escapeRegex(searchTerm), $options: "i" } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(
        "name email phone userId dob profession country city isBlocked verificationInfo.verified kyc.status createdAt",
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Users fetched successfully",
    data: {
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    },
  });
});

export const getUserDetailsForAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;

  const user = await User.findOne({ _id: id, role: "user" }).select(
    "name email phone userId dob profession country city isBlocked verificationInfo.verified kyc.status createdAt",
  );

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User details fetched successfully",
    data: {
      user,
    },
  });
});

export const updateUserByAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { name, userId, password, latitude, longitude, defaultRadius } =
    req.body;

  const user = await User.findOne({ _id: id, role: "user" });

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  if (userId && userId !== user.userId) {
    const existingUser = await User.findOne({ userId });
    if (existingUser) {
      throw new AppError(httpStatus.BAD_REQUEST, "userId already exists");
    }
    user.userId = userId;
  }

  if (name) user.name = name;
  if (password) {
    user.password = password;
  }
  if (defaultRadius !== undefined) {
    user.defaultRadius = parseRadius(defaultRadius);
  }

  const hasLatitude =
    latitude !== undefined && latitude !== null && latitude !== "";
  const hasLongitude =
    longitude !== undefined && longitude !== null && longitude !== "";

  if (hasLatitude !== hasLongitude) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "latitude and longitude must be provided together",
    );
  }

  if (hasLatitude && hasLongitude) {
    const parsedLatitude = parseCoordinate(latitude, "latitude", -90, 90);
    const parsedLongitude = parseCoordinate(longitude, "longitude", -180, 180);
    user.location = {
      latitude: parsedLatitude,
      longitude: parsedLongitude,
    };
  }

  if (req.file) {
    const result = await uploadOnCloudinary(req.file.buffer);
    if (!user.avatar) {
      user.avatar = { public_id: "", url: "" };
    }
    user.avatar.public_id = result.public_id;
    user.avatar.url = result.secure_url;
  }

  await user.save();

  const responseUser = await User.findById(id).select(
    "-password -refreshToken -verificationInfo -password_reset_token -__v",
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User updated successfully",
    data: responseUser,
  });
});

export const deleteUserByAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;

  const user = await User.findOne({ _id: id, role: "user" });

  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  await User.findOneAndDelete({ _id: id, role: "user" });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User deleted successfully",
    data: null,
  });
});
