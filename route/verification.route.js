import express from "express";
import {
  createVerification,
  deleteVerification,
  getVerifications,
  updateVerification,
  uploadVerificationCSV,
} from "../controller/verification.controller.js";
import { protect, isAdmin } from "../middleware/auth.middleware.js";
import { uploadCSVFile } from "../middleware/multer.middleware.js";

const router = express.Router();

// Routes can be used by admin
router.use(protect);
router.use(isAdmin);

router.get("/", getVerifications);
router.post("/", createVerification);
router.post("/upload-csv", uploadCSVFile.single("file"), uploadVerificationCSV);
router.put("/:id", updateVerification);
router.patch("/:id", updateVerification);
router.delete("/:id", deleteVerification);

export default router;
