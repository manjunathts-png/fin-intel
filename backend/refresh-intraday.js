"use strict";
/**
 * Intraday stock score refresh — runs ~5× per day during NSE market hours.
 *
 * Reads the latest stock_picks from Supabase, fetches live Yahoo Finance
 * quotes for the top 50 picks + Nifty 50, recomputes the 7 price-sensitive
 * signals (breakout, volume, 52W high, gap, ret1w, RS 1M) from live data,
 * blends with the EOD base score, and upserts back to Supabase.
 *
 * Does NOT rerun the full Nifty-500 scan — only updates the stored picks.
 *
 * Usage: node backend/refresh-intraday.js
 */

require("dotenv").config();
const YahooFinance   = require("yahoo-finance2").default;
const { createClient } = require("@supabase/supabase-js");
const WebSocket      = require("ws");
const { intradaySignalScore } = require("./stock_signals");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : parseFloat(v.toFixed(d)));

// ─── Time-adjusted volume shock ───────────────────────────────────────────────
// Only valid if ≥60 min into session (avoid 9:15-10:15 AM open-volume noise).
// Projects current partial-day volume to full-day using elapsed session time.
function liveVolumeShock(currentVolume, avg20, nowIST) {
  const [h, m] = nowIST;
  const sessionStart = 9 * 60 + 15;   // 9:15 AM IST in minutes
  const sessionEnd   = 15 * 60 + 30;  // 3:30 PM IST
  const sessionLen   = sessionEnd - sessionStart;    // 375 min
  const elapsed      = (h * 60 + m) - sessionStart;
  if (elapsed < 60 || !avg20 || !currentVolume) return { fired: false };
  const projected = currentVolume * (sessionLen / elapsed);
  const ratio     = round(projected / avg20, 2);
  return {
    fired:  ratio >= 2,
    ratio,
    volume: currentVolume,
    avg20:  Math.round(avg20),
    projected: Math.round(projected),
  };
}

async function main() {
  const now = new Date();
  // Convert UTC to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);
  const nowIST    = [istNow.getUTCHours(), istNow.getUTCMinutes()];

  console.log(`Intraday refresh — ${now.toISOString()} (IST ${nowIST[0]}:${String(nowIST[1]).padStart(2,"0")})`);

  // ── Load current stock_picks ─────────────────────────────────────────────
  const { data: row, error } = await supabase
    .from("radar_cache").select("data").eq("key", "stock_picks").single();
  if (error) throw new Error(`Failed to load stock_picks: ${error.message}`);

  const stored   = row.data;
  const allPicks = stored.all ?? stored.picks ?? [];
  const top50    = allPicks.slice(0, 50);

  if (!top50.length) throw new Error("No picks found in Supabase");
  console.log(`  Loaded ${top50.length} picks from Supabase (EOD built at ${stored.asOf?.slice(0,16)})`);

  // ── Fetch live quotes (top 50 + Nifty) ───────────────────────────────────
  const symbols  = top50.map((p) => p.symbol);
  const allSyms  = [...symbols, "^NSEI"];     // Nifty for relative-strength

  console.log(`  Fetching ${allSyms.length} quotes from Yahoo Finance…`);
  const quoteMap = {};
  const BATCH    = 10;
  for (let i = 0; i < allSyms.length; i += BATCH) {
    const batch = allSyms.slice(i, i + BATCH);
    await Promise.all(batch.map(async (sym) => {
      try {
        const q = await yf.quote(sym, {
          fields: [
            "regularMarketPrice", "regularMarketOpen", "regularMarketPreviousClose",
            "regularMarketVolume", "regularMarketChangePercent",
            "regularMarketDayHigh", "fiftyTwoWeekHigh",
          ],
        });
        quoteMap[sym] = q;
      } catch (e) {
        console.warn(`    ⚠ ${sym}: ${e.message}`);
      }
    }));
  }

  const niftyQ   = quoteMap["^NSEI"];
  const niftyChg = niftyQ?.regularMarketChangePercent ?? 0;
  console.log(`  Nifty today: ${niftyChg >= 0 ? "+" : ""}${niftyChg.toFixed(2)}%`);

  // ── Recompute intraday signals per pick ───────────────────────────────────
  let updated = 0;
  const intradayAsOf = now.toISOString();

  for (const p of top50) {
    const q = quoteMap[p.symbol];
    if (!q?.regularMarketPrice) continue;

    const price     = q.regularMarketPrice;
    const open      = q.regularMarketOpen;
    const prevClose = q.regularMarketPreviousClose ?? p.prevClose;
    const volume    = q.regularMarketVolume;
    const chgPct    = q.regularMarketChangePercent ?? 0;

    // ── Recompute each intraday signal using stored reference values ────────
    const h52       = q.fiftyTwoWeekHigh ?? p.near52wHigh?.high52w;
    const band20    = p.breakout20d?.bandHigh;
    const band50    = p.breakout50d?.bandHigh;
    const avg20vol  = p.volumeAvg20;

    const near52wHigh = h52 ? {
      fired:       price >= h52 * 0.98,
      distancePct: round(((price - h52) / h52) * 100, 2),
      high52w:     round(h52, 2),
    } : { fired: false };

    const breakout20d = band20 != null ? {
      fired:     price > band20,
      bandHigh:  round(band20, 2),
      breakPct:  round(((price - band20) / band20) * 100, 2),
    } : { fired: false };

    const breakout50d = band50 != null ? {
      fired:     price > band50,
      bandHigh:  round(band50, 2),
      breakPct:  round(((price - band50) / band50) * 100, 2),
    } : { fired: false };

    const gapPct = prevClose ? ((open - prevClose) / prevClose) * 100 : 0;
    const gapUp  = { fired: gapPct >= 1.5, gapPct: round(gapPct, 2), open: round(open, 2), prevClose: round(prevClose, 2) };

    const volumeShock = liveVolumeShock(volume, avg20vol, nowIST);

    // ret1w: approx update using today's change added to stored EOD ret1w
    const ret1wBase = p.ret1w ?? 0;
    const ret1w     = round(ret1wBase + chgPct, 2);

    // RS vs Nifty 1M: approximate update (stored EOD RS + today's excess move)
    const rsVsNifty1M = p.rsVsNifty1M != null
      ? round(p.rsVsNifty1M + (chgPct - niftyChg), 2)
      : null;

    // Build intraday signal overlay (reuse disc.* from EOD run — they update daily anyway)
    const liveSignals = {
      ...p,             // all EOD fields (golden cross, MACD, DMA, etc.)
      near52wHigh,
      breakout20d,
      breakout50d,
      gapUp,
      volumeShock,
      ret1w,
      rsVsNifty1M,
    };

    const freshIntraday  = intradaySignalScore(liveSignals);
    const eodBase        = p.eodBaseScore ?? 0;
    const liveRaw        = Math.max(0, Math.min(100, Math.round(eodBase + freshIntraday)));

    // Blend with EOD composite score to prevent multiple-run drift
    const eodComposite   = p.eodCompositeScore ?? p.compositeScore ?? liveRaw;
    const smoothed       = Math.round(0.7 * liveRaw + 0.3 * eodComposite);

    // Patch the pick in-place
    p.compositeScore  = smoothed;
    p.liveRaw         = liveRaw;
    p.near52wHigh     = near52wHigh;
    p.breakout20d     = breakout20d;
    p.breakout50d     = breakout50d;
    p.gapUp           = gapUp;
    p.volumeShock     = volumeShock;
    p.ret1w           = ret1w;
    p.rsVsNifty1M     = rsVsNifty1M;
    p.close           = round(price, 2);
    p.changePct       = round(chgPct, 2);
    p.intradayAsOf    = intradayAsOf;
    updated++;
  }

  // ── Re-sort by updated compositeScore (within top 50 only) ───────────────
  // NOTE: persistence fields (daysInTop50, yesterdayRank, etc.) are preserved
  // via the `...p` spread above — intraday must not touch them. Those only
  // get recomputed at EOD when the full Nifty-500 scan runs.
  top50.sort((a, b) => b.compositeScore - a.compositeScore || b.signalCount - a.signalCount);
  top50.forEach((s, i) => { s.rank = i + 1; });
  console.log(`  ✓ Updated ${updated} picks · top 5: ${top50.slice(0,5).map(p => `${p.label}[${p.compositeScore}]`).join(", ")}`);

  // ── Preserve the full `all` list from EOD ─────────────────────────────────
  // Previously this intraday run clobbered `all` with just top 50, which
  // erased rank context for positions 51-200. That broke next-morning
  // persistence tracking (couldn't tell if a stock was rank 75 yesterday).
  // Now we splice the updated top 50 back into the stored `all` and keep
  // the rest untouched.
  const updatedAll = stored.all ? [...stored.all] : [...top50];
  const top50Map = Object.fromEntries(top50.map((p) => [p.symbol, p]));
  for (let i = 0; i < updatedAll.length; i++) {
    if (top50Map[updatedAll[i].symbol]) updatedAll[i] = top50Map[updatedAll[i].symbol];
  }

  // ── Upsert back to Supabase ───────────────────────────────────────────────
  const updatedData = {
    ...stored,
    picks:          top50,
    all:            updatedAll,   // preserves EOD context for stocks 51-200
    intradayAsOf,
  };

  const { error: upsertErr } = await supabase
    .from("radar_cache")
    .upsert({ key: "stock_picks", data: updatedData, built_at: new Date().toISOString() });
  if (upsertErr) throw new Error(`Supabase upsert failed: ${upsertErr.message}`);

  console.log(`✓ stock_picks updated in Supabase (intraday, ${updated} picks refreshed)`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
