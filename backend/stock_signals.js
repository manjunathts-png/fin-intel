"use strict";

/**
 * Stock Signals — technical signal detection on daily OHLCV.
 *
 * Reads from stock_history_cache.json (populated by stock_momentum.js).
 * Computes per-stock signals: volume shockers, breakouts, gap-ups, candle
 * patterns, RSI, golden cross, DMA position, and a composite momentum score.
 *
 * No external API calls — pure computation on cached OHLCV.
 */

const { STOCK_SECTORS } = require("./stock_universe");
const { fetchSymbolHistory } = require("./stock_momentum");
const { getNifty500 } = require("./nifty500_universe");

// ─── Basic helpers ────────────────────────────────────────────────────────────

const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const sum  = (arr) => arr.reduce((s, x) => s + x, 0);
const round = (v, d = 2) => (v == null || !isFinite(v) ? null : parseFloat(v.toFixed(d)));

// ─── Indicator computations ───────────────────────────────────────────────────

// Simple Moving Average over last `n` closes
function sma(prices, n) {
  if (prices.length < n) return null;
  const slice = prices.slice(-n);
  return mean(slice.map((p) => p.close));
}

// RSI(14) using Wilder's smoothing
function rsi14(prices) {
  if (prices.length < 15) return null;
  const closes = prices.map((p) => p.close);
  let gains = 0, losses = 0;
  // Initial average over first 14 deltas
  for (let i = 1; i <= 14; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / 14, avgLoss = losses / 14;
  // Wilder's smoothing over the rest
  for (let i = 15; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * 13 + g) / 14;
    avgLoss = (avgLoss * 13 + l) / 14;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// 20-day average volume (excludes today)
function avgVolume(prices, n = 20) {
  if (prices.length < n + 1) return null;
  const slice = prices.slice(-n - 1, -1); // n bars ending yesterday
  return mean(slice.map((p) => p.volume).filter((v) => v > 0));
}

// 52-week (252 trading days) high
function high52w(prices) {
  if (prices.length < 30) return null;
  const slice = prices.slice(-252);
  return Math.max(...slice.map((p) => p.high));
}

// N-day high (looking back N bars excluding today)
function nDayHigh(prices, n) {
  if (prices.length < n + 1) return null;
  const slice = prices.slice(-n - 1, -1);
  return Math.max(...slice.map((p) => p.high));
}

// ─── Signal detectors ─────────────────────────────────────────────────────────

// Volume Shocker: today's volume >= 2× the 20-day average
function detectVolumeShock(prices) {
  if (prices.length < 21) return { fired: false };
  const today = prices[prices.length - 1];
  const avg20 = avgVolume(prices, 20);
  if (!avg20 || !today.volume) return { fired: false };
  const ratio = today.volume / avg20;
  return {
    fired:  ratio >= 2,
    ratio:  round(ratio, 2),
    volume: today.volume,
    avg20:  Math.round(avg20),
  };
}

// 52-week high (or within 2%)
function detect52wHigh(prices) {
  const h52 = high52w(prices);
  if (!h52) return { fired: false };
  const last = prices[prices.length - 1].close;
  const distance = ((last - h52) / h52) * 100;
  // distance >= -2 means close is at or within 2% of 52w high
  return {
    fired: distance >= -2,
    distancePct: round(distance, 2),
    high52w: round(h52, 2),
  };
}

// Daily breakout: close > N-day high (typical N = 20, 50)
function detectBreakout(prices, n) {
  const hi = nDayHigh(prices, n);
  if (!hi) return { fired: false };
  const close = prices[prices.length - 1].close;
  return {
    fired: close > hi,
    bandHigh: round(hi, 2),
    breakPct: round(((close - hi) / hi) * 100, 2),
  };
}

// Gap up: today's open > yesterday's close by > 1.5%
function detectGapUp(prices) {
  if (prices.length < 2) return { fired: false };
  const t = prices[prices.length - 1];
  const y = prices[prices.length - 2];
  if (!t.open || !y.close) return { fired: false };
  const gapPct = ((t.open - y.close) / y.close) * 100;
  return {
    fired: gapPct >= 1.5,
    gapPct: round(gapPct, 2),
    open: round(t.open, 2),
    prevClose: round(y.close, 2),
  };
}

// Bullish Engulfing: today's body engulfs yesterday's body
function detectBullishEngulfing(prices) {
  if (prices.length < 2) return false;
  const t = prices[prices.length - 1];
  const y = prices[prices.length - 2];
  const yBody = Math.abs(y.close - y.open);
  const tBody = Math.abs(t.close - t.open);
  // Yesterday red, today green, today's body engulfs
  return (
    y.close < y.open &&
    t.close > t.open &&
    t.open <= y.close &&
    t.close >= y.open &&
    tBody > yBody * 1.1
  );
}

// Hammer: small body at top, long lower wick, little/no upper wick
function detectHammer(prices) {
  if (prices.length < 1) return false;
  const t = prices[prices.length - 1];
  const body = Math.abs(t.close - t.open);
  const range = t.high - t.low;
  if (range === 0 || body / range > 0.4) return false;
  const lowerWick = Math.min(t.open, t.close) - t.low;
  const upperWick = t.high - Math.max(t.open, t.close);
  return lowerWick >= body * 2 && upperWick <= body * 0.5;
}

// Doji: open ~= close (body < 10% of range)
function detectDoji(prices) {
  if (prices.length < 1) return false;
  const t = prices[prices.length - 1];
  const body = Math.abs(t.close - t.open);
  const range = t.high - t.low;
  return range > 0 && body / range < 0.1;
}

// Golden Cross: 50 DMA just crossed above 200 DMA in the last 5 sessions
function detectGoldenCross(prices) {
  if (prices.length < 205) return false;
  for (let off = 0; off < 5; off++) {
    const slice    = prices.slice(0, prices.length - off);
    const slicePrev = prices.slice(0, prices.length - off - 1);
    if (slicePrev.length < 201) continue;
    const dma50Now  = sma(slice, 50);
    const dma200Now = sma(slice, 200);
    const dma50Yes  = sma(slicePrev, 50);
    const dma200Yes = sma(slicePrev, 200);
    if (dma50Now == null || dma200Now == null || dma50Yes == null || dma200Yes == null) continue;
    if (dma50Yes <= dma200Yes && dma50Now > dma200Now) return true;
  }
  return false;
}

// MACD signal: bullish if MACD line crosses above signal line in last 3 sessions
// Uses EMA(12)/EMA(26) for MACD, EMA(9) of MACD for signal
function ema(arr, n) {
  if (arr.length < n) return [];
  const k = 2 / (n + 1);
  let prev = mean(arr.slice(0, n));
  const out = [prev];
  for (let i = n; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function detectMacdBullish(prices) {
  if (prices.length < 35) return false;
  const closes = prices.map((p) => p.close);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  // Align: ema26 starts later — trim ema12 to match
  const diffLen = ema12.length - ema26.length;
  const macd = ema26.map((v, i) => ema12[i + diffLen] - v);
  if (macd.length < 12) return false;
  const sig = ema(macd, 9);
  // crossover in last 3 bars?
  const macdTail = macd.slice(-Math.min(4, sig.length + 1));
  const sigTail  = sig.slice(-Math.min(4, sig.length));
  for (let i = 1; i < sigTail.length; i++) {
    const mPrev = macdTail[i - 1], mNow = macdTail[i];
    const sPrev = sigTail[i - 1],  sNow = sigTail[i];
    if (mPrev <= sPrev && mNow > sNow) return true;
  }
  return false;
}

// ─── Composite score ──────────────────────────────────────────────────────────
//
// Weighted blend of signals — bullish-biased momentum score (0-100).
// Used to rank top picks.

function compositeScore(sig) {
  let s = 0;

  // ─── Volume + breakout = highest weight ──────────────────────────────
  if (sig.volumeShock.fired) {
    s += sig.volumeShock.ratio >= 5 ? 28
       : sig.volumeShock.ratio >= 3 ? 22
       :                              16;
  }
  if (sig.near52wHigh.fired) {
    // closer to high = stronger; at/above = 22, within 2% = 18
    s += sig.near52wHigh.distancePct >= -0.5 ? 22 : 18;
  }
  if (sig.breakout20d.fired) s += 15;
  if (sig.breakout50d.fired) s += 12;
  if (sig.gapUp.fired)       s += sig.gapUp.gapPct >= 3 ? 12 : 8;

  // ─── Pattern bonuses ─────────────────────────────────────────────────
  if (sig.bullishEngulfing) s += 8;
  if (sig.hammer)           s += 5;

  // ─── Trend & indicator bonuses ───────────────────────────────────────
  if (sig.goldenCross) s += 18;
  if (sig.macdBullish) s += 12;
  if (sig.rsiSignal === "overbought") s -= 4;      // contrarian penalty
  if (sig.rsiSignal === "oversold")   s += 6;

  // ─── DMA stack (long-term trend confirmation) ────────────────────────
  if (sig.above20DMA && sig.above50DMA && sig.above200DMA) s += 12;
  else if (sig.above50DMA && sig.above200DMA)              s += 6;
  else if (!sig.above200DMA && !sig.above50DMA)            s -= 5;  // below trend penalty

  // ─── Recent return momentum bonus (1W) ───────────────────────────────
  if (sig.ret1w >= 8) s += 10;
  else if (sig.ret1w >= 5) s += 7;
  else if (sig.ret1w >= 2) s += 3;
  else if (sig.ret1w <= -5) s -= 4;

  // ─── Relative strength vs Nifty ──────────────────────────────────────
  if (sig.rsVsNifty1M != null) {
    if (sig.rsVsNifty1M >= 10) s += 14;
    else if (sig.rsVsNifty1M >= 5) s += 9;
    else if (sig.rsVsNifty1M >= 0) s += 3;
    else if (sig.rsVsNifty1M <= -5) s -= 5;
  }
  if (sig.rsVsNifty3M != null) {
    if (sig.rsVsNifty3M >= 15) s += 10;
    else if (sig.rsVsNifty3M >= 5) s += 5;
    else if (sig.rsVsNifty3M <= -10) s -= 4;
  }

  // ─── Discovery-feed boosts (NSE published lists) ─────────────────────
  if (sig.disc?.in52wHi)       s += 10;        // appears in NSE 52w high list today
  if (sig.disc?.isGainer)      s += 8;         // top % gainer today
  if (sig.disc?.isMostActive)  s += 4;         // volume leader
  if (sig.disc?.bulkBuy)       s += 12;        // bulk deal BUY recently
  if (sig.disc?.blockBuy)      s += 18;        // block deal BUY (large institutional)
  if (sig.disc?.oiLong)        s += 10;        // F&O long buildup
  if (sig.disc?.oiShortCover)  s += 8;         // short covering

  // ─── Bearish discovery flags ─────────────────────────────────────────
  if (sig.disc?.in52wLo)       s -= 12;
  if (sig.disc?.isLoser)       s -= 6;
  if (sig.disc?.oiShort)       s -= 10;
  if (sig.disc?.oiLongUnwind)  s -= 6;

  // ─── High delivery % bonus (handled in leaderboard for backward compat) ─
  if (sig.highDelivery) s += 8;

  return Math.max(0, Math.min(100, Math.round(s)));
}

// Count of "fired" bullish signals (display badge count)
function countBullishSignals(sig) {
  return (
    (sig.volumeShock.fired   ? 1 : 0) +
    (sig.near52wHigh.fired   ? 1 : 0) +
    (sig.breakout20d.fired   ? 1 : 0) +
    (sig.breakout50d.fired   ? 1 : 0) +
    (sig.gapUp.fired         ? 1 : 0) +
    (sig.bullishEngulfing    ? 1 : 0) +
    (sig.hammer              ? 1 : 0) +
    (sig.goldenCross         ? 1 : 0) +
    (sig.macdBullish         ? 1 : 0) +
    (sig.rsiSignal === "oversold" ? 1 : 0) +
    (sig.disc?.in52wHi       ? 1 : 0) +
    (sig.disc?.bulkBuy       ? 1 : 0) +
    (sig.disc?.blockBuy      ? 1 : 0) +
    (sig.disc?.oiLong        ? 1 : 0) +
    ((sig.rsVsNifty1M ?? 0) >= 5 ? 1 : 0) +
    ((sig.rsVsNifty3M ?? 0) >= 10 ? 1 : 0)
  );
}

// ─── Per-stock signal computation ─────────────────────────────────────────────

function computeSignals(prices, extra = {}) {
  if (!prices || prices.length < 30) return null;

  const today = prices[prices.length - 1];
  const yest  = prices[prices.length - 2] ?? today;

  const dma20  = sma(prices, 20);
  const dma50  = sma(prices, 50);
  const dma200 = sma(prices, 200);

  const rsi = rsi14(prices);
  const rsiSig = rsi == null ? "neutral"
               : rsi >= 70 ? "overbought"
               : rsi <= 30 ? "oversold"
               : "neutral";

  // 1-week return for composite bonus
  const ret1w = prices.length >= 6
    ? ((today.close - prices[prices.length - 6].close) / prices[prices.length - 6].close) * 100
    : null;

  const sig = {
    volumeShock:      detectVolumeShock(prices),
    near52wHigh:      detect52wHigh(prices),
    breakout20d:      detectBreakout(prices, 20),
    breakout50d:      detectBreakout(prices, 50),
    gapUp:            detectGapUp(prices),
    bullishEngulfing: detectBullishEngulfing(prices),
    hammer:           detectHammer(prices),
    doji:             detectDoji(prices),
    goldenCross:      detectGoldenCross(prices),
    macdBullish:      detectMacdBullish(prices),
    rsi14:            round(rsi, 1),
    rsiSignal:        rsiSig,
    dma20:            round(dma20, 2),
    dma50:            round(dma50, 2),
    dma200:           round(dma200, 2),
    above20DMA:       dma20  != null && today.close > dma20,
    above50DMA:       dma50  != null && today.close > dma50,
    above200DMA:      dma200 != null && today.close > dma200,
    ret1w:            round(ret1w, 2),
    close:            round(today.close, 2),
    prevClose:        round(yest.close, 2),
    changePct:        round(((today.close - yest.close) / yest.close) * 100, 2),
    asOf:             today.date,
    ...extra,
  };

  sig.compositeScore = compositeScore(sig);
  sig.signalCount    = countBullishSignals(sig);
  return sig;
}

// ─── Relative strength vs Nifty ──────────────────────────────────────────────

function pctReturn(prices, days) {
  if (prices.length === 0) return null;
  const latest = prices[prices.length - 1].close;
  const t = new Date(); t.setDate(t.getDate() - days);
  const tStr = t.toISOString().slice(0, 10);
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prices[mid].date <= tStr) lo = mid;
    else hi = mid - 1;
  }
  const past = prices[lo].close;
  if (!past || past <= 0) return null;
  return ((latest - past) / past) * 100;
}

// ─── Build leaderboard of picks ───────────────────────────────────────────────

async function buildSignalsLeaderboard({
  deliveryMap   = {},
  discBonuses   = {},     // { SYMBOL → discovery flags } from nse_discovery.buildSymbolBonuses
  niftyReturns  = null,   // { ret1w, ret1m, ret3m, ret6m, ret1y } from nifty_benchmark
  universe,                // [{symbol, label, sector}] - Nifty500 list
  concurrency   = 6,       // parallel Yahoo fetches
} = {}) {
  const all       = [];
  const warnings  = [];

  // Fallback to legacy 84-stock universe if Nifty500 not supplied
  if (!universe) {
    universe = [];
    for (const [sector, stocks] of Object.entries(STOCK_SECTORS)) {
      for (const s of stocks) universe.push({ ...s, sector });
    }
  }

  console.log(`  scanning ${universe.length} stocks (concurrency=${concurrency})…`);

  // Concurrent fetch with bounded parallelism
  async function processOne({ symbol, label, sector }) {
    try {
      const entry = await fetchSymbolHistory(symbol);
      if (!entry?.prices?.length) return null;
      if (entry.prices[0].high == null) {
        warnings.push(`${symbol}: cache missing OHLCV`);
        return null;
      }
      const baseSymbol = symbol.replace(".NS", "");

      // Relative strength vs Nifty
      let rsVsNifty1M = null, rsVsNifty3M = null, rsVsNifty1Y = null;
      if (niftyReturns) {
        const r1m = pctReturn(entry.prices, 30);
        const r3m = pctReturn(entry.prices, 90);
        const r1y = pctReturn(entry.prices, 365);
        if (r1m != null && niftyReturns.ret1m != null) rsVsNifty1M = round(r1m - niftyReturns.ret1m, 2);
        if (r3m != null && niftyReturns.ret3m != null) rsVsNifty3M = round(r3m - niftyReturns.ret3m, 2);
        if (r1y != null && niftyReturns.ret1y != null) rsVsNifty1Y = round(r1y - niftyReturns.ret1y, 2);
      }

      const sig = computeSignals(entry.prices, {
        symbol, label, sector,
        deliveryPct: deliveryMap[baseSymbol] ?? null,
        disc:        discBonuses[baseSymbol] ?? null,
        rsVsNifty1M, rsVsNifty3M, rsVsNifty1Y,
      });
      if (sig) {
        // Apply delivery flag (used by composite via highDelivery)
        sig.highDelivery = sig.deliveryPct != null && sig.deliveryPct >= 60;
        // Re-run composite now that highDelivery and rs are set
        sig.compositeScore = compositeScore(sig);
        sig.signalCount    = countBullishSignals(sig);
        return sig;
      }
    } catch (e) {
      warnings.push(`${symbol} (${label}): ${e.message}`);
    }
    return null;
  }

  // Bounded parallelism
  const queue = [...universe];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const sig = await processOne(item);
      if (sig) all.push(sig);
    }
  });
  await Promise.all(workers);

  // Sort by composite score, then by signal count
  all.sort((a, b) => b.compositeScore - a.compositeScore || b.signalCount - a.signalCount);
  all.forEach((s, i) => { s.rank = i + 1; });

  return {
    asOf:     new Date().toISOString(),
    universe: universe.length,
    scanned:  all.length,
    picks:    all.slice(0, 50),    // top 50 — UI renders top 10
    all,                            // full list (for filters/explore)
    warnings,
  };
}

module.exports = {
  computeSignals,
  buildSignalsLeaderboard,
};
