import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import httpStatus from "http-status";
import { User } from "../model/user.model.js";
import { Guardian } from "../model/guardian.model.js";
import { News } from "../model/news.model.js";

export const getDashboardStats = catchAsync(async (req, res) => {
  // Total Users
  const totalUsers = await User.countDocuments();
  // Total Guardians
  const totalGuardians = await Guardian.countDocuments();
  // Total News
  const totalNews = await News.countDocuments();

  // For chart data: we'll generate dummy last 30 days data
  // In real implementation, you'd aggregate from created_at
  // We'll just return sample data matching the UI
  const chartData = {
    labels: ["3 Oct", "10 Oct", "14 Oct", "20 Oct", "23 Oct", "27 Oct", "30 Oct"],
    totalUsers: [1200, 1500, 1800, 2100, 2400, 2700, 3000],
    newJoined: [50, 70, 90, 60, 80, 100, 120],
    totalGuardian: [800, 900, 1000, 1100, 1200, 1300, 1400],
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
  const users = await User.find()
    .sort({ createdAt: -1 })
    .limit(10)
    .select("name email phone createdAt");
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
  user.isBlocked = Boolean(req.body.isBlocked);
  await user.save();
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: user.isBlocked ? "User blocked successfully" : "User unblocked successfully", data: { _id: user._id, isBlocked: user.isBlocked } });
});
