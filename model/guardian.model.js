import mongoose, { Schema } from "mongoose";

const guardianSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    protectorUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    relationship: {
      type: String,
      enum: ["parent", "spouse", "sibling", "other"],
      default: "other",
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    // Records that this relationship was requested as Primary. For a pending
    // invite it drives the invite copy; after acceptance it is retained so a
    // reciprocal-primary offer can still be authorised without trusting a
    // client-supplied flag. The current Primary Guardian is only asked for
    // approval after this invite has been accepted; until then the existing
    // primary remains fully in place.
    requestedPrimary: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["pending", "accepted"],
      default: "pending",
    },
    requestedAccounts: [
      {
        type: Schema.Types.ObjectId,
        ref: "Account",
      },
    ],
    respondedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Indexes
guardianSchema.index({ user: 1 });
guardianSchema.index({ protectorUser: 1 });
guardianSchema.index({ user: 1, protectorUser: 1, status: 1 });
// Defence in depth: even if two requests race, MongoDB must never persist
// two Primary Guardians for the same owner.
guardianSchema.index(
  { user: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } }
);

export const Guardian = mongoose.model("Guardian", guardianSchema);
