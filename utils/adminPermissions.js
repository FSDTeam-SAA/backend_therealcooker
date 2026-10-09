export const ADMIN_ROLES = ["superadmin", "operations", "support", "analyst"];
export const rolePermissions = {
  superadmin: ["*"],
  operations: ["overview:read", "users:read", "users:write", "accounts:read", "banks:read", "banks:write", "alerts:read", "alerts:write", "cases:read", "cases:write", "events:read", "learning:read", "learning:results", "verification:read", "health:read"],
  support: ["overview:read", "users:read", "alerts:read", "cases:read", "cases:write", "learning:read", "learning:results", "health:read"],
  analyst: ["overview:read", "events:read", "learning:read", "health:read"],
};
export const permissionsFor = (user) => user?.role === "admin" ? rolePermissions[user.adminRole || "superadmin"] || [] : [];
export const can = (user, permission) => permissionsFor(user).some(p => p === "*" || p === permission);
export function routePermission(req) {
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  const action = ["GET", "HEAD"].includes(req.method) ? "read" : "write";
  let section = "users";
  if (/\/admin\/me$/.test(path)) return "overview:read";
  if (/\/dashboard\//.test(path)) section = path.endsWith("recent-users") ? "users" : "overview";
  else if (/\/staff/.test(path)) return "staff:write";
  else if (/\/audit/.test(path)) return "audit:read";
  else if (/\/alerts/.test(path)) section = "alerts";
  else if (/\/cases/.test(path)) section = "cases";
  else if (/\/events/.test(path)) section = "events";
  else if (/\/banks/.test(path)) section = "banks";
  else if (/\/accounts/.test(path)) section = "accounts";
  else if (/\/health/.test(path)) section = "health";
  else if (/\/learning-attempts|\/attempts(?:\/|$)/.test(path)) return "learning:results";
  else if (/\/learning/.test(path)) section = "learning";
  else if (/\/verification/.test(path)) section = "verification";
  else if (/\/news/.test(path)) section = "content";
  else if (/\/terms/.test(path)) section = "content";
  else if (/\/subscription/.test(path)) section = "billing";
  return `${section}:${action}`;
}
