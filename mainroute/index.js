import express from "express";
import accountRoutes from "../route/account.route.js";
import activityRoutes from "../route/activity.route.js";
import adminRoutes from "../route/admin.route.js";
import authRoutes from "../route/auth.route.js";
import guardianRoutes from "../route/guardian.route.js";
import kycRoutes from "../route/kyc.route.js";
import newsRoutes from "../route/news.route.js";
import learningRoutes from "../route/learning.route.js";
import learningMaterialRoutes from "../route/learning-material.route.js";
import verificationRoutes from "../route/verification.route.js";
import notificationRoutes from "../route/notification.route.js";
import termsRoutes from "../route/terms.route.js";
import userRoutes from "../route/user.route.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/accounts", accountRoutes);
router.use("/guardians", guardianRoutes);
router.use("/news", newsRoutes);
router.use("/learnings", learningRoutes);
router.use("/learning", learningRoutes);
router.use("/learning-materials", learningMaterialRoutes);
router.use("/verifications", verificationRoutes);
router.use("/verification", verificationRoutes);
router.use("/terms", termsRoutes);
router.use("/admin", adminRoutes);
router.use("/users", userRoutes);
// Mounted before userRoutes would matter (it doesn't here — different
// sub-path), kept separate from user.route.js since KYC is its own concern
// with its own unauthenticated webhook route.
router.use("/users/kyc", kycRoutes);
router.use("/activities", activityRoutes);
router.use("/notifications", notificationRoutes);

export default router;
