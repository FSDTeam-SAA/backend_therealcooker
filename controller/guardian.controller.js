import crypto from "crypto";
import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Account } from "../model/account.model.js";
import { Guardian } from "../model/guardian.model.js";
import { GuardianAccount } from "../model/guardianAccount.model.js";
import { GuardianDeletionRequest } from "../model/guardianDeletionRequest.model.js";
import { Notification } from "../model/notification.model.js";
import { PrimaryGuardianChangeRequest } from "../model/primaryGuardianChangeRequest.model.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catchAsync.js";
import { generateOTP } from "../utils/commonMethod.js";
import { createAndEmitNotification } from "../utils/notification.js";
import { sendEmail } from "../utils/sendEmail.js";
import sendResponse from "../utils/sendResponse.js";
import { emitToUser } from "../utils/socket.js";

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");
const GUARDIAN_DELETE_OTP_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const userLabel = (user) => user?.name || user?.email || "User";

// Resolves the requester's current primary guardian and the app account
// behind it (if the protector has one), the same way accounts' removal
// flow finds who has to approve.
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

const guardianDeletionRequestActions = (guardianId, requestId) => ({
  sendOtp: `/api/v1/guardians/${guardianId}/delete/${requestId}/send-otp`,
});

const trySendPushNotification = async (userIds, title, body) => {
  try {
    const { sendPushNotification } = await import(
      "../utils/sendPushNotification.js"
    );
    await sendPushNotification(userIds, title, body);
  } catch (error) {
    console.error("Push notification skipped:", error);
  }
};

const guardianInviteActions = (guardianId) => ({
  accept: `/api/v1/guardians/${guardianId}/accept`,
  reject: `/api/v1/guardians/${guardianId}/reject`,
});

const primaryGuardianChangeActions = (requestId) => ({
  approve: `/api/v1/guardians/primary-change/${requestId}/approve`,
  reject: `/api/v1/guardians/primary-change/${requestId}/reject`,
});

const primaryGuardianChangePayload = ({
  request,
  requester,
  currentPrimary,
  proposedPrimary,
}) => ({
  requestId: request._id,
  requester: {
    id: requester._id,
    name: requester.name,
    email: requester.email,
  },
  currentPrimaryGuardian: {
    id: currentPrimary._id,
    name: currentPrimary.name,
  },
  proposedPrimaryGuardian: {
    id: proposedPrimary._id,
    name: proposedPrimary.name,
    relationship: proposedPrimary.relationship,
  },
  actions: primaryGuardianChangeActions(request._id),
});

const notifyCurrentPrimaryOfChange = async ({
  request,
  requester,
  currentPrimary,
  proposedPrimary,
}) => {
  const requesterName = userLabel(requester);
  await createAndEmitNotification({
    recipient: request.currentPrimaryGuardianUser,
    sender: requester._id,
    type: "guardian_primary_change_requested",
    title: "Primary Guardian change approval",
    body: `${requesterName} wants to make ${proposedPrimary.name} their Primary Guardian. Approve this change to become a Secondary Guardian.`,
    data: primaryGuardianChangePayload({
      request,
      requester,
      currentPrimary,
      proposedPrimary,
    }),
  });
};

// Creates the approval request without changing either guardian's role. The
// same proposed change is idempotent; a competing unresolved change is
// rejected so two promotions can never be approved concurrently.
const requestPrimaryGuardianChange = async ({ requester, proposedPrimary }) => {
  const current = await findPrimaryGuardianForUser(requester._id);
  if (!current) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "An accepted Primary Guardian is required before changing roles"
    );
  }

  if (String(current.guardian._id) === String(proposedPrimary._id)) {
    return { alreadyPrimary: true, request: null, current };
  }

  const existingRequest = await PrimaryGuardianChangeRequest.findOne({
    user: requester._id,
    status: "pending",
  });
  if (existingRequest) {
    const sameChange =
      String(existingRequest.currentPrimaryGuardian) ===
        String(current.guardian._id) &&
      String(existingRequest.proposedPrimaryGuardian) ===
        String(proposedPrimary._id);
    if (sameChange) {
      await notifyCurrentPrimaryOfChange({
        request: existingRequest,
        requester,
        currentPrimary: current.guardian,
        proposedPrimary,
      });
      return { alreadyPending: true, request: existingRequest, current };
    }
    throw new AppError(
      httpStatus.CONFLICT,
      "Another Primary Guardian change is already waiting for approval"
    );
  }

  let request;
  try {
    request = await PrimaryGuardianChangeRequest.create({
      user: requester._id,
      currentPrimaryGuardian: current.guardian._id,
      currentPrimaryGuardianUser: current.protectorUser._id,
      proposedPrimaryGuardian: proposedPrimary._id,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    throw new AppError(
      httpStatus.CONFLICT,
      "Another Primary Guardian change is already waiting for approval"
    );
  }

  try {
    await notifyCurrentPrimaryOfChange({
      request,
      requester,
      currentPrimary: current.guardian,
      proposedPrimary,
    });
  } catch (error) {
    // Do not leave a request permanently pending if its required approver
    // notification could not be created. A retry can safely create it again.
    await PrimaryGuardianChangeRequest.deleteOne({
      _id: request._id,
      status: "pending",
    });
    throw error;
  }

  return { request, current };
};

const buildGuardianPayload = async (guardian) => {
  const guardianObject = guardian.toObject ? guardian.toObject() : guardian;
  const linkedAccounts = await GuardianAccount.find({
    guardian: guardianObject._id,
  }).populate("account");
  const requestedAccounts = await Account.find({
    _id: { $in: guardianObject.requestedAccounts || [] },
  });
  const pendingPrimaryChange = guardianObject.isPrimary
    ? null
    : await PrimaryGuardianChangeRequest.findOne({
        user: guardianObject.user,
        proposedPrimaryGuardian: guardianObject._id,
        status: "pending",
      }).select("status");

  return {
    ...guardianObject,
    accounts: linkedAccounts.map((ga) => ga.account),
    requestedAccounts,
    primaryChangeStatus:
      pendingPrimaryChange?.status ||
      (guardianObject.status === "pending" && guardianObject.requestedPrimary
        ? "awaiting_guardian_acceptance"
        : null),
  };
};

// A pending Primary invite is still a deliberate Primary selection. Treat it
// as occupied here so accepting two reciprocal offers in quick succession can
// never create competing Primary Guardian records.
const hasPrimaryGuardianSelection = async (userId) =>
  Boolean(
    await Guardian.exists({
      user: userId,
      isPrimary: true,
      status: { $in: ["pending", "accepted"] },
    })
  );

// A protector is represented by ONE guardian record per requester, but can
// protect many of the requester's accounts. When the same protector is linked
// to additional accounts, merge those accounts into the existing record instead
// of creating a duplicate (or wrongly rejecting the request).
const mergeAccountsIntoGuardian = async (guardian, accounts, requester) => {
  let newAccounts = [];

  if (guardian.status === "pending") {
    // Union the newly requested accounts into the pending invite (dedup by id).
    const existingIds = new Set(
      (guardian.requestedAccounts || []).map((id) => String(id))
    );
    newAccounts = accounts.filter(
      (account) => !existingIds.has(String(account._id))
    );
    if (newAccounts.length > 0) {
      guardian.requestedAccounts = [
        ...(guardian.requestedAccounts || []),
        ...newAccounts.map((account) => account._id),
      ];
      await guardian.save();
    }
  } else {
    // Accepted: the protector already trusts this requester, so link the new
    // accounts directly (same behaviour as updateGuardianAccounts). The
    // composite unique index on GuardianAccount guards against duplicates.
    const existingLinks = await GuardianAccount.find({ guardian: guardian._id });
    const linkedIds = new Set(existingLinks.map((link) => String(link.account)));
    newAccounts = accounts.filter(
      (account) => !linkedIds.has(String(account._id))
    );
    if (newAccounts.length > 0) {
      await GuardianAccount.insertMany(
        newAccounts.map((account) => ({
          guardian: guardian._id,
          account: account._id,
        }))
      );
    }
  }

  if (newAccounts.length > 0 && guardian.protectorUser) {
    const requesterName = requester.name || requester.email;
    await createAndEmitNotification({
      recipient: guardian.protectorUser,
      sender: requester._id,
      type: "guardian_invite",
      title: "Guardian accounts updated",
      body: `${requesterName} added you to protect more of their accounts.`,
      data: {
        guardianId: guardian._id,
        requester: {
          id: requester._id,
          name: requester.name,
          email: requester.email,
        },
        accounts: newAccounts.map((account) => ({
          id: account._id,
          accountType: account.accountType,
          bankName: account.bankName,
        })),
        actions: guardianInviteActions(guardian._id),
      },
    });
  }

  return {
    addedCount: newAccounts.length,
    payload: await buildGuardianPayload(guardian),
  };
};

// Create guardian. Guardians protect all of the requester's accounts.
export const createGuardian = catchAsync(async (req, res) => {
  const { name, email, phone, relationship, isPrimary } = req.body;

  if (!name || !email || !phone) {
    throw new AppError(httpStatus.BAD_REQUEST, "Missing required fields");
  }

  // The protector must already be a registered user on the platform
  const protectorUser = await User.findOne({ email });
  if (!protectorUser) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Protector must have an active account"
    );
  }

  if (String(protectorUser._id) === String(req.user._id)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You cannot add yourself as a guardian"
    );
  }

  const existingGuardians = await Guardian.find({
    user: req.user._id,
    status: { $in: ["pending", "accepted"] },
  });
  const existingGuardian = existingGuardians.find(
    (guardian) => String(guardian.protectorUser) === String(protectorUser._id)
  );
  const isFirstGuardian = existingGuardians.length === 0;
  const shouldBePrimary = isFirstGuardian;
  const wantsPrimaryChange = !isFirstGuardian && isPrimary === true;
  const secondaryCount = existingGuardians.filter(
    (guardian) => !guardian.isPrimary
  ).length;
  if (!existingGuardian && existingGuardians.length >= 4) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You can have 1 primary and up to 3 secondary guardians"
    );
  }
  if (!existingGuardian && !shouldBePrimary && secondaryCount >= 3) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "You can add up to 3 secondary guardians"
    );
  }
  if (wantsPrimaryChange) {
    const currentPrimary = existingGuardians.find(
      (guardian) => guardian.isPrimary
    );
    if (!currentPrimary || currentPrimary.status !== "accepted") {
      throw new AppError(
        httpStatus.CONFLICT,
        "Wait for your current Primary Guardian to accept before changing roles"
      );
    }
  }

  const accounts = await Account.find({
    user: req.user._id,
    isActive: true,
  });

  // A protector can guard many of your accounts. If this protector is already
  // linked to you, merge the newly selected accounts into that record instead
  // of rejecting the request. Adding the same person to the same account twice
  // is a no-op (deduped here and by the GuardianAccount unique index).
  if (existingGuardian) {
    let primaryChangeRequested = false;
    if (wantsPrimaryChange && !existingGuardian.isPrimary) {
      if (existingGuardian.status === "pending") {
        existingGuardian.requestedPrimary = true;
        primaryChangeRequested = true;
      } else {
        const change = await requestPrimaryGuardianChange({
          requester: req.user,
          proposedPrimary: existingGuardian,
        });
        primaryChangeRequested = !change.alreadyPrimary;
      }
      await existingGuardian.save();
    }
    const { addedCount, payload } = await mergeAccountsIntoGuardian(
      existingGuardian,
      accounts,
      req.user
    );
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message:
        addedCount > 0
          ? "Guardian updated with the selected account(s)"
          : "This guardian already protects the selected account(s)",
      // alreadyLinked lets the client show a "already a guardian for this
      // account" notice instead of the success/confirm flow.
      data: {
        ...payload,
        addedCount,
        alreadyLinked: addedCount === 0,
        primaryChangeRequested,
      },
    });
    return;
  }

  // Create a pending invite. Account links are created only after acceptance.
  const guardian = await Guardian.create({
    user: req.user._id,
    protectorUser: protectorUser._id,
    name,
    email,
    phone,
    relationship,
    isPrimary: shouldBePrimary,
    requestedPrimary: wantsPrimaryChange,
    status: "pending",
    requestedAccounts: accounts.map((account) => account._id),
  });

  const requesterName = req.user.name || req.user.email;
  const guardianRole = guardian.isPrimary ? "primary" : "secondary";
  const inviteBody = guardian.requestedPrimary
    ? `${requesterName} invited you to be their guardian and intends to request you as Primary after you accept.`
    : `${requesterName} invited you to be their ${guardianRole} guardian.`;
  await createAndEmitNotification({
    recipient: protectorUser._id,
    sender: req.user._id,
    type: "guardian_invite",
    title: "Guardian invite",
    body: inviteBody,
    data: {
      guardianId: guardian._id,
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
      actions: guardianInviteActions(guardian._id),
    },
  });

  const guardianWithAccounts = await buildGuardianPayload(guardian);

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    success: true,
    message: "Guardian invite sent successfully",
    data: guardianWithAccounts,
  });
});

// Get all guardians of logged-in user with their accounts
export const getGuardians = catchAsync(async (req, res) => {
  const guardians = await Guardian.find({ user: req.user._id });

  const result = await Promise.all(
    guardians.map((guardian) => buildGuardianPayload(guardian))
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardians fetched successfully",
    data: result,
  });
});

// Get single guardian with accounts
export const getGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;
  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  const result = await buildGuardianPayload(guardian);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian fetched successfully",
    data: result,
  });
});

// Update guardian info
export const updateGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, relationship } = req.body;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  if (name) guardian.name = name;
  if (email) guardian.email = email;
  if (phone) guardian.phone = phone;
  if (relationship) guardian.relationship = relationship;

  await guardian.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian updated successfully",
    data: guardian,
  });
});

// Cancels a still-pending invite before the protector has responded to it.
// An already-accepted guardian can't be removed this way — that must go
// through the guardian-approval flow (requestGuardianDeletion /
// sendGuardianDeletionOtp / verifyGuardianDeletionOtp), the same
// guardian-first pattern used to remove a protected account.
export const deleteGuardian = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  if (guardian.status !== "pending") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Use the guardian-approved removal flow"
    );
  }

  if (guardian.protectorUser) {
    const requesterName = userLabel(req.user);
    await createAndEmitNotification({
      recipient: guardian.protectorUser,
      sender: req.user._id,
      type: "guardian_invite_cancelled",
      title: "Guardian invite cancelled",
      body: `${requesterName} withdrew their guardian invite.`,
      data: { guardianId: guardian._id },
    });
  }

  await guardian.deleteOne();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invite cancelled",
    data: null,
  });
});

// Re-notifies a still-pending invite that hasn't been responded to yet.
// Doesn't touch requestedAccounts — just pushes a fresh guardian_invite so
// there's an easy, obvious one to act on again. The client drops the
// earlier unresponded invite for this guardianId the moment this one
// arrives, so the protector only ever sees one live invite per person.
export const resendGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    user: req.user._id,
    status: "pending",
  });
  if (!guardian) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Pending guardian invite not found"
    );
  }

  const accounts = await Account.find({
    _id: { $in: guardian.requestedAccounts || [] },
  });

  const requesterName = userLabel(req.user);
  const guardianRole = guardian.isPrimary ? "primary" : "secondary";
  const inviteBody = guardian.requestedPrimary
    ? `${requesterName} invited you to be their guardian and intends to request you as Primary after you accept.`
    : `${requesterName} invited you to be their ${guardianRole} guardian.`;
  await createAndEmitNotification({
    recipient: guardian.protectorUser,
    sender: req.user._id,
    type: "guardian_invite",
    title: "Guardian invite",
    body: inviteBody,
    data: {
      guardianId: guardian._id,
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
      actions: guardianInviteActions(guardian._id),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Invite resent",
    data: { guardianId: guardian._id },
  });
});

// Starts a guarded role-change request. No role is changed here: only the
// owner's current Primary Guardian can approve the switch.
export const makeGuardianPrimary = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    user: req.user._id,
    status: "accepted",
  });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Connected guardian not found");
  }

  const change = await requestPrimaryGuardianChange({
    requester: req.user,
    proposedPrimary: guardian,
  });

  if (change.alreadyPrimary) {
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "This guardian is already Primary",
      data: { status: "already_primary", guardianId: guardian._id },
    });
    return;
  }

  sendResponse(res, {
    statusCode: httpStatus.ACCEPTED,
    success: true,
    message: change.alreadyPending
      ? "Primary Guardian change is already waiting for approval"
      : "Current Primary Guardian notified for approval",
    data: {
      requestId: change.request._id,
      status: "pending",
      currentPrimaryGuardian: {
        id: change.current.guardian._id,
        name: change.current.guardian.name,
      },
      proposedPrimaryGuardian: {
        id: guardian._id,
        name: guardian.name,
      },
    },
  });
});

const resolvePrimaryChangeNotifications = async (requestId, decision) => {
  await Notification.updateMany(
    {
      type: "guardian_primary_change_requested",
      "data.requestId": requestId,
    },
    {
      $set: {
        "data.resolved": true,
        "data.decision": decision,
      },
    }
  );
};

// Current-Primary-Guardian-only. The role swap and request resolution happen
// in one transaction, so an interrupted approval cannot leave the owner with
// no Primary Guardian or with two of them.
export const approvePrimaryGuardianChange = catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const changeRequest = await PrimaryGuardianChangeRequest.findOne({
        _id: requestId,
        currentPrimaryGuardianUser: req.user._id,
        status: "pending",
      }).session(session);
      if (!changeRequest) {
        throw new AppError(
          httpStatus.CONFLICT,
          "This Primary Guardian change has already been handled or is not yours to approve"
        );
      }

      const currentPrimary = await Guardian.findOne({
        _id: changeRequest.currentPrimaryGuardian,
        user: changeRequest.user,
        protectorUser: req.user._id,
        status: "accepted",
        isPrimary: true,
      }).session(session);
      const proposedPrimary = await Guardian.findOne({
        _id: changeRequest.proposedPrimaryGuardian,
        user: changeRequest.user,
        status: "accepted",
        isPrimary: false,
      }).session(session);

      if (!currentPrimary || !proposedPrimary) {
        throw new AppError(
          httpStatus.CONFLICT,
          "Guardian roles changed while this request was pending. No changes were made"
        );
      }

      const demoted = await Guardian.findOneAndUpdate(
        {
          _id: currentPrimary._id,
          user: changeRequest.user,
          isPrimary: true,
          status: "accepted",
        },
        { $set: { isPrimary: false } },
        { new: true, session }
      );
      if (!demoted) {
        throw new AppError(
          httpStatus.CONFLICT,
          "The current Primary Guardian could not be verified. No changes were made"
        );
      }

      const promoted = await Guardian.findOneAndUpdate(
        {
          _id: proposedPrimary._id,
          user: changeRequest.user,
          isPrimary: false,
          status: "accepted",
        },
        { $set: { isPrimary: true, requestedPrimary: false } },
        { new: true, session }
      );
      if (!promoted) {
        throw new AppError(
          httpStatus.CONFLICT,
          "The proposed Primary Guardian could not be verified. No changes were made"
        );
      }

      changeRequest.status = "approved";
      changeRequest.resolvedAt = new Date();
      await changeRequest.save({ session });
    });
  } finally {
    await session.endSession();
  }

  const resolvedRequest = await PrimaryGuardianChangeRequest.findById(
    requestId
  )
    .populate("user", "name email")
    .populate("currentPrimaryGuardian", "name protectorUser")
    .populate("proposedPrimaryGuardian", "name protectorUser");

  try {
    await resolvePrimaryChangeNotifications(requestId, "approved");
  } catch (error) {
    console.error("Primary Guardian request resolution sync failed:", error);
  }

  const requesterName = userLabel(resolvedRequest.user);
  try {
    await createAndEmitNotification({
      recipient: resolvedRequest.user._id,
      sender: req.user._id,
      type: "guardian_primary_change_approved",
      title: "Primary Guardian change approved",
      body: `${resolvedRequest.proposedPrimaryGuardian.name} is now your Primary Guardian. ${resolvedRequest.currentPrimaryGuardian.name} is now a Secondary Guardian.`,
      data: {
        requestId: resolvedRequest._id,
        resolved: true,
        decision: "approved",
        currentPrimaryGuardian: {
          id: resolvedRequest.currentPrimaryGuardian._id,
          name: resolvedRequest.currentPrimaryGuardian.name,
        },
        proposedPrimaryGuardian: {
          id: resolvedRequest.proposedPrimaryGuardian._id,
          name: resolvedRequest.proposedPrimaryGuardian.name,
        },
      },
    });

    await createAndEmitNotification({
      recipient: resolvedRequest.proposedPrimaryGuardian.protectorUser,
      sender: req.user._id,
      type: "guardian_promoted_to_primary",
      title: "You are now a Primary Guardian",
      body: `You are now ${requesterName}'s Primary Guardian.`,
      data: {
        requestId: resolvedRequest._id,
        requester: {
          id: resolvedRequest.user._id,
          name: resolvedRequest.user.name,
          email: resolvedRequest.user.email,
        },
        resolved: true,
      },
    });
  } catch (error) {
    // The decision is already committed. Do not report a failed approval to
    // the guardian (and invite a misleading retry) solely because an outcome
    // notification could not be persisted.
    console.error("Primary Guardian approval notification failed:", error);
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Primary Guardian change approved",
    data: {
      requestId: resolvedRequest._id,
      status: "approved",
      currentPrimaryGuardian: {
        id: resolvedRequest.proposedPrimaryGuardian._id,
        name: resolvedRequest.proposedPrimaryGuardian.name,
      },
      previousPrimaryGuardian: {
        id: resolvedRequest.currentPrimaryGuardian._id,
        name: resolvedRequest.currentPrimaryGuardian.name,
      },
    },
  });
});

// Current-Primary-Guardian-only. Rejection resolves the request without
// touching either guardian record.
export const rejectPrimaryGuardianChange = catchAsync(async (req, res) => {
  const { requestId } = req.params;

  const changeRequest = await PrimaryGuardianChangeRequest.findOneAndUpdate(
    {
      _id: requestId,
      currentPrimaryGuardianUser: req.user._id,
      status: "pending",
    },
    { $set: { status: "rejected", resolvedAt: new Date() } },
    { new: true }
  )
    .populate("user", "name email")
    .populate("currentPrimaryGuardian", "name")
    .populate("proposedPrimaryGuardian", "name");

  if (!changeRequest) {
    throw new AppError(
      httpStatus.CONFLICT,
      "This Primary Guardian change has already been handled or is not yours to reject"
    );
  }

  try {
    await resolvePrimaryChangeNotifications(requestId, "rejected");
  } catch (error) {
    console.error("Primary Guardian request resolution sync failed:", error);
  }
  try {
    await createAndEmitNotification({
      recipient: changeRequest.user._id,
      sender: req.user._id,
      type: "guardian_primary_change_rejected",
      title: "Primary Guardian change declined",
      body: `${changeRequest.currentPrimaryGuardian.name} declined the request to make ${changeRequest.proposedPrimaryGuardian.name} your Primary Guardian. No guardian roles were changed.`,
      data: {
        requestId: changeRequest._id,
        resolved: true,
        decision: "rejected",
        currentPrimaryGuardian: {
          id: changeRequest.currentPrimaryGuardian._id,
          name: changeRequest.currentPrimaryGuardian.name,
        },
        proposedPrimaryGuardian: {
          id: changeRequest.proposedPrimaryGuardian._id,
          name: changeRequest.proposedPrimaryGuardian.name,
        },
      },
    });
  } catch (error) {
    console.error("Primary Guardian rejection notification failed:", error);
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Primary Guardian change rejected",
    data: { requestId: changeRequest._id, status: "rejected" },
  });
});

// Guardian removal now runs guardian-first, mirroring account removal: the
// owner notifies their primary guardian, the guardian approves in-app
// (pushing the OTP to the owner in real time over the socket + email/push),
// and the owner enters that OTP to finish. If the guardian being removed IS
// the current primary, they end up approving their own removal — there's no
// other primary to ask, and it still stops the owner from unilaterally
// dropping their primary guardian without that guardian's own confirmation.
export const requestGuardianDeletion = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  const primaryGuardian = await findPrimaryGuardianForUser(req.user._id);
  if (!primaryGuardian) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "A primary guardian is required to remove a guardian"
    );
  }

  const deletionRequest = await GuardianDeletionRequest.findOneAndUpdate(
    {
      guardian: guardian._id,
      user: req.user._id,
      status: { $in: ["notified", "otp_sent"] },
    },
    {
      $set: {
        guardian: guardian._id,
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
    type: "guardian_deletion_requested",
    title: "Guardian removal approval needed",
    body: `${requesterName} wants to remove ${guardian.name} as a guardian and needs your approval.`,
    data: {
      requestId: deletionRequest._id,
      guardian: {
        id: guardian._id,
        name: guardian.name,
        isPrimary: guardian.isPrimary,
      },
      requester: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      actions: guardianDeletionRequestActions(guardian._id, deletionRequest._id),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Your primary guardian was notified to approve this removal",
    data: { requestId: deletionRequest._id },
  });
});

// Guardian-invoked. Accept both "notified" (first send) and "otp_sent"
// (guardian re-sending) so the button keeps working on repeat taps.
export const sendGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;

  const deletionRequest = await GuardianDeletionRequest.findOne({
    _id: requestId,
    guardian: id,
    primaryGuardianUser: req.user._id,
    status: { $in: ["notified", "otp_sent"] },
  }).populate("guardian user");

  if (!deletionRequest?.guardian) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "No active removal request to approve for this guardian"
    );
  }

  const otp = generateOTP(6);
  deletionRequest.otpHash = hashOtp(otp);
  deletionRequest.otpExpiresAt = new Date(
    Date.now() + GUARDIAN_DELETE_OTP_WINDOW_MS
  );
  deletionRequest.otpSentAt = new Date();
  deletionRequest.status = "otp_sent";
  await deletionRequest.save();

  let emailSent = true;
  try {
    await sendEmail({
      email: deletionRequest.user.email,
      subject: "Guardian Removal OTP",
      message: `Your primary guardian approved removing ${deletionRequest.guardian.name} as a guardian. Your OTP is: ${otp}`,
    });
  } catch (error) {
    emailSent = false;
    console.error("Guardian deletion OTP email failed:", error);
  }

  await trySendPushNotification(
    [deletionRequest.user._id],
    "Guardian removal OTP",
    `Your guardian removal OTP is ${otp}`
  );

  await createAndEmitNotification({
    recipient: deletionRequest.user._id,
    sender: req.user._id,
    type: "guardian_deletion_otp_required",
    title: "Guardian removal OTP sent",
    body: `${userLabel(req.user)} approved removing ${deletionRequest.guardian.name}. Your OTP is ${otp}.`,
    data: {
      requestId: deletionRequest._id,
      guardian: {
        id: deletionRequest.guardian._id,
        name: deletionRequest.guardian.name,
      },
      guardianApprover: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
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

export const verifyGuardianDeletionOtp = catchAsync(async (req, res) => {
  const { id, requestId } = req.params;
  const { otp } = req.body;

  if (!otp) {
    throw new AppError(httpStatus.BAD_REQUEST, "OTP is required");
  }

  const deletionRequest = await GuardianDeletionRequest.findOne({
    _id: requestId,
    guardian: id,
    user: req.user._id,
    status: "otp_sent",
  }).populate("guardian primaryGuardianUser");

  if (!deletionRequest?.guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian removal request not found");
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

  const guardian = deletionRequest.guardian;
  const wasPrimary = guardian.isPrimary;

  const cancelledPrimaryChange =
    await PrimaryGuardianChangeRequest.findOneAndUpdate(
      {
        user: req.user._id,
        status: "pending",
        $or: [
          { currentPrimaryGuardian: guardian._id },
          { proposedPrimaryGuardian: guardian._id },
        ],
      },
      { $set: { status: "cancelled", resolvedAt: new Date() } },
      { new: true }
    );
  if (cancelledPrimaryChange) {
    await resolvePrimaryChangeNotifications(
      cancelledPrimaryChange._id,
      "cancelled"
    );
  }

  await GuardianAccount.deleteMany({ guardian: guardian._id });
  await guardian.deleteOne();

  // If the deleted guardian was primary and exactly one guardian remains,
  // that guardian automatically takes over as primary rather than leaving
  // the user with no primary guardian at all.
  if (wasPrimary) {
    const remainingGuardians = await Guardian.find({ user: req.user._id });
    if (remainingGuardians.length === 1) {
      remainingGuardians[0].isPrimary = true;
      await remainingGuardians[0].save();
    }
  }

  const confirmationPayload = {
    requestId: deletionRequest._id,
    guardian: { id: guardian._id, name: guardian.name },
  };

  await Promise.all([
    createAndEmitNotification({
      recipient: req.user._id,
      sender: deletionRequest.primaryGuardianUser._id,
      type: "guardian_deletion_completed",
      title: "Guardian removed",
      body: `${guardian.name} was removed as your guardian.`,
      data: confirmationPayload,
    }),
    createAndEmitNotification({
      recipient: deletionRequest.primaryGuardianUser._id,
      sender: req.user._id,
      type: "guardian_deletion_completed",
      title: "Guardian removed",
      body: `${guardian.name} was removed as ${userLabel(req.user)}'s guardian after your approval.`,
      data: confirmationPayload,
    }),
  ]);

  emitToUser(req.user._id, "guardian-deletion:completed", confirmationPayload);
  emitToUser(
    deletionRequest.primaryGuardianUser._id,
    "guardian-deletion:completed",
    confirmationPayload
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian removed successfully",
    data: null,
  });
});

// Add/remove accounts to an existing guardian
export const updateGuardianAccounts = catchAsync(async (req, res) => {
  const { id } = req.params;
  const { accountIds } = req.body; // array of account IDs to link

  if (!accountIds || !Array.isArray(accountIds)) {
    throw new AppError(httpStatus.BAD_REQUEST, "accountIds array required");
  }

  const guardian = await Guardian.findOne({ _id: id, user: req.user._id });
  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Guardian not found");
  }

  // Verify accounts belong to user
  const accounts = await Account.find({
    _id: { $in: accountIds },
    user: req.user._id,
  });
  if (accounts.length !== accountIds.length) {
    throw new AppError(httpStatus.BAD_REQUEST, "One or more accounts not found");
  }

  if (guardian.status === "pending") {
    guardian.requestedAccounts = accountIds;
    await guardian.save();

    const updated = await buildGuardianPayload(guardian);
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Pending guardian invite accounts updated successfully",
      data: updated,
    });
    return;
  }

  // Remove existing links for this guardian
  await GuardianAccount.deleteMany({ guardian: guardian._id });

  // Create new links
  if (accountIds.length > 0) {
    const entries = accountIds.map((accountId) => ({
      guardian: guardian._id,
      account: accountId,
    }));
    await GuardianAccount.insertMany(entries);
  }

  // Return updated guardian with accounts
  const updated = await Guardian.findById(guardian._id);
  const updatedAccounts = await GuardianAccount.find({ guardian: guardian._id })
    .populate("account");

  const result = {
    ...updated.toObject(),
    accounts: updatedAccounts.map(ga => ga.account),
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian accounts updated successfully",
    data: result,
  });
});

export const acceptGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    protectorUser: req.user._id,
    status: "pending",
  }).populate("user", "name email phone");

  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending guardian invite not found");
  }

  const accounts = await Account.find({
    user: guardian.user._id,
    isActive: true,
  });
  const accountIds = accounts.map((account) => account._id);

  if (accountIds.length > 0) {
    // Only clear THIS guardian's stale links for these accounts. Scoping by
    // guardian keeps other guardians that protect the same accounts intact
    // (an account may have several guardians).
    await GuardianAccount.deleteMany({
      guardian: guardian._id,
      account: { $in: accountIds },
    });
    await GuardianAccount.insertMany(
      accountIds.map((accountId) => ({
        guardian: guardian._id,
        account: accountId,
      }))
    );
  }

  const wasPrimaryRequest =
    guardian.isPrimary === true || guardian.requestedPrimary === true;
  const shouldRequestPrimaryChange = guardian.requestedPrimary === true;
  guardian.status = "accepted";
  guardian.requestedAccounts = accountIds;
  guardian.respondedAt = new Date();
  await guardian.save();

  const protectorName = req.user.name || req.user.email;
  await createAndEmitNotification({
    recipient: guardian.user._id,
    sender: req.user._id,
    type: "guardian_invite_accepted",
    title: "Guardian invite accepted",
    body: `${protectorName} accepted your guardian invite.`,
    data: {
      guardianId: guardian._id,
      protector: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
    },
  });

  // A newly invited proposed primary must first agree to be a guardian.
  // Only now is it valid to ask the existing Primary Guardian to approve
  // the role swap. Any failure here leaves the existing roles untouched and
  // does not undo the guardian's successfully accepted invitation.
  if (shouldRequestPrimaryChange) {
    try {
      await requestPrimaryGuardianChange({
        requester: guardian.user,
        proposedPrimary: guardian,
      });
    } catch (error) {
      await createAndEmitNotification({
        recipient: guardian.user._id,
        sender: req.user._id,
        type: "guardian_primary_change_not_started",
        title: "Primary Guardian change needs attention",
        body: `${protectorName} accepted your guardian invite, but the Primary Guardian change could not be requested. No guardian roles were changed.`,
        data: {
          proposedPrimaryGuardian: {
            id: guardian._id,
            name: guardian.name,
          },
          reason: error.message,
        },
      });
    }
  }

  const updatedGuardian = await Guardian.findById(guardian._id);
  const result = await buildGuardianPayload(updatedGuardian);
  const reciprocalPrimaryEligible =
    wasPrimaryRequest &&
    !(await hasPrimaryGuardianSelection(req.user._id));

  result.reciprocalPrimaryOffer = reciprocalPrimaryEligible
    ? {
        eligible: true,
        requester: {
          id: guardian.user._id,
          name: guardian.user.name,
          email: guardian.user.email,
        },
      }
    : { eligible: false };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian invite accepted successfully",
    data: result,
  });
});

// After accepting somebody's Primary Guardian request, an invitee with no
// Primary Guardian of their own can choose to make the relationship mutual.
// The accepted relationship is the authority for this action; the client does
// not send contact details or claim that the original invite was Primary.
export const sendReciprocalPrimaryInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const acceptedRequest = await Guardian.findOne({
    _id: id,
    protectorUser: req.user._id,
    status: "accepted",
  }).populate("user", "name email phone");

  if (!acceptedRequest) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "Accepted guardian relationship not found"
    );
  }
  if (!acceptedRequest.isPrimary && !acceptedRequest.requestedPrimary) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "A reciprocal invite is only available for a Primary Guardian request"
    );
  }

  const requester = acceptedRequest.user;
  const existingPrimary = await Guardian.findOne({
    user: req.user._id,
    isPrimary: true,
    status: { $in: ["pending", "accepted"] },
  });
  if (existingPrimary) {
    if (String(existingPrimary.protectorUser) === String(requester._id)) {
      sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message:
          existingPrimary.status === "accepted"
            ? `${userLabel(requester)} is already your Primary Guardian`
            : `A Primary Guardian invite is already pending for ${userLabel(requester)}`,
        data: await buildGuardianPayload(existingPrimary),
      });
      return;
    }
    throw new AppError(
      httpStatus.CONFLICT,
      "You already have a Primary Guardian or a pending Primary invite"
    );
  }

  const activeGuardians = await Guardian.find({
    user: req.user._id,
    status: { $in: ["pending", "accepted"] },
  });
  let reciprocal = activeGuardians.find(
    (guardian) =>
      String(guardian.protectorUser) === String(requester._id)
  );
  if (!reciprocal && activeGuardians.length >= 4) {
    throw new AppError(
      httpStatus.CONFLICT,
      "Guardian limit reached. Remove a Secondary Guardian before sending this invite"
    );
  }

  const accounts = await Account.find({
    user: req.user._id,
    isActive: true,
  });
  const accountIds = accounts.map((account) => account._id);
  const wasExisting = Boolean(reciprocal);
  const wasAccepted = reciprocal?.status === "accepted";

  try {
    if (reciprocal) {
      reciprocal.isPrimary = true;
      reciprocal.requestedPrimary = false;
      reciprocal.requestedAccounts = accountIds;
      await reciprocal.save();
    } else {
      reciprocal = await Guardian.create({
        user: req.user._id,
        protectorUser: requester._id,
        name: userLabel(requester),
        email: requester.email,
        // Phone is not required during registration, but Guardian's legacy
        // schema requires a non-empty value. It can be completed in Profile
        // later without blocking this consent-driven reciprocal flow.
        phone: requester.phone || "Not provided",
        relationship: acceptedRequest.relationship,
        isPrimary: true,
        requestedPrimary: false,
        status: "pending",
        requestedAccounts: accountIds,
      });
    }
  } catch (error) {
    if (error?.code === 11000) {
      throw new AppError(
        httpStatus.CONFLICT,
        "A Primary Guardian invite was created at the same time. Refresh your Guardians list"
      );
    }
    throw error;
  }

  const ownerName = userLabel(req.user);
  try {
    if (wasAccepted) {
      await createAndEmitNotification({
        recipient: requester._id,
        sender: req.user._id,
        type: "guardian_promoted_to_primary",
        title: "You are now a Primary Guardian",
        body: `You are now ${ownerName}'s Primary Guardian.`,
        data: {
          guardianId: reciprocal._id,
          requester: {
            id: req.user._id,
            name: req.user.name,
            email: req.user.email,
          },
        },
      });
    } else {
      await createAndEmitNotification({
        recipient: requester._id,
        sender: req.user._id,
        type: "guardian_invite",
        title: "Primary Guardian invite",
        body: `${ownerName} invited you to be their Primary Guardian.`,
        data: {
          guardianId: reciprocal._id,
          requester: {
            id: req.user._id,
            name: req.user.name,
            email: req.user.email,
          },
          accounts: accounts.map((account) => ({
            id: account._id,
            accountType: account.accountType,
            bankName: account.bankName,
          })),
          actions: guardianInviteActions(reciprocal._id),
        },
      });
    }
  } catch (error) {
    if (!wasExisting) {
      await Guardian.deleteOne({ _id: reciprocal._id, status: "pending" });
    } else if (!wasAccepted) {
      reciprocal.isPrimary = false;
      await reciprocal.save();
    }
    throw error;
  }

  sendResponse(res, {
    statusCode: wasExisting ? httpStatus.OK : httpStatus.CREATED,
    success: true,
    message: wasAccepted
      ? `${userLabel(requester)} is now your Primary Guardian`
      : "Reciprocal Primary Guardian invite sent successfully",
    data: await buildGuardianPayload(reciprocal),
  });
});

export const rejectGuardianInvite = catchAsync(async (req, res) => {
  const { id } = req.params;

  const guardian = await Guardian.findOne({
    _id: id,
    protectorUser: req.user._id,
    status: "pending",
  }).populate("user", "name email");

  if (!guardian) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending guardian invite not found");
  }

  const accounts = await Account.find({
    _id: { $in: guardian.requestedAccounts || [] },
  });
  const requesterId = guardian.user._id;
  const protectorName = req.user.name || req.user.email;

  // Build the response payload before deleting — the Flutter client parses
  // this the same way it parses acceptGuardianInvite's response, so it must
  // not be null (the guardian doc won't exist anymore once we delete it).
  guardian.status = "rejected";
  const result = await buildGuardianPayload(guardian);

  await guardian.deleteOne();

  await createAndEmitNotification({
    recipient: requesterId,
    sender: req.user._id,
    type: "guardian_invite_rejected",
    title: "Guardian invite rejected",
    body: `${protectorName} rejected your guardian invite.`,
    data: {
      guardianId: id,
      protector: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      },
      accounts: accounts.map((account) => ({
        id: account._id,
        accountType: account.accountType,
        bankName: account.bankName,
      })),
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Guardian invite rejected successfully",
    data: result,
  });
});
