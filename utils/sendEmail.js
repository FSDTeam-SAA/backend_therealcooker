import nodemailer from "nodemailer";
import {
  EMAIL_HOST,
  EMAIL_PORT,
  EMAIL_USER,
  EMAIL_PASS,
} from "../confiig/env.js";

const emailHost = EMAIL_HOST || "smtp.gmail.com";
const emailPort = Number(EMAIL_PORT) || 587;

export const sendEmail = async ({ email, subject, message }) => {
  if (!EMAIL_USER || !EMAIL_PASS) {
    throw new Error("Email service credentials are not configured");
  }

  const transporter = nodemailer.createTransport({
    host: emailHost,
    port: emailPort,
    secure: emailPort === 465,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });
  await transporter.sendMail({
    from: EMAIL_USER,
    to: email,
    subject: subject
      ? subject
      : "Password change Link : change it by 10 minutes",
    html: message,
  });
};

export const sendMessageTemplate = ({ email, name, phone, message }) => {
  return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: auto; border: 1px solid #e5e7eb; padding: 30px; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);">
      <header style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #e5e7eb;">
        <h1 style="color: #0f172a; margin: 0;">Hello Admin</h1>
        <p style="font-size: 14px; color: #6b7280; margin-top: 4px;">New Contact Message Notification</p>
      </header>

      <section style="padding: 25px 0;">
        <p style="font-size: 16px; color: #111827; margin: 0 0 10px;"><strong>Sender Email:</strong> ${email}</p>
        <p style="font-size: 16px; color: #111827; margin: 0 0 10px;"><strong>Name:</strong> ${name}</p>
        <p style="font-size: 16px; color: #111827; margin: 0 0 10px;"><strong>Phone:</strong> ${phone}</p>

        <div style="margin-top: 20px; padding: 20px; background-color: #f9fafb; border-left: 4px solid #1d4ed8; border-radius: 8px;">
          <p style="font-size: 15px; color: #374151; margin: 0; white-space: pre-wrap;">
            ${message}
          </p>
        </div>
      </section>

      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;"/>

      <footer style="text-align: center; font-size: 13px; color: #9ca3af;">
        This message was sent via the Quantivo contact form.<br />
        &copy; 2025 Quantivo. All rights reserved.
      </footer>
    </div>
  `;
};

export const inviteLinkTemplate = (inviterName, inviteLink) => {
  return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: auto; border-radius: 14px; overflow: hidden; background-color: #f9fafb; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.08);">
      
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #4f46e5, #3b82f6); padding: 30px; text-align: center; color: white;">
        <h1 style="margin: 0; font-size: 26px; font-weight: bold;">You're Invited!</h1>
        <p style="margin-top: 6px; font-size: 15px; opacity: 0.9;">
          ${inviterName} has invited you to join Quantivo
        </p>
      </div>

      <!-- Body -->
      <div style="padding: 30px; background-color: #ffffff;">
        <p style="font-size: 16px; color: #374151; margin-bottom: 20px;">
          We’re excited to have you onboard! Click the button below to accept your invitation and get started.
        </p>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${inviteLink}" target="_blank" 
            style="display: inline-block; padding: 14px 28px; background-color: #3b82f6; color: #ffffff; font-size: 16px; font-weight: 600; border-radius: 8px; text-decoration: none; box-shadow: 0 4px 10px rgba(59, 130, 246, 0.3);">
            Accept Invitation
          </a>
        </div>

        <p style="font-size: 14px; color: #6b7280; text-align: center;">
          If the button above doesn’t work, copy and paste this link into your browser:
        </p>
        <p style="font-size: 14px; color: #2563eb; word-break: break-all; text-align: center;">
          ${inviteLink}
        </p>
      </div>

      <!-- Footer -->
      <div style="background-color: #f3f4f6; text-align: center; padding: 15px; font-size: 13px; color: #9ca3af;">
        &copy; 2025 Quantivo. All rights reserved.
      </div>
    </div>
  `;
};
