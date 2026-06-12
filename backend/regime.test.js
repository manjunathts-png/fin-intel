"use strict";

/**
 * Unit tests for the market-regime filter.
 * Run with:  node --test backend/regime.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { computeRegime, applyRegime, _config } = require("./regime");

// Build a universe with a given fraction above the 200DMA.
function universe(fracAbove, n = 100) {
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i}`,
    above200DMA: i < Math.round(fracAbove * n),
    compositeScore: 50,
    rsVsNifty3M: 0,
  }));
}

test("broad participation + rising index = risk_on", () => {
  const r = computeRegime({ stocks: universe(0.70), niftyReturns: { ret3m: 6 } });
  assert.strictEqual(r.regime, "risk_on");
  assert.strictEqual(r.weakPenalty, 0, "no penalty in a healthy tape");
  assert.strictEqual(r.breadthPct, 70);
});

test("narrow breadth = risk_off", () => {
  const r = computeRegime({ stocks: universe(0.30), niftyReturns: { ret3m: 1 } });
  assert.strictEqual(r.regime, "risk_off");
  assert.strictEqual(r.weakPenalty, _config.PENALTY_RISK_OFF);
});

test("index down hard forces risk_off even with okay breadth", () => {
  const r = computeRegime({ stocks: universe(0.52), niftyReturns: { ret3m: -8 } });
  assert.strictEqual(r.regime, "risk_off");
});

test("middling breadth = neutral with a small penalty", () => {
  const r = computeRegime({ stocks: universe(0.48), niftyReturns: { ret3m: 2 } });
  assert.strictEqual(r.regime, "neutral");
  assert.strictEqual(r.weakPenalty, _config.PENALTY_NEUTRAL);
});

test("no breadth data degrades to neutral, no crash", () => {
  const r = computeRegime({ stocks: [], niftyReturns: null });
  assert.strictEqual(r.regime, "neutral");
  assert.strictEqual(r.breadthPct, null);
});

test("applyRegime docks weak names but spares leaders", () => {
  const stocks = [
    { symbol: "LEADER", above200DMA: true,  rsVsNifty3M: 12, compositeScore: 80 },
    { symbol: "KNIFE",  above200DMA: false, rsVsNifty3M: -3, compositeScore: 60 },
    { symbol: "LAGGARD", above200DMA: true, rsVsNifty3M: -15, compositeScore: 55 },
  ];
  const info = { regime: "risk_off", weakPenalty: 12 };
  const n = applyRegime(stocks, info);
  assert.strictEqual(n, 2, "knife (below 200DMA) and laggard (RS<-10) docked");
  assert.strictEqual(stocks[0].compositeScore, 80, "leader untouched");
  assert.strictEqual(stocks[1].compositeScore, 48, "knife 60-12");
  assert.strictEqual(stocks[2].compositeScore, 43, "laggard 55-12");
});

test("applyRegime is a no-op in risk_on (weakPenalty 0)", () => {
  const stocks = [{ symbol: "KNIFE", above200DMA: false, rsVsNifty3M: -20, compositeScore: 60 }];
  const n = applyRegime(stocks, { regime: "risk_on", weakPenalty: 0 });
  assert.strictEqual(n, 0);
  assert.strictEqual(stocks[0].compositeScore, 60);
  assert.strictEqual(stocks[0].regimePenalty, 0);
});

// ── Adaptive regime: VIX + FII flows ──────────────────────────────────────────

test("panic VIX forces risk_off even with healthy breadth", () => {
  const r = computeRegime({
    stocks: universe(0.65), niftyReturns: { ret3m: 4 },
    macro: { indiaVix: 30, fiiNet5d: 0, ageDays: 0 },
  });
  assert.strictEqual(r.regime, "risk_off", "VIX ≥ 28 is a 2-vote bear trigger");
});

test("elevated VIX downgrades risk_on to neutral", () => {
  const calm = computeRegime({
    stocks: universe(0.65), niftyReturns: { ret3m: 4 },
    macro: { indiaVix: 13, fiiNet5d: 0, ageDays: 0 },
  });
  assert.strictEqual(calm.regime, "risk_on");
  const stressed = computeRegime({
    stocks: universe(0.65), niftyReturns: { ret3m: 4 },
    macro: { indiaVix: 24, fiiNet5d: 0, ageDays: 0 },
  });
  assert.strictEqual(stressed.regime, "neutral",
    "VIX 22-28 adds a bear vote — risk_on requires zero bear votes");
});

test("sustained FII selling + elevated VIX = risk_off", () => {
  const r = computeRegime({
    stocks: universe(0.50), niftyReturns: { ret3m: 1 },
    macro: { indiaVix: 23, fiiNet5d: -9500, ageDays: 1 },
  });
  assert.strictEqual(r.regime, "risk_off", "VIX vote + FII vote = 2 bear votes");
});

test("stale macro snapshot is ignored", () => {
  const r = computeRegime({
    stocks: universe(0.65), niftyReturns: { ret3m: 4 },
    macro: { indiaVix: 35, fiiNet5d: -20000, ageDays: 12 },
  });
  assert.strictEqual(r.regime, "risk_on", "macro older than 7d must not drive the regime");
  assert.strictEqual(r.indiaVix, null);
});

test("missing macro degrades to legacy behaviour", () => {
  const r = computeRegime({ stocks: universe(0.70), niftyReturns: { ret3m: 6 } });
  assert.strictEqual(r.regime, "risk_on");
});

test("risk_off amplifies the overextension dock by 50%", () => {
  const stocks = [
    { symbol: "STRETCHED", above200DMA: true, rsVsNifty3M: 15, compositeScore: 70, overextensionPenalty: -20 },
    { symbol: "CLEAN",     above200DMA: true, rsVsNifty3M: 12, compositeScore: 65, overextensionPenalty: 0 },
  ];
  const n = applyRegime(stocks, { regime: "risk_off", weakPenalty: 12 });
  // STRETCHED: strong leader (no weak dock) but overextended → extra -10 (50% of 20)
  assert.strictEqual(stocks[0].regimeOverextPenalty, 10);
  assert.strictEqual(stocks[0].compositeScore, 60);
  // CLEAN: untouched
  assert.strictEqual(stocks[1].regimeOverextPenalty, 0);
  assert.strictEqual(stocks[1].compositeScore, 65);
  assert.strictEqual(n, 1);
});

test("overextension amplifier only fires in risk_off", () => {
  for (const regime of ["neutral", "risk_on"]) {
    const stocks = [{ symbol: "S", above200DMA: true, rsVsNifty3M: 15, compositeScore: 70, overextensionPenalty: -20 }];
    applyRegime(stocks, { regime, weakPenalty: regime === "neutral" ? 4 : 0 });
    assert.strictEqual(stocks[0].regimeOverextPenalty, 0, `no amplifier in ${regime}`);
    assert.strictEqual(stocks[0].compositeScore, 70);
  }
});

test("weak + overextended stock takes both docks in risk_off", () => {
  const stocks = [{ symbol: "WORST", above200DMA: false, rsVsNifty3M: -15, compositeScore: 60, overextensionPenalty: -10 }];
  const n = applyRegime(stocks, { regime: "risk_off", weakPenalty: 12 });
  assert.strictEqual(n, 1, "one stock hit (counted once despite two effects)");
  assert.strictEqual(stocks[0].compositeScore, 60 - 12 - 5);
});
