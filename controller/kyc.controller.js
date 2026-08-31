import crypto from "crypto";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import { User } from "../model/user.model.js";
import catchAsync from "../utils/catchAsync.js";
import {
  fetchVerification,
  isValidWebhookSignature,
  mapVerificationStatus,
  widgetConfig,
} from "../utils/dojah.js";
import sendResponse from "../utils/sendResponse.js";

// Dojah requires reference_id to be at least 10 characters and unique per
// session — the user id alone isn't (it's reused every time someone
// re-attempts KYC), so a fresh one is minted per session and matched back
// to the user by that value, not by id.
const generateReferenceId = (userId) =>
  `DJ-${userId}-${crypto.randomBytes(4).toString("hex")}`;

// Starts (or restarts) a KYC session: mints a reference_id and hands back
// everything the app's embedded Dojah widget page needs to launch — the
// public key and app id, never the secret key.
//
// Deliberately resets status to "not_started" rather than "pending" —
// opening the widget isn't a submission. This also self-heals a stale
// "pending"/"failed" left over from a previous attempt's referenceId (which
// Dojah has no record for any more, so getKycStatus's poll could never
// clear it on its own): every fresh attempt starts from a clean slate, and
// if the user backs out (or the widget's close event fires) before
// actually submitting anything, status stays "not_started" so the Profile
// screen keeps showing "Verify Now" instead of a phantom "pending".
// getKycStatus is what actually promotes this to "pending", once Dojah
// confirms something was submitted for this reference_id.
export const createKycSession = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  const { appId, publicKey, widgetId } = widgetConfig();
  if (!appId || !publicKey || !widgetId) {
    throw new AppError(
      httpStatus.SERVICE_UNAVAILABLE,
      "KYC verification isn't configured yet"
    );
  }

  const referenceId = generateReferenceId(user._id.toString());
  user.kyc.status = "not_started";
  user.kyc.referenceId = referenceId;
  user.kyc.verifiedAt = undefined;
  await user.save();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "KYC session created",
    data: {
      appId,
      publicKey,
      widgetId,
      referenceId,
      email: user.email,
      userData: {
        first_name: user.name?.split(" ")?.[0] || "",
        last_name: user.name?.split(" ")?.slice(1).join(" ") || "",
      },
    },
  });
});

// Reconciles and returns the current KYC status. As long as the current
// session hasn't already reached a terminal state ("completed"/"failed"),
// this actively asks Dojah for the latest state instead of only trusting
// whatever the webhook has (or hasn't) delivered yet — the webhook needs a
// publicly reachable URL, which a local dev backend usually isn't, so this
// poll is what makes status checking work everywhere the webhook can't
// reach.
//
// This also covers the not_started case with a referenceId still on file
// (a session was created but createKycSession no longer marks it
// "pending" up front) — if the user actually submitted something before
// backing out, this is what promotes the status to "pending"; if they
// closed the widget without submitting, Dojah has nothing on record for
// that reference_id, fetchVerification fails, and the status correctly
// stays not_started.
export const getKycStatus = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, "User not found");
  }

  const reconcilableStatuses = ["not_started", "pending"];
  if (
    reconcilableStatuses.includes(user.kyc?.status) &&
    user.kyc?.referenceId
  ) {
    try {
      const verification = await fetchVerification(user.kyc.referenceId);
      const status = mapVerificationStatus(verification);
      if (status !== user.kyc.status) {
        user.kyc.status = status;
        user.kyc.idType = verification.id_type || user.kyc.idType;
        user.kyc.raw = verification;
        if (status === "completed") user.kyc.verifiedAt = new Date();
        await user.save();
      }
    } catch (error) {
      // Dojah being unreachable/erroring (including "no such verification"
      // when nothing was ever submitted) shouldn't fail the status check —
      // just fall through and report whatever we already had stored.
      console.error("Dojah verification poll failed:", error.message);
    }
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "KYC status fetched",
    data: {
      status: user.kyc?.status || "not_started",
      verifiedAt: user.kyc?.verifiedAt || null,
    },
  });
});

// Dojah's webhook — not behind `protect`, since Dojah isn't one of our
// logged-in users. Authenticated instead by the HMAC signature in
// x-dojah-signature (see isValidWebhookSignature), computed over the raw
// request body server.js stashes on req.rawBody.
export const dojahWebhook = catchAsync(async (req, res) => {
  const signature = req.headers["x-dojah-signature"];
  if (!isValidWebhookSignature(req.rawBody, signature)) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid webhook signature");
  }

  const payload = req.body;
  const referenceId = payload.reference_id;
  if (!referenceId) {
    // Nothing to match this event to — acknowledge so Dojah doesn't keep
    // retrying an event we can never act on.
    return sendResponse(res, {
      statusCode: 200,
      success: true,
      message: "Ignored (no reference_id)",
      data: null,
    });
  }

  const user = await User.findOne({ "kyc.referenceId": referenceId });
  if (user) {
    const status = mapVerificationStatus(payload);
    user.kyc.status = status;
    user.kyc.idType = payload.id_type || user.kyc.idType;
    user.kyc.raw = payload;
    if (status === "completed") user.kyc.verifiedAt = new Date();
    await user.save();
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: "Webhook processed",
    data: null,
  });
});
