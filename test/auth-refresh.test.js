import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { refreshToken } from "../controller/auth.controller.js";
import { User } from "../model/user.model.js";

const call = body => new Promise((resolve, reject) => {
  const res = { status(code) { this.code = code; return this; }, json(value) { resolve({ status: this.code, ...value }); } };
  refreshToken({ body }, res, reject);
});
test("refresh accepts a current token and rejects missing, expired, revoked and blocked sessions", async () => {
  const find = User.findById;
  const previous = { access: process.env.JWT_ACCESS_SECRET, refresh: process.env.JWT_REFRESH_SECRET, expires: process.env.JWT_ACCESS_EXPIRES_IN };
  process.env.JWT_ACCESS_SECRET = "refresh-test-access";
  process.env.JWT_REFRESH_SECRET = "refresh-test-secret";
  process.env.JWT_ACCESS_EXPIRES_IN = "15m";
  const id = "507f1f77bcf86cd799439011";
  const token = jwt.sign({ _id: id }, process.env.JWT_REFRESH_SECRET, { expiresIn: "1h" });
  const user = { _id: id, role: "admin", email: "admin@example.test", refreshToken: token, isBlocked: false, verificationInfo: { verified: true } };
  User.findById = async () => user;
  try {
    const response = await call({ refreshToken: token });
    assert.equal(response.status, 200);
    assert.equal(jwt.verify(response.data.accessToken, process.env.JWT_ACCESS_SECRET)._id, id);
    for (const body of [undefined, {}, { refreshToken: "invalid" }, { refreshToken: jwt.sign({ _id: id }, process.env.JWT_REFRESH_SECRET, { expiresIn: -1 }) }]) {
      await assert.rejects(call(body), e => e.statusCode === 401);
    }
    user.refreshToken = "revoked";
    await assert.rejects(call({ refreshToken: token }), e => e.statusCode === 401);
    user.refreshToken = token;
    user.isBlocked = true;
    await assert.rejects(call({ refreshToken: token }), e => e.statusCode === 401);
    user.isBlocked = false;
    user.verificationInfo.verified = false;
    await assert.rejects(call({ refreshToken: token }), e => e.statusCode === 401);
  } finally {
    User.findById = find;
    for (const [key, value] of [["JWT_ACCESS_SECRET", previous.access], ["JWT_REFRESH_SECRET", previous.refresh], ["JWT_ACCESS_EXPIRES_IN", previous.expires]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
