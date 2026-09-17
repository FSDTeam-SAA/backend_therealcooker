import mongoose, { Schema } from "mongoose";

const verificationSchema = new Schema(
  {
    email: {
      type: String,
      trim: true,
      default: "",
    },
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    account: {
      type: String,
      trim: true,
      default: "",
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      default: "verified",
    },
    source: {
      type: String,
      default: "manual", // "manual" or "csv"
    },
  },
  { timestamps: true }
);

verificationSchema.index({ email: 1 });
verificationSchema.index({ phone: 1 });
verificationSchema.index({ account: 1 });
verificationSchema.index({ website: 1 });
verificationSchema.index({ createdAt: -1 });

export const Verification = mongoose.model("Verification", verificationSchema);
