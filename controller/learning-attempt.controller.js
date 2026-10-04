import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { Learning } from "../model/learning.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { User } from "../model/user.model.js";
import { gradeAnswers } from "../utils/learningQuiz.js";

const validId = id => {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, "Invalid ID");
  return id;
};
const respond = (res, data, statusCode = 200) => sendResponse(res, { statusCode, success: true, message: "Learning quiz request successful", data });
async function published(id) {
  const learning = await Learning.findOne({ _id: validId(id), isPublished: true });
  if (!learning) throw new AppError(404, "Learning material not found");
  return learning;
}
export const getQuiz = catchAsync(async (req, res) => {
  const learning = await published(req.params.id);
  respond(res, { learningId: learning._id, quizVersion: learning.quizVersion || 1, questions: learning.questions.map(q => ({ _id: q._id, question: q.question, options: q.options.map(o => ({ id: o.id, text: o.text })) })) });
});
export const submitAttempt = catchAsync(async (req, res) => {
  const learning = await published(req.params.id);
  if (req.body.quizVersion !== (learning.quizVersion || 1)) throw new AppError(409, "Quiz changed. Reload the quiz before submitting");
  const answers = gradeAnswers(learning.questions, req.body.answers);
  const attempt = await LearningAttempt.create({ user: req.user._id, learning: learning._id, learningTitle: learning.title, quizVersion: learning.quizVersion || 1, answers, score: answers.filter(a => a.isCorrect).length, totalQuestions: answers.length });
  respond(res, attempt, 201);
});
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
async function list(req, res, filter, admin) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  if (admin && typeof req.query.search === "string" && req.query.search.trim()) {
    const pattern = { $regex: escapeRegex(req.query.search.trim()), $options: "i" };
    const users = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select("_id");
    filter.user = { $in: users.map(u => u._id) };
  }
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    for (const [key, operator] of [["from", "$gte"], ["to", "$lte"]]) {
      if (req.query[key]) {
        const date = new Date(req.query[key]);
        if (Number.isNaN(date.getTime())) throw new AppError(400, "Invalid date filter");
        if (key === "to" && /^\d{4}-\d{2}-\d{2}$/.test(req.query[key])) date.setUTCHours(23, 59, 59, 999);
        filter.createdAt[operator] = date;
      }
    }
  }
  const query = LearningAttempt.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit);
  if (admin) query.select("-answers").populate("user", "name email");
  const [total, attempts, stats] = await Promise.all([
    LearningAttempt.countDocuments(filter), query,
    admin ? LearningAttempt.aggregate([
      { $match: { ...filter, learning: new mongoose.Types.ObjectId(filter.learning) } },
      { $group: { _id: null, users: { $addToSet: "$user" }, averageScore: { $avg: { $multiply: [{ $divide: ["$score", "$totalQuestions"] }, 100] } } } },
      { $project: { _id: 0, uniqueUsers: { $size: "$users" }, averageScore: 1 } },
    ]) : [],
  ]);
  respond(res, { attempts, summary: admin ? { totalAttempts: total, uniqueUsers: stats[0]?.uniqueUsers || 0, averageScore: stats[0]?.averageScore || 0 } : undefined, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } });
}
export const getMyAttempts = catchAsync(async (req, res) => list(req, res, { learning: validId(req.params.id), user: req.user._id }, false));
export const getAdminAttempts = catchAsync(async (req, res) => list(req, res, { learning: validId(req.params.id) }, true));
export const getUserAttempts = catchAsync(async (req, res) => list(req, res, { user: validId(req.params.userId) }, false));
export const getAttemptDetails = catchAsync(async (req, res) => {
  const attempt = await LearningAttempt.findById(validId(req.params.attemptId)).populate("user", "name email");
  if (!attempt) throw new AppError(404, "Attempt not found");
  respond(res, attempt);
});
