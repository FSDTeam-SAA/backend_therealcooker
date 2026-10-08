import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { Guardian } from "../model/guardian.model.js";
import { News } from "../model/news.model.js";
import { recordEvent } from "../utils/operations.js";

export const getDashboardStats = catchAsync(async (req, res) => {
  // Total Users
  const totalUsers = await User.countDocuments({ role: "user" });
  // Total Guardians
  const totalGuardians = await Guardian.countDocuments();
  // Total News
  const totalNews = await News.countDocuments();

  const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - 29);
  const dates = Array.from({ length: 30 }, (_, i) => new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
  const growth = async (Model, filter = {}) => Model.aggregate([
    { $match: { ...filter, createdAt: { $gte: start } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" } }, count: { $sum: 1 } } },
  ]);
  const [users, guardians, userBaseline, guardianBaseline] = await Promise.all([
    growth(User, { role: "user" }), growth(Guardian), User.countDocuments({ role: "user", createdAt: { $lt: start } }), Guardian.countDocuments({ createdAt: { $lt: start } }),
  ]);
  const userMap = new Map(users.map(row => [row._id, row.count]));
  const guardianMap = new Map(guardians.map(row => [row._id, row.count]));
  let runningUsers = userBaseline, runningGuardians = guardianBaseline;
  const chartData = { labels: dates, newJoined: dates.map(date => userMap.get(date) || 0),
    totalUsers: dates.map(date => (runningUsers += userMap.get(date) || 0)),
    totalGuardian: dates.map(date => (runningGuardians += guardianMap.get(date) || 0)),
  };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Dashboard stats fetched",
    data: {
      totalUsers,
      totalGuardians,
      totalNews,
      chartData,
    },
  });
});

// (Optional) admin can get recent users
export const getRecentUsers = catchAsync(async (req, res) => {
  const users = await User.find({ role: "user" })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("name email phone userId createdAt");
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Recent users fetched",
    data: users,
  });
});

export const getGuardiansForAdmin = catchAsync(async (req, res) => {
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
  const search = req.query.search?.trim();
  const filter = search
    ? { $or: [{ name: { $regex: search, $options: "i" } }, { email: { $regex: search, $options: "i" } }, { phone: { $regex: search, $options: "i" } }] }
    : {};
  const [guardians, total] = await Promise.all([
    Guardian.find(filter).populate("user", "name email userId").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Guardian.countDocuments(filter),
  ]);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: "Guardians fetched successfully", data: { guardians, pagination: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) } } });
});

export const setUserBlocked = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user || user.role === "admin") return sendResponse(res, { statusCode: httpStatus.NOT_FOUND, success: false, message: "User not found", data: null });
  if (typeof req.body.isBlocked !== "boolean") return sendResponse(res, { statusCode: 400, success: false, message: "isBlocked must be boolean", data: null });
  user.isBlocked = req.body.isBlocked;
  await user.save();
  await recordEvent({ kind: "protective_action", user: user._id, actor: req.user._id, entityType: "user", entityId: String(user._id), outcome: user.isBlocked ? "user_blocked" : "user_unblocked", reason: typeof req.body.reason === "string" ? req.body.reason.slice(0, 2000) : "Admin action" });
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: user.isBlocked ? "User blocked successfully" : "User unblocked successfully", data: { _id: user._id, isBlocked: user.isBlocked } });
});
