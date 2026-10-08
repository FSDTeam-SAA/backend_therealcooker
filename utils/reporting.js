import AppError from "../errors/AppError.js";
export const DAY = 86_400_000;
export function reportingWindow(query = {}, now = new Date()) {
  const days = query.days === undefined ? 30 : Number(query.days);
  if (![7, 30, 90].includes(days)) throw new AppError(400, "days must be 7, 30 or 90");
  const end = new Date(now); end.setUTCHours(23, 59, 59, 999);
  const start = new Date(end); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - days + 1);
  return { days, start, end };
}
export const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function pageOptions(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
}
export function dateFilter(query, field = "createdAt") {
  const range = {};
  for (const [key, op] of [["from", "$gte"], ["to", "$lte"]]) {
    if (!query[key]) continue;
    const value = new Date(query[key]);
    if (!Number.isFinite(value.getTime())) throw new AppError(400, "Invalid date filter");
    if (key === "to" && /^\d{4}-\d{2}-\d{2}$/.test(query[key])) value.setUTCHours(23, 59, 59, 999);
    range[op] = value;
  }
  if (range.$gte && range.$lte && range.$gte > range.$lte) throw new AppError(400, "from must precede to");
  return Object.keys(range).length ? { [field]: range } : {};
}
export function trendRows(start, end, series) {
  const maps = Object.fromEntries(Object.entries(series).map(([key, rows]) => [key, new Map(rows.map(row => [row._id, row.count]))]));
  const result = [];
  for (let day = new Date(start); day <= end; day = new Date(day.getTime() + DAY)) {
    const date = day.toISOString().slice(0, 10);
    result.push({ date, ...Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, map.get(date) || 0])) });
  }
  return result;
}
export const percent = (count, total) => total ? Math.round(count / total * 1000) / 10 : 0;
