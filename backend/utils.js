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

module.exports = { atomicWrite, daysAgo, mean, stddev, median, round, round2 };
