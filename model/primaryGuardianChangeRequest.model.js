import mongoose, { Schema } from "mongoose";

const primaryGuardianChangeRequestSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    currentPrimaryGuardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
      required: true,
    },
    currentPrimaryGuardianUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    proposedPrimaryGuardian: {
      type: Schema.Types.ObjectId,
      ref: "Guardian",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    resolvedAt: Date,
  },
  { timestamps: true }
);

// An owner may only have one unresolved role-change request. This prevents
// two guardians approving competing promotions at the same time.
primaryGuardianChangeRequestSchema.index(
  { user: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
  }
);
primaryGuardianChangeRequestSchema.index({
  currentPrimaryGuardianUser: 1,
  status: 1,
});

export const PrimaryGuardianChangeRequest = mongoose.model(
  "PrimaryGuardianChangeRequest",
  primaryGuardianChangeRequestSchema
);
