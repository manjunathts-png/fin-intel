"use strict";
/**
 * Data Health Check
 *
 * Verifies that stock price data in Supabase is fresh and reachable data
 * sources are working. Run after every refresh step to catch silent failures.
 *
 * Checks:
 *   1. Supabase stock_picks freshness (intraday threshold: 3h, EOD: 28h)
 *   2. Price coverage — % of top-50 picks that have a valid close price
 *   3. Source connectivity — Stooq, NSE, Yahoo for one probe symbol
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Usage:
 *   node backend/data-health-check.js           # report only
 *   node backend/data-health-check.js --fix     # re-run refresh if stale
 *   node backend/data-health-check.js --mode eod|intraday
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

require("dotenv").config();
const { execSync }     = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const WebSocket        = require("ws");
const path             = require("path");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const args   = process.argv.slice(2);
const FIX    = args.includes("--fix");
const MODE   = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "intraday";
const PROBE  = "TCS.NS";  // test symbol for source connectivity checks

const STALE_INTRADAY_H = 3;   // hours — intraday data older than this is stale
const STALE_EOD_H      = 28;  // hours — EOD data older than this is stale
const MIN_PRICE_COVERAGE = 0.80;  // at least 80% of top-50 picks need a valid close

const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

let allPassed = true;

function ok(label, detail = "") {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label, detail = "") {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  allPassed = false;
}

function info(label, detail = "") {
  console.log(`  ℹ ${label}${detail ? ` — ${detail}` : ""}`);
}

function hoursAgo(isoStr) {
  if (!isoStr) return Infinity;
  return (Date.now() - new Date(isoStr).getTime()) / (1000 * 60 * 60);
}

// ─── Check 1: Supabase freshness ──────────────────────────────────────────────

async function checkSupabaseFreshness() {
  console.log("\n[1] Supabase stock_picks freshness");
  const { data: row, error } = await supabase
    .from("radar_cache").select("data, built_at").eq("key", "stock_picks").single();

  if (error || !row) {
    fail("stock_picks", `could not load from Supabase: ${error?.message ?? "no row"}`);
    return null;
  }

  const stored       = row.data;
  const builtAt      = row.built_at;
  const intradayAsOf = stored.intradayAsOf;
  const eodAsOf      = stored.asOf;

  const eodAge      = hoursAgo(eodAsOf);
  const intradayAge = hoursAgo(intradayAsOf);
  const dbAge       = hoursAgo(builtAt);

  info("EOD asOf",      `${eodAsOf?.slice(0, 16) ?? "—"} (${eodAge.toFixed(1)}h ago)`);
  info("intraday asOf", `${intradayAsOf?.slice(0, 16) ?? "—"} (${intradayAge.toFixed(1)}h ago)`);
  info("DB built_at",   `${builtAt?.slice(0, 16) ?? "—"} (${dbAge.toFixed(1)}h ago)`);

  if (eodAge > STALE_EOD_H) {
    fail("EOD freshness", `${eodAge.toFixed(1)}h old — expected < ${STALE_EOD_H}h`);
  } else {
    ok("EOD freshness", `${eodAge.toFixed(1)}h old`);
  }

  if (MODE === "intraday") {
    if (intradayAge > STALE_INTRADAY_H) {
      fail("intraday freshness", `${intradayAge.toFixed(1)}h old — expected < ${STALE_INTRADAY_H}h`);
    } else {
      ok("intraday freshness", `${intradayAge.toFixed(1)}h old`);
    }
  }

  return stored;
}

// ─── Check 2: Price coverage ──────────────────────────────────────────────────

function checkPriceCoverage(stored) {
  console.log("\n[2] Price coverage");
  if (!stored) { fail("price coverage", "no stored data"); return; }

  const picks = stored.picks ?? [];
  if (picks.length === 0) { fail("price coverage", "no picks in store"); return; }

  const withClose  = picks.filter((p) => p.close != null && p.close > 0).length;
  const coverage   = withClose / picks.length;

  if (coverage < MIN_PRICE_COVERAGE) {
    fail("price coverage", `${withClose}/${picks.length} picks have close price (${(coverage * 100).toFixed(0)}% < ${(MIN_PRICE_COVERAGE * 100).toFixed(0)}% threshold)`);
  } else {
    ok("price coverage", `${withClose}/${picks.length} picks have close price`);
  }

  // Spot-check: report the 3 most recent intradayAsOf timestamps
  const times = picks
    .map((p) => p.intradayAsOf)
    .filter(Boolean)
    .sort()
    .slice(-3);
  if (times.length) {
    info("last intraday updates", times.map((t) => t.slice(11, 16)).join(", ") + " UTC");
  }
}

// ─── Check 3: Source connectivity ────────────────────────────────────────────

async function checkStooq() {
  const sym = PROBE.replace(".NS", "").toLowerCase();
  const d1  = new Date(); d1.setDate(d1.getDate() - 10);
  const d2  = new Date(); d2.setDate(d2.getDate() + 1);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://stooq.com/q/d/l/?s=${sym}.ns&d1=${fmt(d1)}&d2=${fmt(d2)}&i=d`;
  const res = await fetch(url, {
    headers: { "User-Agent": FETCH_UA },
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 50 || !text.toLowerCase().startsWith("date")) {
    throw new Error(`unexpected response (len=${text.length})`);
  }
  const lines = text.trim().split(/\r?\n/);
  return `${lines.length - 1} rows`;
}

async function checkNse() {
  const NSE_BASE = "https://www.nseindia.com";
  // Warm cookies
  const warm = await fetch(NSE_BASE + "/", {
    headers: { "User-Agent": FETCH_UA },
    signal:  AbortSignal.timeout(12000),
  });
  const cookie = (warm.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const nseSym = PROBE.replace(".NS", "");
  const url    = `${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(nseSym)}`;
  const res    = await fetch(url, {
    headers: {
      "User-Agent": FETCH_UA,
      "Accept": "application/json",
      "Referer": `${NSE_BASE}/get-quotes/equity?symbol=${nseSym}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j    = await res.json();
  const last = j?.priceInfo?.lastPrice;
  if (!last) throw new Error("no lastPrice in response");
  return `${nseSym} = ₹${last}`;
}

async function checkYahoo() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${PROBE}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { "User-Agent": FETCH_UA, "Accept": "application/json" },
    signal:  AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j    = await res.json();
  const ts   = j?.chart?.result?.[0]?.timestamp ?? [];
  if (!ts.length) throw new Error("empty result");
  return `${ts.length} bars`;
}

async function checkSources() {
  console.log(`\n[3] Data source connectivity (probe: ${PROBE})`);

  for (const [name, fn] of [["Stooq", checkStooq], ["NSE", checkNse], ["Yahoo", checkYahoo]]) {
    try {
      const detail = await fn();
      ok(name, detail);
    } catch (e) {
      fail(name, e.message);
    }
  }
}

// ─── Optional fix: re-run refresh ─────────────────────────────────────────────

function runFix(mode) {
  const script = mode === "eod"
    ? "node backend/refresh-cache.js stocks"
    : "node backend/refresh-intraday.js";
  console.log(`\n[fix] Running: ${script}`);
  try {
    execSync(script, {
      cwd:   path.join(__dirname, ".."),
      stdio: "inherit",
      env:   { ...process.env },
    });
    console.log("[fix] Re-run complete.");
  } catch (e) {
    console.error(`[fix] Re-run failed: ${e.message}`);
    allPassed = false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Data Health Check — ${new Date().toISOString()} (mode: ${MODE}) ===`);

  const stored = await checkSupabaseFreshness();
  checkPriceCoverage(stored);
  await checkSources();

  console.log(`\n${"─".repeat(50)}`);
  if (allPassed) {
    console.log("✓ All checks passed.");
  } else {
    console.error("✗ One or more checks FAILED.");
    if (FIX) {
      runFix(MODE);
    } else {
      console.error("  Run with --fix to attempt automatic recovery.");
    }
  }
  console.log("─".repeat(50));

  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
