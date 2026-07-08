// Timestamp helpers. Two formats coexist in the DB:
//   - GitHub payloads:   "2026-07-07T08:04:11Z"        (ISO, explicit zone)
//   - SQLite defaults:   "2026-07-07 08:04:11"          (datetime('now') — UTC but NO zone)
// Date.parse treats the second form as LOCAL time — a classic silent bug. Normalize first.

export const HOURS_24 = 24 * 60 * 60 * 1000;

export function toMs(t: string | null | undefined): number {
  if (!t) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(t)) {
    return Date.parse(t.replace(" ", "T") + "Z"); // SQLite datetime('now') is UTC
  }
  return Date.parse(t);
}

// Six-minute tenths with a 0.1 floor (build plan S2).
export function tokensFor(startMs: number, endMs: number): number {
  const minutes = (endMs - startMs) / 60_000;
  return Math.max(0.1, Math.ceil(minutes / 6) / 10);
}
