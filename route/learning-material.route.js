import express from "express";

import {
  getPublishedLearningById,
  getPublishedLearnings,
} from "../controller/learning.controller.js";

const router = express.Router();

router.get("/", getPublishedLearnings);
router.get("/:id", getPublishedLearningById);

export default router;
