import express from "express";
import { getAdminAttempts, getAttemptDetails, getUserAttempts } from "../controller/learning-attempt.controller.js";
import {
  getDashboardStats,
  getRecentUsers,
  getGuardiansForAdmin,
  setUserBlocked,
} from "../controller/admin.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";
import { getOverview, getAdminIdentity, listAlerts, updateAlert, listCases, createCase, updateCase, listEvents, listAudit, listAccounts, getOperationalUser, listOperators, listStaff, updateStaffRole, getHealth } from "../controller/operations.controller.js";
import { getDashboardStatus, getExecutiveDashboard, getInfrastructure, getAnalyticsReport, getAnalyticsPdf } from "../controller/dashboard.controller.js";
import { listAdminBanks, createBank, updateBank, deleteBank } from "../controller/bank.controller.js";
import { listFeedback, getFeedback, reviewFeedbackDecision } from "../controller/verification-feedback.controller.js";
import { upload } from "../middleware/multer.middleware.js";

const router = express.Router();

router.use(protect, isAdmin);
router.get("/me", getAdminIdentity);
router.get("/banks", listAdminBanks);
router.post("/banks", upload.single("logo"), createBank);
router.patch("/banks/:id", upload.single("logo"), updateBank);
router.delete("/banks/:id", deleteBank);
router.get("/dashboard/overview", getOverview);
router.get("/dashboard/status", getDashboardStatus);
router.get("/dashboard/executive", getExecutiveDashboard);
router.get("/alerts", listAlerts);
router.patch("/alerts/:id", updateAlert);
router.get("/cases/operators", listOperators);
router.get("/cases", listCases);
router.post("/cases", createCase);
router.patch("/cases/:id", updateCase);
router.get("/events", listEvents);
router.get("/audit", listAudit);
router.get("/accounts", listAccounts);
router.get("/users/:id/overview", getOperationalUser);
router.get("/staff", listStaff);
router.patch("/staff/:id/role", updateStaffRole);
router.get("/health", getHealth);
router.get("/health/infrastructure", getInfrastructure);
router.get("/analytics/report", getAnalyticsReport);
router.get("/analytics/report.pdf", getAnalyticsPdf);
router.get("/verification-feedback", listFeedback);
router.get("/verification-feedback/:id", getFeedback);
router.patch("/verification-feedback/:id", reviewFeedbackDecision);
router.get("/learnings/:id/attempts", getAdminAttempts);
router.get("/learning-attempts/:attemptId", getAttemptDetails);
router.get("/users/:userId/learning-attempts", getUserAttempts);

router.get("/dashboard/stats", getDashboardStats);
router.get("/dashboard/recent-users", getRecentUsers);
router.get("/guardians", getGuardiansForAdmin);
router.patch("/users/:id/block", setUserBlocked);

export default router;
