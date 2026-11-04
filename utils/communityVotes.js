import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Verification } from "../model/verification.model.js";
import { VerificationFeedback, VerificationVote, VOTE_VERDICTS } from "../model/verificationFeedback.model.js";
import { buildVerificationLookupFilter } from "../controller/verification.controller.js";

// Verifier records written from community feedback: "community" when the votes decided, and
// "community_review" when an admin decided from the Feedback & Votes page. Records with any other
// source were entered by an admin (manual or CSV) and votes never change them.
export const COMMUNITY_SOURCES = ["community", "community_review"];
const VERIFIER_STATUS = { legitimate: "verified", suspicious: "fraudulent" };

// Votes needed before a clear lead becomes a verdict. The product defines no minimum yet, so a strict
// lead decides on its own; set COMMUNITY_VOTE_MIN_VOTES to require more.
export const minimumVotes = () => Math.max(1, Number.parseInt(process.env.COMMUNITY_VOTE_MIN_VOTES, 10) || 1);

export const tally = rows => {
  const counts = Object.fromEntries(VOTE_VERDICTS.map(verdict => [verdict, rows.find(row => row._id === verdict)?.count || 0]));
  return { ...counts, total: VOTE_VERDICTS.reduce((sum, verdict) => sum + counts[verdict], 0) };
};

// The single verdict with strictly more votes than each other one, "tie" when the lead is shared,
// "none" without votes.
export function voteOutcome(counts) {
  const top = Math.max(...VOTE_VERDICTS.map(verdict => counts[verdict] || 0));
  if (!top) return "none";
  const leaders = VOTE_VERDICTS.filter(verdict => (counts[verdict] || 0) === top);
  return leaders.length > 1 ? "tie" : leaders[0];
}

// What the votes mean for a contact:
// - An admin decision stands; votes are still counted but change nothing.
// - Legitimate or Suspicious in the lead (with enough votes) becomes the verdict.
// - Not sure in the lead, or a tie, needs an admin. A verdict already applied stays: unclear votes
//   never replace a clear one.
// - Otherwise the contact keeps collecting votes.
export function decide(counts, resolution, min = minimumVotes()) {
  const outcome = voteOutcome(counts);
  if (resolution?.by === "admin") return { outcome, status: "resolved", verdict: null };
  if ((outcome === "legitimate" || outcome === "suspicious") && counts.total >= min) return { outcome, status: "resolved", verdict: outcome };
  if (outcome === "not_sure" || outcome === "tie") return { outcome, status: "needs_review", verdict: null };
  return { outcome, status: resolution?.verdict ? "resolved" : "collecting", verdict: null };
}

const findVerifierRecord = (feedback, session) => Verification.findOne(buildVerificationLookupFilter(feedback.type, feedback.value)).sort({ createdAt: -1 }).session(session);

// Writes a verdict to the verifier, so the next lookup returns it.
async function applyVerdict(feedback, verdict, by, session) {
  let record = feedback.verification ? await Verification.findById(feedback.verification).session(session) : null;
  record ||= await findVerifierRecord(feedback, session);
  if (record && by === "community" && record.source !== "community") throw new AppError(409, "This contact is already in the verification database");
  record ||= new Verification({ [feedback.type]: feedback.value });
  record.status = VERIFIER_STATUS[verdict];
  record.source = by === "admin" ? "community_review" : "community";
  await record.save({ session });
  feedback.verification = record._id;
}

// Recounts the contact's votes and applies what they now mean. Always rewrites the feedback
// document, so concurrent transactions on the same contact conflict and retry instead of
// overwriting each other's counts.
async function recalculate(feedback, session, now = new Date()) {
  const rows = await VerificationVote.aggregate([{ $match: { feedback: feedback._id } }, { $group: { _id: "$verdict", count: { $sum: 1 } } }]).session(session);
  const counts = tally(rows), wasReviewing = feedback.status === "needs_review";
  const decision = decide(counts, feedback.resolution);
  Object.assign(feedback, { counts, outcome: decision.outcome, status: decision.status, lastVoteAt: now });
  feedback.firstVoteAt ||= now;
  if (decision.verdict && decision.verdict !== feedback.resolution?.verdict) {
    await applyVerdict(feedback, decision.verdict, "community", session);
    feedback.resolution = { verdict: decision.verdict, by: "community", at: now };
    feedback.history.push({ action: "community_verdict", by: "community", counts, at: now });
  }
  if (decision.status === "needs_review" && !wasReviewing) feedback.history.push({ action: "review_required", by: "community", counts, at: now });
  await feedback.save({ session });
}

async function inTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); }
  finally { await session.endSession(); }
  return result;
}

const duplicateVote = () => new AppError(409, "You have already shared feedback on this");

// One vote per user per contact. Contacts with an admin-entered verifier record take no votes: the
// feedback flow is only offered when the lookup found nothing.
export async function recordVote({ type, value, displayValue, user, verdict }) {
  try {
    return await inTransaction(async session => {
      const record = await findVerifierRecord({ type, value }, session).lean();
      if (record && !COMMUNITY_SOURCES.includes(record.source)) throw new AppError(409, "This contact is already in the verification database");
      const feedback = await VerificationFeedback.findOneAndUpdate({ type, value }, { $setOnInsert: { type, value, displayValue } }, { upsert: true, new: true, session });
      if (await VerificationVote.exists({ feedback: feedback._id, user }).session(session)) throw duplicateVote();
      const [vote] = await VerificationVote.create([{ feedback: feedback._id, user, verdict }], { session });
      await recalculate(feedback, session, vote.createdAt);
      return { vote, feedback };
    });
  } catch (error) {
    // The unique index is the last line of defence when two identical requests race.
    if (error?.code === 11000 && error.keyPattern?.user) throw duplicateVote();
    throw error;
  }
}

// Admin decisions: verify or flag (with a reason) set the verifier record and lock it against later
// votes; keep collecting clears the review flag and leaves any verdict as it is.
export const REVIEW_ACTIONS = { verify: "legitimate", flag: "suspicious", collect: null };
export function reviewFeedback(id, { action, reason, admin }) {
  return inTransaction(async session => {
    const feedback = await VerificationFeedback.findById(id).session(session);
    if (!feedback) throw new AppError(404, "Feedback record not found");
    const now = new Date(), { legitimate, suspicious, not_sure, total } = feedback.counts, counts = { legitimate, suspicious, not_sure, total };
    if (action === "collect") {
      if (feedback.resolution?.by === "admin") throw new AppError(409, "An admin has already decided this contact");
      feedback.status = feedback.resolution?.verdict ? "resolved" : "collecting";
      feedback.history.push({ action: "keep_collecting", by: "admin", admin, reason, counts, at: now });
    } else {
      const verdict = REVIEW_ACTIONS[action];
      await applyVerdict(feedback, verdict, "admin", session);
      feedback.resolution = { verdict, by: "admin", admin, reason, at: now };
      feedback.status = "resolved";
      feedback.history.push({ action: verdict === "legitimate" ? "admin_verified" : "admin_flagged", by: "admin", admin, reason, counts, at: now });
    }
    await feedback.save({ session });
    return feedback;
  });
}
