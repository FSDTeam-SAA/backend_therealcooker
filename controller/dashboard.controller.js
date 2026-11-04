import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { User } from "../model/user.model.js";
import { Account } from "../model/account.model.js";
import { AvailabilitySample, ServerMetricSample } from "../model/operation.model.js";
import { VerificationFeedback } from "../model/verificationFeedback.model.js";
import { can } from "../utils/adminPermissions.js";
import { DAY } from "../utils/reporting.js";
import { reportingTimezone, reportingPeriod, startOfToday, recentDays } from "../utils/reportingPeriods.js";
import { ratio, activeIncidents, searches, learningOverview, activeUsers, newUsers, dailySeries, platformServices,
  ACTIVE_WINDOW_DAYS, recentlyActiveUsers, totalAccounts, internalSecurityEvents, externalSecurityEvents, moduleCompletionDistribution } from "../utils/dashboardMetrics.js";
import { sampleEnvironment, latestServerMetrics } from "../utils/availability.js";
import { gpuStatus, hostDescription } from "../utils/serverMetrics.js";
import { databaseMetrics } from "../utils/databaseMetrics.js";
import { buildAnalyticsReport } from "../utils/analyticsReport.js";
import { renderAnalyticsPdf } from "../utils/analyticsPdf.js";

const respond = (res, data) => sendResponse(res, { statusCode: 200, success: true, message: "Dashboard data fetched successfully", data });
const KYC_SUBMITTED = ["pending", "completed", "failed"];
const bankAccounts = { isActive: true, accountType: "bank" };
// Any active account the user linked in the app: bank or wallet.
const linkedAccounts = { isActive: true };

// Shared by the header, the sidebar badge and the dashboard so their counts always agree.
async function liveStatus(now = new Date()) {
  const [incidents, kycPending, feedbackReview, latest] = await Promise.all([
    activeIncidents(),
    User.countDocuments({ role: "user", "kyc.status": "pending" }),
    VerificationFeedback.countDocuments({ status: "needs_review" }),
    AvailabilitySample.aggregate([
      { $match: { environment: sampleEnvironment(), checkedAt: { $gte: new Date(now - 20 * 60_000) } } }, { $sort: { checkedAt: 1 } },
      { $group: { _id: "$service", available: { $last: "$available" }, checkedAt: { $last: "$checkedAt" } } },
    ]),
  ]);
  const degraded = latest.filter(row => !row.available).map(row => row._id).sort();
  return {
    incidents, kycPending, feedbackReview,
    // null when no recent check exists: the state is unknown, not healthy.
    systems: { operational: latest.length ? degraded.length === 0 : null, degraded, checkedAt: latest.length ? new Date(Math.max(...latest.map(row => row.checkedAt))) : null },
  };
}

export const getDashboardStatus = catchAsync(async (req, res) => respond(res, await liveStatus()));

export const getExecutiveDashboard = catchAsync(async (req, res) => {
  const now = new Date(), zone = reportingTimezone();
  const week = reportingPeriod({ period: "week" }, now, zone), month = reportingPeriod({ period: "month" }, now, zone);
  const today = { from: startOfToday(now, zone), to: now }, thisWeek = { from: week.start, to: now }, thisMonth = { from: month.start, to: now };
  const trend = recentDays(7, now, zone);
  const canSeePeople = can(req.user, "users:read");
  const [status, totalUsers, newThisWeek, activeToday, active, accounts, linkedUsers, bankUsers, bankRows,
    internal, external, monthSearches, learning, learningDistribution, daily, kycCounts, kycRecent, services] = await Promise.all([
    liveStatus(now),
    User.countDocuments({ role: "user" }), newUsers(thisWeek), activeUsers(today), recentlyActiveUsers(now), totalAccounts(),
    Account.distinct("user", linkedAccounts),
    Account.distinct("user", bankAccounts),
    Account.aggregate([{ $match: bankAccounts }, { $group: { _id: "$bankName", users: { $addToSet: "$user" } } }, { $project: { _id: 0, bank: "$_id", users: { $size: "$users" } } }, { $sort: { users: -1, bank: 1 } }, { $limit: 6 }]),
    internalSecurityEvents(), externalSecurityEvents(), searches(thisMonth),
    learningOverview(), moduleCompletionDistribution(),
    dailySeries({ from: trend.start, to: now }, trend.days, zone),
    User.aggregate([{ $match: { role: "user", "kyc.status": { $in: KYC_SUBMITTED } } }, { $group: { _id: "$kyc.status", count: { $sum: 1 } } }]),
    canSeePeople ? User.find({ role: "user", "kyc.status": { $in: KYC_SUBMITTED } }).sort({ "kyc.submittedAt": -1, updatedAt: -1 }).limit(5).select("name userId kyc.status kyc.submittedAt").lean() : null,
    platformServices(thisMonth, now),
  ]);

  const kyc = Object.fromEntries(KYC_SUBMITTED.map(state => [state, kycCounts.find(row => row._id === state)?.count || 0]));

  respond(res, {
    generatedAt: now, timezone: zone,
    periods: { week: { start: week.start, label: week.label }, month: { start: month.start, label: month.label } },
    status,
    snapshot: { totalUsers, newThisWeek, activeToday,
      activeUsers: active.count, activeWindow: { days: ACTIVE_WINDOW_DAYS, since: active.since }, totalAccounts: accounts,
      verifiedUsers: kyc.completed, verifiedPercent: ratio(kyc.completed, totalUsers),
      linkedAccountUsers: linkedUsers.length, linkedAccountPercent: ratio(linkedUsers.length, totalUsers) },
    security: { internal, external },
    services,
    verifier: monthSearches,
    learning, learningDistribution,
    trend: daily.map(row => ({ date: row.date, activeUsers: row.activeUsers, alerts: row.fraudAlerts, panics: row.incidents })),
    kyc: { pending: kyc.pending, verified: kyc.completed, rejected: kyc.failed,
      recent: kycRecent?.map(user => ({ id: user._id, name: user.name || null, userId: user.userId || null, status: user.kyc?.status, submittedAt: user.kyc?.submittedAt || null })) ?? null },
    banks: { connectedUsers: bankUsers.length, rows: bankRows.map(row => ({ bank: row.bank || "Unspecified", users: row.users, percent: ratio(row.users, bankUsers.length) })) },
  });
});

// Backend host and database measurements. The host is whichever machine runs this API instance.
export const getInfrastructure = catchAsync(async (req, res) => {
  const now = new Date(), environment = sampleEnvironment();
  const memoryPercent = { $multiply: [{ $divide: [{ $subtract: ["$host.memoryTotal", "$host.memoryFree"] }, "$host.memoryTotal"] }, 100] };
  const [series, [first], stored, database] = await Promise.all([
    ServerMetricSample.aggregate([
      { $match: { environment, checkedAt: { $gte: new Date(now - DAY) } } },
      { $group: { _id: { $dateTrunc: { date: "$checkedAt", unit: "minute", binSize: 15 } }, cpu: { $avg: "$host.cpuPercent" }, memory: { $avg: memoryPercent }, processCpu: { $avg: "$process.cpuPercent" } } },
      { $sort: { _id: 1 } },
    ]),
    ServerMetricSample.find({ environment }).sort({ checkedAt: 1 }).limit(1).select("checkedAt").lean(),
    latestServerMetrics() ? null : ServerMetricSample.findOne({ environment }).sort({ checkedAt: -1 }).lean(),
    databaseMetrics().catch(() => null),
  ]);
  const latest = latestServerMetrics() || stored;
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  respond(res, {
    generatedAt: now,
    server: { environment, ...hostDescription(), latest, trackingSince: first?.checkedAt || null,
      series: series.map(row => ({ at: row._id, cpuPercent: round(row.cpu), memoryPercent: round(row.memory), processCpuPercent: round(row.processCpu) })),
      gpu: { status: gpuStatus(), gpus: latest?.gpus || [] } },
    database, databaseError: database ? null : "Database statistics could not be read.",
  });
});

const reportQuery = query => ({ period: query.period || "week", date: query.date || undefined });
export const getAnalyticsReport = catchAsync(async (req, res) => respond(res, await buildAnalyticsReport(reportQuery(req.query))));
export const getAnalyticsPdf = catchAsync(async (req, res) => {
  const report = await buildAnalyticsReport(reportQuery(req.query));
  const pdf = await renderAnalyticsPdf(report);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="moneykee-analytics-${report.period.period}-${report.period.startDate}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(pdf);
});
