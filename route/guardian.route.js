import express from "express";
import {
  createGuardian,
  getGuardians,
  getGuardian,
  updateGuardian,
  deleteGuardian,
  updateGuardianAccounts,
  acceptGuardianInvite,
  sendReciprocalPrimaryInvite,
  rejectGuardianInvite,
  resendGuardianInvite,
  makeGuardianPrimary,
  approvePrimaryGuardianChange,
  rejectPrimaryGuardianChange,
  requestGuardianDeletion,
  sendGuardianDeletionOtp,
  verifyGuardianDeletionOtp,
} from "../controller/guardian.controller.js";
import { protect } from "../middleware/auth.middleware.js";

const router = express.Router();

router.use(protect);

router.route("/")
  .post(createGuardian)
  .get(getGuardians);

router.post("/:id/accept", acceptGuardianInvite);
router.post(
  "/:id/reciprocal-primary-invite",
  sendReciprocalPrimaryInvite
);
router.post("/:id/reject", rejectGuardianInvite);
router.post("/:id/resend-invite", resendGuardianInvite);
router.put("/:id/make-primary", makeGuardianPrimary);
router.post(
  "/primary-change/:requestId/approve",
  approvePrimaryGuardianChange
);
router.post(
  "/primary-change/:requestId/reject",
  rejectPrimaryGuardianChange
);
router.post("/:id/delete/request", requestGuardianDeletion);
router.post("/:id/delete/:requestId/send-otp", sendGuardianDeletionOtp);
router.post("/:id/delete/:requestId/verify-otp", verifyGuardianDeletionOtp);

router.route("/:id")
  .get(getGuardian)
  .put(updateGuardian)
  .delete(deleteGuardian);

// Update accounts for a guardian
router.put("/:id/accounts", updateGuardianAccounts);

export default router;
