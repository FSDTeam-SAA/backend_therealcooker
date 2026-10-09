import test from "node:test";
import assert from "node:assert/strict";
import { User } from "../model/user.model.js";
import { SecurityAlert, SupportCase, OperationEvent, AvailabilitySample, LearningProgress } from "../model/operation.model.js";
import { Account } from "../model/account.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { can, routePermission } from "../utils/adminPermissions.js";
import { reportingWindow, dateFilter, trendRows, percent } from "../utils/reporting.js";
import { updateAlert, updateCase, listEvents, updateStaffRole, getOverview } from "../controller/operations.controller.js";
import { isAdmin } from "../middleware/auth.middleware.js";

const operator = { _id: "507f1f77bcf86cd799439011", role: "admin", adminRole: "operations" };
const call = (handler, body, extra = {}) => new Promise((resolve, reject) => {
  const res = { status(code) { this.code = code; return this; }, json(value) { resolve({ status: this.code, ...value }); } };
  handler({ user: operator, params: { id: "507f1f77bcf86cd799439012" }, query: {}, body, ...extra }, res, reject);
});
test("user serialization never returns password hashes, plaintext, OTPs or KYC raw payloads", () => {
  const user = new User({ email: "person@example.test", password: "hash", refreshToken: "refresh", password_reset_token: "reset", verificationInfo: { verified: true, token: "1234" }, kyc: { raw: { sensitive: true }, status: "completed" } });
  user.set("textPassword", "plaintext", { strict: false });
  for (const value of [user.toObject(), user.toJSON()]) {
    for (const field of ["password", "textPassword", "refreshToken", "password_reset_token", "adminRole"]) assert.equal(value[field], undefined);
    assert.deepEqual(value.verificationInfo, { verified: true }); assert.equal(value.kyc.raw, undefined);
  }
});
test("permissions enforce sensitive data and write boundaries, including legacy admin compatibility", () => {
  assert.equal(can({ role: "admin" }, "staff:write"), true);
  assert.equal(can({ role: "user", adminRole: "superadmin" }, "users:read"), false);
  assert.equal(can({ ...operator, adminRole: "analyst" }, "users:read"), false);
  assert.equal(can({ ...operator, adminRole: "support" }, "cases:write"), true);
  assert.equal(can(operator, "staff:write"), false);
  const req = { user: { ...operator, adminRole: "analyst" }, method: "GET", baseUrl: "/api/v1/admin", path: "/users/1/overview" };
  assert.equal(routePermission(req), "users:read");
  assert.throws(() => isAdmin(req, {}, () => assert.fail("access should be denied")), /does not permit/);
  assert.equal(routePermission({ ...req, path: "/dashboard/recent-users" }), "users:read");
  assert.equal(routePermission({ ...req, path: "/audit" }), "audit:read");
  assert.equal(routePermission({ ...req, path: "/learnings/1/attempts" }), "learning:results");
  assert.equal(can(req.user, "learning:results"), false);
});
test("reports validate dates and fill missing daily buckets across year boundaries", () => {
  const window = reportingWindow({ days: 7 }, new Date("2027-01-02T12:00:00Z"));
  assert.equal(window.start.toISOString(), "2026-12-27T00:00:00.000Z");
  assert.throws(() => reportingWindow({ days: 500 }), /days/);
  assert.throws(() => dateFilter({ from: "bad" }), /Invalid/);
  assert.throws(() => dateFilter({ from: "2027-01-01", to: "2026-01-01" }), /precede/);
  const rows = trendRows(window.start, window.end, { users: [{ _id: "2027-01-01", count: 4 }] });
  assert.equal(rows.length, 7); assert.equal(rows[5].users, 4); assert.equal(rows[0].users, 0);
  assert.equal(percent(1, 3), 33.3); assert.equal(percent(0, 0), 0);
});
test("alert resolution requires a reason and stores first operator action, verdict and resolution", async () => {
  const original = SecurityAlert.findById;
  const alert = { status: "open", save: async () => {} };
  SecurityAlert.findById = async () => alert;
  try {
    await assert.rejects(call(updateAlert, { status: "resolved" }), /Reason/);
    const response = await call(updateAlert, { status: "resolved", verdict: "false_positive", reason: "User confirmed safe", resolution: "Reviewed with user" });
    assert.equal(response.data.status, "resolved"); assert.equal(alert.verdict, "false_positive");
    assert.equal(alert.resolution, "Reviewed with user"); assert.ok(alert.firstActionAt); assert.ok(alert.resolvedAt);
    await call(updateAlert, { status: "open", reason: "Further review" }); assert.equal(alert.resolvedAt, undefined);
  } finally { SecurityAlert.findById = original; }
});
test("case resolution cannot be saved without an explanation", async () => {
  const original = SupportCase.findById;
  SupportCase.findById = async () => ({ status: "open", notes: [], save: async () => {} });
  try {
    await assert.rejects(call(updateCase, { status: "resolved" }), /Resolution/);
    const response = await call(updateCase, { status: "resolved", resolution: "Confirmed account secure", note: "Called user" });
    assert.equal(response.data.resolvedBy, operator._id); assert.equal(response.data.notes.length, 1);
  } finally { SupportCase.findById = original; }
});
test("staff role editor cannot demote its own account", async () => {
  await assert.rejects(call(updateStaffRole, { adminRole: "analyst", reason: "Review" }, { params: { id: operator._id } }), /own admin role/);
});
test("analyst event queries project out identifiers and never populate users", async () => {
  const find = OperationEvent.find, count = OperationEvent.countDocuments; let projection;
  const query = { sort() { return this; }, skip() { return this; }, limit() { return this; }, select(fields) { projection = fields; return this; }, populate() { assert.fail("analyst must not populate identities"); }, lean: async () => [] };
  OperationEvent.find = () => query; OperationEvent.countDocuments = async () => 0;
  try {
    await call(listEvents, {}, { user: { ...operator, adminRole: "analyst" } });
    assert.equal(projection.includes("user"), false); assert.equal(projection.includes("entityId"), false);
  } finally { OperationEvent.find = find; OperationEvent.countDocuments = count; }
});

test("overview combines database aggregates, separates verification types and zero-fills trends", async () => {
  const restore = [];
  const stub = (model, method, fn) => { const original = model[method]; model[method] = fn; restore.push(() => model[method] = original); };
  const date = new Date().toISOString().slice(0, 10);
  stub(User, "countDocuments", async filter => { assert.equal(filter.role, "user"); return filter["kyc.status"] ? 2 : filter["verificationInfo.verified"] ? 3 : 4; });
  stub(User, "aggregate", async pipeline => {
    if (pipeline.some(stage => stage.$bucket)) return [{ _id: 25, count: 2 }];
    if (pipeline.some(stage => stage.$limit)) return [{ _id: "Engineer", count: 2 }];
    return [{ _id: date, count: 2 }];
  });
  stub(Account, "countDocuments", async () => 6);
  stub(Account, "distinct", async () => ["user1", "user2"]);
  stub(Account, "aggregate", async pipeline => {
    if (pipeline.some(stage => stage.$bucket)) return [{ _id: 1, users: 2 }];
    if (pipeline.some(stage => stage.$count)) return [{ count: 2 }];
    return [{ bank: "Example Bank", users: 2, accounts: 6 }];
  });
  stub(OperationEvent, "distinct", async () => ["user1"]);
  stub(OperationEvent, "countDocuments", async () => 1);
  stub(OperationEvent, "aggregate", async pipeline => {
    const group = pipeline.find(stage => stage.$group)?.$group;
    return typeof group?._id === "string" ? [{ _id: group._id === "$tool" ? "phone" : group._id === "$outcome" ? "sos" : "moneykee", count: 5 }] : [{ _id: date, count: 1 }];
  });
  stub(OperationEvent, "findOne", () => ({ sort() { return this; }, select() { return this; }, lean: async () => ({ occurredAt: new Date() }) }));
  stub(SecurityAlert, "countDocuments", async () => 1);
  stub(SecurityAlert, "aggregate", async pipeline => {
    const group = pipeline.find(stage => stage.$group)?.$group;
    return group?.averageMs ? [{ averageMs: 120000, count: 1 }] : group?._id === "$severity" ? [{ _id: "critical", count: 1 }] : [{ _id: date, count: 1 }];
  });
  stub(SupportCase, "countDocuments", async () => 1);
  stub(SupportCase, "aggregate", async () => [{ _id: date, count: 1 }]);
  stub(LearningProgress, "aggregate", async () => [{ started: 5, completed: 3, averageDurationMs: 60000, additionalUsers: [null, "user1"] }]);
  stub(LearningAttempt, "aggregate", async () => [{ _id: "lesson", title: "Safety", users: 1, attempts: 2 }]);
  stub(LearningAttempt, "countDocuments", async () => 2);
  stub(AvailabilitySample, "aggregate", async () => [{ _id: "moneykee", samples: 10, healthy: 9, lastCheckedAt: new Date() }]);
  try {
    const response = await call(getOverview, {}, { query: { days: "7" } });
    const data = response.data;
    assert.equal(data.users.total, 4); assert.equal(data.users.emailVerifiedPercent, 75); assert.equal(data.users.kycVerified, 2);
    assert.equal(data.accounts.bankLinkedPercent, 50); assert.equal(data.trends.length, 7); assert.equal(data.trends[6].newUsers, 2); assert.equal(data.trends[0].newUsers, 0);
    assert.equal(data.alerts.averageResponseMs, 120000); assert.equal(data.learning.incomplete, 2); assert.equal(data.learning.additionalQuestionUsers, 1);
    assert.equal(data.availability[0].percent, 90); assert.equal(data.verification.usage[0]._id, "phone");
    assert.deepEqual(data.users.profiles.ages, [{ label: "25-34", count: 2 }]);
    assert.deepEqual(data.users.profiles.accountCounts, [{ label: "0", users: 2 }, { label: "1", users: 2 }]);
    assert.equal(data.panics.byType[0].label, "sos");
  } finally { restore.reverse().forEach(fn => fn()); }
});
