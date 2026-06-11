"use strict";

/**
 * Unit tests for the entry-timing guards in the composite momentum score.
 *
 * Run with:  node --test backend/stock_signals.test.js
 *
 * These lock in the behaviour that the score should NOT chase exhausted
 * breakouts (overbought + stretched + just-spiked) and SHOULD reward buying a
 * confirmed uptrend on a pullback.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const {
  overextensionPenalty,
  pullbackBonus,
  eodSignalScore,
} = require("./stock_signals");

test("overextension penalty scales with RSI", () => {
  assert.strictEqual(overextensionPenalty({ rsi14: 65 }), 0,   "RSI 65 → not overbought");
  assert.strictEqual(overextensionPenalty({ rsi14: 72 }), -6,  "RSI 72 → -6");
  assert.strictEqual(overextensionPenalty({ rsi14: 76 }), -10, "RSI 76 → -10");
  assert.strictEqual(overextensionPenalty({ rsi14: 82 }), -15, "RSI 82 → -15");
});

test("overextension penalty stacks RSI + stretch + spike + blow-off + BB + 3M", () => {
  const exhausted = {
    rsi14: 82, close: 135, dma50: 100, dma20: 120, ret1w: 28, ret3m: 40, bbPct: 0.97,
    above50DMA: true, above200DMA: true, near52wHigh: { fired: true }, rsVsNifty3M: 20,
  };
  // -15 (RSI≥80) -12 (≥30% above 50DMA) -12 (≥25% week) -6 (blow-off) -6 (bbPct≥0.95) -8 (ret3m≥35) = -59
  assert.strictEqual(overextensionPenalty(exhausted), -59);
});

test("overextension: 1-week threshold fires at 10%, raised middle tier", () => {
  assert.strictEqual(overextensionPenalty({ ret1w: 8 }),  0,   "ret1w 8% → below new threshold");
  assert.strictEqual(overextensionPenalty({ ret1w: 10 }), -4,  "ret1w 10% → -4 (new tier)");
  assert.strictEqual(overextensionPenalty({ ret1w: 16 }), -8,  "ret1w 16% → -8 (raised from -6)");
  assert.strictEqual(overextensionPenalty({ ret1w: 25 }), -12, "ret1w 25% → -12 (unchanged)");
});

test("overextension: upper Bollinger Band penalty fires above 0.85", () => {
  assert.strictEqual(overextensionPenalty({ bbPct: 0.80 }), 0,  "bbPct 0.80 → 0");
  assert.strictEqual(overextensionPenalty({ bbPct: 0.88 }), -3, "bbPct 0.88 → -3");
  assert.strictEqual(overextensionPenalty({ bbPct: 0.96 }), -6, "bbPct 0.96 → -6");
});

test("overextension: 3M momentum reversal fires above 20% (IC = -0.033, t = -4.22)", () => {
  assert.strictEqual(overextensionPenalty({ ret3m: 15 }), 0,  "ret3m 15% → 0");
  assert.strictEqual(overextensionPenalty({ ret3m: 25 }), -4, "ret3m 25% → -4");
  assert.strictEqual(overextensionPenalty({ ret3m: 40 }), -8, "ret3m 40% → -8");
});

test("clean early breakout is not penalised", () => {
  const clean = {
    rsi14: 60, close: 108, dma50: 100, dma20: 105, ret1w: 4,
    above50DMA: true, above200DMA: true, near52wHigh: { fired: false }, rsVsNifty3M: 8,
  };
  assert.strictEqual(overextensionPenalty(clean), 0);
});

test("buyable pullback in an uptrend earns the bonus", () => {
  const pullback = {
    rsi14: 50, close: 101, dma20: 100, dma50: 95, ret1w: 1,
    above50DMA: true, above200DMA: true, rsVsNifty3M: 6, near52wHigh: { fired: false },
  };
  assert.strictEqual(pullbackBonus(pullback), 14, "+8 healthy RSI +6 near 20DMA");
  assert.strictEqual(overextensionPenalty(pullback), 0);
});

test("downtrend gets no pullback bonus even with healthy RSI", () => {
  const downtrend = {
    rsi14: 50, close: 90, dma20: 92, dma50: 95, ret1w: 0,
    above50DMA: false, above200DMA: false, rsVsNifty3M: -12,
  };
  assert.strictEqual(pullbackBonus(downtrend), 0);
});

test("exhausted breakout scores below a clean breakout (entry timing inverted)", () => {
  const exhausted = {
    rsi14: 82, close: 135, dma50: 100, dma20: 120, ret1w: 28,
    above50DMA: true, above200DMA: true, near52wHigh: { fired: true }, rsVsNifty3M: 20,
  };
  const clean = {
    rsi14: 60, close: 108, dma50: 100, dma20: 105, ret1w: 4,
    above50DMA: true, above200DMA: true, near52wHigh: { fired: false }, rsVsNifty3M: 8,
  };
  assert.ok(
    eodSignalScore(exhausted) < eodSignalScore(clean),
    `exhausted (${eodSignalScore(exhausted)}) should score below clean (${eodSignalScore(clean)})`,
  );
});
