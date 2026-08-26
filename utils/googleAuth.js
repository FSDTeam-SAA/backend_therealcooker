import { OAuth2Client } from "google-auth-library";

const DEFAULT_GOOGLE_WEB_CLIENT_ID =
  "703899914024-e0o1iakl8ag4rtk71fbh2msosfmfea8b.apps.googleusercontent.com";

const client = new OAuth2Client();

export const validateGoogleProfile = (payload) => {
  const email = payload?.email?.trim().toLowerCase();

  if (!payload?.sub || !email || payload.email_verified !== true) {
    throw new Error("Google account does not have a verified email address");
  }

  return {
    googleId: payload.sub,
    email,
    name:
      payload.name?.trim() ||
      [payload.given_name, payload.family_name].filter(Boolean).join(" ").trim() ||
      email.split("@")[0],
    picture: typeof payload.picture === "string" ? payload.picture : "",
  };
};

export const verifyGoogleIdToken = async (idToken) => {
  const audience =
    process.env.GOOGLE_CLIENT_ID?.trim() || DEFAULT_GOOGLE_WEB_CLIENT_ID;
  const ticket = await client.verifyIdToken({ idToken, audience });

  return validateGoogleProfile(ticket.getPayload());
};
