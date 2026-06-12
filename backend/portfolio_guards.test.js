"use strict";

/**
 * Unit tests for the portfolio-level guards.
 * Run with:  node --test backend/portfolio_guards.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { applySectorCap, sectorBreakdown, _config } = require("./portfolio_guards");

// Ranked list: scores descending, sector assigned per index via `sectorOf`.
function ranked(n, sectorOf) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`,
    sector: sectorOf(i),
    compositeScore: 100 - i,
    signalCount: 0,
  }));
}

test("diversified top-50 is untouched", () => {
  // 10 sectors round-robin → 5 per sector in top 50, well under the cap (15)
  const stocks = ranked(60, (i) => `SEC${i % 10}`);
  const docked = applySectorCap(stocks, { topN: 50 });
  assert.strictEqual(docked, 0);
  assert.ok(stocks.every((s) => !s.sectorCapped && s.sectorCapPenalty === 0));
  assert.strictEqual(stocks[0].compositeScore, 100, "scores unchanged");
});

test("crowded sector gets docked beyond the cap", () => {
  // First 25 stocks all IT — cap is floor(50 × 0.30) = 15, so 10 docked
  const stocks = ranked(60, (i) => (i < 25 ? "IT" : `SEC${i % 8}`));
  const docked = applySectorCap(stocks, { topN: 50 });
  assert.strictEqual(docked, 10, "IT names 16-25 exceed the 15-name cap");
  const capped = stocks.filter((s) => s.sectorCapped);
  assert.strictEqual(capped.length, 10);
  assert.ok(capped.every((s) => s.sector === "IT"));
  assert.ok(capped.every((s) => s.sectorCapPenalty === -_config.SECTOR_CAP_DOCK));
  // The first 15 IT names keep their score
  assert.strictEqual(stocks[14].compositeScore, 100 - 14);
  // The 16th IT name is docked
  assert.strictEqual(stocks[15].compositeScore, 100 - 15 - _config.SECTOR_CAP_DOCK);
});

test("stocks outside the top-N window are never docked", () => {
  // Everything beyond rank 50 is one sector — irrelevant, cap only guards the window
  const stocks = ranked(100, (i) => (i < 50 ? `SEC${i % 10}` : "CROWDED"));
  const docked = applySectorCap(stocks, { topN: 50 });
  assert.strictEqual(docked, 0);
  assert.ok(stocks.slice(50).every((s) => !s.sectorCapped));
});

test("dock is soft — score floors at 0, stock is not removed", () => {
  const stocks = ranked(20, () => "ONLY");
  for (const s of stocks) s.compositeScore = 2;   // near-zero scores
  const docked = applySectorCap(stocks, { topN: 20, maxFrac: 0.25 });
  assert.ok(docked > 0);
  assert.ok(stocks.every((s) => s.compositeScore >= 0), "score never goes negative");
  assert.strictEqual(stocks.length, 20, "nothing removed");
});

test("missing sector falls into one Unknown bucket", () => {
  const stocks = ranked(50, () => null);
  const docked = applySectorCap(stocks, { topN: 50 });
  assert.strictEqual(docked, 50 - 15, "all share the Unknown bucket — overflow docked");
});

test("sectorBreakdown reports the top-N mix", () => {
  const stocks = ranked(50, (i) => (i < 30 ? "BANKS" : "AUTO"));
  const mix = sectorBreakdown(stocks, 50);
  assert.deepStrictEqual(mix[0], { sector: "BANKS", count: 30, pct: 60 });
  assert.deepStrictEqual(mix[1], { sector: "AUTO", count: 20, pct: 40 });
});
