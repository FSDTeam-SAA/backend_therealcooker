import test from "node:test";
import assert from "node:assert/strict";
import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { Notification } from "../model/notification.model.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { SecurityAlert, OperationEvent, AvailabilitySample, LearningProgress, IntegrationMetric, ServerMetricSample } from "../model/operation.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { Learning } from "../model/learning.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { VerificationFeedback } from "../model/verificationFeedback.model.js";
import { learningOverview, guardianAlerts, completionMilestones } from "../utils/dashboardMetrics.js";
import { getExecutiveDashboard, getDashboardStatus, getAnalyticsReport, getAnalyticsPdf } from "../controller/dashboard.controller.js";
import { buildAnalyticsReport } from "../utils/analyticsReport.js";
import { renderAnalyticsPdf } from "../utils/analyticsPdf.js";
import { routePermission, can } from "../utils/adminPermissions.js";

const call = (handler, adminRole, query = {}) => new Promise((resolve, reject) => {
  const headers = {};
  const res = { status(code) { this.code = code; return this; }, json(value) { resolve(value.data); }, setHeader(name, value) { headers[name] = value; }, end(body) { resolve({ headers, body }); } };
  handler({ user: { _id: "507f1f77bcf86cd799439011", role: "admin", adminRole }, params: {}, query, body: {} }, res, reject);
});
const chain = value => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, populate() { return this; }, lean: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });

function stubAll(stubs = []) {
  const restore = [];
  const stub = (model, method, fn) => { const original = model[method]; model[method] = fn; restore.push(() => { model[method] = original; }); };
  for (const model of [User, Account, Notification, SecurityAlert, OperationEvent, AvailabilitySample, LearningProgress, LearningAttempt, IntegrationMetric, ServerMetricSample, EmergencySession, LimitIncreaseRequest]) stub(model, "aggregate", async () => []);
  for (const model of [User, SecurityAlert, OperationEvent, LearningProgress, VerificationFeedback]) stub(model, "countDocuments", async () => 0);
  for (const model of [Account, OperationEvent, Learning]) stub(model, "distinct", async () => []);
  for (const model of [User, SecurityAlert, EmergencySession, IntegrationMetric, ServerMetricSample, OperationEvent]) stub(model, "find", () => chain([]));
  for (const [model, method, fn] of stubs) stub(model, method, fn);
  return () => restore.reverse().forEach(fn => fn());
}
const matchOf = pipeline => pipeline[0]?.$match || {};

test("empty data reports unknown ratios instead of zero and hides people from analysts", async () => {
  const restore = stubAll();
  try {
    const data = await call(getExecutiveDashboard, "analyst");
    assert.equal(data.kyc.recent, null);
    assert.equal(data.feed, undefined); assert.equal(data.panics, undefined);
    assert.deepEqual(data.security.internal.categories.map(row => [row.key, row.count]), [["guardian_alerts", 0], ["sos", 0], ["account_locks", 0]]);
    assert.deepEqual([data.security.internal.total, data.security.external.total], [0, 0]);
    assert.deepEqual([data.snapshot.activeUsers, data.snapshot.totalAccounts, data.snapshot.activeWindow.days], [0, 0, 30]);
    assert.deepEqual(data.learningDistribution, { totalModules: 0, milestones: [] });
    assert.equal(data.verifier.flagRate, null); assert.equal(data.learning.completionRate, null);
    assert.equal(data.snapshot.verifiedPercent, null); assert.equal(data.status.systems.operational, null);
    assert.equal(data.trend.length, 7);
    assert.deepEqual(data.status.incidents, { active: 0, criticalSos: 0, elevatedGuardianPanic: 0 });
    assert.equal(data.services.find(service => service.service === "api").state, "collecting");
    assert.deepEqual(data.services.map(service => service.service).filter(name => ["sms", "maps"].includes(name)), []);
  } finally { restore(); }
});

test("incidents are classified by type: SOS is Critical, guardian panic is Elevated, other alerts are not incidents", async () => {
  const restore = stubAll([[SecurityAlert, "aggregate", async pipeline => {
    const match = matchOf(pipeline);
    // Only panic alert types may be counted as high-risk incidents.
    if (match.status) { assert.deepEqual(match.type, { $in: ["sos", "guardian_alert"] }); return [{ _id: "sos", count: 2 }, { _id: "guardian_alert", count: 1 }]; }
    return [];
  }]]);
  try {
    const status = await call(getDashboardStatus, "support");
    assert.deepEqual(status.incidents, { active: 3, criticalSos: 2, elevatedGuardianPanic: 1 });
  } finally { restore(); }
});

test("weekly and monthly figures use Sunday-start weeks and calendar months", async () => {
  const ranges = [];
  const restore = stubAll([[User, "countDocuments", async filter => { if (filter.createdAt) ranges.push(filter.createdAt.$gte); return 0; }]]);
  try {
    const data = await call(getExecutiveDashboard, "superadmin");
    const weekStart = new Date(data.periods.week.start), monthStart = new Date(data.periods.month.start);
    assert.equal(weekStart.getUTCDay(), 0); assert.equal(weekStart.getUTCHours(), 0);
    assert.equal(monthStart.getUTCDate(), 1);
    assert.equal(ranges[0].toISOString(), weekStart.toISOString(), "new users this week starts on Sunday");
  } finally { restore(); }
});

test("searches include every supported type, and guardian alerts exclude the user's own copy", async () => {
  let guardianMatch;
  const restore = stubAll([
    [OperationEvent, "aggregate", async pipeline => matchOf(pipeline).kind === "verification_lookup" ? [
      { _id: { tool: "phone", outcome: "verified" }, count: 3 }, { _id: { tool: "account", outcome: "fraudulent" }, count: 1 },
      { _id: { tool: "email", outcome: "not_found" }, count: 4 }, { _id: { tool: "website", outcome: "verified" }, count: 2 },
    ] : []],
    [Notification, "aggregate", async pipeline => { guardianMatch = matchOf(pipeline); return [{ _id: "guardian_alert", count: 2 }, { _id: "sos_emergency_active", count: 3 }]; }],
    [IntegrationMetric, "aggregate", async () => [{ attempts: 5, accepted: 4, failed: 1, noDevice: 2 }]],
    [IntegrationMetric, "find", () => chain([{ hour: new Date("2026-10-19T02:00:00Z") }])],
  ]);
  try {
    const data = await call(getExecutiveDashboard, "superadmin");
    assert.deepEqual(data.verifier.byType, { phone: 3, account: 1, email: 4, website: 2 });
    assert.equal(data.verifier.total, 10); assert.equal(data.verifier.numbers, 4); assert.equal(data.verifier.flagRate, 10);
    const guardian = await guardianAlerts({ from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") });
    assert.deepEqual(guardianMatch.$expr, { $ne: ["$recipient", "$sender"] });
    assert.deepEqual([guardian.total, guardian.fromSos, guardian.fromGuardianPanic, guardian.push.accepted, guardian.push.failed], [5, 3, 2, 4, 1]);
  } finally { restore(); }
});

test("analytics report compares with the previous period and the PDF renders it", async () => {
  const restore = stubAll([[SecurityAlert, "aggregate", async pipeline => {
    const match = matchOf(pipeline);
    if (match.createdAt && match.type?.$in && pipeline[1].$group._id === "$type") return [{ _id: "sos", count: 1 }];
    return [];
  }]]);
  try {
    const report = await buildAnalyticsReport({ period: "month", date: "2026-09-10" }, new Date("2026-10-19T10:00:00Z"));
    assert.equal(report.period.label, "September 2026"); assert.equal(report.previous.label, "August 2026");
    assert.equal(report.daily.length, 30); assert.equal(report.period.isCurrent, false);
    assert.equal(report.incidents.period.criticalSos, 1);
    assert.ok(report.limitations.some(text => text.includes("Forward Alert")));
    const pdf = await renderAnalyticsPdf(report);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok((pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length >= 2);
    const response = await call(getAnalyticsPdf, "analyst", { period: "week" });
    assert.equal(response.headers["Content-Type"], "application/pdf");
    assert.match(response.headers["Content-Disposition"], /moneykee-analytics-week-\d{4}-\d{2}-\d{2}\.pdf/);
    await assert.rejects(call(getAnalyticsReport, "analyst", { period: "year" }), /week or month/);
  } finally { restore(); }
});

test("analytics and infrastructure routes use the existing permission model", () => {
  const request = path => ({ method: "GET", baseUrl: "/api/v1/admin", path });
  assert.equal(routePermission(request("/analytics/report")), "overview:read");
  assert.equal(routePermission(request("/analytics/report.pdf")), "overview:read");
  assert.equal(routePermission(request("/health/infrastructure")), "health:read");
  assert.equal(can({ role: "admin", adminRole: "analyst" }, "overview:read"), true);
  assert.equal(can({ role: "user", adminRole: "superadmin" }, "overview:read"), false);
});

test("learning counts each user and module once: completed when the quiz is submitted, otherwise not completed", async () => {
  const pair = (user, learning) => ({ _id: { user, learning } });
  const restore = stubAll([
    [OperationEvent, "aggregate", async pipeline => {
      const group = pipeline.find(stage => stage.$group).$group;
      if (group._id === "$entityId") return [{ _id: "aaaaaaaaaaaaaaaaaaaaaaa1", opens: 5 }, { _id: "aaaaaaaaaaaaaaaaaaaaaaa2", opens: 2 }];
      return [pair("u1", "aaaaaaaaaaaaaaaaaaaaaaa1"), pair("u2", "aaaaaaaaaaaaaaaaaaaaaaa1"), pair("u3", "aaaaaaaaaaaaaaaaaaaaaaa2")];
    }],
    // Opened before open tracking existed: known only because the quiz was started.
    [LearningProgress, "aggregate", async () => [pair("u4", "aaaaaaaaaaaaaaaaaaaaaaa2")]],
    [LearningAttempt, "aggregate", async () => [pair("u1", "aaaaaaaaaaaaaaaaaaaaaaa1"), pair("u4", "aaaaaaaaaaaaaaaaaaaaaaa2"), pair("u5", "aaaaaaaaaaaaaaaaaaaaaaa2")]],
    [Learning, "findById", id => ({ select() { return this; }, lean: async () => ({ _id: id, title: id.endsWith("2") ? "Breach flow basics" : "OTP safety" }) })],
  ]);
  try {
    const learning = await learningOverview();
    assert.deepEqual([learning.opened, learning.completed, learning.notCompleted, learning.completionRate], [5, 3, 2, 60]);
    // Module 2 has more completions (2) than module 1 (1), even though module 1 was opened more often.
    assert.deepEqual(learning.mostPopular, { title: "Breach flow basics", completions: 2, opens: 2 });
    const data = await call(getExecutiveDashboard, "superadmin");
    assert.deepEqual(Object.keys(data.learning).sort(), ["completed", "completionRate", "mostPopular", "notCompleted", "openTrackingSince", "opened"]);
  } finally { restore(); }
});

test("module completion milestones are spread from one module to all of them, without duplicates", () => {
  assert.deepEqual(completionMilestones(0), []);
  assert.deepEqual(completionMilestones(1), [1]);
  assert.deepEqual(completionMilestones(3), [1, 2, 3]);
  assert.deepEqual(completionMilestones(5), [1, 2, 3, 4, 5]);
  assert.deepEqual(completionMilestones(6), [1, 2, 4, 5, 6]);
  assert.deepEqual(completionMilestones(10), [1, 3, 6, 8, 10]);
  assert.deepEqual(completionMilestones(20), [1, 6, 11, 15, 20]);
  assert.deepEqual(completionMilestones(50), [1, 13, 26, 38, 50]);
  for (let modules = 1; modules <= 200; modules++) {
    const milestones = completionMilestones(modules);
    assert.equal(milestones[0], 1); assert.equal(milestones.at(-1), modules);
    assert.equal(milestones.length, Math.min(5, modules));
    assert.ok(milestones.every((value, index) => !index || value > milestones[index - 1]));
  }
});

test("module completion distribution is cumulative: a user counts at every milestone they reached", async () => {
  const modules = Array.from({ length: 10 }, (_, index) => `m${index}`);
  let match;
  // Per completed-module count: 3 users completed 1, 2 completed 4, 1 completed all 10.
  const restore = stubAll([
    [Learning, "distinct", async () => modules],
    [LearningAttempt, "aggregate", async pipeline => { match = matchOf(pipeline); return [{ _id: 1, users: 3 }, { _id: 4, users: 2 }, { _id: 10, users: 1 }]; }],
  ]);
  try {
    const data = await call(getExecutiveDashboard, "superadmin");
    assert.deepEqual(match, { learning: { $in: modules } });
    assert.deepEqual(data.learningDistribution, { totalModules: 10, milestones: [
      { minimum: 1, users: 6 }, { minimum: 3, users: 3 }, { minimum: 6, users: 1 }, { minimum: 8, users: 1 }, { minimum: 10, users: 1 },
    ] });
  } finally { restore(); }
});
