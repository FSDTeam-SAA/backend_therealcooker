import crypto from "crypto";

// https://sandbox.dojah.io while testing; switch to https://api.dojah.io
// once you move to live keys.
const BASE_URL = process.env.DOJAH_BASE_URL || "https://sandbox.dojah.io";
const DEFAULT_WIDGET_ID = "6a8cefd14fe3f81e010810d1";

const authHeaders = () => ({
  Authorization: process.env.DOJAH_SECRET_KEY, // raw secret key, no "Bearer"
  AppId: process.env.DOJAH_APP_ID,
  "Content-Type": "application/json",
});

// Widget config the app needs to render the EasyOnboard flow itself — the
// public key and app id are safe client-side (that's what "public" means
// here); the secret key never leaves the backend.
export const widgetConfig = () => ({
  appId: process.env.DOJAH_APP_ID,
  publicKey: process.env.DOJAH_PUBLIC_KEY,
  widgetId: process.env.DOJAH_WIDGET_ID || DEFAULT_WIDGET_ID,
});

// The authoritative check: ask Dojah directly for a verification's current
// status by its reference_id. Used as a fallback when the webhook hasn't
// arrived yet (or can't reach this backend at all, e.g. a local dev server
// only reachable on the LAN) — see kyc.controller.js getKycStatus.
export const fetchVerification = async (referenceId) => {
  const url = `${BASE_URL}/api/v1/kyc/verification?reference_id=${encodeURIComponent(referenceId)}`;
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`Dojah verification lookup failed: ${response.status}`);
  }
  return response.json();
};

// Dojah signs each webhook body with your secret key: HMAC-SHA256 over the
// *raw* request bytes, hex-encoded, sent in the x-dojah-signature header.
// Must be computed over the untouched raw body — re-serializing the parsed
// JSON can byte-shift the string and make a genuine signature look invalid,
// which is why server.js stashes req.rawBody instead of using req.body here.
export const isValidWebhookSignature = (rawBody, signatureHeader) => {
  if (!signatureHeader || !rawBody) return false;
  const expected = crypto
    .createHmac("sha256", process.env.DOJAH_SECRET_KEY || "")
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "hex");
  const gotBuf = Buffer.from(String(signatureHeader), "hex");
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
};

// Maps a Dojah verification response onto our own smaller status enum.
// verification_status alone isn't enough — it tracks whether the *flow*
// finished, not whether the person passed. Dojah's own docs are explicit
// about this: a "Completed" flow with status: false means it ran to the
// end but the person failed the check (bad selfie match, invalid ID,
// etc.), not that we should mark them verified.
export const mapVerificationStatus = ({ verification_status, status }) => {
  if (verification_status === "Failed" || verification_status === "Abandoned") {
    return "failed";
  }
  if (verification_status === "Completed") {
    return status ? "completed" : "failed";
  }
  return "pending"; // "Ongoing" / "Pending"
};
