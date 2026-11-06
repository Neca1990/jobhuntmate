// When the hourly search should run: some user is in their active hours and the most eager of them is due.
// Mirrors engine/schedule.py, which still checks each site and user itself.
import { TIMEZONES } from "./geo.gen.js";

const TOLERANCE_MIN = 15;
const minutes = (hm) => { const [h, m] = String(hm || "00:00").split(":").map(Number); return h * 60 + m; };

function localMinutes(now, tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  const parts = fmt.formatToParts(now);
  return Number(parts.find((p) => p.type === "hour").value) * 60 + Number(parts.find((p) => p.type === "minute").value);
}

export function activeNow(settings, now) {
  const sched = settings.schedule || {};
  const tz = sched.timezone || TIMEZONES[settings.country || "RS"] || "UTC";
  const local = localMinutes(now, tz);
  const from = minutes(sched.active_from || "00:00"), to = minutes(sched.active_to || "23:59");
  return from <= to ? local >= from && local <= to : local >= from || local <= to;
}

export function isDue(users, lastRun, now) {
  const active = users.filter((u) => (u.searches || []).length && activeNow(u, now));
  if (!active.length) return { due: false, reason: "nobody_active" };
  const every = Math.min(...active.map((u) => Math.max(1, Number(u.schedule?.interval_hours) || 2)));
  const since = lastRun ? (now - new Date(lastRun)) / 60000 : Infinity;
  return since >= every * 60 - TOLERANCE_MIN ? { due: true, users: active.length } : { due: false, reason: "not_yet" };
}
