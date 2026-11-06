import express from "express";
import { protect, optionalAuth } from "../middleware/auth.middleware.js";
import { getQuiz, submitAttempt, getMyAttempts, getMyCompletedLearnings } from "../controller/learning-attempt.controller.js";

import {
  getPublishedLearningById,
  getPublishedLearnings,
} from "../controller/learning.controller.js";

const router = express.Router();

router.get("/", getPublishedLearnings);
router.get("/completed/me", protect, getMyCompletedLearnings);
router.get("/:id/quiz", protect, getQuiz);
router.post("/:id/attempts", protect, submitAttempt);
router.get("/:id/attempts/me", protect, getMyAttempts);
// Public; a signed-in reader is attributed so module openings can be counted per user.
router.get("/:id", optionalAuth, getPublishedLearningById);

export default router;
