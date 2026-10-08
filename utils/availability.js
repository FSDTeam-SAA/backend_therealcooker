import mongoose from "mongoose";
import { AvailabilitySample } from "../model/operation.model.js";
import { safelyTrack } from "./operations.js";

export async function sampleAvailability() {
  const checkedAt = new Date();
  const start = Date.now();
  let available = false;
  try { await mongoose.connection.db.admin().ping(); available = true; } catch { /* captured as outage */ }
  const samples = [
    { service: "moneykee", available: true, latencyMs: 0, checkedAt },
    { service: "database", available, latencyMs: Date.now() - start, checkedAt },
  ];
  // Operator-configured health URLs only; no user supplied URLs or response content is retained.
  const integrations = JSON.parse(process.env.INTEGRATION_HEALTH_URLS || "{}");
  for (const [service, url] of Object.entries(integrations)) {
    if (!/^https?:\/\//.test(String(url))) continue;
    const started = Date.now(); let healthy = false;
    try { const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" }); healthy = response.ok; await response.body?.cancel(); } catch { /* captured as outage */ }
    samples.push({ service, available: healthy, latencyMs: Date.now() - started, checkedAt });
  }
  await safelyTrack(() => AvailabilitySample.insertMany(samples));
}
export function startAvailabilityMonitor() {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await sampleAvailability(); } catch (error) { console.error("Availability monitor failed:", error.message); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(tick, 60_000); timer.unref();
  return timer;
}
