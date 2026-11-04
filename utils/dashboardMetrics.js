import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { Notification } from "../model/notification.model.js";
import { Learning } from "../model/learning.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { SecurityAlert, OperationEvent, AvailabilitySample, IntegrationMetric, LearningProgress, ServerMetricSample } from "../model/operation.model.js";
import { percent } from "./reporting.js";
import { GUARDIAN_ALERT_TYPES } from "./notification.js";
import { loadFirebase } from "./integrationMetrics.js";
import { sampleEnvironment } from "./availability.js";
import { isAtlas } from "./databaseMetrics.js";

// Metric definitions shared by the dashboard, the analytics report and its PDF, so one number never
// has two meanings. Every range is half-open: { from, to } matches from <= t < to.

// Incidents: each SOS session and each "Alert Guardians" request records exactly one alert (keyed by
// session or share id), so counting alerts counts distinct incidents however many notifications they sent.
export const INCIDENT_TYPES = { sos: "criticalSos", guardian_alert: "elevatedGuardianPanic" };
export const PANIC_TYPES = Object.keys(INCIDENT_TYPES);
export const SEARCH_TYPES = ["phone", "account", "email", "website"];
export const SEARCH_OUTCOMES = ["verified", "fraudulent", "not_found"];
const between = ({ from, to }) => ({ $gte: from, $lt: to });
// Unlike percent(), a ratio with no denominator is unknown rather than zero.
export const ratio = (count, total) => total ? percent(count, total) : null;
const byKey = (rows, keys, field = "count") => Object.fromEntries(keys.map(key => [key, rows.find(row => row._id === key)?.[field] || 0]));
const incidentCounts = rows => {
  const counts = { criticalSos: 0, elevatedGuardianPanic: 0 };
  for (const row of rows) counts[INCIDENT_TYPES[row._id]] += row.count;
  return { total: counts.criticalSos + counts.elevatedGuardianPanic, ...counts };
};

// Unresolved incidents right now. SOS incidents resolve when the emergency is cleared; guardian
// panics have no session and stay active until an operator resolves the alert.
export async function activeIncidents() {
  const rows = await SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, status: { $ne: "resolved" } } }, { $group: { _id: "$type", count: { $sum: 1 } } }]);
  const { total, ...counts } = incidentCounts(rows);
  return { active: total, ...counts };
}

export async function incidentActivity(range) {
  const [started, [resolved], [response]] = await Promise.all([
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, createdAt: between(range) } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, resolvedAt: between(range) } }, { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: { $subtract: ["$resolvedAt", "$createdAt"] } } } }]),
    SecurityAlert.aggregate([{ $match: { type: { $in: PANIC_TYPES }, createdAt: between(range), firstActionAt: { $ne: null } } }, { $group: { _id: null, count: { $sum: 1 }, averageMs: { $avg: { $subtract: ["$firstActionAt", "$createdAt"] } } } }]),
  ]);
  return { ...incidentCounts(started), resolved: resolved?.count || 0, averageResolutionMs: resolved?.averageMs ?? null, averageFirstActionMs: response?.averageMs ?? null };
}

// Guardian alerts: emergency notifications stored for a guardian (not the user's own copy). Push
// results come from FCM telemetry, which only exists from when tracking started.
export async function guardianAlerts(range) {
  const [rows, [push], [first]] = await Promise.all([
    Notification.aggregate([{ $match: { type: { $in: GUARDIAN_ALERT_TYPES }, createdAt: between(range), sender: { $ne: null }, $expr: { $ne: ["$recipient", "$sender"] } } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
    IntegrationMetric.aggregate([{ $match: { service: "fcm", category: "guardian_alert", hour: between(range) } }, { $group: { _id: null, attempts: { $sum: "$attempts" }, accepted: { $sum: "$accepted" }, failed: { $sum: "$failed" }, noDevice: { $sum: "$noDevice" } } }]),
    IntegrationMetric.find({ service: "fcm" }).sort({ hour: 1 }).limit(1).select("hour").lean().then(rows => rows),
  ]);
  const counts = byKey(rows, GUARDIAN_ALERT_TYPES);
  return {
    total: counts.guardian_alert + counts.sos_emergency_active, fromSos: counts.sos_emergency_active, fromGuardianPanic: counts.guardian_alert,
    push: { trackedSince: first?.hour || null, attempts: push?.attempts || 0, accepted: push?.accepted || 0, failed: push?.failed || 0, noDevice: push?.noDevice || 0 },
  };
}

// Other security alerts (limit verification, account locks, manual) — everything that is not a panic.
export const fraudAlertCount = range => SecurityAlert.countDocuments({ type: { $nin: PANIC_TYPES }, createdAt: between(range) });
export async function fraudAlertBreakdown(range) {
  const [types, severities] = await Promise.all(["$type", "$severity"].map(field => SecurityAlert.aggregate([{ $match: { type: { $nin: PANIC_TYPES }, createdAt: between(range) } }, { $group: { _id: field, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }])));
  return { byType: types.map(row => ({ type: row._id, count: row.count })), bySeverity: severities.map(row => ({ severity: row._id, count: row.count })) };
}

export async function alertQuality(range) {
  const [row] = await SecurityAlert.aggregate([
    { $match: { createdAt: between(range) } },
    { $group: { _id: null,
      reviewed: { $sum: { $cond: [{ $ne: ["$verdict", "unreviewed"] }, 1, 0] } },
      falsePositive: { $sum: { $cond: [{ $eq: ["$verdict", "false_positive"] }, 1, 0] } },
      responseMs: { $avg: { $cond: [{ $ifNull: ["$firstActionAt", false] }, { $subtract: ["$firstActionAt", "$createdAt"] }, null] } },
      responded: { $sum: { $cond: [{ $ifNull: ["$firstActionAt", false] }, 1, 0] } } } },
  ]);
  return { reviewed: row?.reviewed || 0, falsePositive: row?.falsePositive || 0, rate: ratio(row?.falsePositive || 0, row?.reviewed || 0), averageResponseMs: row?.responseMs ?? null, responded: row?.responded || 0 };
}

// Searches: one record per lookup the verifier processed (requests rejected by validation are not
// recorded). Only the type and outcome are stored, never the searched value.
export async function searches(range) {
  const rows = await OperationEvent.aggregate([{ $match: { kind: "verification_lookup", occurredAt: between(range) } }, { $group: { _id: { tool: "$tool", outcome: "$outcome" }, count: { $sum: 1 } } }]);
  const sum = (tools, outcomes) => rows.filter(row => (!tools || tools.includes(row._id.tool)) && (!outcomes || outcomes.includes(row._id.outcome))).reduce((total, row) => total + row.count, 0);
  const total = sum();
  return {
    total, numbers: sum(["phone", "account"]),
    byType: Object.fromEntries(SEARCH_TYPES.map(type => [type, sum([type])])),
    byOutcome: Object.fromEntries(SEARCH_OUTCOMES.map(outcome => [outcome, sum(null, [outcome])])),
    flagRate: ratio(sum(null, ["fraudulent"]), total),
    share: Object.fromEntries(SEARCH_OUTCOMES.map(outcome => [outcome, ratio(sum(null, [outcome]), total)])),
  };
}

// Activity is recorded as one marker per user per UTC day, so active-user counts follow UTC days.
export const activeUsers = async range => (await OperationEvent.distinct("user", { kind: "activity", occurredAt: between(range), user: { $ne: null } })).length;
export const newUsers = range => User.countDocuments({ role: "user", createdAt: between(range) });

// Active users: registered users with at least one activity marker in the last `days` UTC days, today
// included. Markers come from every successful authenticated app request and every sign-in or token
// refresh, so a user counts once however often they were active. Deleted users drop out.
export const ACTIVE_WINDOW_DAYS = 30;
export async function recentlyActiveUsers(now = new Date(), days = ACTIVE_WINDOW_DAYS) {
  const from = new Date(now); from.setUTCHours(0, 0, 0, 0); from.setUTCDate(from.getUTCDate() - (days - 1));
  const ids = await OperationEvent.distinct("user", { kind: "activity", occurredAt: { $gte: from, $lte: now }, user: { $ne: null } });
  return { count: ids.length ? await User.countDocuments({ _id: { $in: ids }, role: "user" }) : 0, since: from };
}

// Accounts users added in the app and still hold. Removing an account deletes it; inactive records are
// hidden from the app, so they are excluded too, as are accounts left behind by deleted users. An
// account entered twice by the same user (same type, bank and number) counts once.
export async function totalAccounts() {
  const [row] = await Account.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: { user: "$user", type: "$accountType", bank: "$bankName", number: "$accountNumberEncrypted" } } },
    { $lookup: { from: User.collection.collectionName, localField: "_id.user", foreignField: "_id", pipeline: [{ $match: { role: "user" } }, { $project: { _id: 1 } }], as: "owner" } },
    { $match: { "owner.0": { $exists: true } } },
    { $count: "count" },
  ]);
  return row?.count || 0;
}

// Security events, all time. Operational telemetry (SecurityAlert, OperationEvent) only exists from when
// tracking started, and deleting a user removes their sessions and limit requests while alerts are kept,
// so each event is counted from every table that records it and deduplicated by the key they share.
async function distinctKeys(sources) {
  const [first, ...rest] = sources.map(({ model, match = {}, key }) => ({ model, coll: model.collection.collectionName, pipeline: [{ $match: match }, { $project: { _id: 0, key } }] }));
  const [row] = await first.model.aggregate([...first.pipeline, ...rest.map(({ coll, pipeline }) => ({ $unionWith: { coll, pipeline } })),
    { $match: { key: { $nin: [null, ""] } } }, { $group: { _id: "$key" } }, { $count: "count" }]);
  return row?.count || 0;
}
const idKey = { $toString: "$_id" };

// "Alert Guardians" requests are keyed by their live-location share id. Requests sent before share ids
// existed are only in guardians' notifications; one request notifies every guardian at once, so
// notifications from the same sender within a couple of seconds are one request.
async function guardianAlertEvents() {
  const legacy = { type: "guardian_alert", sender: { $ne: null }, "data.liveLocationShareId": { $exists: false }, $expr: { $ne: ["$recipient", "$sender"] } };
  const [keyed, [early]] = await Promise.all([
    distinctKeys([
      { model: SecurityAlert, match: { type: "guardian_alert" }, key: "$entityId" },
      { model: OperationEvent, match: { kind: "panic", outcome: "guardian_alert" }, key: "$entityId" },
      { model: Notification, match: { type: "guardian_alert" }, key: "$data.liveLocationShareId" },
    ]),
    Notification.aggregate([
      { $match: legacy },
      { $setWindowFields: { partitionBy: "$sender", sortBy: { createdAt: 1 }, output: { previous: { $shift: { output: "$createdAt", by: -1 } } } } },
      { $match: { $expr: { $or: [{ $eq: ["$previous", null] }, { $gt: [{ $subtract: ["$createdAt", "$previous"] }, 2000] }] } } },
      { $count: "count" },
    ]),
  ]);
  return keyed + (early?.count || 0);
}

// Internal events are the user's own safety actions in the app. A lockdown is its own event: SOS
// activation locks every active account (when the user has any), and so does a failed or expired
// limit-increase verification.
export async function internalSecurityEvents() {
  const [guardianAlerts, sos, sosLockdowns, verificationLockdowns] = await Promise.all([
    guardianAlertEvents(),
    distinctKeys([
      { model: EmergencySession, key: idKey },
      { model: SecurityAlert, match: { type: "sos" }, key: "$entityId" },
      { model: OperationEvent, match: { kind: "panic", outcome: "sos" }, key: "$entityId" },
    ]),
    distinctKeys([
      { model: EmergencySession, match: { "lockedAccounts.0": { $exists: true } }, key: idKey },
      { model: OperationEvent, match: { kind: "protective_action", outcome: "accounts_locked", entityType: "emergency" }, key: "$entityId" },
    ]),
    distinctKeys([
      { model: LimitIncreaseRequest, match: { status: "locked" }, key: idKey },
      { model: SecurityAlert, match: { type: "account_lock" }, key: "$entityId" },
      { model: OperationEvent, match: { kind: "protective_action", outcome: "accounts_locked", entityType: "limit_request" }, key: "$entityId" },
    ]),
  ]);
  return securityEventGroup([
    { key: "guardian_alerts", label: "Guardian Alerts", count: guardianAlerts },
    { key: "sos", label: "SOS Events", count: sos },
    { key: "account_locks", label: "Bank Account Lock Events", count: sosLockdowns + verificationLockdowns,
      parts: [{ label: "from SOS", count: sosLockdowns }, { label: "after failed limit verification", count: verificationLockdowns }] },
  ]);
}

// External events come from the account's financial settings. Every limit-increase request counts,
// whatever happened next; its current status is reported alongside.
export async function externalSecurityEvents() {
  const [requests, statuses] = await Promise.all([
    distinctKeys([
      { model: LimitIncreaseRequest, key: idKey },
      { model: SecurityAlert, match: { type: "suspicious_limit" }, key: "$entityId" },
    ]),
    LimitIncreaseRequest.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const status = byKey(statuses, ["approved", "locked", "notified", "otp_sent"]);
  const pending = status.notified + status.otp_sent, removed = requests - status.approved - status.locked - pending;
  return securityEventGroup([
    { key: "limit_increase", label: "Increased Account Limit", count: requests,
      parts: [{ label: "completed", count: status.approved }, { label: "locked", count: status.locked }, { label: "awaiting verification", count: pending },
        ...(removed > 0 ? [{ label: "no longer on record", count: removed }] : [])] },
  ]);
}
const securityEventGroup = categories => ({ total: categories.reduce((sum, category) => sum + category.count, 0), categories });

// Users who completed at least N of the published modules, at up to five milestones spread evenly from
// one module to all of them. Completion follows learningOverview (the module's quiz was submitted); a
// module counts once per user however many times it was submitted. Deleted users are excluded.
export function completionMilestones(modules, count = 5) {
  if (modules <= count) return Array.from({ length: Math.max(0, modules) }, (_, index) => index + 1);
  return [...new Set(Array.from({ length: count }, (_, index) => Math.round(1 + index * (modules - 1) / (count - 1))))];
}
export async function moduleCompletionDistribution() {
  const modules = await Learning.distinct("_id", { isPublished: true });
  const milestones = completionMilestones(modules.length);
  const rows = milestones.length ? await LearningAttempt.aggregate([
    { $match: { learning: { $in: modules } } },
    { $group: { _id: { user: "$user", learning: "$learning" } } },
    { $group: { _id: "$_id.user", completed: { $sum: 1 } } },
    { $lookup: { from: User.collection.collectionName, localField: "_id", foreignField: "_id", pipeline: [{ $match: { role: "user" } }, { $project: { _id: 1 } }], as: "owner" } },
    { $match: { "owner.0": { $exists: true } } },
    { $group: { _id: "$completed", users: { $sum: 1 } } },
  ]) : [];
  return { totalModules: modules.length, milestones: milestones.map(minimum => ({ minimum, users: rows.filter(row => row._id >= minimum).reduce((sum, row) => sum + row.users, 0) })) };
}

export async function userActivity(range) {
  const [active, created, kycSubmitted, kycCompleted, linked] = await Promise.all([
    activeUsers(range), newUsers(range),
    User.countDocuments({ role: "user", "kyc.submittedAt": between(range) }),
    User.countDocuments({ role: "user", "kyc.verifiedAt": between(range) }),
    Account.aggregate([{ $match: { createdAt: between(range) } }, { $group: { _id: "$accountType", count: { $sum: 1 } } }]),
  ]);
  return { active, new: created, kycSubmitted, kycCompleted, accountsLinked: byKey(linked, ["bank", "wallet"]) };
}

// Learning is counted per user per module. A module is "opened" when the user loads it in the app
// (or, before open tracking existed, started its quiz) and "completed" once they submit its quiz.
// Opened but never submitted counts as not completed. Without a range the figures are all-time.
export async function learningOverview(range) {
  const within = field => range ? { [field]: between(range) } : {};
  const pairs = (Model, match, userField = "$user", learningField = { $toString: "$learning" }) => Model.aggregate([{ $match: match }, { $group: { _id: { user: { $toString: userField }, learning: learningField } } }]);
  const [opened, quizStarted, submitted, opens, [firstOpen]] = await Promise.all([
    pairs(OperationEvent, { kind: "learning_opened", user: { $ne: null }, ...within("occurredAt") }, "$user", "$entityId"),
    pairs(LearningProgress, within("startedAt")),
    pairs(LearningAttempt, within("createdAt")),
    // Every opening counts here, including ones from signed-out sessions.
    OperationEvent.aggregate([{ $match: { kind: "learning_opened", ...within("occurredAt") } }, { $group: { _id: "$entityId", opens: { $sum: 1 } } }]),
    OperationEvent.find({ kind: "learning_opened" }).sort({ occurredAt: 1 }).limit(1).select("occurredAt").lean(),
  ]);
  const key = row => `${row._id.user}:${row._id.learning}`;
  const completed = new Set(submitted.map(key));
  const engaged = new Set([...opened, ...quizStarted, ...submitted].map(key));
  const notCompleted = [...engaged].filter(pair => !completed.has(pair)).length;

  // Most popular: the module most users completed; ties go to the one opened most often.
  const byModule = new Map();
  for (const row of submitted) byModule.set(row._id.learning, { completions: (byModule.get(row._id.learning)?.completions || 0) + 1, opens: 0 });
  for (const row of opens) if (row._id) byModule.set(row._id, { completions: byModule.get(row._id)?.completions || 0, opens: row.opens });
  const [topId, top] = [...byModule].sort(([, a], [, b]) => b.completions - a.completions || b.opens - a.opens)[0] || [];
  const topModule = topId && /^[0-9a-f]{24}$/.test(topId) ? await Learning.findById(topId).select("title").lean() : null;

  return {
    opened: engaged.size, completed: completed.size, notCompleted, completionRate: ratio(completed.size, engaged.size),
    mostPopular: top ? { title: topModule?.title || null, completions: top.completions, opens: top.opens } : null,
    openTrackingSince: firstOpen?.occurredAt || null,
  };
}

// Daily totals for each local calendar day in `days`.
export async function dailySeries(range, days, zone) {
  const day = field => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: zone } });
  const count = (Model, match, field) => Model.aggregate([{ $match: { ...match, [field]: between(range) } }, { $group: { _id: day(field), count: { $sum: 1 } } }]);
  const [active, created, incidents, fraud, lookups] = await Promise.all([
    OperationEvent.aggregate([{ $match: { kind: "activity", occurredAt: between(range), user: { $ne: null } } }, { $group: { _id: { date: day("occurredAt"), user: "$user" } } }, { $group: { _id: "$_id.date", count: { $sum: 1 } } }]),
    count(User, { role: "user" }, "createdAt"),
    count(SecurityAlert, { type: { $in: PANIC_TYPES } }, "createdAt"),
    count(SecurityAlert, { type: { $nin: PANIC_TYPES } }, "createdAt"),
    count(OperationEvent, { kind: "verification_lookup" }, "occurredAt"),
  ]);
  const value = (rows, date) => rows.find(row => row._id === date)?.count || 0;
  return days.map(date => ({ date, activeUsers: value(active, date), newUsers: value(created, date), incidents: value(incidents, date), fraudAlerts: value(fraud, date), searches: value(lookups, date) }));
}

// Platform services the backend can actually check. States: monitored (has checks), collecting (too
// little data yet) or not_configured. Integrations added later appear once they have health checks.
const SERVICE_LABELS = { database: () => isAtlas() ? "MongoDB Atlas" : "MongoDB", verifier: () => "Verifier DB", fcm: () => "Firebase FCM" };
export async function platformServices(range, now = new Date()) {
  // The current minute may not have been sampled yet, so API coverage stops before it.
  const coverageEnd = new Date(Math.min(range.to, Math.floor(now / 60_000) * 60_000));
  const [checks, [coverage], fcmTraffic, firebase] = await Promise.all([
    AvailabilitySample.aggregate([{ $match: { service: { $ne: "moneykee" }, checkedAt: between(range) } }, { $sort: { checkedAt: 1 } },
      { $group: { _id: "$service", samples: { $sum: 1 }, healthy: { $sum: { $cond: ["$available", 1, 0] } }, lastCheckedAt: { $last: "$checkedAt" }, lastAvailable: { $last: "$available" },
        lastFailureAt: { $max: { $cond: ["$available", null, "$checkedAt"] } }, lastError: { $last: "$error" } } }]),
    // The API writes one heartbeat a minute while it runs, so minutes without one are downtime.
    AvailabilitySample.aggregate([
      { $match: { service: "moneykee", environment: sampleEnvironment(), checkedAt: { $gte: range.from, $lt: coverageEnd } } },
      { $group: { _id: { $dateTrunc: { date: "$checkedAt", unit: "minute" } } } },
      { $group: { _id: null, minutes: { $sum: 1 }, since: { $min: "$_id" } } },
    ]),
    IntegrationMetric.aggregate([{ $match: { service: "fcm", hour: between(range) } }, { $sort: { hour: 1 } }, { $group: { _id: null, attempts: { $sum: "$attempts" }, accepted: { $sum: "$accepted" }, failed: { $sum: "$failed" }, serviceErrors: { $sum: "$serviceErrors" }, lastSuccessAt: { $max: "$lastSuccessAt" }, lastFailureAt: { $max: "$lastFailureAt" }, lastError: { $last: "$lastError" } } }]),
    loadFirebase(),
  ]);
  const expectedMinutes = coverage ? Math.round((coverageEnd - coverage.since) / 60_000) : 0;
  const check = service => {
    const row = checks.find(item => item._id === service);
    return row ? { percent: ratio(row.healthy, row.samples), samples: row.samples, lastCheckedAt: row.lastCheckedAt, healthyNow: row.lastAvailable, lastFailureAt: row.lastFailureAt, lastError: row.lastAvailable ? null : row.lastError || null } : null;
  };
  const services = [
    { service: "api", label: "MoneyKee API", method: "Heartbeat each minute while the API runs",
      ...(coverage ? { state: expectedMinutes >= 60 ? "monitored" : "collecting", percent: expectedMinutes >= 60 ? Math.min(100, ratio(coverage.minutes, expectedMinutes)) : null, since: coverage.since, minutes: coverage.minutes, expectedMinutes } : { state: "collecting", percent: null }) },
    ...["database", "verifier"].map(service => ({ service, label: SERVICE_LABELS[service](), method: service === "database" ? "Ping each minute" : "Read of the verification records each minute", ...(check(service) ? { state: "monitored", ...check(service) } : { state: "collecting", percent: null }) })),
    { service: "fcm", label: "Firebase FCM", method: "Dry-run message validated by FCM every 15 minutes (nothing is delivered)",
      ...(!firebase ? { state: "not_configured", detail: "Firebase credentials are not available to this backend instance." } : check("fcm") ? { state: "monitored", ...check("fcm") } : { state: "collecting", percent: null }),
      traffic: fcmTraffic[0] ? { attempts: fcmTraffic[0].attempts, accepted: fcmTraffic[0].accepted, failed: fcmTraffic[0].failed, serviceErrors: fcmTraffic[0].serviceErrors, lastSuccessAt: fcmTraffic[0].lastSuccessAt, lastFailureAt: fcmTraffic[0].lastFailureAt, lastError: fcmTraffic[0].lastError || null } : null },
    ...checks.filter(row => !["database", "verifier", "fcm"].includes(row._id)).map(row => ({ service: row._id, label: row._id, method: "Configured health URL", state: "monitored", ...check(row._id) })),
  ];
  return services;
}

// CPU and memory of the backend host over a range, from this environment's minute samples.
export async function serverSummary(range) {
  const [row] = await ServerMetricSample.aggregate([
    { $match: { environment: sampleEnvironment(), checkedAt: between(range) } },
    { $group: { _id: null, samples: { $sum: 1 }, since: { $min: "$checkedAt" }, averageCpu: { $avg: "$host.cpuPercent" }, peakCpu: { $max: "$host.cpuPercent" },
      averageMemory: { $avg: { $multiply: [{ $divide: [{ $subtract: ["$host.memoryTotal", "$host.memoryFree"] }, "$host.memoryTotal"] }, 100] } },
      peakMemory: { $max: { $multiply: [{ $divide: [{ $subtract: ["$host.memoryTotal", "$host.memoryFree"] }, "$host.memoryTotal"] }, 100] } },
      averageProcessRss: { $avg: "$process.rss" } } },
  ]);
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  return row ? { samples: row.samples, since: row.since, averageCpuPercent: round(row.averageCpu), peakCpuPercent: round(row.peakCpu), averageMemoryPercent: round(row.averageMemory), peakMemoryPercent: round(row.peakMemory), averageProcessRss: row.averageProcessRss ? Math.round(row.averageProcessRss) : null } : { samples: 0, since: null };
}
