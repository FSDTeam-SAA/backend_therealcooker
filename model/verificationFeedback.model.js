import mongoose, { Schema } from "mongoose";

// Community feedback on contacts the verifier had no record of. Pending contacts are kept out of the
// Verification collection, whose lookup treats any record it finds as a verdict; a verdict reached
// here is written there (see utils/communityVotes.js).
export const VOTE_VERDICTS = ["legitimate", "suspicious", "not_sure"];
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model });

// One per contact: the vote tally (recomputed from the votes on every change), the review state and
// how each verdict was reached.
const feedbackSchema = new Schema({
  type: { type: String, enum: ["email", "phone", "account", "website"], required: true },
  // Normalized exactly like the verifier lookup, so the same contact always maps to one record.
  value: { type: String, required: true },
  // As the first voter typed it, for display.
  displayValue: { type: String, default: "" },
  counts: {
    legitimate: { type: Number, default: 0 }, suspicious: { type: Number, default: 0 },
    not_sure: { type: Number, default: 0 }, total: { type: Number, default: 0 },
  },
  // Which verdict the votes currently favour: none (no votes), tie, or the single leading verdict.
  outcome: { type: String, enum: ["none", "tie", ...VOTE_VERDICTS], default: "none" },
  // collecting: no decision yet. needs_review: Not sure leads or the leaders are tied.
  // resolved: a verdict is in the verifier, set by the community or an admin.
  status: { type: String, enum: ["collecting", "needs_review", "resolved"], default: "collecting" },
  // The verdict currently applied to the verifier. It stays when later votes become unclear: an
  // established verdict is only replaced by another clear verdict or an admin decision.
  resolution: {
    verdict: { type: String, enum: ["legitimate", "suspicious"] },
    by: { type: String, enum: ["community", "admin"] },
    admin: ref("User"), reason: { type: String, maxlength: 2000 }, at: Date,
  },
  verification: ref("Verification"),
  history: [{
    _id: false,
    action: { type: String, enum: ["community_verdict", "review_required", "admin_verified", "admin_flagged", "keep_collecting"], required: true },
    by: { type: String, enum: ["community", "admin"], required: true },
    admin: ref("User"), reason: { type: String, maxlength: 2000 },
    counts: { legitimate: Number, suspicious: Number, not_sure: Number, total: Number },
    at: { type: Date, default: Date.now },
  }],
  firstVoteAt: Date, lastVoteAt: Date,
}, { timestamps: true });
feedbackSchema.index({ type: 1, value: 1 }, { unique: true });
feedbackSchema.index({ status: 1, updatedAt: -1 });
feedbackSchema.index({ "resolution.verdict": 1, "resolution.at": -1 });
export const VerificationFeedback = mongoose.model("VerificationFeedback", feedbackSchema);

// Every individual vote, kept whatever the current result. The unique index is what guarantees one
// vote per user per contact, including for concurrent or direct API requests.
const voteSchema = new Schema({
  feedback: { ...ref("VerificationFeedback"), required: true },
  user: { ...ref("User"), required: true },
  verdict: { type: String, enum: VOTE_VERDICTS, required: true },
}, { timestamps: true });
voteSchema.index({ feedback: 1, user: 1 }, { unique: true });
voteSchema.index({ createdAt: -1 });
export const VerificationVote = mongoose.model("VerificationVote", voteSchema);
