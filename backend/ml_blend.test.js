"use strict";

/**
 * Unit tests for the gated ML blend.
 * Run with:  node --test backend/ml_blend.test.js
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { blendWeightForAuc, toPercentileMap, applyMlBlend, _config } = require("./ml_blend");

test("a chance-level model is gated off (weight 0)", () => {
  assert.strictEqual(blendWeightForAuc(0.50), 0);
  assert.strictEqual(blendWeightForAuc(0.509), 0, "just below the gate");
  assert.strictEqual(blendWeightForAuc(null), 0);
  assert.strictEqual(blendWeightForAuc(NaN), 0);
});

test("blend weight ramps with edge above the gate", () => {
  assert.strictEqual(blendWeightForAuc(0.51), 0, "at the floor weight starts at 0");
  assert.ok(blendWeightForAuc(0.55) > 0, "above gate gets positive weight");
  assert.ok(blendWeightForAuc(0.55) < _config.MAX_WEIGHT, "mid-range is below the cap");
  assert.strictEqual(blendWeightForAuc(0.60), _config.MAX_WEIGHT, "at AUC_FULL hits the cap");
  assert.strictEqual(blendWeightForAuc(0.80), _config.MAX_WEIGHT, "never exceeds the cap");
});

test("percentile map ranks by probability", () => {
  const m = toPercentileMap([
    { symbol: "A", prob: 0.1 },
    { symbol: "B", prob: 0.9 },
    { symbol: "C", prob: 0.5 },
    { symbol: "D", prob: null },   // dropped
  ]);
  assert.strictEqual(m.get("A"), 0,   "lowest prob → 0th pct");
  assert.strictEqual(m.get("B"), 100, "highest prob → 100th pct");
  assert.strictEqual(m.get("C"), 50,  "middle prob → 50th pct");
  assert.ok(!m.has("D"), "null prob excluded");
});

test("applyMlBlend leaves scores untouched when weight is 0", () => {
  const stocks = [{ symbol: "A", compositeScore: 80 }, { symbol: "B", compositeScore: 40 }];
  const n = applyMlBlend(stocks, { weight: 0, bySymbol: new Map([["A", 0], ["B", 100]]) });
  assert.strictEqual(n, 0);
  assert.strictEqual(stocks[0].compositeScore, 80, "score unchanged");
  assert.strictEqual(stocks[1].compositeScore, 40, "score unchanged");
  assert.strictEqual(stocks[0].mlBlendWeight, 0);
  assert.strictEqual(stocks[0].mlScore, 0, "ml percentile still annotated");
});

test("applyMlBlend mixes composite and ML percentile at the given weight", () => {
  const stocks = [{ symbol: "A", compositeScore: 80 }];
  // w=0.5: 0.5*80 + 0.5*0 = 40
  const n = applyMlBlend(stocks, { weight: 0.5, bySymbol: new Map([["A", 0]]) });
  assert.strictEqual(n, 1);
  assert.strictEqual(stocks[0].compositeScore, 40);
  assert.strictEqual(stocks[0].mlBlendWeight, 0.5);
});

test("applyMlBlend skips stocks with no ML score", () => {
  const stocks = [{ symbol: "A", compositeScore: 70 }, { symbol: "X", compositeScore: 30 }];
  const n = applyMlBlend(stocks, { weight: 0.3, bySymbol: new Map([["A", 100]]) });
  assert.strictEqual(n, 1, "only A blended");
  assert.strictEqual(stocks[1].compositeScore, 30, "unscored stock untouched");
  assert.strictEqual(stocks[1].mlScore, null);
});
