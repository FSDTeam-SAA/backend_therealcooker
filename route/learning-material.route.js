import express from "express";
import { protect } from "../middleware/auth.middleware.js";
import { getQuiz, submitAttempt, getMyAttempts } from "../controller/learning-attempt.controller.js";

import {
  getPublishedLearningById,
  getPublishedLearnings,
} from "../controller/learning.controller.js";

const router = express.Router();

router.get("/", getPublishedLearnings);
router.get("/:id/quiz", protect, getQuiz);
router.post("/:id/attempts", protect, submitAttempt);
router.get("/:id/attempts/me", protect, getMyAttempts);
router.get("/:id", getPublishedLearningById);

export default router;
