import mongoose, { Schema } from "mongoose";

export const BANK_ACCOUNT_TYPES = ["cheque", "savings", "transmission", "credit"];

const accountSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    accountType: {
      type: String,
      enum: ["bank", "wallet"],
      required: true,
    },
    bankName: {
      type: String,
      required: function () {
        return this.accountType === "bank";
      },
    },
    // Required for new bank accounts in createAccount; not enforced at the
    // schema level so bank accounts linked before this field existed still save.
    bankAccountType: {
      type: String,
      enum: BANK_ACCOUNT_TYPES,
    },
    nickname: {
      type: String,
      trim: true,
      default: "",
    },
    imageUrl: {
      type: String,
      trim: true,
      default: "",
    },
    accountNumberEncrypted: {
      type: String,
      default: "",
      trim: true,
    },
    simulatedTransferLimit: {
      type: Number,
      default: 0,
      min: 0,
    },
    isLocked: {
      type: Boolean,
      default: false,
    },
    lockedReason: {
      type: String,
      default: "",
    },
    lockedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Indexes
accountSchema.index({ user: 1 });

export const Account = mongoose.model("Account", accountSchema);
