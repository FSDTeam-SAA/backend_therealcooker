import express from "express";
import {
  getDashboardStats,
  getRecentUsers,
  getGuardiansForAdmin,
  setUserBlocked,
} from "../controller/admin.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect, isAdmin);

router.get("/dashboard/stats", getDashboardStats);
router.get("/dashboard/recent-users", getRecentUsers);
router.get("/guardians", getGuardiansForAdmin);
router.patch("/users/:id/block", setUserBlocked);

export default router;
