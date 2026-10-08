import mongoose, { Schema } from "mongoose";

const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model });
const event = new Schema({
  kind: { type: String, required: true, index: true },
  user: ref("User"), actor: ref("User"),
  source: { type: String, default: "moneykee" },
  entityType: String, entityId: String,
  outcome: String, tool: String, reason: String,
  occurredAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });
event.index({ kind: 1, occurredAt: -1 });
event.index({ user: 1, occurredAt: -1 });
event.index({ kind: 1, user: 1, occurredAt: 1 }, { unique: true, partialFilterExpression: { kind: "activity" } });
export const OperationEvent = mongoose.model("OperationEvent", event);

const alert = new Schema({
  key: { type: String, required: true, unique: true },
  type: { type: String, enum: ["sos", "guardian_alert", "suspicious_limit", "account_lock", "manual"], required: true },
  title: { type: String, required: true, maxlength: 200 },
  user: ref("User"), entityId: String,
  severity: { type: String, enum: ["elevated", "high", "critical"], default: "elevated" },
  status: { type: String, enum: ["open", "acknowledged", "resolved"], default: "open" },
  verdict: { type: String, enum: ["unreviewed", "confirmed", "false_positive"], default: "unreviewed" },
  firstActionAt: Date, resolvedAt: Date, reviewedBy: ref("User"),
  resolution: { type: String, default: "", maxlength: 2000 },
  source: { type: String, default: "moneykee" },
}, { timestamps: true, optimisticConcurrency: true });
alert.index({ status: 1, severity: 1, createdAt: -1 });
export const SecurityAlert = mongoose.model("SecurityAlert", alert);

const caseSchema = new Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  user: ref("User"), alert: ref("SecurityAlert"), assignedTo: ref("User"), createdBy: ref("User"),
  status: { type: String, enum: ["open", "in_progress", "resolved"], default: "open" },
  severity: { type: String, enum: ["elevated", "high", "critical"], default: "elevated" },
  notes: [{ body: { type: String, maxlength: 2000 }, actor: ref("User"), at: { type: Date, default: Date.now } }],
  resolution: { type: String, default: "", maxlength: 2000 },
  firstActionAt: Date, resolvedAt: Date, resolvedBy: ref("User"),
}, { timestamps: true, optimisticConcurrency: true });
caseSchema.index({ status: 1, createdAt: -1 });
export const SupportCase = mongoose.model("SupportCase", caseSchema);

const audit = new Schema({
  actor: ref("User"), actorRole: String, action: String, resource: String, resourceId: String,
  outcome: String, reason: { type: String, maxlength: 2000 },
  changes: { status: String, severity: String, verdict: String, adminRole: String, assignedTo: String, isBlocked: Boolean },
  // Never store request bodies: they may contain credentials, OTPs or financial details.
}, { timestamps: true });
audit.index({ createdAt: -1 });
export const AuditLog = mongoose.model("AuditLog", audit);

const availability = new Schema({
  service: { type: String, required: true }, available: Boolean, latencyMs: Number,
  checkedAt: { type: Date, default: Date.now },
}, { timestamps: true });
availability.index({ service: 1, checkedAt: -1 });
export const AvailabilitySample = mongoose.model("AvailabilitySample", availability);

const progress = new Schema({
  user: { ...ref("User"), required: true }, learning: { ...ref("Learning"), required: true },
  quizVersion: Number, startedAt: { type: Date, required: true }, completedAt: Date,
  durationMs: Number, attempts: { type: Number, default: 0 }, additionalQuestions: { type: Number, default: 0 },
}, { timestamps: true });
progress.index({ user: 1, learning: 1, quizVersion: 1 }, { unique: true });
export const LearningProgress = mongoose.model("LearningProgress", progress);
