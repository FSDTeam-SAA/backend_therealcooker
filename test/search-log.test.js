import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { User } from "../model/user.model.js";
import { Verification } from "../model/verification.model.js";
import { OperationEvent } from "../model/operation.model.js";
import { VerificationFeedback } from "../model/verificationFeedback.model.js";
import { optionalAuth } from "../middleware/auth.middleware.js";
import { checkVerification } from "../controller/verification.controller.js";
import { maskSearchValue } from "../utils/maskSearchValue.js";

process.env.JWT_ACCESS_SECRET ||= "test-access-secret";
const userId = "507f1f77bcf86cd799439011";
const run = (middleware, headers = {}) => new Promise(resolve => { const req = { headers }; middleware(req, {}, () => resolve(req)); });

test("searched values are stored partly hidden, websites as host only", () => {
  assert.equal(maskSearchValue("email", "john.doe@gmail.com"), "jo•••@gmail.com");
  assert.equal(maskSearchValue("phone", "27119990000"), "271•••••0000");
  assert.equal(maskSearchValue("account", "123456789"), "••••6789");
  assert.equal(maskSearchValue("website", "safe.example.com/login/reset"), "safe.example.com");
  assert.equal(maskSearchValue("email", "nonsense"), "•••");
});

test("optional auth attaches a valid user and never rejects anonymous or bad tokens", async () => {
  const original = User.findById;
  User.findById = async id => id === userId ? { _id: userId, verificationInfo: { verified: true }, isBlocked: false } : null;
  try {
    assert.equal((await run(optionalAuth)).user, undefined);
    assert.equal((await run(optionalAuth, { authorization: "Bearer not-a-jwt" })).user, undefined);
    const expired = jwt.sign({ _id: userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 });
    assert.equal((await run(optionalAuth, { authorization: `Bearer ${expired}` })).user, undefined);
    const valid = jwt.sign({ _id: userId }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" });
    assert.equal((await run(optionalAuth, { authorization: `Bearer ${valid}` })).user._id, userId);
    User.findById = async () => ({ _id: userId, verificationInfo: { verified: true }, isBlocked: true });
    assert.equal((await run(optionalAuth, { authorization: `Bearer ${valid}` })).user, undefined, "blocked users are not attached");
  } finally { User.findById = original; }
});

test("a search records the type, result, user and masked value, and the response is unchanged", async () => {
  const state = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  const originals = { findOne: Verification.findOne, create: OperationEvent.create, feedback: VerificationFeedback.findOne };
  VerificationFeedback.findOne = () => ({ select() { return this; }, lean: async () => null });
  const recorded = [];
  OperationEvent.create = async data => { recorded.push(data); return data; };
  Verification.findOne = () => ({ sort() { return this; }, lean: async () => null });
  try {
    const body = await new Promise((resolve, reject) => {
      const res = { status() { return this; }, json: resolve };
      checkVerification({ body: { type: "phone", value: "+27 11 999 0000" }, query: {}, user: { _id: userId } }, res, reject);
    });
    assert.equal(body.status, "not_found"); assert.equal(body.data.value, "27119990000");
    assert.deepEqual({ ...recorded[0] }, { kind: "verification_lookup", tool: "phone", outcome: "not_found", source: "moneykee", user: userId, maskedValue: "271•••••0000" });
    assert.ok(!JSON.stringify(recorded).includes("27119990000"), "the full value is never stored");
    assert.deepEqual(body.data.feedback, { yourVote: null }, "a user who has not voted can give feedback");
  } finally {
    Verification.findOne = originals.findOne; OperationEvent.create = originals.create; VerificationFeedback.findOne = originals.feedback;
    state ? Object.defineProperty(mongoose.connection, "readyState", state) : delete mongoose.connection.readyState;
  }
});
