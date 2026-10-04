import express from "express";
import {
  createLearning,
  updateLearning,
  deleteLearning,
  getLearnings,
  getLearningById,
} from "../controller/learning.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/multer.middleware.js";

const router = express.Router();

// Full learning records include answer keys and are admin-only.
router.use(protect, isAdmin);
router.get("/", getLearnings);
router.get("/:id", getLearningById);

// Admin protected routes

router.post("/", upload.single("image"), createLearning);
router.put("/:id", upload.single("image"), updateLearning);
router.patch("/:id", upload.single("image"), updateLearning);
router.delete("/:id", deleteLearning);

export default router;
