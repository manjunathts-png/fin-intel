"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { buildTrackRecord, niftyForwardReturn, _config } = require("./track_record");

// Synthetic Nifty series: 60 consecutive "trading days", close = 100 + i
const NIFTY = Array.from({ length: 60 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  close: 100 + i,
}));

function row(pick_date, rank, ret_21d, extra = {}) {
  return { pick_date, symbol: `S${rank}`, rank, ret_5d: null, ret_10d: null, ret_21d, ...extra };
}

test("niftyForwardReturn enters strictly after pick_date and exits N bars later", () => {
  // pick 2026-01-05 → entry = first date > pick_date = 2026-01-06 (close 105)
  // exit = 21 trading days later = index+21 → close 126
  const r = niftyForwardReturn(NIFTY, "2026-01-05", 21);
  assert.ok(Math.abs(r - ((126 / 105 - 1) * 100)) < 1e-9);
});

test("niftyForwardReturn returns null when the window has not resolved", () => {
  assert.strictEqual(niftyForwardReturn(NIFTY, "2026-02-25", 21), null);
  assert.strictEqual(niftyForwardReturn(NIFTY, "2026-03-15", 5), null);   // pick after last bar
  assert.strictEqual(niftyForwardReturn([], "2026-01-05", 21), null);
});

test("buildTrackRecord summary pools per-pick returns with net-of-cost stats", () => {
  const rows = [
    row("2026-01-05", 1, 10), row("2026-01-05", 5, -2), row("2026-01-05", 30, 4),
    row("2026-01-06", 2, 6),  row("2026-01-06", 40, null),   // unresolved excluded
  ];
  const tr = buildTrackRecord(rows, NIFTY, { costPct: 0.30 });
  const s21 = tr.summary.ret_21d;
  assert.strictEqual(s21.top10.n, 3);            // ranks 1, 5, 2
  assert.strictEqual(s21.top50.n, 4);
  assert.ok(Math.abs(s21.top10.mean - (10 - 2 + 6) / 3) < 0.01);
  assert.ok(Math.abs(s21.top10.meanNet - ((10 - 2 + 6) / 3 - 0.3)) < 0.01);
  // hit rate: 2 of 3 top-10 positive
  assert.ok(Math.abs(s21.top10.hitRate - 66.67) < 0.1);
});

test("buildTrackRecord series has one point per cohort date with nifty baseline", () => {
  const rows = [
    row("2026-01-05", 1, 10), row("2026-01-05", 30, 4),
    row("2026-01-06", 3, -5),
  ];
  const tr = buildTrackRecord(rows, NIFTY, { costPct: 0.30 });
  assert.strictEqual(tr.series.length, 2);
  const d1 = tr.series[0];
  assert.strictEqual(d1.date, "2026-01-05");
  assert.ok(Math.abs(d1.top10 - (10 - 0.3)) < 0.01);           // only rank 1 in top-10
  assert.ok(Math.abs(d1.top50 - ((10 + 4) / 2 - 0.3)) < 0.01);
  assert.ok(d1.nifty != null);
});

test("buildTrackRecord distribution buckets cover all resolved picks", () => {
  const rows = [
    row("2026-01-05", 1, -15), row("2026-01-05", 2, -7), row("2026-01-05", 3, 1),
    row("2026-01-05", 4, 8),   row("2026-01-05", 5, 25),
  ];
  const tr = buildTrackRecord(rows, NIFTY);
  const total = tr.distribution.reduce((s, b) => s + b.count, 0);
  assert.strictEqual(total, 5);
  assert.strictEqual(tr.distribution.find((b) => b.label === "> 20%").count, 1);
});

test("buildTrackRecord rotation compounds non-overlapping cohorts", () => {
  // Three cohorts 30+ days apart → all eligible; each top-10 return +10 gross
  const rows = [
    row("2026-01-05", 1, 10), row("2026-02-06", 1, 10), row("2026-03-10", 1, 10),
  ];
  // Extend nifty far enough that all three resolve
  const nifty = Array.from({ length: 120 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    close: 100,
  }));
  const tr = buildTrackRecord(rows, nifty, { costPct: 0 });
  assert.ok(tr.rotation.length >= 3);
  const final = tr.rotation[tr.rotation.length - 1];
  assert.ok(Math.abs(final.strategy - 100 * 1.1 ** 3) < 0.5);  // three compounded +10% legs
  assert.ok(Math.abs(final.nifty - 100) < 1e-9);               // flat nifty
});

test("buildTrackRecord rotation skips cohorts inside the holding window", () => {
  // Second cohort only 5 days after the first → skipped (overlapping)
  const rows = [
    row("2026-01-05", 1, 10), row("2026-01-10", 1, 50),
  ];
  const tr = buildTrackRecord(rows, NIFTY, { costPct: 0 });
  // rotation gated to >=3 points; with one eligible cohort it stays empty
  assert.deepStrictEqual(tr.rotation, []);
});

test("buildTrackRecord tolerates missing nifty series", () => {
  const rows = [row("2026-01-05", 1, 10)];
  const tr = buildTrackRecord(rows, null);
  assert.strictEqual(tr.series[0].nifty, null);
  assert.strictEqual(tr.summary.ret_21d.top10.n, 1);
});

test("cost constant matches ml/config.py", () => {
  assert.strictEqual(_config.ROUND_TRIP_COST_PCT, 0.30);
});
