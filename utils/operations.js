import mongoose from "mongoose";
import { OperationEvent, SecurityAlert } from "../model/operation.model.js";

// Telemetry must not interrupt a user's emergency or change an existing API outcome.
export async function safelyTrack(work) {
  if (mongoose.connection.readyState !== 1) return;
  try { return await work(); }
  catch (error) { console.error("Operational tracking failed:", error.message); }
}
export const recordEvent = (data) => safelyTrack(() => OperationEvent.create(data));
export const recordAlert = (data) => safelyTrack(() => SecurityAlert.findOneAndUpdate(
  { key: data.key }, { $setOnInsert: data }, { upsert: true, new: true, setDefaultsOnInsert: true }
));
export const resolveTrackedEmergency = (session, actor) => safelyTrack(async () => {
  await SecurityAlert.updateOne({ key: `sos:${session._id}` }, { $set: {
    status: "resolved", resolvedAt: session.resolvedAt, reviewedBy: actor,
    resolution: `Cleared by ${session.clearedByRole}`,
  } });
  await OperationEvent.create({ kind: "panic_resolved", user: session.user, actor, entityType: "emergency", entityId: String(session._id), outcome: session.clearedByRole });
});
