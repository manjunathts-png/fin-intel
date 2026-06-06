"use strict";
/**
 * Intraday stock score refresh — runs ~5× per day during NSE market hours.
 *
 * Reads the latest stock_picks from Supabase, fetches live quotes for the
 * top 50 picks + Nifty 50, recomputes the 7 price-sensitive signals
 * (breakout, volume, 52W high, gap, ret1w, RS 1M) from live data, blends
 * with the EOD base score, and upserts back to Supabase.
 *
 * Does NOT rerun the full Nifty-500 scan — only updates the stored picks.
 *
 * Quote source priority (Yahoo Finance is blocked on GitHub Actions IPs):
 *   1. NSE equity quote API  — official, no API key, works on CI
 *   2. Yahoo Finance v8 REST — fallback, per-symbol when NSE fails
 *
 * Usage: node backend/refresh-intraday.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const WebSocket        = require("ws");
const { intradaySignalScore } = require("./stock_signals");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : parseFloat(v.toFixed(d)));

// ─── NSE live quote (primary) ─────────────────────────────────────────────────

const NSE_BASE = "https://www.nseindia.com";
const NSE_UA   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let nseCookie = "";

async function warmNseCookies() {
  try {
    const res = await fetch(NSE_BASE + "/", {
      headers: { "User-Agent": NSE_UA },
      signal:  AbortSignal.timeout(12000),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    nseCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  } catch (e) {
    console.warn(`  [nse] cookie warm failed: ${e.message}`);
  }
}

async function nseGet(url, referer = NSE_BASE + "/") {
  if (!nseCookie) await warmNseCookies();
  const headers = {
    "User-Agent":      NSE_UA,
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         referer,
  };
  if (nseCookie) headers.Cookie = nseCookie;
  let res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403) {
    await warmNseCookies();
    headers.Cookie = nseCookie;
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  }
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  return res.json();
}

function mapNseEquity(j) {
  const pi = j?.priceInfo  ?? {};
  const ti = j?.tradeInfo  ?? {};
  const ih = pi.intraDayHighLow ?? {};
  return {
    regularMarketPrice:         pi.lastPrice              ?? null,
    regularMarketOpen:          pi.open                   ?? null,
    regularMarketPreviousClose: pi.previousClose          ?? null,
    regularMarketVolume:        ti.totalTradedVolume       ?? null,
    regularMarketChangePercent: pi.pChange                ?? null,
    regularMarketDayHigh:       ih.max                    ?? null,
    fiftyTwoWeekHigh:           pi.weekHighLow?.max       ?? null,
  };
}

async function fetchNseEquityQuote(symbol) {
  const nseSym  = symbol.replace(".NS", "");
  const url     = `${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(nseSym)}`;
  const referer = `${NSE_BASE}/get-quotes/equity?symbol=${encodeURIComponent(nseSym)}`;
  const j = await nseGet(url, referer);
  const q = mapNseEquity(j);
  if (!q.regularMarketPrice) throw new Error("no price in NSE response");
  return q;
}

async function fetchNiftyLiveChange() {
  const j = await nseGet(`${NSE_BASE}/api/allIndices`, `${NSE_BASE}/`);
  const entry = (j.data ?? []).find((d) => d.index === "NIFTY 50");
  if (!entry) throw new Error("NIFTY 50 not found in allIndices");
  return { regularMarketChangePercent: entry.percentChange ?? 0 };
}

// ─── Yahoo Finance v8 REST (fallback per symbol) ──────────────────────────────

const YF_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fetchYahooQuote(symbol) {
  const isIndex = symbol.startsWith("^");
  const encoded = encodeURIComponent(symbol);
  const params  = new URLSearchParams({
    fields: "regularMarketPrice,regularMarketOpen,regularMarketPreviousClose,regularMarketVolume,regularMarketChangePercent,regularMarketDayHigh,fiftyTwoWeekHigh",
    formatted: "false",
  });
  for (const base of [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
  ]) {
    const url = `${base}/v8/finance/chart/${encoded}?interval=1m&range=1d`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": YF_UA, "Accept": "application/json" },
        signal:  AbortSignal.timeout(15000),
      });
      if (res.status === 429) { console.warn(`  [yahoo] ${symbol}: 429`); break; }
      if (!res.ok) continue;
      const data   = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta     = result.meta ?? {};
      const price    = meta.regularMarketPrice ?? null;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
      const changePct = (price != null && prevClose != null && prevClose > 0)
        ? ((price - prevClose) / prevClose) * 100
        : null;
      return {
        regularMarketPrice:         price,
        regularMarketOpen:          meta.regularMarketOpen ?? prevClose,
        regularMarketPreviousClose: prevClose,
        regularMarketVolume:        meta.regularMarketVolume  ?? null,
        regularMarketChangePercent: changePct,
        regularMarketDayHigh:       meta.regularMarketDayHigh ?? null,
        fiftyTwoWeekHigh:           meta.fiftyTwoWeekHigh     ?? null,
      };
    } catch (e) {
      console.warn(`  [yahoo] ${symbol}: ${e.message}`);
    }
  }
  return null;
}

// ─── Unified quote fetcher ────────────────────────────────────────────────────

async function fetchQuote(symbol) {
  if (symbol === "^NSEI") {
    try {
      return await fetchNiftyLiveChange();
    } catch (e) {
      console.warn(`  [nse] ^NSEI: ${e.message} — trying Yahoo…`);
      return await fetchYahooQuote(symbol);
    }
  }
  try {
    return await fetchNseEquityQuote(symbol);
  } catch (e) {
    console.warn(`  [nse] ${symbol}: ${e.message} — trying Yahoo…`);
    return await fetchYahooQuote(symbol);
  }
}

// ─── Time-adjusted volume shock ───────────────────────────────────────────────

function liveVolumeShock(currentVolume, avg20, nowIST) {
  const [h, m]       = nowIST;
  const sessionStart = 9 * 60 + 15;
  const sessionEnd   = 15 * 60 + 30;
  const sessionLen   = sessionEnd - sessionStart;
  const elapsed      = (h * 60 + m) - sessionStart;
  if (elapsed < 60 || !avg20 || !currentVolume) return { fired: false };
  const projected = currentVolume * (sessionLen / elapsed);
  const ratio     = round(projected / avg20, 2);
  return {
    fired:     ratio >= 2,
    ratio,
    volume:    currentVolume,
    avg20:     Math.round(avg20),
    projected: Math.round(projected),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const now    = new Date();
  const ist    = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const nowIST = [ist.getUTCHours(), ist.getUTCMinutes()];

  console.log(`Intraday refresh — ${now.toISOString()} (IST ${nowIST[0]}:${String(nowIST[1]).padStart(2, "0")})`);

  // ── Load current stock_picks ─────────────────────────────────────────────
  const { data: row, error } = await supabase
    .from("radar_cache").select("data").eq("key", "stock_picks").single();
  if (error) throw new Error(`Failed to load stock_picks: ${error.message}`);

  const stored   = row.data;
  const allPicks = stored.all ?? stored.picks ?? [];
  const top50    = allPicks.slice(0, 50);

  if (!top50.length) throw new Error("No picks found in Supabase");
  console.log(`  Loaded ${top50.length} picks (EOD built at ${stored.asOf?.slice(0, 16)})`);

  // ── Warm NSE cookies once before batch ───────────────────────────────────
  await warmNseCookies();
  console.log(`  NSE cookies warmed (${nseCookie ? "ok" : "empty"})`);

  // ── Fetch live quotes — NSE primary, Yahoo fallback ──────────────────────
  const symbols  = top50.map((p) => p.symbol);
  const allSyms  = [...symbols, "^NSEI"];
  console.log(`  Fetching ${allSyms.length} quotes (NSE primary, Yahoo fallback)…`);

  const quoteMap = {};
  let nseOk = 0, nseErr = 0;
  for (const sym of allSyms) {
    const q = await fetchQuote(sym);
    if (q?.regularMarketPrice != null || (sym === "^NSEI" && q?.regularMarketChangePercent != null)) {
      quoteMap[sym] = q;
      nseOk++;
    } else {
      nseErr++;
    }
  }
  console.log(`  Quotes: ${nseOk} ok, ${nseErr} failed`);

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

    const h52    = q.fiftyTwoWeekHigh ?? p.near52wHigh?.high52w;
    const band20 = p.breakout20d?.bandHigh;
    const band50 = p.breakout50d?.bandHigh;
    const avg20v = p.volumeAvg20;

    const near52wHigh = h52 ? {
      fired:       price >= h52 * 0.98,
      distancePct: round(((price - h52) / h52) * 100, 2),
      high52w:     round(h52, 2),
    } : { fired: false };

    const breakout20d = band20 != null ? {
      fired:    price > band20,
      bandHigh: round(band20, 2),
      breakPct: round(((price - band20) / band20) * 100, 2),
    } : { fired: false };

    const breakout50d = band50 != null ? {
      fired:    price > band50,
      bandHigh: round(band50, 2),
      breakPct: round(((price - band50) / band50) * 100, 2),
    } : { fired: false };

    const gapPct = (prevClose && open != null) ? ((open - prevClose) / prevClose) * 100 : 0;
    const gapUp  = { fired: gapPct >= 1.5, gapPct: round(gapPct, 2), open: round(open, 2), prevClose: round(prevClose, 2) };

    const volumeShock = liveVolumeShock(volume, avg20v, nowIST);

    const ret1wBase = p.ret1w ?? 0;
    const ret1w     = round(ret1wBase + chgPct, 2);

    const rsVsNifty1M = p.rsVsNifty1M != null
      ? round(p.rsVsNifty1M + (chgPct - niftyChg), 2)
      : null;

    const liveSignals = {
      ...p,
      near52wHigh, breakout20d, breakout50d,
      gapUp, volumeShock, ret1w, rsVsNifty1M,
    };

    const freshIntraday = intradaySignalScore(liveSignals);
    const eodBase       = p.eodBaseScore ?? 0;
    const liveRaw       = Math.max(0, Math.min(100, Math.round(eodBase + freshIntraday)));

    const eodComposite = p.eodCompositeScore ?? p.compositeScore ?? liveRaw;
    const smoothed     = Math.round(0.7 * liveRaw + 0.3 * eodComposite);

    p.compositeScore = smoothed;
    p.liveRaw        = liveRaw;
    p.near52wHigh    = near52wHigh;
    p.breakout20d    = breakout20d;
    p.breakout50d    = breakout50d;
    p.gapUp          = gapUp;
    p.volumeShock    = volumeShock;
    p.ret1w          = ret1w;
    p.rsVsNifty1M   = rsVsNifty1M;
    p.close          = round(price, 2);
    p.changePct      = round(chgPct, 2);
    p.intradayAsOf   = intradayAsOf;
    updated++;
  }

  // ── Re-sort within top 50 ─────────────────────────────────────────────────
  top50.sort((a, b) => b.compositeScore - a.compositeScore || b.signalCount - a.signalCount);
  top50.forEach((s, i) => { s.rank = i + 1; });
  console.log(`  ✓ Updated ${updated} picks · top 5: ${top50.slice(0, 5).map((p) => `${p.label}[${p.compositeScore}]`).join(", ")}`);

  // ── Splice updated top 50 back into full `all` list ───────────────────────
  const updatedAll = stored.all ? [...stored.all] : [...top50];
  const top50Map   = Object.fromEntries(top50.map((p) => [p.symbol, p]));
  for (let i = 0; i < updatedAll.length; i++) {
    if (top50Map[updatedAll[i].symbol]) updatedAll[i] = top50Map[updatedAll[i].symbol];
  }

  // ── Upsert to Supabase ────────────────────────────────────────────────────
  const updatedData = { ...stored, picks: top50, all: updatedAll, intradayAsOf };
  const { error: upsertErr } = await supabase
    .from("radar_cache")
    .upsert({ key: "stock_picks", data: updatedData, built_at: new Date().toISOString() });
  if (upsertErr) throw new Error(`Supabase upsert failed: ${upsertErr.message}`);

  console.log(`✓ stock_picks updated (intraday, ${updated} picks, ${nseOk}/${allSyms.length} quotes)`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
