"use strict";
const fs = require("fs");

// ─── File I/O ─────────────────────────────────────────────────────────────────

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// ─── Date ─────────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// Elapsed hours since an ISO timestamp, discounting full weekend (Sat/Sun,
// UTC calendar day) overlap. NSE/AMFI don't publish on weekends, so anything
// refreshed only by the nightly cron (Mon-Fri) genuinely can't get newer data
// then — a flat wall-clock threshold treats that normal gap as an outage every
// single weekend. UTC vs IST day boundaries differ by 5.5h, an acceptable
// approximation for a coarse freshness gate (not used for exact scheduling).
function businessHoursAge(isoStr, nowMs = Date.now()) {
  if (!isoStr) return Infinity;
  const start = new Date(isoStr).getTime();
  if (isNaN(start)) return Infinity;
  if (nowMs <= start) return 0;

  const oneDay = 86400000;
  let weekendMs = 0;
  const dayStart = new Date(isoStr);
  dayStart.setUTCHours(0, 0, 0, 0);
  let cursor = dayStart.getTime();

  while (cursor < nowMs) {
    const dayEnd = cursor + oneDay;
    const overlapStart = Math.max(cursor, start);
    const overlapEnd   = Math.min(dayEnd, nowMs);
    if (overlapEnd > overlapStart) {
      const dow = new Date(cursor).getUTCDay(); // 0=Sun, 6=Sat
      if (dow === 0 || dow === 6) weekendMs += overlapEnd - overlapStart;
    }
    cursor = dayEnd;
  }
  return (nowMs - start - weekendMs) / (1000 * 60 * 60);
}

// ─── Math ─────────────────────────────────────────────────────────────────────

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

const stddev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

const median = (a) => {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// Returns null for non-finite inputs (catches both NaN and Infinity).
// Prefer this over checking isNaN, which passes Infinity through.
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : parseFloat(v.toFixed(d)));

const round2 = (v) => round(v, 2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { atomicWrite, daysAgo, mean, stddev, median, round, round2, sleep, businessHoursAge };
