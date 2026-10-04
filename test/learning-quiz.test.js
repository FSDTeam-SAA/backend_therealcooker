import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuestions, gradeAnswers } from "../utils/learningQuiz.js";
import { Learning } from "../model/learning.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { getQuiz, submitAttempt, getMyAttempts } from "../controller/learning-attempt.controller.js";
import { toPublicLearningDto } from "../controller/learning.controller.js";
import { updateLearning } from "../controller/learning.controller.js";
import { User } from "../model/user.model.js";
import jwt from "jsonwebtoken";
import learningRouter from "../route/learning.route.js";
import adminRouter from "../route/admin.route.js";
import materialRouter from "../route/learning-material.route.js";

const questions = normalizeQuestions([{ question: "Pick B", options: ["A", "B", "C", "D"].map(id => ({ id, text: id })), correctOptionId: "B", explanation: "B is correct" }]);
const learningId = "507f1f77bcf86cd799439011";
const userId = "507f1f77bcf86cd799439012";
const call = (handler, req) => new Promise((resolve, reject) => {
  let status;
  const res = { status(code) { status = code; return res; }, json(body) { resolve({ status, ...body }); } };
  handler(req, res, reject);
});
test("validates four options, IDs and answer keys before saving", () => {
  assert.throws(() => normalizeQuestions("bad json"), /JSON/);
  assert.throws(() => normalizeQuestions([{ ...questions[0], options: questions[0].options.slice(1) }]), /four options/);
  assert.throws(() => normalizeQuestions([{ ...questions[0], correctOptionId: "E" }]), /correct option/);
  assert.throws(() => normalizeQuestions([questions[0], questions[0]]), /duplicate/);
  assert.deepEqual(normalizeQuestions([]), []);
});
test("grades server-side and rejects incomplete, unknown and duplicate answers", () => {
  const answer = { questionId: questions[0]._id, optionId: "B" };
  assert.equal(gradeAnswers(questions, [answer])[0].isCorrect, true);
  assert.equal(gradeAnswers(questions, [{ ...answer, optionId: "A" }])[0].isCorrect, false);
  assert.throws(() => gradeAnswers(questions, []), /every question/);
  assert.throws(() => gradeAnswers(questions, [{ ...answer, questionId: learningId }]), /Invalid/);
  assert.throws(() => gradeAnswers(questions, [{ ...answer, optionId: "E" }]), /Invalid/);
  const two = normalizeQuestions([questions[0], { ...questions[0], _id: learningId }]);
  assert.throws(() => gradeAnswers(two, [answer, answer]), /duplicate/);
});
test("quiz response hides keys and explanations, and public content only adds quiz metadata", async () => {
  const original = Learning.findOne;
  Learning.findOne = async filter => {
    assert.equal(filter.isPublished, true);
    return { _id: learningId, questions, quizVersion: 2 };
  };
  try {
    const result = await call(getQuiz, { params: { id: learningId } });
    assert.equal(result.data.quizVersion, 2);
    assert.equal(JSON.stringify(result.data).includes("correctOptionId"), false);
    assert.equal(JSON.stringify(result.data).includes("explanation"), false);
    const dto = toPublicLearningDto({ _id: learningId, questions }, { protocol: "https", get: () => "example.com" });
    assert.equal(dto.mcq_count, 1);
    assert.equal(dto.questions, undefined);
  } finally { Learning.findOne = original; }
});
test("submission rejects stale quizzes, trusts authenticated user and preserves snapshots", async () => {
  const originalFind = Learning.findOne;
  const originalCreate = LearningAttempt.create;
  Learning.findOne = async () => ({ _id: learningId, title: "Lesson", questions, quizVersion: 2 });
  LearningAttempt.create = async value => value;
  const req = { params: { id: learningId }, user: { _id: userId }, body: { quizVersion: 1, user: "spoofed", score: 100, answers: [{ questionId: questions[0]._id, optionId: "B" }] } };
  try {
    await assert.rejects(call(submitAttempt, req), e => e.statusCode === 409);
    req.body.quizVersion = 2;
    const result = await call(submitAttempt, req);
    assert.equal(result.status, 201);
    assert.equal(result.data.user, userId);
    assert.equal(result.data.score, 1);
    questions[0].question = "Edited later";
    assert.equal(result.data.answers[0].question, "Pick B");
  } finally { Learning.findOne = originalFind; LearningAttempt.create = originalCreate; }
});
test("user history query is scoped to authenticated user", async () => {
  const count = LearningAttempt.countDocuments;
  const find = LearningAttempt.find;
  LearningAttempt.countDocuments = async filter => { assert.equal(filter.user, userId); return 0; };
  LearningAttempt.find = filter => {
    assert.equal(filter.user, userId);
    const query = { sort: () => query, skip: () => query, limit: () => Promise.resolve([]) };
    return query;
  };
  try {
    const result = await call(getMyAttempts, { params: { id: learningId }, user: { _id: userId }, query: { user: "spoofed" } });
    assert.equal(result.data.pagination.total, 0);
  } finally { LearningAttempt.countDocuments = count; LearningAttempt.find = find; }
});
test("quiz edits increment version while unchanged questions preserve version", async () => {
  const find = Learning.findById;
  const document = new Learning({ title: "Lesson", description: "Content", questions, quizVersion: 2 });
  document.save = async () => document;
  Learning.findById = async () => document;
  try {
    const body = { questions: JSON.stringify(document.questions.map(q => q.toObject())) };
    await call(updateLearning, { params: { id: learningId }, body });
    assert.equal(document.quizVersion, 2);
    const edited = JSON.parse(body.questions);
    edited[0].correctOptionId = "A";
    await call(updateLearning, { params: { id: learningId }, body: { questions: edited } });
    assert.equal(document.quizVersion, 3);
    await call(updateLearning, { params: { id: learningId }, body: { description: "New content" } });
    assert.equal(document.quizVersion, 3);
    assert.equal(document.questions.length, 1);
    await call(updateLearning, { params: { id: learningId }, body: { questions: [] } });
    assert.equal(document.quizVersion, 4);
    assert.equal(document.questions.length, 0);
  } finally { Learning.findById = find; }
});
test("routers deny anonymous quiz submissions and non-admin access to answer keys and other users' answers", async () => {
  const find = User.findById;
  const verified = User.isOTPVerified;
  const secret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "local-quiz-route-test";
  User.findById = async () => ({ _id: userId, role: "user" });
  User.isOTPVerified = async () => true;
  const token = jwt.sign({ _id: userId }, process.env.JWT_ACCESS_SECRET);
  const denied = (router, method, url, authorization) => new Promise(resolve => router.handle({ method, url, headers: authorization ? { authorization } : {} }, {}, resolve));
  try {
    assert.equal((await denied(materialRouter, "POST", `/${learningId}/attempts`)).statusCode, 404);
    assert.equal((await denied(learningRouter, "GET", "/", `Bearer ${token}`)).statusCode, 403);
    assert.equal((await denied(learningRouter, "GET", `/${learningId}`, `Bearer ${token}`)).statusCode, 403);
    assert.equal((await denied(adminRouter, "GET", `/learning-attempts/${learningId}`, `Bearer ${token}`)).statusCode, 403);
  } finally {
    User.findById = find;
    User.isOTPVerified = verified;
    if (secret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = secret;
  }
});
