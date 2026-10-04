import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { protect } from "../middleware/auth.middleware.js";
import { User } from "../model/user.model.js";

test("authentication distinguishes expired credentials, invalid sessions and database failures", async () => {
  const find = User.findById;
  const secret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "middleware-test-secret";
  const id = "507f1f77bcf86cd799439011";
  const token = jwt.sign({ _id: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "1h" });
  const req = authorization => ({ headers: authorization ? { authorization } : {} });
  const user = { _id: id, isBlocked: false, verificationInfo: { verified: true } };
  User.findById = async () => user;
  try {
    await assert.rejects(protect(req(), {}, () => {}), e => e.statusCode === 401);
    await assert.rejects(protect(req("Basic " + token), {}, () => {}), e => e.statusCode === 401);
    const expired = jwt.sign({ _id: id }, process.env.JWT_ACCESS_SECRET, { expiresIn: -1 });
    await assert.rejects(protect(req("Bearer " + expired), {}, () => {}), e => e.statusCode === 401 && /expired/.test(e.message));
    const validRequest = req("Bearer " + token);
    let passed = false;
    await protect(validRequest, {}, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(validRequest.user, user);
    user.isBlocked = true;
    await assert.rejects(protect(req("Bearer " + token), {}, () => {}), e => e.statusCode === 401);
    user.isBlocked = false;
    const dbError = new Error("Database unavailable");
    User.findById = async () => { throw dbError; };
    await assert.rejects(protect(req("Bearer " + token), {}, () => {}), e => e === dbError);
  } finally {
    User.findById = find;
    if (secret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = secret;
  }
});
