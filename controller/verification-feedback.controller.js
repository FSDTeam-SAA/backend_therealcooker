import mongoose from "mongoose";
import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { VerificationFeedback, VerificationVote, VOTE_VERDICTS } from "../model/verificationFeedback.model.js";
import { LOOKUP_TYPES, normalizeVerificationValue, validateLookupValue } from "./verification.controller.js";
import { recordVote, reviewFeedback, REVIEW_ACTIONS, REQUIRED_VOTES } from "../utils/communityVotes.js";
import { DAY, escapeRegex, pageOptions } from "../utils/reporting.js";
import { reportingPeriod } from "../utils/reportingPeriods.js";

const respond = (res, data, message = "Feedback fetched successfully", statusCode = httpStatus.OK) => sendResponse(res, { statusCode, success: true, message, data });
const validId = id => { if (!mongoose.isValidObjectId(id)) throw new AppError(httpStatus.BAD_REQUEST, "Invalid ID"); return id; };

// App users: one vote on a contact the verifier had no record of, while it is still collecting votes.
// The value is normalized like the lookup, so every way of typing the same contact counts toward one
// record. The response says whether this vote closed voting, never how others voted.
export const submitFeedback = catchAsync(async (req, res) => {
  const type = String(req.body?.type ?? "").trim().toLowerCase();
  if (!LOOKUP_TYPES.has(type)) throw new AppError(httpStatus.BAD_REQUEST, "Type must be one of: email, phone, account, website");
  const verdict = String(req.body?.verdict ?? "").trim().toLowerCase();
  if (!VOTE_VERDICTS.includes(verdict)) throw new AppError(httpStatus.BAD_REQUEST, "Verdict must be one of: legitimate, suspicious, not_sure");
  const rawValue = req.body?.value;
  const value = normalizeVerificationValue(rawValue, type);
  validateLookupValue(value, type, rawValue);

  const { vote, feedback } = await recordVote({ type, value, displayValue: String(rawValue).trim().slice(0, 200), user: req.user._id, verdict });
  respond(res, { type, value, verdict: vote.verdict, submittedAt: vote.createdAt, status: feedback.status }, "Thanks, your feedback was recorded", httpStatus.CREATED);
});

const STATUSES = ["collecting", "needs_review", "resolved"];

export const listFeedback = catchAsync(async (req, res) => {
  const filter = {};
  if (LOOKUP_TYPES.has(req.query.type)) filter.type = req.query.type;
  if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    const pattern = { $regex: escapeRegex(req.query.search.trim()), $options: "i" };
    filter.$or = [{ value: pattern }, { displayValue: pattern }];
  }
  const { page, limit, skip } = pageOptions(req.query);
  const now = new Date(), week = reportingPeriod({ period: "week" }, now);
  const [items, total, contacts, votesThisWeek, awaitingReview, markedScam] = await Promise.all([
    VerificationFeedback.find(filter).sort({ lastVoteAt: -1, _id: -1 }).skip(skip).limit(limit).select("-history").populate("verification", "status source").lean(),
    VerificationFeedback.countDocuments(filter),
    VerificationFeedback.countDocuments(),
    VerificationVote.countDocuments({ createdAt: { $gte: week.start } }),
    VerificationFeedback.countDocuments({ status: "needs_review" }),
    VerificationFeedback.countDocuments({ "resolution.verdict": "suspicious", "resolution.at": { $gte: new Date(now - 30 * DAY) } }),
  ]);
  respond(res, {
    items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    summary: { contacts, votesThisWeek, weekLabel: week.label, awaitingReview, markedScam },
    requiredVotes: REQUIRED_VOTES,
  });
});

// Votes are listed without voters: the app tells users their feedback is anonymous.
export const getFeedback = catchAsync(async (req, res) => {
  const id = validId(req.params.id);
  const [feedback, votes] = await Promise.all([
    VerificationFeedback.findById(id).populate("verification", "status source updatedAt").populate("resolution.admin", "name email").populate("history.admin", "name email").lean(),
    VerificationVote.find({ feedback: id }).sort({ createdAt: -1 }).limit(100).select("verdict createdAt").lean(),
  ]);
  if (!feedback) throw new AppError(httpStatus.NOT_FOUND, "Feedback record not found");
  respond(res, { ...feedback, history: [...feedback.history].reverse(), votes: votes.map(vote => ({ id: vote._id, verdict: vote.verdict, createdAt: vote.createdAt })), requiredVotes: REQUIRED_VOTES });
});

export const reviewFeedbackDecision = catchAsync(async (req, res) => {
  const id = validId(req.params.id);
  const action = req.body?.action;
  if (!Object.hasOwn(REVIEW_ACTIONS, action)) throw new AppError(httpStatus.BAD_REQUEST, "Action must be one of: verify, flag, hold");
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (action !== "hold" && !reason) throw new AppError(httpStatus.BAD_REQUEST, "Give a short reason for this decision");
  if (reason.length > 2000) throw new AppError(httpStatus.BAD_REQUEST, "Reason must be 2000 characters or fewer");
  const feedback = await reviewFeedback(id, { action, reason: reason || undefined, admin: req.user._id });
  respond(res, feedback, action === "hold" ? "The contact stays pending review" : "Decision saved");
});
