import express from "express";
import {
  createAccount,
  getAccounts,
  getAccount,
  getEmergencyStatus,
  activateEmergencyMode,
  alertGuardian,
  updateEmergencyLocation,
  getEmergencyLocation,
  sendEmergencyClearUserOtp,
  verifyEmergencyClearUserOtp,
  clearEmergencyByPrimaryGuardian,
  updateAccount,
  deleteAccount,
  requestAccountDeletion,
  sendAccountDeletionOtp,
  verifyAccountDeletionOtp,
  simulateLimitIncrease,
  sendLimitIncreaseOtp,
  verifyLimitIncreaseOtp,
  timeoutLimitIncreaseOtp,
} from "../controller/account.controller.js";
import { protect } from "../middleware/auth.middleware.js";
import { upload } from "../middleware/multer.middleware.js";

const router = express.Router();

router.use(protect); // All routes require authentication

router.route("/")
  .post(upload.single("image"), createAccount)
  .get(getAccounts);

router.get("/emergency/status", getEmergencyStatus);
router.post("/emergency/activate", activateEmergencyMode);
router.post("/emergency/alert-guardian", alertGuardian);
router.get("/emergency/location", getEmergencyLocation);
router.patch("/emergency/location", updateEmergencyLocation);
router.post("/emergency/clear/send-user-otp", sendEmergencyClearUserOtp);
router.post("/emergency/clear/verify-user-otp", verifyEmergencyClearUserOtp);
router.post(
  "/emergency/:sessionId/guardian-clear",
  clearEmergencyByPrimaryGuardian
);
router.post("/:id/test/increase-limit", simulateLimitIncrease);
router.post("/:id/delete/request", requestAccountDeletion);
router.post("/:id/delete/:requestId/send-otp", sendAccountDeletionOtp);
router.post("/:id/delete/:requestId/verify-otp", verifyAccountDeletionOtp);
router.post(
  "/:id/test/limit-increase-requests/:requestId/send-otp",
  sendLimitIncreaseOtp
);
router.post(
  "/:id/test/limit-increase-requests/:requestId/verify-otp",
  verifyLimitIncreaseOtp
);
router.post(
  "/:id/test/limit-increase-requests/:requestId/timeout",
  timeoutLimitIncreaseOtp
);

router.route("/:id")
  .get(getAccount)
  .put(updateAccount)
  .delete(deleteAccount);

export default router;
