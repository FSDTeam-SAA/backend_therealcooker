import "dotenv/config";
import mongoose from "mongoose";
import { EmergencySession } from "../model/emergencySession.model.js";
import { LimitIncreaseRequest } from "../model/limitIncreaseRequest.model.js";
import { Notification } from "../model/notification.model.js";
import { SecurityAlert, OperationEvent } from "../model/operation.model.js";

const apply = process.argv.includes("--apply");
async function event(data) {
  await OperationEvent.updateOne({ kind: data.kind, entityId: data.entityId, outcome: data.outcome }, { $setOnInsert: { ...data, createdAt: data.occurredAt, updatedAt: data.occurredAt } }, { upsert: true, timestamps: false });
}
async function alert(data) {
  await SecurityAlert.updateOne({ key: data.key }, { $setOnInsert: { ...data, updatedAt: data.createdAt } }, { upsert: true, timestamps: false });
}
try {
  await mongoose.connect(process.env.MONGO_URI);
  const counts = await Promise.all([EmergencySession.countDocuments(), LimitIncreaseRequest.countDocuments({ isSuspicious: true }), Notification.countDocuments({ type: "guardian_alert" })]);
  console.log(`Source records: ${counts[0]} SOS sessions, ${counts[1]} suspicious simulated limit requests, ${counts[2]} guardian notifications (deduplicated by share ID on apply).`);
  if (!apply) console.log("Dry run. Use --apply to backfill recoverable operational history. No activity, lookup history or operator response times will be fabricated.");
  else {
    for await (const session of EmergencySession.find().lean().cursor()) {
      const createdAt = session.activatedAt || session.createdAt;
      await alert({ key: `sos:${session._id}`, type: "sos", title: "SOS emergency activated", severity: "critical", user: session.user, entityId: String(session._id), status: session.status === "resolved" ? "resolved" : "open", resolvedAt: session.resolvedAt, resolution: session.status === "resolved" ? `Cleared by ${session.clearedByRole || "existing safety flow"}` : "", createdAt });
      await event({ kind: "panic", user: session.user, actor: session.user, entityType: "emergency", entityId: String(session._id), outcome: "sos", occurredAt: createdAt });
      if (session.lockedAccounts?.length) await event({ kind: "protective_action", user: session.user, actor: session.user, entityType: "emergency", entityId: String(session._id), outcome: "accounts_locked", reason: "SOS emergency mode activated", occurredAt: createdAt });
    }
    for await (const request of LimitIncreaseRequest.find({ isSuspicious: true }).lean().cursor()) {
      await alert({ key: `limit:${request._id}`, type: "suspicious_limit", title: "Repeated transfer limit increase within 24 hours", severity: "elevated", user: request.user, entityId: String(request._id), source: "simulation", createdAt: request.createdAt });
      if (request.status === "locked") {
        await alert({ key: `lock:${request._id}`, type: "account_lock", title: "Accounts locked after limit verification failed", severity: "high", user: request.user, entityId: String(request._id), source: "simulation", createdAt: request.lockedAt || request.updatedAt });
        await event({ kind: "protective_action", user: request.user, actor: request.guardianUser, entityType: "limit_request", entityId: String(request._id), source: "simulation", outcome: "accounts_locked", occurredAt: request.lockedAt || request.updatedAt });
      }
    }
    for await (const notification of Notification.find({ type: "guardian_alert", "data.liveLocationShareId": { $exists: true } }).sort({ createdAt: 1 }).lean().cursor()) {
      const shareId = notification.data.liveLocationShareId;
      await alert({ key: `guardian:${shareId}`, type: "guardian_alert", title: "User requested guardian attention", severity: "high", user: notification.sender, entityId: shareId, createdAt: notification.createdAt });
      await event({ kind: "panic", user: notification.sender, actor: notification.sender, entityType: "guardian_alert", entityId: shareId, outcome: "guardian_alert", occurredAt: notification.createdAt });
    }
    console.log("Backfill completed. Existing admin reviews and operational records were preserved.");
  }
} finally { await mongoose.disconnect(); }
