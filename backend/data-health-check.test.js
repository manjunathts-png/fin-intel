"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { summarizeEtfBlob, bodySnippet, fixScriptsForFailures } = require("./data-health-check");

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

// ─── fixScriptsForFailures ────────────────────────────────────────────────────
// Regression coverage for the 2026-07-06 incident: a stale mf_radar failure
// was "fixed" by re-running the stocks-only refresh, which can never touch
// mf_radar — three wasted CI runs and three failure emails before the
// Monday-night nightly run incidentally cleared it.

test("fixScriptsForFailures maps mf_radar failures to the mf target, not stocks", () => {
  const results = [
    { status: "ok",   check: "stock_picks EOD freshness" },
    { status: "fail", check: "mf_radar freshness" },
    { status: "fail", check: "mf_radar fund count" },
  ];
  assert.deepStrictEqual(fixScriptsForFailures(results, "eod"), ["node backend/refresh-cache.js mf"]);
});

test("fixScriptsForFailures maps etf_picks failures to the etf target", () => {
  const results = [{ status: "fail", check: "etf_picks price coverage" }];
  assert.deepStrictEqual(fixScriptsForFailures(results, "eod"), ["node backend/refresh-cache.js etf"]);
});

test("fixScriptsForFailures maps stocks failures to stocks (eod) or refresh-intraday.js (intraday mode)", () => {
  const results = [{ status: "fail", check: "stocks EOD freshness" }];
  assert.deepStrictEqual(fixScriptsForFailures(results, "eod"), ["node backend/refresh-cache.js stocks"]);
  assert.deepStrictEqual(fixScriptsForFailures(results, "intraday"), ["node backend/refresh-intraday.js"]);

  const priceCoverage = [{ status: "fail", check: "price coverage" }];
  assert.deepStrictEqual(fixScriptsForFailures(priceCoverage, "eod"), ["node backend/refresh-cache.js stocks"]);
});

test("fixScriptsForFailures runs each distinct target once, in a stable order, skipping passing checks", () => {
  const results = [
    { status: "fail", check: "stocks EOD freshness" },
    { status: "fail", check: "mf_radar freshness" },
    { status: "ok",   check: "etf_picks freshness" },
    { status: "fail", check: "mf_radar fund count" },  // duplicate target, must not double-run
  ];
  assert.deepStrictEqual(fixScriptsForFailures(results, "eod"), [
    "node backend/refresh-cache.js stocks",
    "node backend/refresh-cache.js mf",
  ]);
});

test("fixScriptsForFailures returns nothing for third-party outages no local refresh can fix", () => {
  const results = [
    { status: "fail", check: "Nifty benchmark" },
    { status: "fail", check: "all price sources" },
  ];
  assert.deepStrictEqual(fixScriptsForFailures(results, "eod"), []);
});

test("fixScriptsForFailures returns nothing when everything passed", () => {
  assert.deepStrictEqual(fixScriptsForFailures([{ status: "ok", check: "mf_radar freshness" }], "eod"), []);
  assert.deepStrictEqual(fixScriptsForFailures([], "eod"), []);
});
