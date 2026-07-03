"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { summarizeEtfBlob, bodySnippet } = require("./data-health-check");

test("summarizeEtfBlob counts ETFs across the real { types } blob shape", () => {
  const blob = {
    asOf: "2026-07-03T00:00:00Z",
    types: [
      { type: "Equity Broad", etfs: [{ ticker: "NIFTYBEES", latestPrice: 280.5 }, { ticker: "JUNIORBEES", latestPrice: 720 }] },
      { type: "Commodity Gold", etfs: [{ ticker: "GOLDBEES", latestPrice: 62.1 }] },
    ],
    warnings: [],
  };
  assert.deepStrictEqual(summarizeEtfBlob(blob), { etfCount: 3, pricedCount: 3 });
});

test("summarizeEtfBlob detects a real zero-out: entries present, no prices", () => {
  const blob = {
    types: [
      { type: "Equity Broad", etfs: [{ ticker: "NIFTYBEES", latestPrice: null, warnings: ["Price fetch failed"] }, { ticker: "JUNIORBEES" }] },
    ],
  };
  assert.deepStrictEqual(summarizeEtfBlob(blob), { etfCount: 2, pricedCount: 0 });
});

test("summarizeEtfBlob handles empty types and missing etfs arrays", () => {
  assert.deepStrictEqual(summarizeEtfBlob({ types: [] }), { etfCount: 0, pricedCount: 0 });
  assert.deepStrictEqual(summarizeEtfBlob({ types: [{ type: "X" }] }), { etfCount: 0, pricedCount: 0 });
});

test("summarizeEtfBlob falls back to legacy flat picks/etfs shapes", () => {
  assert.deepStrictEqual(
    summarizeEtfBlob({ picks: [{ close: 100 }, { close: null }] }),
    { etfCount: 2, pricedCount: 1 }
  );
  assert.deepStrictEqual(
    summarizeEtfBlob({ etfs: [{ latestPrice: 55 }] }),
    { etfCount: 1, pricedCount: 1 }
  );
});

test("summarizeEtfBlob tolerates null/undefined blobs", () => {
  assert.deepStrictEqual(summarizeEtfBlob(null), { etfCount: 0, pricedCount: 0 });
  assert.deepStrictEqual(summarizeEtfBlob(undefined), { etfCount: 0, pricedCount: 0 });
  assert.deepStrictEqual(summarizeEtfBlob({}), { etfCount: 0, pricedCount: 0 });
});

test("bodySnippet collapses whitespace, truncates, and handles empty bodies", () => {
  assert.strictEqual(bodySnippet("<html>\n  <body>Exceeded the daily\thits limit</body>"), "<html> <body>Exceeded the daily hits limit</body>");
  assert.strictEqual(bodySnippet("x".repeat(200)).length, 80);
  assert.strictEqual(bodySnippet(""), "(empty body)");
  assert.strictEqual(bodySnippet(null), "(empty body)");
});
