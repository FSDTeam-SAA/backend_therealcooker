import express from "express";
import {
  checkVerification,
  createVerification,
  deleteVerification,
  getVerifications,
  updateVerification,
  uploadVerificationCSV,
} from "../controller/verification.controller.js";
import { submitFeedback } from "../controller/verification-feedback.controller.js";
import { protect, isAdmin, optionalAuth } from "../middleware/auth.middleware.js";
import { uploadCSVFile } from "../middleware/multer.middleware.js";

const router = express.Router();

// Public lookup must be registered before the admin middleware.
// Public lookup; a signed-in user is recorded with the search when the app sends its token.
router.post("/check", optionalAuth, checkVerification);
// Community feedback on a contact the lookup did not find; one vote per signed-in user.
router.post("/feedback", protect, submitFeedback);

// Management routes can only be used by admins.
router.use(protect);
router.use(isAdmin);

router.get("/", getVerifications);
router.post("/", createVerification);
router.post("/upload-csv", uploadCSVFile.single("file"), uploadVerificationCSV);
router.put("/:id", updateVerification);
router.patch("/:id", updateVerification);
router.delete("/:id", deleteVerification);

export default router;
