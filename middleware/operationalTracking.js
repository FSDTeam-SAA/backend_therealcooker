import { OperationEvent, AuditLog } from "../model/operation.model.js";
import { safelyTrack } from "../utils/operations.js";

export function operationalTracking(req, res, next) {
  let snapshot;
  const json = res.json;
  res.json = function (body) {
    // Capture before Express restores mount paths and route params after dispatch.
    snapshot = { user: req.user, resource: `${req.baseUrl}${req.route?.path || req.path}`, resourceId: req.params?.id || req.params?.attemptId,
      reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 2000) : undefined,
      changes: Object.fromEntries(["status", "severity", "verdict", "adminRole", "assignedTo", "isBlocked"].filter(key => ["string", "boolean"].includes(typeof req.body?.[key])).map(key => [key, typeof req.body[key] === "string" ? req.body[key].slice(0, 100) : req.body[key]])) };
    return json.call(this, body);
  };
  res.on("finish", () => {
    const user = snapshot?.user || req.user;
    if (!user || res.statusCode >= 400) return;
    if (user.role !== "admin") {
      // One daily record per user supports distinct active-user windows without logging sensitive URLs.
      const day = new Date(); day.setUTCHours(0, 0, 0, 0);
      void safelyTrack(() => OperationEvent.updateOne(
        { kind: "activity", user: user._id, occurredAt: day },
        { $setOnInsert: { kind: "activity", user: user._id, occurredAt: day, source: "moneykee" } },
        { upsert: true }
      ));
    }
    if (user.role === "admin" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      void safelyTrack(() => AuditLog.create({ actor: user._id, actorRole: user.adminRole || "superadmin",
        action: req.method, resource: snapshot?.resource,
        resourceId: snapshot?.resourceId, outcome: String(res.statusCode),
        reason: snapshot?.reason,
        changes: snapshot?.changes,
      }));
    }
  });
  next();
}
