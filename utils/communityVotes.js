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

// Unique users who must vote on a contact before the community decides anything. The vote that
// reaches this number closes voting and the verdict is taken from exactly these votes: nothing is
// decided before it, and no vote is taken after it.
export const REQUIRED_VOTES = 30;

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
// - An admin decision stands; votes never change it.
// - Until `required` users have voted nothing is decided, however one-sided the votes are.
// - Then Legitimate or Suspicious with strictly more votes than each other option becomes the
//   verdict. Not sure in the lead, or a lead shared by two or three options, goes to an admin.
// No percentage threshold applies: only the unique leader counts.
export function decide(counts, resolution, required = REQUIRED_VOTES) {
  const outcome = voteOutcome(counts);
  if (resolution?.by === "admin") return { outcome, status: "resolved", verdict: null, reason: null };
  if ((counts.total || 0) < required) return { outcome, status: "collecting", verdict: null, reason: null };
  if (outcome === "legitimate" || outcome === "suspicious") return { outcome, status: "resolved", verdict: outcome, reason: null };
  return { outcome, status: "needs_review", verdict: null, reason: outcome === "not_sure" ? "not_sure_leads" : "tie" };
}

// Counts the contact's earliest REQUIRED_VOTES votes. Voting closes at that number, so these are all
// of its votes; the limit keeps an evaluation to exactly that many even for records from before it.
export const countVotes = (feedbackId, session) => VerificationVote.aggregate([
  { $match: { feedback: feedbackId } },
  { $sort: { createdAt: 1, _id: 1 } },
  { $limit: REQUIRED_VOTES },
  { $group: { _id: "$verdict", count: { $sum: 1 } } },
]).session(session).then(tally);

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

// Closes community voting with the result of `decision`: a clear verdict goes to the verifier,
// anything else waits for an admin.
async function close(feedback, decision, counts, session, now) {
  feedback.closedAt = now;
  if (decision.verdict) {
    await applyVerdict(feedback, decision.verdict, "community", session);
    feedback.resolution = { verdict: decision.verdict, by: "community", at: now };
    feedback.reviewReason = undefined;
    feedback.history.push({ action: "community_verdict", by: "community", counts, at: now });
  } else {
    feedback.reviewReason = decision.reason;
    feedback.history.push({ action: "review_required", by: "community", counts, at: now });
  }
}

// Recounts the contact's votes after a new one. Only called while the contact is collecting, and
// concurrent votes on a contact are serialized (see recordVote), so exactly one vote reaches
// REQUIRED_VOTES and the evaluation runs once, in the same transaction that stores that vote.
async function recalculate(feedback, session, now = new Date()) {
  const counts = await countVotes(feedback._id, session);
  const decision = decide(counts, feedback.resolution);
  Object.assign(feedback, { counts, outcome: decision.outcome, status: decision.status, lastVoteAt: now });
  feedback.firstVoteAt ||= now;
  if (decision.status !== "collecting") await close(feedback, decision, counts, session, now);
  await feedback.save({ session });
}

export async function inTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try { await session.withTransaction(async () => { result = await work(session); }); }
  finally { await session.endSession(); }
  return result;
}

const duplicateVote = () => new AppError(409, "You have already shared feedback on this");
const votingClosed = () => new AppError(409, "Feedback on this has closed. Check it again to see the latest result.");
const isDuplicateKey = (error, field) => error?.code === 11000 && Boolean(error.keyPattern?.[field]);

// One vote per user per contact, taken only while the contact is collecting. Contacts with an
// admin-entered verifier record take no votes: the feedback flow is only offered when the lookup
// found nothing.
export async function recordVote({ type, value, displayValue, user, verdict }, attempt = 1) {
  try {
    return await inTransaction(async session => {
      const record = await findVerifierRecord({ type, value }, session).lean();
      if (record && !COMMUNITY_SOURCES.includes(record.source)) throw new AppError(409, "This contact is already in the verification database");
      // Writing to the contact's feedback document first takes its lock for this transaction, so two
      // votes on one contact can never both count from the same total: the later one hits a write
      // conflict and withTransaction retries it against the committed result, where it may find
      // voting closed.
      const now = new Date();
      const feedback = await VerificationFeedback.findOneAndUpdate({ type, value }, { $setOnInsert: { type, value, displayValue }, $set: { lastVoteAt: now } }, { upsert: true, new: true, session });
      if (await VerificationVote.exists({ feedback: feedback._id, user }).session(session)) throw duplicateVote();
      if (feedback.status !== "collecting" || feedback.resolution?.by === "admin" || feedback.counts.total >= REQUIRED_VOTES) throw votingClosed();
      const [vote] = await VerificationVote.create([{ feedback: feedback._id, user, verdict }], { session });
      await recalculate(feedback, session, vote.createdAt);
      return { vote, feedback };
    });
  } catch (error) {
    // The unique index is the last line of defence when two identical requests race.
    if (isDuplicateKey(error, "user")) throw duplicateVote();
    // Two first votes on a new contact can race to create its feedback record; the loser retries
    // and votes on the record the winner created.
    if (isDuplicateKey(error, "value") && attempt < 3) return recordVote({ type, value, displayValue, user, verdict }, attempt + 1);
    throw error;
  }
}

// Admin decisions: verify or flag (with a reason) set the verifier record and are final: community
// voting closes and neither votes nor the community evaluation change them. hold keeps a contact the
// closed vote sent for review pending a later decision.
export const REVIEW_ACTIONS = { verify: "legitimate", flag: "suspicious", hold: null };
export function reviewFeedback(id, { action, reason, admin }) {
  return inTransaction(async session => {
    const feedback = await VerificationFeedback.findById(id).session(session);
    if (!feedback) throw new AppError(404, "Feedback record not found");
    const now = new Date(), { legitimate, suspicious, not_sure, total } = feedback.counts, counts = { legitimate, suspicious, not_sure, total };
    if (action === "hold") {
      if (feedback.status !== "needs_review") throw new AppError(409, "Only a contact awaiting review can be kept pending");
      feedback.history.push({ action: "kept_pending", by: "admin", admin, reason, counts, at: now });
    } else {
      const verdict = REVIEW_ACTIONS[action];
      await applyVerdict(feedback, verdict, "admin", session);
      feedback.resolution = { verdict, by: "admin", admin, reason, at: now };
      feedback.status = "resolved";
      feedback.closedAt ||= now;
      feedback.history.push({ action: verdict === "legitimate" ? "admin_verified" : "admin_flagged", by: "admin", admin, reason, counts, at: now });
    }
    await feedback.save({ session });
    return feedback;
  });
}

// Removes a community verdict from the verifier. Only records the votes wrote are removed.
async function withdrawVerdict(feedback, session) {
  const record = feedback.verification ? await Verification.findById(feedback.verification).session(session) : await findVerifierRecord(feedback, session);
  if (record?.source === "community") await record.deleteOne({ session });
  feedback.resolution = undefined;
  feedback.verification = undefined;
}

// Brings a contact recorded before the consensus threshold in line with it (see
// scripts/migrate-community-consensus.js). A community verdict or review reached with fewer than
// REQUIRED_VOTES votes is withdrawn and the contact collects votes again; a contact that already
// has REQUIRED_VOTES votes is evaluated on its earliest REQUIRED_VOTES. Admin decisions are never
// touched. Returns "reset", "closed" or "unchanged".
export async function reconcileFeedback(id, session, now = new Date()) {
  const feedback = await VerificationFeedback.findById(id).session(session);
  if (!feedback || feedback.resolution?.by === "admin") return "unchanged";
  const counts = await countVotes(feedback._id, session);
  const decision = decide(counts, null);
  const verdictStale = Boolean(feedback.resolution?.verdict) && feedback.resolution.verdict !== decision.verdict;
  const stateStale = feedback.status !== decision.status
    || (decision.verdict && feedback.resolution?.verdict !== decision.verdict)
    || (decision.status === "needs_review" && feedback.reviewReason !== decision.reason);
  const countsStale = VOTE_VERDICTS.some(verdict => feedback.counts[verdict] !== counts[verdict]) || feedback.counts.total !== counts.total;
  if (!verdictStale && !stateStale && !countsStale) return "unchanged";

  if (verdictStale) await withdrawVerdict(feedback, session);
  Object.assign(feedback, { counts, outcome: decision.outcome, status: decision.status });
  if (!verdictStale && !stateStale) { await feedback.save({ session }); return "unchanged"; }
  let result;
  if (decision.status === "collecting") {
    feedback.closedAt = undefined;
    feedback.reviewReason = undefined;
    feedback.history.push({ action: "consensus_reset", by: "community", counts, at: now });
    result = "reset";
  } else {
    await close(feedback, decision, counts, session, now);
    result = "closed";
  }
  await feedback.save({ session });
  return result;
}
