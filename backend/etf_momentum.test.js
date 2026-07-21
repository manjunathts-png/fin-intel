"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { momentumFromPrices, _config } = require("./etf_momentum");

// Regression coverage for the 2026-07-20 incident: DEFENCEIETF, HDFCDEF,
// KOTAKGOLD, AXISGOLD showed every return horizon as "—" on the live ETF
// Picks page. Root cause: buildEtfEntry required >=30 total price rows
// before computing ANY horizon, so a handful of genuinely thin-traded ETFs
// (a few prints a month) got zero momentum data even when a real 1W/1M
// return was computable from the rows they had.

function series(dates, closes) {
  return dates.map((date, i) => ({ date, close: closes[i], volume: 1000 }));
}

const NOW = new Date("2026-07-20T12:00:00Z").getTime();

test("computes momentum from a thin-but-fresh series (the actual bug fixed here)", () => {
  // 5 prints over the last 3 weeks, most recent yesterday — exactly the
  // shape of a low-liquidity gold/defence ETF. Old code required 30 rows
  // and would have returned nothing at all.
  const s = series(
    ["2026-06-29", "2026-07-06", "2026-07-13", "2026-07-17", "2026-07-19"],
    [100, 101, 103, 104, 105]
  );
  const result = momentumFromPrices(s, NOW);
  assert.strictEqual(result.momentumSource, "price");
  assert.ok(result.stats.ret1w != null, "a 5-row series should still yield a 1W return");
  assert.ok(result.warning?.includes("Thin price history"), "should flag thin history for transparency");
});

test("refuses to compute from a stale series instead of faking a flat 0% return", () => {
  // Latest print is 45 days old — using it as "now" would silently produce
  // a misleading ~0% return instead of an honest "no recent data".
  const dates = [];
  const closes = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(NOW - (200 - i * 10) * 86400000);
    dates.push(d.toISOString().slice(0, 10));
    closes.push(100 + i);
  }
  const s = series(dates, closes);
  const result = momentumFromPrices(s, NOW);
  assert.strictEqual(result.stats, null);
  assert.strictEqual(result.momentumSource, null);
  assert.ok(result.warning.includes("too stale"), `expected a staleness warning, got: ${result.warning}`);
});

test("still computes normally from a full, fresh, liquid series", () => {
  const dates = [];
  const closes = [];
  for (let i = 0; i < 400; i++) {
    const d = new Date(NOW - (399 - i) * 86400000);
    dates.push(d.toISOString().slice(0, 10));
    closes.push(100 + i * 0.05);
  }
  const s = series(dates, closes);
  const result = momentumFromPrices(s, NOW);
  assert.strictEqual(result.momentumSource, "price");
  assert.strictEqual(result.warning, null, "a full history shouldn't get a thin-history warning");
  assert.ok(result.stats.ret1w != null);
  assert.ok(result.stats.ret1y != null);
});

test("reports no usable series below the minimum row count", () => {
  const result = momentumFromPrices(series(["2026-07-19"], [100]), NOW);
  assert.strictEqual(result.stats, null);
  assert.ok(result.warning.includes("No usable price series"));
  assert.ok(result.warning.includes("1 rows"));
});

test("tolerates null/empty price series", () => {
  assert.strictEqual(momentumFromPrices(null, NOW).stats, null);
  assert.strictEqual(momentumFromPrices([], NOW).stats, null);
  assert.strictEqual(momentumFromPrices(undefined, NOW).stats, null);
});

test("boundary: exactly MAX_STALE_PRICE_DAYS old still computes; one day older doesn't", () => {
  // Use a midnight-UTC "now" so date-string truncation (dates carry no
  // time-of-day) doesn't shift the boundary by fractional hours.
  const nowMidnight = new Date("2026-07-20T00:00:00Z").getTime();
  const edge = new Date(nowMidnight - _config.MAX_STALE_PRICE_DAYS * 86400000).toISOString().slice(0, 10);
  const s = series(["2026-01-01", edge], [100, 105]);
  const atBoundary = momentumFromPrices(s, nowMidnight);
  assert.strictEqual(atBoundary.momentumSource, "price");

  const tooOld = new Date(nowMidnight - (_config.MAX_STALE_PRICE_DAYS + 1) * 86400000).toISOString().slice(0, 10);
  const s2 = series(["2026-01-01", tooOld], [100, 105]);
  const pastBoundary = momentumFromPrices(s2, nowMidnight);
  assert.strictEqual(pastBoundary.stats, null);
});

test("config constants are sane", () => {
  assert.strictEqual(_config.MIN_PRICE_ROWS, 2);
  assert.strictEqual(_config.MAX_STALE_PRICE_DAYS, 10);
  // Enough to meaningfully de-burst 36 sequential fetches (2026-07-20: zero
  // delay meant all 36 tripped Yahoo's 429 in ~3 seconds) without materially
  // slowing the refresh (36 ETFs x 200ms = ~7s added, trivial next to the
  // job's multi-minute runtime).
  assert.strictEqual(_config.PRICE_FETCH_THROTTLE_MS, 200);
});

// Regression coverage for the 2026-07-21 incident: throttling (PR #42) wasn't
// enough — Stooq and Yahoo both stayed unreachable for all 36 ETFs across
// multiple separate job runs, pointing at a persistent block on GitHub
// Actions' shared runner IP pool rather than a burst this repo's own request
// rate caused. Fix: reuse stock_momentum.js's NSE Bhavcopy archive (already
// proven reliable from CI) as a zero-network-call primary source, since ETFs
// trade on NSE's cash segment under the same EQ/BE series codes Bhavcopy
// already parses for stocks.
test("fetchTickerPrice uses the bhavcopy cache first, without touching Stooq/Yahoo", async () => {
  const stockMomentumPath = require.resolve("./stock_momentum");
  const etfMomentumPath = require.resolve("./etf_momentum");

  const fakePrices = [
    { date: "2026-07-15", close: 100, volume: 1000 },
    { date: "2026-07-16", close: 101, volume: 1200 },
    { date: "2026-07-17", close: 102.5, volume: 900 },
  ];

  const realStockMomentumExports = require(stockMomentumPath);
  delete require.cache[etfMomentumPath];
  require.cache[stockMomentumPath] = {
    id: stockMomentumPath,
    filename: stockMomentumPath,
    loaded: true,
    exports: {
      ...realStockMomentumExports,
      getCachedPrices: (symbol) => (symbol === "BHAVCOPYTEST.NS" ? fakePrices : null),
    },
  };

  try {
    const { fetchTickerPrice } = require(etfMomentumPath);
    const entry = await fetchTickerPrice("BHAVCOPYTEST");
    assert.strictEqual(entry.source, "bhavcopy");
    assert.strictEqual(entry.prices.length, 3);
    assert.strictEqual(entry.prices[2].close, 102.5);
  } finally {
    // Restore the real module so later tests in this process (or a shared
    // require cache) never see the stub.
    delete require.cache[stockMomentumPath];
    delete require.cache[etfMomentumPath];
    require(stockMomentumPath);
    require(etfMomentumPath);
  }
});
