import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import crypto from "crypto";
import httpStatus from "http-status";
import sendResponse from "../utils/sendResponse.js";
import { Account } from "../model/account.model.js";
import { AccountDeletionRequest } from "../model/accountDeletionRequest.model.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { Notification } from "../model/notification.model.js";
import { User } from "../model/user.model.js";
import { generateOTP, uploadOnCloudinary } from "../utils/commonMethod.js";
import { createAndEmitNotification } from "../utils/notification.js";
import { sendEmail } from "../utils/sendEmail.js";
import { emitToUser } from "../utils/socket.js";

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");
const OTP_WINDOW_MS = 90 * 1000;

const uploadedFileUrl = async (req) => {
  if (!req.file) return "";
  const result = await uploadOnCloudinary(req.file.buffer);
  return result.secure_url;
};

const parseLimit = (value, fieldName) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `${fieldName} must be a non-negative number`
    );
  }
  return parsed;
};

const getAcceptedGuardianForAccount = async (accountId) => {
  const guardianAccounts = await GuardianAccount.find({ account: accountId })
    .populate("guardian");
  const guardianAccount = guardianAccounts.find(
    (link) => link.guardian?.isPrimary
  );

  if (!guardianAccount?.guardian) return null;

  const guardian = guardianAccount.guardian;
  if (guardian.status && guardian.status !== "accepted") return null;

  let protectorUser = null;
  if (guardian.protectorUser) {
    protectorUser = await User.findById(guardian.protectorUser);
  }
  if (!protectorUser && guardian.email) {
    protectorUser = await User.findOne({ email: guardian.email });
  }

  if (!protectorUser) return null;

  return { guardian, protectorUser };
};

const limitRequestActions = (accountId, requestId) => ({
  sendOtp: `/api/v1/accounts/${accountId}/test/limit-increase-requests/${requestId}/send-otp`,
});

const accountSummary = (account) => ({
  id: account._id,
  accountType: account.accountType,
  bankName: account.bankName,
  nickname: account.nickname,
  imageUrl: account.imageUrl,
});

const parseEmergencyLocation = (value) => {
  if (!value || typeof value !== "object") return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
};

const emergencySessionPayload = (session) => ({
  id: session?._id,
  active: session?.status === "active",
  eventLocation: session?.eventLocation || null,
  lastKnownLocation: session?.lastKnownLocation || null,
  lockedAccountIds: (session?.lockedAccounts || []).map((id) => id.toString()),
  activatedAt: session?.activatedAt || null,
  resolvedAt: session?.resolvedAt || null,
  clearedByRole: session?.clearedByRole || "",
});

const findActiveEmergencySession = (userId) =>
  EmergencySession.findOne({ user: userId, status: "active" }).sort({
    createdAt: -1,
  });

const resolveProtectorUser = async (guardian) => {
  let protectorUser = null;
  if (guardian.protectorUser) {
    protectorUser = await User.findById(guardian.protectorUser);
  }
  if (!protectorUser && guardian.email) {
    protectorUser = await User.findOne({ email: guardian.email });
  }
  return protectorUser;
};

const findAcceptedGuardianUsers = async (
  userId,
  { primaryOnly = true } = {}
) => {
  const guardianQuery = {
    user: userId,
    status: "accepted",
  };
  if (primaryOnly) guardianQuery.isPrimary = true;

  const acceptedGuardians = await Guardian.find(guardianQuery);
  const guardianUsers = [];
  for (const guardian of acceptedGuardians) {
    const protectorUser = await resolveProtectorUser(guardian);
    if (protectorUser) {
      guardianUsers.push({ guardian, protectorUser });
    }
  }
  return guardianUsers;
};

const findPrimaryGuardianOverride = async (ownerId, guardianUser) => {
  return Guardian.findOne({
    user: ownerId,
    isPrimary: true,
    status: "accepted",
    $or: [
      { protectorUser: guardianUser._id },
      ...(guardianUser.email ? [{ email: guardianUser.email }] : []),
    ],
  });
};

const findPrimaryGuardianForUser = async (userId) => {
  const guardian = await Guardian.findOne({
    user: userId,
    isPrimary: true,
    status: "accepted",
  });
  if (!guardian) return null;

  let protectorUser = null;
  if (guardian.protectorUser) {
    protectorUser = await User.findById(guardian.protectorUser);
  }
  if (!protectorUser && guardian.email) {
    protectorUser = await User.findOne({ email: guardian.email });
  }

  if (!protectorUser) return null;
  return { guardian, protectorUser };
};

const deleteAccountWithLinks = async (account) => {
  await GuardianAccount.deleteMany({ account: account._id });
  await account.deleteOne();
};

const sendEmergencyResolvedNotifications = async ({
  session,
  clearedByUser,
  clearedByRole,
  guardianUsers = null,
}) => {
  const owner = await User.findById(session.user);
  const resolvedPayload = {
    ...emergencySessionPayload(session),
    clearedBy: {
      role: clearedByRole,
      id: clearedByUser._id,
      name: clearedByUser.name,
      email: clearedByUser.email,
    },
    user: owner
      ? {
          id: owner._id,
          name: owner.name,
          email: owner.email,
        }
      : null,
  };
  const protectors = guardianUsers || (await findAcceptedGuardianUsers(session.user));

  await Promise.all([
    createAndEmitNotification({
      recipient: session.user,
      sender: clearedByUser._id,
      type: "sos_emergency_resolved",
      title: "Emergency mode ended",
      body:
        clearedByRole === "primary_guardian"
          ? "Your primary guardian marked you safe."
          : "You marked yourself safe.",
      data: resolvedPayload,
    }),
    ...protectors.map(({ guardian, protectorUser }) =>
      createAndEmitNotification({
        recipient: protectorUser._id,
        sender: clearedByUser._id,
        type: "sos_emergency_resolved",
        title: "Emergency mode ended",
        body: `${userLabel(owner)}'s emergency mode was ended.`,
        data: {
          ...resolvedPayload,
          guardianRole: guardian.isPrimary ? "primary" : "secondary",
        },
      })
    ),
  ]);

  emitToUser(session.user, "emergency:resolved", resolvedPayload);
  protectors.forEach(({ protectorUser }) =>
    emitToUser(protectorUser._id, "emergency:resolved", resolvedPayload)
  );

  return resolvedPayload;
};

const resolveEmergencySession = async ({
  session,
  clearedByUser,
  clearedByRole,
  clearedByGuardian = null,
}) => {
  const clearedAt = new Date();
  session.status = "resolved";
  session.resolvedAt = clearedAt;
  session.clearedByRole = clearedByRole;
  session.clearedByUser = clearedByUser._id;
  if (clearedByGuardian) {
    session.clearedByGuardian = clearedByGuardian._id;
  }
  session.clearanceHistory.push({
    role: clearedByRole,
    clearedByUser: clearedByUser._id,
    ...(clearedByGuardian ? { clearedByGuardian: clearedByGuardian._id } : {}),
    clearedAt,
  });
  session.userClearOtpHash = "";
  session.userClearOtpExpiresAt = undefined;
  await session.save();

  // The original "sos_emergency_active" notifications/activities still carry
  // active: true from when they were sent. Patch them so tapping an old
  // alert later (from Notifications or Recent Activities) shows it's already
  // resolved instead of re-opening the live emergency screen.
  await Notification.updateMany(
    { type: "sos_emergency_active", "data.id": session._id },
    { $set: { "data.active": false } }
  );

  return session;
};

const sendEmergencyClearOtp = async ({ session, user }) => {
  const otp = generateOTP(6);
  session.userClearOtpHash = hashOtp(otp);
  session.userClearOtpExpiresAt = new Date(Date.now() + OTP_WINDOW_MS);
  session.userClearOtpSentAt = new Date();
  await session.save();

  await Promise.all([
    createAndEmitNotification({
      recipient: user._id,
      sender: user._id,
      type: "sos_emergency_clear_otp",
      title: "Emergency clear OTP",
      body: `Your emergency clear OTP is: ${otp}`,
      data: {
        emergencySessionId: session._id,
        expiresAt: session.userClearOtpExpiresAt,
        ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
      },
    }),
    sendEmail({
      email: user.email,
      subject: "Emergency clear OTP",
      message: `Your emergency clear OTP is: ${otp}`,
    }).catch(() => null),
  ]);

  return {
    expiresAt: session.userClearOtpExpiresAt,
    ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
  };
};

const trySendPushNotification = async (userIds, title, body) => {
  try {
    const { sendPushNotification } = await import("../utils/sendPushNotification.js");
    await sendPushNotification(userIds, title, body);
  } catch (error) {
    console.error("Push notification skipped:", error);
  }
};

const userLabel = (user) => user?.name || user?.email || "User";

const lockLimitRequest = async (limitRequest, reason) => {
  const account = limitRequest.account;
  const owner = limitRequest.user;
  const guardianUser = limitRequest.guardianUser;

  // Failing to verify a suspicious limit increase in time is treated the
  // same as an SOS lockdown: every one of the user's active accounts gets
  // locked, not just the one whose limit was being changed (see
  // activateEmergencyMode, which locks the same way).
  const lockedAt = new Date();
  const activeAccounts = await Account.find({
    user: owner._id,
    isActive: true,
  });
  await Account.updateMany(
    { _id: { $in: activeAccounts.map((acc) => acc._id) } },
    { $set: { isLocked: true, lockedReason: reason, lockedAt } }
  );

  limitRequest.status = "locked";
  limitRequest.lockedAt = lockedAt;
  await limitRequest.save();

  const lockPayload = {
    requestId: limitRequest._id,
    account: accountSummary(account),
    lockedAccounts: activeAccounts.map((acc) => acc._id),
    reason,
    lastKnownLocation: owner.location || null,
    user: {
      id: owner._id,
      name: owner.name,
      email: owner.email,
    },
  };

  // Only the primary guardian receives emergency alerts alongside the user;
  // secondary guardians are intentionally excluded.
  const acceptedGuardians = await Guardian.find({
    user: owner._id,
    status: "accepted",
    isPrimary: true,
  });
  const guardianUsers = [];
  for (const guardian of acceptedGuardians) {
    let protectorUser = null;
    if (guardian.protectorUser) {
      protectorUser = await User.findById(guardian.protectorUser);
    }
    if (!protectorUser && guardian.email) {
      protectorUser = await User.findOne({ email: guardian.email });
    }
    if (protectorUser) {
      guardianUsers.push({ guardian, protectorUser });
    }
  }

  await Promise.all([
    createAndEmitNotification({
      recipient: owner._id,
      sender: guardianUser._id,
      type: "account_locked",
      title: "Accounts locked",
      body: "All of your linked accounts were locked after transfer limit verification failed.",
      data: lockPayload,
    }),
    ...guardianUsers.map(({ guardian, protectorUser }) =>
      createAndEmitNotification({
        recipient: protectorUser._id,
        sender: owner._id,
        type: "account_locked",
        title: "Emergency alert",
        body: `All of ${userLabel(owner)}'s linked accounts are locked.`,
        data: {
          ...lockPayload,
          guardianRole: guardian.isPrimary ? "primary" : "secondary",
        },
      })
    ),
  ]);

  emitToUser(owner._id, "account:locked", lockPayload);
  guardianUsers.forEach(({ protectorUser }) =>
    emitToUser(protectorUser._id, "account:locked", lockPayload)
  );

  return lockPayload;
};

// Create an account (no guardian relation yet)
export const createAccount = catchAsync(async (req, res) => {
  const { accountType, bankName, nickname, accountNumberEncrypted } = req.body;

  if (!accountType || !accountNumberEncrypted) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required fields");
  }
  if (accountType === "bank" && !bankName) {
    throw new AppError(httpStatus.BAD_REQUEST, "Bank name is required for bank accounts");
  }

  const account = await Account.create({
    user: req.user._id,
    accountType,
    bankName,
    nickname: nickname?.trim() || "",
    accountNumberEncrypted,
    imageUrl: await uploadedFileUrl(req),
  });

  const guardians = await Guardian.find({
    user: req.user._id,
    status: { $in: ["pending", "accepted"] },
  });
  const acceptedGuardians = guardians.filter(
    (guardian) => guardian.status === "accepted"
  );
  if (acceptedGuardians.length > 0) {
    await GuardianAccount.insertMany(
      acceptedGuardians.map((guardian) => ({
        guardian: guardian._id,
        account: account._id,
      })),
      { ordered: false }
    ).catch(() => {});
  }

  const pendingGuardians = guardians.filter(
    (guardian) => guardian.status === "pending"
  );
  await Promise.all(
    pendingGuardians.map(async (guardian) => {
      const requestedIds = new Set(
        (guardian.requestedAccounts || []).map((id) => String(id))
      );
      if (!requestedIds.has(String(account._id))) {
        guardian.requestedAccounts = [
          ...(guardian.requestedAccounts || []),
          account._id,
        ];
        await guardian.save();
      }
    })
  );

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Account created successfully",
    data: account,
  });
});

// Get all accounts of logged-in user (with optional guardian info)
export const getAccounts = catchAsync(async (req, res) => {
  const accounts = await Account.find({ user: req.user._id, isActive: true });

  // For each account, check if it's linked to any guardian
  const accountsWithGuardian = await Promise.all(
    accounts.map(async (acc) => {
      const guardianAccount = await GuardianAccount.findOne({ account: acc._id })
        .populate("guardian", "name email phone relationship");
      return {
        ...acc.toObject(),
        guardian: guardianAccount ? guardianAccount.guardian : null,
      };
    })
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Accounts fetched successfully",
    data: accountsWithGuardian,
  });
});

export const getEmergencyStatus = catchAsync(async (req, res) => {
  const session = await findActiveEmergencySession(req.user._id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emergency status fetched successfully",
    data: session
      ? emergencySessionPayload(session)
      : {
          active: false,
          eventLocation: null,
          lastKnownLocation: null,
          lockedAccountIds: [],
          activatedAt: null,
        },
  });
});

export const activateEmergencyMode = catchAsync(async (req, res) => {
  const existingSession = await findActiveEmergencySession(req.user._id);
  if (existingSession) {
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Emergency mode is already active",
      data: emergencySessionPayload(existingSession),
    });
    return;
  }

  const eventLocation = parseEmergencyLocation(req.body?.eventLocation);
  const lastKnownLocation = parseEmergencyLocation(req.body?.lastKnownLocation);
  const activeAccounts = await Account.find({
    user: req.user._id,
    isActive: true,
  });

  const lockedAt = new Date();
  await Account.updateMany(
    { _id: { $in: activeAccounts.map((account) => account._id) } },
    {
      $set: {
        isLocked: true,
        lockedReason: "SOS emergency mode activated",
        lockedAt,
      },
    }
  );

  const session = await EmergencySession.create({
    user: req.user._id,
    status: "active",
    eventLocation,
    lastKnownLocation: lastKnownLocation || eventLocation,
    lockedAccounts: activeAccounts.map((account) => account._id),
    activatedAt: lockedAt,
  });

  const payload = {
    ...emergencySessionPayload(session),
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
    },
    accounts: activeAccounts.map(accountSummary),
  };

  // Only the primary guardian receives emergency alerts alongside the user;
  // secondary guardians are intentionally excluded.
  const acceptedGuardians = await Guardian.find({
    user: req.user._id,
    status: "accepted",
    isPrimary: true,
  });
  const guardianUsers = [];
  for (const guardian of acceptedGuardians) {
    const protectorUser = await resolveProtectorUser(guardian);
    if (protectorUser) {
      guardianUsers.push({ guardian, protectorUser });
    }
  }

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: req.user._id,
      type: "sos_emergency_active",
      title: "Emergency mode active",
      body: "Emergency instructions were sent to your guardians and banks.",
      data: payload,
    }),
    ...guardianUsers.map(({ guardian, protectorUser }) =>
      createAndEmitNotification({
        recipient: protectorUser._id,
        sender: req.user._id,
        type: "sos_emergency_active",
        title: "Emergency alert",
        body: `${userLabel(req.user)} activated SOS emergency mode.`,
        data: {
          ...payload,
          guardianRole: guardian.isPrimary ? "primary" : "secondary",
        },
      })
    ),
  ]);

  emitToUser(req.user._id, "emergency:activated", payload);
  guardianUsers.forEach(({ protectorUser }) =>
    emitToUser(protectorUser._id, "emergency:activated", payload)
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emergency mode activated",
    data: payload,
  });
});

// Lighter-weight than activateEmergencyMode: notifies every accepted guardian
// the same way (same notification/socket mechanism, same alert screen on
// their end), but doesn't lock any accounts or create an EmergencySession.
// The alert screen's "End Emergency" action stays hidden for this because
// there's no session id in the payload for it to act on.
export const alertGuardian = catchAsync(async (req, res) => {
  const eventLocation = parseEmergencyLocation(req.body?.eventLocation);
  const guardianUsers = await findAcceptedGuardianUsers(req.user._id, {
    primaryOnly: false,
  });

  if (guardianUsers.length === 0) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "No accepted guardians are linked to alert"
    );
  }

  const payload = {
    eventLocation,
    lastKnownLocation: eventLocation,
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
    },
  };

  await Promise.all(
    guardianUsers.map(({ guardian, protectorUser }) =>
      createAndEmitNotification({
        recipient: protectorUser._id,
        sender: req.user._id,
        type: "guardian_alert",
        title: "Guardian alert",
        body: `${userLabel(req.user)} needs your attention.`,
        data: {
          ...payload,
          guardianRole: guardian.isPrimary ? "primary" : "secondary",
        },
      })
    )
  );

  guardianUsers.forEach(({ protectorUser }) =>
    emitToUser(protectorUser._id, "guardian:alert", payload)
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "All guardians have been alerted",
    data: payload,
  });
});

export const sendEmergencyClearUserOtp = catchAsync(async (req, res) => {
  const session = await findActiveEmergencySession(req.user._id);
  if (!session) {
    throw new AppError(httpStatus.NOT_FOUND, "No active emergency mode found");
  }

  const otpPayload = await sendEmergencyClearOtp({
    session,
    user: req.user,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emergency clear OTP sent successfully",
    data: otpPayload,
  });
});

export const verifyEmergencyClearUserOtp = catchAsync(async (req, res) => {
  const { otp } = req.body;
  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const session = await findActiveEmergencySession(req.user._id);
  if (!session) {
    throw new AppError(httpStatus.NOT_FOUND, "No active emergency mode found");
  }

  if (
    !session.userClearOtpHash ||
    session.userClearOtpHash !== hashOtp(otp) ||
    session.userClearOtpExpiresAt?.getTime() < Date.now()
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid or expired OTP");
  }

  await resolveEmergencySession({
    session,
    clearedByUser: req.user,
    clearedByRole: "user",
  });
  const data = await sendEmergencyResolvedNotifications({
    session,
    clearedByUser: req.user,
    clearedByRole: "user",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emergency mode ended successfully",
    data,
  });
});

export const clearEmergencyByPrimaryGuardian = catchAsync(async (req, res) => {
  const { sessionId } = req.params;
  const session = await EmergencySession.findOne({
    _id: sessionId,
    status: "active",
  });
  if (!session) {
    throw new AppError(httpStatus.NOT_FOUND, "Active emergency mode not found");
  }

  const primaryGuardian = await findPrimaryGuardianOverride(
    session.user,
    req.user
  );
  if (!primaryGuardian) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Only the primary guardian can end this emergency"
    );
  }

  const guardianUsers = await findAcceptedGuardianUsers(session.user);
  await resolveEmergencySession({
    session,
    clearedByUser: req.user,
    clearedByRole: "primary_guardian",
    clearedByGuardian: primaryGuardian,
  });
  const data = await sendEmergencyResolvedNotifications({
    session,
    clearedByUser: req.user,
    clearedByRole: "primary_guardian",
    guardianUsers,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Emergency mode ended by primary guardian",
    data,
  });
});

// Get single account
export const getAccount = catchAsync(async (req, res) => {
  const { id } = req.params;
  const account = await Account.findOne({ _id: id, user: req.user._id });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }
  // Check guardian association
  const guardianAccount = await GuardianAccount.findOne({ account: account._id })
    .populate("guardian", "name email phone relationship");
  const result = {
    ...account.toObject(),
    guardian: guardianAccount ? guardianAccount.guardian : null,
  };
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account fetched successfully",
    data: result,
  });
});

// Update account (only certain fields)
export const updateAccount = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { accountType, bankName, nickname, accountNumberEncrypted, isActive } =
    req.body;

  const account = await Account.findOne({ _id: id, user: req.user._id });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }

  if (accountType) account.accountType = accountType;
  if (bankName) account.bankName = bankName;
  if (nickname !== undefined) account.nickname = nickname?.trim() || "";
  if (accountNumberEncrypted) account.accountNumberEncrypted = accountNumberEncrypted;
  if (isActive !== undefined) account.isActive = isActive;

  await account.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account updated successfully",
    data: account,
  });
});

// Delete account (soft delete? we set isActive false or remove)
export const deleteAccount = catchAsync(async (req, res) => {
  throw new AppError(
    httpStatus.BAD_REQUEST,
    "Use the two-factor account removal flow"
  );
});

// Account deletion now runs guardian-first: the owner just notifies their
// primary guardian, the guardian approves in-app (pushing the OTP to the
// owner in real time over the socket + email/push), and the owner enters
// that OTP to finish. There is no more "owner verifies their own OTP" step.
const DELETION_OTP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

const deletionRequestActions = (accountId, requestId) => ({
  sendOtp: `/api/v1/accounts/${accountId}/delete/${requestId}/send-otp`,
});

export const requestAccountDeletion = catchAsync(async (req, res) => {
  const { id } = req.params;
  const account = await Account.findOne({
    _id: id,
    user: req.user._id,
    isActive: true,
  });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }

  const primaryGuardian = await findPrimaryGuardianForUser(req.user._id);
  if (!primaryGuardian) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A primary guardian is required to remove an account"
    );
  }

  const deletionRequest = await AccountDeletionRequest.findOneAndUpdate(
    {
      account: account._id,
      user: req.user._id,
      status: { $in: ["notified", "otp_sent"] },
    },
    {
      $set: {
        account: account._id,
        user: req.user._id,
        primaryGuardian: primaryGuardian.guardian._id,
        primaryGuardianUser: primaryGuardian.protectorUser._id,
        otpHash: "",
        status: "notified",
      },
      $unset: { otpExpiresAt: "", otpSentAt: "", verifiedAt: "" },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const requesterName = userLabel(req.user);

  await createAndEmitNotification({
    recipient: primaryGuardian.protectorUser._id,
    sender: req.user._id,
    type: "account_deletion_requested",
    title: "Account removal approval needed",
    body: `${requesterName} wants to remove a linked account and needs your approval.`,
    data: {
      requestId: deletionRequest._id,
      account: accountSummary(account),
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      actions: deletionRequestActions(account._id, deletionRequest._id),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Your primary guardian was notified to approve this removal",
    data: { requestId: deletionRequest._id },
  });
});

export const sendAccountDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  // Guardian-invoked. Accept both "notified" (first send) and "otp_sent"
  // (guardian re-sending) so the button keeps working on repeat taps.
  const deletionRequest = await AccountDeletionRequest.findOne({
    _id: requestId,
    account: id,
    primaryGuardianUser: req.user._id,
    status: { $in: ["notified", "otp_sent"] },
  }).populate("account user");

  if (!deletionRequest?.account) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "No active removal request to approve for this account"
    );
  }

  const otp = generateOTP(6);
  deletionRequest.otpHash = hashOtp(otp);
  deletionRequest.otpExpiresAt = new Date(Date.now() + DELETION_OTP_WINDOW_MS);
  deletionRequest.otpSentAt = new Date();
  deletionRequest.status = "otp_sent";
  await deletionRequest.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: deletionRequest.user.email,
      subject: "Account Removal OTP",
      message: `Your guardian approved removing ${deletionRequest.account.bankName || deletionRequest.account.accountType}. Your OTP is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Account deletion OTP email failed:", error);
  }

  await trySendPushNotification(
    [deletionRequest.user._id],
    "Account removal OTP",
    `Your account removal OTP is ${otp}`
  );

  await createAndEmitNotification({
    recipient: deletionRequest.user._id,
    sender: req.user._id,
    type: "account_deletion_otp_required",
    title: "Account removal OTP sent",
    body: `${userLabel(req.user)} approved your account removal. Your OTP is ${otp}.`,
    data: {
      requestId: deletionRequest._id,
      account: accountSummary(deletionRequest.account),
      guardian: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      otp,
      expiresAt: deletionRequest.otpExpiresAt,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to the account owner",
    data: {
      requestId: deletionRequest._id,
      expiresAt: deletionRequest.otpExpiresAt,
      emailSent,
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
    },
  });
});

export const verifyAccountDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const deletionRequest = await AccountDeletionRequest.findOne({
    _id: requestId,
    account: id,
    user: req.user._id,
    status: "otp_sent",
  }).populate("account primaryGuardianUser");

  if (!deletionRequest?.account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account removal request not found");
  }

  if (
    !deletionRequest.otpHash ||
    deletionRequest.otpHash !== hashOtp(otp) ||
    deletionRequest.otpExpiresAt?.getTime() < Date.now()
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid or expired OTP");
  }

  deletionRequest.verifiedAt = new Date();
  deletionRequest.status = "deleted";
  await deletionRequest.save();

  await deleteAccountWithLinks(deletionRequest.account);

  const confirmationPayload = {
    requestId: deletionRequest._id,
    account: accountSummary(deletionRequest.account),
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: deletionRequest.primaryGuardianUser._id,
      type: "account_deletion_completed",
      title: "Account removed",
      body: `${deletionRequest.account.bankName || deletionRequest.account.accountType} was removed from your linked accounts.`,
      data: confirmationPayload,
    }),
    createAndEmitNotification({
      recipient: deletionRequest.primaryGuardianUser._id,
      sender: req.user._id,
      type: "account_deletion_completed",
      title: "Account removed",
      body: `${userLabel(req.user)}'s account was removed after your approval.`,
      data: confirmationPayload,
    }),
  ]);

  emitToUser(req.user._id, "account-deletion:completed", confirmationPayload);
  emitToUser(
    deletionRequest.primaryGuardianUser._id,
    "account-deletion:completed",
    confirmationPayload
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account removed successfully",
    data: null,
  });
});

// Temporary simulation route. Replace this trigger with the banking API webhook later.
export const simulateLimitIncrease = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { requestedLimit, currentLimit } = req.body;

  const account = await Account.findOne({
    _id: id,
    user: req.user._id,
    isActive: true,
  });
  if (!account) {
    throw new AppError(httpStatus.NOT_FOUND, "Account not found");
  }
  if (account.isLocked) {
    throw new AppError(httpStatus.FORBIDDEN, "Account is locked");
  }

  const nextLimit = parseLimit(requestedLimit, "requestedLimit");
  const previousLimit =
    currentLimit !== undefined
      ? parseLimit(currentLimit, "currentLimit")
      : account.simulatedTransferLimit || 0;

  if (nextLimit <= previousLimit) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "requestedLimit must be greater than the current limit"
    );
  }

  const guardianLink = await getAcceptedGuardianForAccount(account._id);
  if (!guardianLink) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "No accepted guardian is linked to this account"
    );
  }

  const previousAttempts = await LimitIncreaseRequest.countDocuments({
    account: account._id,
  });
  const attemptNumber = previousAttempts + 1;

  // Suspicious only if this user made ANY limit-increase attempt within the
  // last 24 hours — across every one of their accounts, not just this one.
  // A change on bank X followed by a change on bank Y is exactly the
  // pattern this is meant to catch, so the lookup is scoped to the user,
  // not the account. A lifetime "2nd attempt ever" counter isn't what
  // matters here either — once 24 hours pass with no activity anywhere,
  // the next increase is treated as a fresh first-time increase again,
  // and it re-starts the 24-hour watch.
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentAttempt = await LimitIncreaseRequest.findOne({
    user: req.user._id,
    createdAt: { $gte: twentyFourHoursAgo },
  }).sort({ createdAt: -1 });
  const isSuspicious = Boolean(recentAttempt);

  const limitRequest = await LimitIncreaseRequest.create({
    account: account._id,
    user: req.user._id,
    guardian: guardianLink.guardian._id,
    guardianUser: guardianLink.protectorUser._id,
    previousLimit,
    requestedLimit: nextLimit,
    attemptNumber,
    isSuspicious,
  });

  const requesterName = req.user.name || req.user.email;
  const notificationPayload = {
    requestId: limitRequest._id,
    attemptNumber,
    account: accountSummary(account),
    previousLimit,
    requestedLimit: nextLimit,
    expiresAt: isSuspicious
      ? new Date(limitRequest.createdAt.getTime() + OTP_WINDOW_MS)
      : null,
    requester: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
    },
    guardian: {
      id: guardianLink.protectorUser._id,
      name: guardianLink.protectorUser.name,
      email: guardianLink.protectorUser.email,
    },
    actions: isSuspicious
      ? limitRequestActions(account._id, limitRequest._id)
      : {},
  };

  if (isSuspicious) {
    // Another increase happened within the last 24 hours — hold off on
    // applying it until the guardian approves and the owner verifies the OTP.
    await Promise.all([
      createAndEmitNotification({
        recipient: guardianLink.protectorUser._id,
        sender: req.user._id,
        type: "suspicious_limit_activity",
        title: "Suspicious activity happened",
        body: `${requesterName} tried to increase a transfer limit again.`,
        data: notificationPayload,
      }),
      createAndEmitNotification({
        recipient: req.user._id,
        sender: guardianLink.protectorUser._id,
        type: "limit_increase_otp_required",
        title: "PIN verification required",
        body: "A transfer limit change needs OTP verification.",
        data: notificationPayload,
      }),
    ]);

    emitToUser(req.user._id, "limit-increase:otp-required", notificationPayload);
  } else {
    // No guardian/OTP gate needed — apply the new limit right away.
    account.simulatedTransferLimit = nextLimit;
    await account.save();

    limitRequest.status = "approved";
    await limitRequest.save();

    // Not suspicious (no other increase in the last 24h) — this is treated
    // as a normal, isolated change, so only the owner is told. The
    // guardian only needs to hear about it once it's actually flagged as
    // suspicious above.
    await createAndEmitNotification({
      recipient: req.user._id,
      sender: guardianLink.protectorUser._id,
      type: "limit_increase_applied",
      title: "Limit increase",
      body: `Your transfer limit was increased from ${previousLimit} to ${nextLimit}.`,
      data: notificationPayload,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: isSuspicious
      ? "Repeated limit increase detected — sent to guardian for approval"
      : "Transfer limit increased",
    data: { request: limitRequest, account },
  });
});

export const sendLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  // A request is "active" while it still needs OTP verification. Accept both
  // "notified" (guardian hasn't sent the OTP yet) and "otp_sent" (guardian is
  // re-sending) so the button keeps working across attempts and re-taps.
  const ACTIVE_STATUSES = ["notified", "otp_sent"];

  // Prefer the exact request the guardian acted on. If that alert has been
  // superseded by a newer attempt (a very common case from the 2nd attempt
  // onward), fall back to the latest still-active request for this account so
  // the guardian can always trigger the OTP instead of hitting a dead button.
  let limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    guardianUser: req.user._id,
    status: { $in: ACTIVE_STATUSES },
  }).populate("account user guardian");

  if (!limitRequest) {
    limitRequest = await LimitIncreaseRequest.findOne({
      account: id,
      guardianUser: req.user._id,
      status: { $in: ACTIVE_STATUSES },
    })
      .sort({ createdAt: -1 })
      .populate("account user guardian");
  }

  if (!limitRequest) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "No active limit request to verify for this account"
    );
  }

  if (!limitRequest.isSuspicious) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "OTP can only be sent for a suspicious (repeated within 24h) limit increase"
    );
  }

  const otp = generateOTP(6);
  limitRequest.otpHash = hashOtp(otp);
  limitRequest.otpExpiresAt = new Date(Date.now() + OTP_WINDOW_MS);
  limitRequest.otpSentAt = new Date();
  limitRequest.status = "otp_sent";
  await limitRequest.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: limitRequest.user.email,
      subject: "Transfer Limit Verification OTP",
      message: `Your OTP for transfer limit verification is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Limit increase OTP email failed:", error);
  }

  await trySendPushNotification(
    [limitRequest.user._id],
    "Verification PIN",
    `Your transfer limit verification PIN is ${otp}`
  );

  await createAndEmitNotification({
    recipient: limitRequest.user._id,
    sender: req.user._id,
    type: "limit_increase_otp_sent",
    title: "Verification OTP sent",
    body: `${req.user.name || req.user.email} sent an OTP for your transfer limit verification. Your OTP is ${otp}.`,
    data: {
      requestId: limitRequest._id,
      account: accountSummary(limitRequest.account),
      previousLimit: limitRequest.previousLimit,
      requestedLimit: limitRequest.requestedLimit,
      otp,
      expiresAt: limitRequest.otpExpiresAt,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to user successfully",
    data: {
      requestId: limitRequest._id,
      expiresAt: limitRequest.otpExpiresAt,
      emailSent,
      ...(process.env.NODE_ENV !== "production" ? { debugOtp: otp } : {}),
    },
  });
});

export const verifyLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    user: req.user._id,
    status: "otp_sent",
  }).populate("account guardian guardianUser");

  if (!limitRequest) {
    throw new AppError(httpStatus.NOT_FOUND, "OTP verification request not found");
  }

  if (limitRequest.isSuspicious) {
    const requestDeadline =
      new Date(limitRequest.createdAt).getTime() + OTP_WINDOW_MS;
    if (Date.now() > requestDeadline) {
      await lockLimitRequest(
        limitRequest,
        "Transfer limit OTP was not submitted within 1 minute 30 seconds"
      );
      throw new AppError(httpStatus.BAD_REQUEST, "Time expired. Account locked.");
    }
  }

  const account = limitRequest.account;
  const otpExpired =
    limitRequest.otpExpiresAt && limitRequest.otpExpiresAt.getTime() < Date.now();
  const otpInvalid = !limitRequest.otpHash || limitRequest.otpHash !== hashOtp(otp);

  if (otpExpired || otpInvalid) {
    await lockLimitRequest(
      limitRequest,
      otpExpired
        ? "Transfer limit OTP expired"
        : "Transfer limit OTP verification failed"
    );

    throw new AppError(
      httpStatus.BAD_REQUEST,
      otpExpired ? "OTP expired. Account locked." : "Invalid OTP. Account locked."
    );
  }

  account.simulatedTransferLimit = limitRequest.requestedLimit;
  await account.save();

  limitRequest.status = "approved";
  limitRequest.verifiedAt = new Date();
  await limitRequest.save();

  const approvalPayload = {
    requestId: limitRequest._id,
    account: accountSummary(account),
    previousLimit: limitRequest.previousLimit,
    requestedLimit: limitRequest.requestedLimit,
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: limitRequest.guardianUser._id,
      type: "limit_increase_approved",
      title: "Limit increase approved",
      body: `Your transfer limit was increased to ${limitRequest.requestedLimit}.`,
      data: approvalPayload,
    }),
    createAndEmitNotification({
      recipient: limitRequest.guardianUser._id,
      sender: req.user._id,
      type: "limit_increase_approved",
      title: `${userLabel(req.user)} is safe`,
      body: `${userLabel(req.user)} submitted the OTP successfully and is safe.`,
      data: approvalPayload,
    }),
  ]);

  emitToUser(req.user._id, "limit-increase:approved", approvalPayload);
  emitToUser(limitRequest.guardianUser._id, "limit-increase:approved", approvalPayload);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Limit increase verified successfully",
    data: {
      account,
      request: limitRequest,
    },
  });
});

export const timeoutLimitIncreaseOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  const limitRequest = await LimitIncreaseRequest.findOne({
    _id: requestId,
    account: id,
    user: req.user._id,
    status: { $in: ["notified", "otp_sent"] },
  }).populate("account user guardianUser");

  if (!limitRequest) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending limit request not found");
  }

  if (!limitRequest.isSuspicious) {
    throw new AppError(httpStatus.BAD_REQUEST, "Only suspicious attempts can time out");
  }

  const requestDeadline =
    new Date(limitRequest.createdAt).getTime() + OTP_WINDOW_MS;
  if (Date.now() < requestDeadline) {
    throw new AppError(httpStatus.BAD_REQUEST, "Verification window is still active");
  }

  const lockPayload = await lockLimitRequest(
    limitRequest,
    "Transfer limit OTP was not submitted within 1 minute 30 seconds"
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Account locked after verification timeout",
    data: lockPayload,
  });
});
