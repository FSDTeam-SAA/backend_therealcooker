import mongoose from "mongoose";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import AppError from "../errors/AppError.js";
import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { EmergencySession } from "../model/emergencySession.model.js";
import { LearningAttempt } from "../model/learning-attempt.model.js";
import { OperationEvent, SecurityAlert, SupportCase, AuditLog, AvailabilitySample, LearningProgress } from "../model/operation.model.js";
import { permissionsFor, can, ADMIN_ROLES } from "../utils/adminPermissions.js";
import { DAY, reportingWindow, pageOptions, dateFilter, escapeRegex, percent, trendRows } from "../utils/reporting.js";

const respond = (res, data, statusCode = 200) => sendResponse(res, { statusCode, success: true, message: "Operational data fetched successfully", data });
const id = value => { if (!mongoose.isValidObjectId(value)) throw new AppError(400, "Invalid ID"); return value; };
const string = (value, name, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new AppError(400, `${name} must be between 1 and ${max} characters`);
  return value.trim();
};
const choice = (value, values, name) => { if (!values.includes(value)) throw new AppError(400, `Invalid ${name}`); return value; };
const userFields = "name email phone userId dob profession country city createdAt isBlocked verificationInfo.verified kyc.status";
const daily = (Model, filter, field = "createdAt", distinct = false) => Model.aggregate([
  { $match: filter },
  ...(distinct ? [{ $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "UTC" } }, user: "$user" } } }, { $group: { _id: "$_id.date", count: { $sum: 1 } } }] : [{ $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: "UTC" } }, count: { $sum: 1 } } }]),
]);
async function paginated(res, Model, filter, query, populate = [], projection) {
  const { page, limit, skip } = pageOptions(query);
  let finder = Model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
  if (projection) finder = finder.select(projection);
  for (const [path, fields] of populate) finder = finder.populate(path, fields);
  const [items, total] = await Promise.all([finder.lean(), Model.countDocuments(filter)]);
  respond(res, { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
}

export const getAdminIdentity = catchAsync(async (req, res) => respond(res, { id: req.user._id, adminRole: req.user.adminRole || "superadmin", permissions: permissionsFor(req.user) }));
export const getOverview = catchAsync(async (req, res) => {
  const now = new Date(); const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
  const seven = new Date(now - 7 * DAY), thirty = new Date(now - 30 * DAY);
  const { start, end, days } = reportingWindow(req.query, now);
  const period = { $gte: start, $lte: end }, users = { role: "user" };
  const activeCount = async since => (await OperationEvent.distinct("user", { kind: "activity", occurredAt: { $gte: since }, user: { $ne: null } })).length;
  const groupedCounts = (Model, filter, field) => Model.aggregate([{ $match: filter }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
  const [totalUsers, emailVerified, kycVerified, newToday, new7, new30, dau, wau, mau, activeAccounts, bankUsers,
    banks, alertsToday, alerts7, alerts30, risk, reviewed, falsePositive, openCases, resolvedCases, openPanics,
    panicToday, protective, response, usage, sources, progress, popular, attempts,
    newTrend, activeTrend, alertTrend, panicTrend, protectiveTrend, caseTrend, confirmedTrend, availability] = await Promise.all([
    User.countDocuments(users), User.countDocuments({ ...users, "verificationInfo.verified": true }), User.countDocuments({ ...users, "kyc.status": "completed" }),
    ...[today, seven, thirty].map(date => User.countDocuments({ ...users, createdAt: { $gte: date } })),
    ...[today, new Date(today - 6 * DAY), new Date(today - 29 * DAY)].map(activeCount),
    Account.countDocuments({ isActive: true }), Account.distinct("user", { isActive: true, accountType: "bank" }),
    Account.aggregate([{ $match: { isActive: true, accountType: "bank" } }, { $group: { _id: "$bankName", users: { $addToSet: "$user" }, accounts: { $sum: 1 } } }, { $project: { bank: "$_id", users: { $size: "$users" }, accounts: 1, _id: 0 } }, { $sort: { users: -1 } }]),
    ...[today, seven, thirty].map(date => SecurityAlert.countDocuments({ createdAt: { $gte: date } })),
    groupedCounts(SecurityAlert, { status: { $ne: "resolved" } }, "severity"),
    SecurityAlert.countDocuments({ createdAt: period, verdict: { $ne: "unreviewed" } }), SecurityAlert.countDocuments({ createdAt: period, verdict: "false_positive" }),
    SupportCase.countDocuments({ status: { $ne: "resolved" } }), SupportCase.countDocuments({ resolvedAt: period }),
    SecurityAlert.countDocuments({ type: { $in: ["sos", "guardian_alert"] }, status: { $ne: "resolved" } }),
    OperationEvent.countDocuments({ kind: "panic", occurredAt: { $gte: today } }),
    OperationEvent.countDocuments({ kind: "protective_action", occurredAt: period, outcome: { $ne: "user_unblocked" } }),
    SecurityAlert.aggregate([{ $match: { firstActionAt: { $ne: null }, createdAt: period } }, { $group: { _id: null, averageMs: { $avg: { $subtract: ["$firstActionAt", "$createdAt"] } }, count: { $sum: 1 } } }]),
    groupedCounts(OperationEvent, { kind: "verification_lookup", occurredAt: period }, "tool"), groupedCounts(OperationEvent, { kind: "verification_lookup", occurredAt: period }, "source"),
    LearningProgress.aggregate([{ $group: { _id: null, started: { $sum: 1 }, completed: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$completedAt", null] }, null] }, 1, 0] } }, averageDurationMs: { $avg: "$durationMs" }, additionalUsers: { $addToSet: { $cond: [{ $gt: ["$additionalQuestions", 0] }, "$user", null] } } } }]),
    LearningAttempt.aggregate([{ $match: { createdAt: period } }, { $group: { _id: "$learning", title: { $last: "$learningTitle" }, users: { $addToSet: "$user" }, attempts: { $sum: 1 } } }, { $project: { title: 1, attempts: 1, users: { $size: "$users" } } }, { $sort: { users: -1 } }, { $limit: 10 }]),
    LearningAttempt.countDocuments({ createdAt: period }),
    daily(User, { ...users, createdAt: period }), daily(OperationEvent, { kind: "activity", occurredAt: period }, "occurredAt", true),
    daily(SecurityAlert, { createdAt: period }), daily(OperationEvent, { kind: "panic", occurredAt: period }, "occurredAt"),
    daily(OperationEvent, { kind: "protective_action", occurredAt: period, outcome: { $ne: "user_unblocked" } }, "occurredAt"), daily(SupportCase, { resolvedAt: period }, "resolvedAt"),
    daily(SecurityAlert, { verdict: "confirmed", createdAt: period }),
    AvailabilitySample.aggregate([{ $match: { checkedAt: period } }, { $group: { _id: "$service", samples: { $sum: 1 }, healthy: { $sum: { $cond: ["$available", 1, 0] } }, lastCheckedAt: { $max: "$checkedAt" } } }]),
  ]);
  const learning = progress[0] || { started: 0, completed: 0, averageDurationMs: null, additionalUsers: [] };
  respond(res, { days, from: start, to: end, timezone: "UTC", generatedAt: now,
    users: { total: totalUsers, emailVerified, emailVerifiedPercent: percent(emailVerified, totalUsers), kycVerified, kycVerifiedPercent: percent(kycVerified, totalUsers), newToday, new7, new30, dau, wau, mau },
    accounts: { active: activeAccounts, bankLinkedUsers: bankUsers.length, bankLinkedPercent: percent(bankUsers.length, totalUsers), banks },
    alerts: { today: alertsToday, last7: alerts7, last30: alerts30, risk, falsePositive, reviewed, falsePositiveRate: percent(falsePositive, reviewed), averageResponseMs: response[0]?.averageMs ?? null, responseSampleCount: response[0]?.count || 0 },
    panics: { today: panicToday, open: openPanics }, cases: { open: openCases, resolved: resolvedCases }, protectiveActions: protective,
    verification: { usage, sources }, learning: { started: learning.started, completed: learning.completed, incomplete: learning.started - learning.completed, averageDurationMs: learning.averageDurationMs, additionalQuestionUsers: learning.additionalUsers.filter(Boolean).length, popular, attempts },
    availability: availability.map(row => ({ service: row._id, samples: row.samples, percent: percent(row.healthy, row.samples), lastCheckedAt: row.lastCheckedAt })),
    trends: trendRows(start, end, { newUsers: newTrend, activeUsers: activeTrend, alerts: alertTrend, panics: panicTrend, protective: protectiveTrend, resolvedCases: caseTrend, confirmed: confirmedTrend }),
    trackingStartedAt: (await OperationEvent.findOne().sort({ occurredAt: 1 }).select("occurredAt").lean())?.occurredAt || null,
  });
});

export const listAlerts = catchAsync(async (req, res) => {
  const filter = { ...dateFilter(req.query) };
  for (const key of ["status", "severity", "verdict", "type"]) if (req.query[key]) filter[key] = req.query[key];
  if (req.query.status === "unresolved") filter.status = { $ne: "resolved" };
  if (req.query.group === "panic") filter.type = { $in: ["sos", "guardian_alert"] };
  if (req.query.search) filter.title = { $regex: escapeRegex(req.query.search), $options: "i" };
  if (req.query.user) filter.user = id(req.query.user);
  await paginated(res, SecurityAlert, filter, req.query, [["user", "name email userId"], ["reviewedBy", "name"]]);
});
export const updateAlert = catchAsync(async (req, res) => {
  const alert = await SecurityAlert.findById(id(req.params.id)); if (!alert) throw new AppError(404, "Alert not found");
  if (!Object.keys(req.body).some(key => ["status", "severity", "verdict", "resolution"].includes(key))) throw new AppError(400, "No alert update provided");
  const reason = string(req.body.reason, "Reason");
  if (req.body.status !== undefined) alert.status = choice(req.body.status, ["open", "acknowledged", "resolved"], "status");
  if (req.body.severity !== undefined) alert.severity = choice(req.body.severity, ["elevated", "high", "critical"], "severity");
  if (req.body.verdict !== undefined) alert.verdict = choice(req.body.verdict, ["unreviewed", "confirmed", "false_positive"], "verdict");
  if (alert.status === "resolved") { alert.resolution = string(req.body.resolution || reason, "Resolution"); alert.resolvedAt ||= new Date(); }
  else { alert.resolvedAt = undefined; alert.resolution = ""; }
  alert.firstActionAt ||= new Date(); alert.reviewedBy = req.user._id;
  await alert.save(); respond(res, alert);
});
export const listCases = catchAsync(async (req, res) => {
  const filter = { ...dateFilter(req.query) };
  for (const key of ["status", "severity"]) if (req.query[key]) filter[key] = req.query[key];
  if (req.query.status === "unresolved") filter.status = { $ne: "resolved" };
  if (req.query.resolvedFrom) Object.assign(filter, dateFilter({ from: req.query.resolvedFrom }, "resolvedAt"));
  if (req.query.search) filter.title = { $regex: escapeRegex(req.query.search), $options: "i" };
  if (req.query.user) filter.user = id(req.query.user);
  await paginated(res, SupportCase, filter, req.query, [["user", "name email userId"], ["assignedTo", "name email"], ["notes.actor", "name"], ["resolvedBy", "name"], ["alert", "title type status"]]);
});
export const createCase = catchAsync(async (req, res) => {
  const payload = { title: string(req.body.title, "Title", 200), createdBy: req.user._id };
  if (req.body.alert) {
    const alert = await SecurityAlert.findById(id(req.body.alert)); if (!alert) throw new AppError(404, "Alert not found");
    payload.alert = alert._id; payload.user = alert.user; payload.severity = alert.severity;
  }
  if (req.body.user) { if (!await User.exists({ _id: id(req.body.user), role: "user" })) throw new AppError(404, "User not found"); payload.user = req.body.user; }
  if (req.body.severity) payload.severity = choice(req.body.severity, ["elevated", "high", "critical"], "severity");
  if (req.body.note) payload.notes = [{ body: string(req.body.note, "Note"), actor: req.user._id }];
  const item = await SupportCase.create(payload);
  if (payload.alert) await SecurityAlert.updateOne({ _id: payload.alert, firstActionAt: null }, { $set: { firstActionAt: item.createdAt } });
  respond(res, item, 201);
});
export const updateCase = catchAsync(async (req, res) => {
  const item = await SupportCase.findById(id(req.params.id)); if (!item) throw new AppError(404, "Case not found");
  if (!Object.keys(req.body).some(key => ["status", "severity", "note", "assignedTo"].includes(key))) throw new AppError(400, "No case update provided");
  if (req.body.status !== undefined) item.status = choice(req.body.status, ["open", "in_progress", "resolved"], "status");
  if (req.body.severity !== undefined) item.severity = choice(req.body.severity, ["elevated", "high", "critical"], "severity");
  if (req.body.assignedTo !== undefined) {
    if (req.body.assignedTo && !await User.exists({ _id: id(req.body.assignedTo), role: "admin", isBlocked: false, adminRole: { $in: ["superadmin", "operations", "support"] } })) throw new AppError(400, "Assignee must be an active case operator");
    item.assignedTo = req.body.assignedTo || null;
  }
  if (req.body.note) item.notes.push({ body: string(req.body.note, "Note"), actor: req.user._id });
  if (item.status === "resolved") { item.resolution = string(req.body.resolution, "Resolution"); item.resolvedAt ||= new Date(); item.resolvedBy = req.user._id; }
  else { item.resolvedAt = undefined; item.resolvedBy = undefined; item.resolution = ""; }
  item.firstActionAt ||= new Date();
  await item.save();
  if (item.alert) await SecurityAlert.updateOne({ _id: item.alert, firstActionAt: null }, { $set: { firstActionAt: item.firstActionAt } });
  respond(res, item);
});

export const listEvents = catchAsync(async (req, res) => {
  const filter = { ...dateFilter(req.query, "occurredAt") };
  for (const key of ["kind", "tool", "source", "outcome"]) if (req.query[key]) filter[key] = req.query[key];
  // Analysts see only operational metadata, never person identifiers.
  const personal = can(req.user, "users:read");
  await paginated(res, OperationEvent, filter, req.query, personal ? [["user", "name userId"], ["actor", "name"]] : [], personal ? undefined : "kind source outcome tool occurredAt createdAt");
});
export const listAudit = catchAsync(async (req, res) => paginated(res, AuditLog, dateFilter(req.query), req.query, [["actor", "name email"]]));
export const listAccounts = catchAsync(async (req, res) => {
  const filter = { ...dateFilter(req.query), isActive: true };
  if (req.query.bank) filter.bankName = req.query.bank;
  if (req.query.locked === "true") filter.isLocked = true;
  if (req.query.user) filter.user = id(req.query.user);
  await paginated(res, Account, filter, req.query, [["user", "name email userId"]], "user accountType bankName nickname isActive isLocked lockedReason lockedAt createdAt");
});
export const getOperationalUser = catchAsync(async (req, res) => {
  const user = await User.findOne({ _id: id(req.params.id), role: "user" }).select(userFields).lean(); if (!user) throw new AppError(404, "User not found");
  const accounts = can(req.user, "accounts:read") ? await Account.find({ user: user._id }).select("bankName nickname accountType isActive isLocked lockedReason createdAt").lean() : [];
  const [accountCount, alerts, cases, emergencies] = await Promise.all([
    Account.countDocuments({ user: user._id, isActive: true }),
    SecurityAlert.find({ user: user._id }).sort({ createdAt: -1 }).limit(20).select("title type severity status verdict createdAt resolution").lean(),
    SupportCase.find({ user: user._id }).sort({ createdAt: -1 }).limit(20).select("title status severity resolution createdAt resolvedAt").lean(),
    EmergencySession.find({ user: user._id }).sort({ activatedAt: -1 }).limit(20).select("status activatedAt resolvedAt clearedByRole").lean(),
  ]);
  const today = new Date();
  let age = null;
  if (user.dob) {
    const birthday = new Date(user.dob); age = today.getUTCFullYear() - birthday.getUTCFullYear();
    if (today.getUTCMonth() < birthday.getUTCMonth() || (today.getUTCMonth() === birthday.getUTCMonth() && today.getUTCDate() < birthday.getUTCDate())) age--;
  }
  respond(res, { user, age, accountCount, accounts, alerts, cases, emergencies });
});
export const listOperators = catchAsync(async (req, res) => respond(res, await User.find({ role: "admin", isBlocked: false, adminRole: { $in: ["superadmin", "operations", "support"] } }).select("name email adminRole").lean()));
export const listStaff = catchAsync(async (req, res) => paginated(res, User, { role: "admin" }, req.query, [], "name email adminRole isBlocked createdAt"));
export const updateStaffRole = catchAsync(async (req, res) => {
  if (String(req.params.id) === String(req.user._id)) throw new AppError(400, "You cannot change your own admin role");
  const adminRole = choice(req.body.adminRole, ADMIN_ROLES, "admin role"); string(req.body.reason, "Reason");
  const staff = await User.findOneAndUpdate({ _id: id(req.params.id), role: "admin" }, { $set: { adminRole } }, { new: true, runValidators: true }).select("name email adminRole");
  if (!staff) throw new AppError(404, "Administrator not found"); respond(res, staff);
});
export const getHealth = catchAsync(async (req, res) => {
  const { start, end } = reportingWindow(req.query);
  const [services, trends] = await Promise.all([
    AvailabilitySample.aggregate([{ $match: { checkedAt: { $gte: start, $lte: end } } }, { $sort: { checkedAt: 1 } }, { $group: { _id: "$service", samples: { $sum: 1 }, healthy: { $sum: { $cond: ["$available", 1, 0] } }, available: { $last: "$available" }, checkedAt: { $last: "$checkedAt" }, latencyMs: { $last: "$latencyMs" } } }]),
    AvailabilitySample.aggregate([{ $match: { checkedAt: { $gte: start, $lte: end } } }, { $group: { _id: { service: "$service", date: { $dateToString: { format: "%Y-%m-%d", date: "$checkedAt", timezone: "UTC" } } }, samples: { $sum: 1 }, healthy: { $sum: { $cond: ["$available", 1, 0] } } } }, { $sort: { "_id.date": 1 } }]),
  ]);
  respond(res, { generatedAt: new Date(), services: services.map(s => ({ service: s._id, samples: s.samples, uptime: percent(s.healthy, s.samples), available: s.available, checkedAt: s.checkedAt, latencyMs: s.latencyMs })), trends: trends.map(s => ({ service: s._id.service, date: s._id.date, uptime: percent(s.healthy, s.samples) })), measurement: "In-process samples; use an external uptime monitor to capture process outages." });
});
