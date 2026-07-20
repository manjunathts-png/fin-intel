"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { computeFundStats, navFreshness, _config } = require("./momentum");

// Defensive parity fix alongside the 2026-07-20 ETF momentum incident:
// computeFundStats had the same latent risk as the old etf_momentum.js code
// (pctReturn treats the series' last entry as "now" regardless of its
// actual date), just much less likely to trigger since AMFI publishes NAV
// every business day. Guarded the same way for consistency.

const NOW = new Date("2026-07-20T00:00:00Z").getTime();

function navs(dates, values) {
  return dates.map((date, i) => ({ date, nav: values[i] }));
}

function dailySeries(nowMs, days, startVal = 100, step = 0.1) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(nowMs - (days - 1 - i) * 86400000);
    out.push({ date: d.toISOString().slice(0, 10), nav: startVal + i * step });
  }
  return out;
}

test("navFreshness: fresh when the latest NAV is recent", () => {
  const n = dailySeries(NOW, 400);
  assert.strictEqual(navFreshness(n, NOW).fresh, true);
});

test("navFreshness: stale when the latest NAV is old, matching MAX_STALE_NAV_DAYS", () => {
  const oldDate = new Date(NOW - (_config.MAX_STALE_NAV_DAYS + 5) * 86400000).toISOString().slice(0, 10);
  const n = navs(["2025-01-01", oldDate], [100, 105]);
  const result = navFreshness(n, NOW);
  assert.strictEqual(result.fresh, false);
  assert.ok(result.staleDays > _config.MAX_STALE_NAV_DAYS);
});

test("navFreshness: empty series is not fresh", () => {
  assert.strictEqual(navFreshness([], NOW).fresh, false);
});

test("computeFundStats: normal fresh fund computes all horizons", () => {
  const n = dailySeries(NOW, 400);
  const stats = computeFundStats(n, NOW);
  assert.strictEqual(stats.navStale, false);
  assert.ok(stats.ret1w != null);
  assert.ok(stats.ret1y != null);
});

test("computeFundStats: stale NAV nulls short-horizon returns but keeps CAGR/drawdown", () => {
  // 5 years of history, but the feed stopped updating 30 days ago — a
  // realistic "broken data feed" shape, not just a short series.
  const stale = dailySeries(NOW - 30 * 86400000, 365 * 5);
  const stats = computeFundStats(stale, NOW);
  assert.strictEqual(stats.navStale, true);
  assert.strictEqual(stats.ret1w, null, "stale feed must not fabricate a flat short-horizon return");
  assert.strictEqual(stats.ret1m, null);
  assert.strictEqual(stats.ret1y, null);
  assert.strictEqual(stats.z1w, null);
  // CAGR/drawdown look backward over history and aren't distorted by a
  // stale tail the same way — they should still compute.
  assert.ok(stats.cagr3y != null, "long-run CAGR should still compute from a stale-but-present series");
  assert.ok(stats.navStaleDays >= 30);
});

test("computeFundStats: navCount and navStartDate are unaffected by staleness", () => {
  const stale = dailySeries(NOW - 30 * 86400000, 100);
  const stats = computeFundStats(stale, NOW);
  assert.strictEqual(stats.navCount, 100);
  assert.strictEqual(stats.navStartDate, stale[0].date);
});

test("config constant is sane", () => {
  assert.strictEqual(_config.MAX_STALE_NAV_DAYS, 10);
});
