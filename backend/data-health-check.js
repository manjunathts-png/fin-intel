"use strict";
/**
 * Data Health Check
 *
 * Verifies that stock, MF, and ETF data in Supabase is fresh and reachable
 * data sources are working. Writes a system_health snapshot to Supabase so
 * the frontend can surface alerts. Run after every refresh step.
 *
 * Checks:
 *   1. stock_picks — EOD freshness (28h), intraday freshness (3h), price coverage
 *   2. mf_radar    — freshness (28h), fund count
 *   3. etf_picks   — freshness (28h), ETF count
 *   4. Nifty benchmark — connectivity via NSE index archive or Stooq/Yahoo
 *   5. Source connectivity — Stooq, NSE, Yahoo for one probe symbol
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
const { execSync }        = require("child_process");
const { createClient }    = require("@supabase/supabase-js");
const WebSocket           = require("ws");
const path                = require("path");
const { businessHoursAge } = require("./utils");

let _supabase = null;
function supabaseClient() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false }, realtime: { transport: WebSocket } }
    );
  }
  return _supabase;
}

const args    = process.argv.slice(2);
const FIX     = args.includes("--fix");
const NOTIFY  = args.includes("--notify");  // send alerts only when this flag is set
const MODE    = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "intraday";
const PROBE   = "TCS.NS";  // test symbol for source connectivity checks

// Alert destinations — set via environment variables (no hard-coded secrets)
// Email  : set ALERT_EMAIL + RESEND_API_KEY (https://resend.com, free 3k/mo)
// Telegram: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//           (create bot via @BotFather, get chat ID via https://api.telegram.org/bot<TOKEN>/getUpdates)
const ALERT_EMAIL       = process.env.ALERT_EMAIL;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

const STALE_INTRADAY_H   = 3;    // hours — intraday data older than this is stale
const STALE_EOD_H        = 28;   // hours — EOD data older than this is stale
const MIN_PRICE_COVERAGE = 0.80; // at least 80% of top-50 picks need a valid close
const MIN_FUND_COUNT     = 60;   // at least this many MF funds expected
const MIN_ETF_COUNT      = 3;    // at least this many ETFs expected

const FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

let allPassed = true;

// ─── Structured result accumulator ───────────────────────────────────────────

const healthResults = [];

function record(check, status, detail = "") {
  healthResults.push({ check, status, detail, ts: new Date().toISOString() });
}

function ok(label, detail = "") {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  record(label, "ok", detail);
}

function fail(label, detail = "") {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  record(label, "fail", detail);
  allPassed = false;
}

function info(label, detail = "") {
  console.log(`  ℹ ${label}${detail ? ` — ${detail}` : ""}`);
}

function warn(label, detail = "") {
  console.warn(`  ⚠ ${label}${detail ? ` — ${detail}` : ""}`);
  record(label, "warn", detail);
}

function hoursAgo(isoStr) {
  if (!isoStr) return Infinity;
  return (Date.now() - new Date(isoStr).getTime()) / (1000 * 60 * 60);
}

// First line of a non-CSV response, collapsed — enough to tell a rate-limit
// notice from a bot-block page in the alert text
function bodySnippet(text, max = 80) {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max) || "(empty body)";
}

// ─── Check 1: Supabase stock_picks freshness ──────────────────────────────────

async function checkSupabaseFreshness() {
  console.log("\n[1] Supabase stock_picks freshness");
  const { data: row, error } = await supabaseClient()
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
    fail("stocks EOD freshness", `${eodAge.toFixed(1)}h old — expected < ${STALE_EOD_H}h`);
  } else {
    ok("stocks EOD freshness", `${eodAge.toFixed(1)}h old`);
  }

  if (MODE === "intraday") {
    if (intradayAge > STALE_INTRADAY_H) {
      fail("stocks intraday freshness", `${intradayAge.toFixed(1)}h old — expected < ${STALE_INTRADAY_H}h`);
    } else {
      ok("stocks intraday freshness", `${intradayAge.toFixed(1)}h old`);
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

  const times = picks
    .map((p) => p.intradayAsOf)
    .filter(Boolean)
    .sort()
    .slice(-3);
  if (times.length) {
    info("last intraday updates", times.map((t) => t.slice(11, 16)).join(", ") + " UTC");
  }
}

// ─── Check 3: MF radar freshness ─────────────────────────────────────────────

async function checkMfRadar() {
  console.log("\n[3] Supabase mf_radar freshness");
  const { data: row, error } = await supabaseClient()
    .from("radar_cache").select("data, built_at").eq("key", "mf_radar").single();

  if (error || !row) {
    fail("mf_radar", `could not load from Supabase: ${error?.message ?? "no row"}`);
    return;
  }

  const age        = hoursAgo(row.built_at);
  // mf_radar is refreshed only by the nightly "all"/"mf" target (Mon-Fri) —
  // no intraday touch re-freshens it like stock_picks. A flat wall-clock
  // threshold fails every single weekend (and Monday, until the Monday-night
  // run lands) even though nothing is actually broken. Discount weekend hours.
  const bizAge     = businessHoursAge(row.built_at);
  const categories = row.data?.categories ?? [];
  const fundCount  = categories.reduce((n, c) => n + (c.funds?.length ?? 0), 0);

  info("mf_radar built_at", `${row.built_at?.slice(0, 16) ?? "—"} (${age.toFixed(1)}h ago, ${bizAge.toFixed(1)}h business-hours)`);
  info("categories", `${categories.length}, funds: ${fundCount}`);

  if (bizAge > STALE_EOD_H) {
    fail("mf_radar freshness", `${age.toFixed(1)}h old (${bizAge.toFixed(1)}h business-hours) — expected < ${STALE_EOD_H}h`);
  } else {
    ok("mf_radar freshness", `${age.toFixed(1)}h old (${bizAge.toFixed(1)}h business-hours)`);
  }

  if (fundCount < MIN_FUND_COUNT) {
    fail("mf_radar fund count", `${fundCount} funds — expected >= ${MIN_FUND_COUNT}`);
  } else {
    ok("mf_radar fund count", `${fundCount} funds`);
  }
}

// ─── Check 4: ETF picks freshness ────────────────────────────────────────────

// The etf_picks blob is { asOf, types: [{ type, etfs: [...] }], warnings }
// (built by etf_momentum.js getEtfLeaderboard). Older/legacy shapes exposed a
// flat picks/etfs array — kept as fallbacks. An ETF counts as "priced" when
// its price fetch succeeded; entries are written even when every source fails,
// so the priced count is what actually detects a data outage.
function summarizeEtfBlob(data) {
  const flat = Array.isArray(data?.types)
    ? data.types.flatMap((t) => t.etfs ?? [])
    : (data?.picks ?? data?.etfs ?? []);
  const priced = flat.filter((e) => (e.latestPrice ?? e.close) > 0).length;
  return { etfCount: flat.length, pricedCount: priced };
}

async function checkEtfPicks() {
  console.log("\n[4] Supabase etf_picks freshness");
  const { data: row, error } = await supabaseClient()
    .from("radar_cache").select("data, built_at").eq("key", "etf_picks").single();

  if (error || !row) {
    fail("etf_picks", `could not load from Supabase: ${error?.message ?? "no row"}`);
    return;
  }

  const age = hoursAgo(row.built_at);
  // Same weekend gap as mf_radar — etf_picks only refreshes via the nightly
  // "all"/"etf" target. See businessHoursAge in utils.js.
  const bizAge = businessHoursAge(row.built_at);
  const { etfCount, pricedCount } = summarizeEtfBlob(row.data);

  info("etf_picks built_at", `${row.built_at?.slice(0, 16) ?? "—"} (${age.toFixed(1)}h ago, ${bizAge.toFixed(1)}h business-hours)`);
  info("ETFs", `${etfCount} (${pricedCount} with price)`);

  if (bizAge > STALE_EOD_H) {
    fail("etf_picks freshness", `${age.toFixed(1)}h old (${bizAge.toFixed(1)}h business-hours) — expected < ${STALE_EOD_H}h`);
  } else {
    ok("etf_picks freshness", `${age.toFixed(1)}h old (${bizAge.toFixed(1)}h business-hours)`);
  }

  if (etfCount < MIN_ETF_COUNT) {
    fail("etf_picks count", `${etfCount} ETFs — expected >= ${MIN_ETF_COUNT}`);
  } else {
    ok("etf_picks count", `${etfCount} ETFs`);
  }

  // Entries exist even when every price fetch failed — check coverage too
  if (etfCount >= MIN_ETF_COUNT) {
    const coverage = pricedCount / etfCount;
    if (coverage < 0.5) {
      fail("etf_picks price coverage", `${pricedCount}/${etfCount} ETFs have a price (<50%) — price sources failed during build`);
    } else if (coverage < MIN_PRICE_COVERAGE) {
      warn("etf_picks price coverage", `${pricedCount}/${etfCount} ETFs have a price (<${MIN_PRICE_COVERAGE * 100}%)`);
    } else {
      ok("etf_picks price coverage", `${pricedCount}/${etfCount} ETFs have a price`);
    }
  }
}

// ─── Check 5: Nifty benchmark ────────────────────────────────────────────────

async function checkNiftyBenchmark() {
  console.log("\n[5] Nifty benchmark connectivity");
  // Try NSE index archive probe (single recent file — fastest)
  const probeDate  = new Date();
  probeDate.setDate(probeDate.getDate() - 3); // go back 3 days to avoid today being non-trading
  const dd   = String(probeDate.getDate()).padStart(2, "0");
  const mm   = String(probeDate.getMonth() + 1).padStart(2, "0");
  const yyyy = probeDate.getFullYear();
  const url  = `https://nsearchives.nseindia.com/content/indices/ind_close_all_${dd}${mm}${yyyy}.csv`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCH_UA },
      signal:  AbortSignal.timeout(15000),
    });
    // 404 is expected for non-trading days — just confirms archive is reachable
    if (res.ok || res.status === 404) {
      ok("NSE index archive", `HTTP ${res.status} — archive reachable`);
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    warn("NSE index archive", e.message);
  }

  // Stooq fallback probe
  try {
    const d1  = new Date(); d1.setDate(d1.getDate() - 10);
    const d2  = new Date(); d2.setDate(d2.getDate() + 1);
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const stooqUrl = `https://stooq.com/q/d/l/?s=%5Ensei&d1=${fmt(d1)}&d2=${fmt(d2)}&i=d`;
    const res  = await fetch(stooqUrl, {
      headers: { "User-Agent": FETCH_UA },
      signal:  AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length < 50 || !text.toLowerCase().startsWith("date")) throw new Error(`unexpected response (len=${text.length}): ${bodySnippet(text)}`);
    ok("Nifty benchmark (Stooq)", `${text.trim().split(/\r?\n/).length - 1} rows`);
    return;
  } catch (e) {
    warn("Nifty benchmark (Stooq)", e.message);
  }

  fail("Nifty benchmark", "NSE index archive and Stooq both unreachable — RS signals will be null");
}

// ─── Check 6: Source connectivity ────────────────────────────────────────────

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
    throw new Error(`unexpected response (len=${text.length}): ${bodySnippet(text)}`);
  }
  const lines = text.trim().split(/\r?\n/);
  return `${lines.length - 1} rows`;
}

async function checkNse() {
  const NSE_BASE = "https://www.nseindia.com";
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
  const j  = await res.json();
  const ts = j?.chart?.result?.[0]?.timestamp ?? [];
  if (!ts.length) throw new Error("empty result");
  return `${ts.length} bars`;
}

async function checkSources() {
  console.log(`\n[6] Data source connectivity (probe: ${PROBE})`);

  let anyUp = false;
  for (const [name, fn] of [["Stooq", checkStooq], ["NSE", checkNse], ["Yahoo", checkYahoo]]) {
    try {
      const detail = await fn();
      ok(name, detail);
      anyUp = true;
    } catch (e) {
      warn(name, e.message);
    }
  }

  if (!anyUp) {
    fail("all price sources", "Stooq, NSE, and Yahoo are all unreachable — no price data possible");
  }
}

// ─── Alert notifications ──────────────────────────────────────────────────────

function buildAlertText() {
  const fails = healthResults.filter((r) => r.status === "fail");
  const warns = healthResults.filter((r) => r.status === "warn");
  const lines = [
    `⚠️ fin-intel data health check — ${fails.length} failure(s), ${warns.length} warning(s)`,
    `Mode: ${MODE} | ${new Date().toISOString().slice(0, 16)} UTC`,
    "",
  ];
  if (fails.length) {
    lines.push("FAILURES:");
    for (const r of fails) lines.push(`  ✗ ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
    lines.push("");
  }
  if (warns.length) {
    lines.push("WARNINGS:");
    for (const r of warns) lines.push(`  ⚠ ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  return lines.join("\n");
}

async function sendEmailAlert(text) {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        // resend.dev is Resend's shared sandbox domain — works with zero DNS
        // setup, but only delivers to the email address that owns the Resend
        // account. Switch to a verified custom domain if that stops being true.
        from:    "fin-intel alerts <onboarding@resend.dev>",
        to:      [ALERT_EMAIL],
        subject: `[fin-intel] Data health check failed (${healthResults.filter((r) => r.status === "fail").length} issues)`,
        text,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    console.log(`  ✓ email alert sent to ${ALERT_EMAIL}`);
    return true;
  } catch (e) {
    console.warn(`  ⚠ email alert failed: ${e.message}`);
    return false;
  }
}

async function sendTelegramAlert(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       `<pre>${text}</pre>`,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    console.log(`  ✓ Telegram alert sent`);
    return true;
  } catch (e) {
    console.warn(`  ⚠ Telegram alert failed: ${e.message}`);
    return false;
  }
}

async function sendAlerts() {
  // Only alert on actual failures (warnings are tolerable)
  const failCount = healthResults.filter((r) => r.status === "fail").length;
  if (failCount === 0) {
    console.log("  ✓ no failures — no alert sent");
    return;
  }

  const text = buildAlertText();
  console.log("\n[alert] Sending failure notifications…");

  let sent = false;
  sent = await sendEmailAlert(text) || sent;
  sent = await sendTelegramAlert(text) || sent;

  if (!sent) {
    console.warn("  ⚠ no alert destinations configured");
    console.warn("  Set RESEND_API_KEY + ALERT_EMAIL for email, or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for Telegram");
  }
}

// ─── Write system_health to Supabase ─────────────────────────────────────────

async function writeSystemHealth() {
  const payload = {
    checkedAt:  new Date().toISOString(),
    mode:       MODE,
    allPassed,
    results:    healthResults,
    failCount:  healthResults.filter((r) => r.status === "fail").length,
    warnCount:  healthResults.filter((r) => r.status === "warn").length,
  };
  try {
    const { error } = await supabaseClient()
      .from("radar_cache")
      .upsert({ key: "system_health", data: payload, built_at: new Date().toISOString() });
    if (error) throw error;
    console.log(`  ✓ system_health written to Supabase (${payload.failCount} fails, ${payload.warnCount} warns)`);
  } catch (e) {
    console.error(`  ✗ failed to write system_health: ${e.message}`);
  }
}

// ─── Optional fix: re-run whichever refresh actually covers what failed ───────

// A fix run of "stocks" can never repair a stale mf_radar (and vice versa) —
// each failing check maps to the one refresh-cache.js target that touches
// that data. Nifty-benchmark/source-connectivity failures map to nothing:
// they're a third-party outage, not something a local re-run can fix.
function fixScriptsForFailures(results, mode) {
  const targets = new Set();
  for (const r of results) {
    if (r.status !== "fail") continue;
    if (r.check.startsWith("stocks EOD") || r.check.startsWith("stocks intraday") ||
        r.check === "price coverage" || r.check === "stock_picks") {
      targets.add(mode === "intraday" ? "intraday" : "stocks");
    } else if (r.check.startsWith("mf_radar")) {
      targets.add("mf");
    } else if (r.check.startsWith("etf_picks")) {
      targets.add("etf");
    }
  }
  return [...targets].map((t) =>
    t === "intraday" ? "node backend/refresh-intraday.js" : `node backend/refresh-cache.js ${t}`
  );
}

function runFix(mode) {
  const scripts = fixScriptsForFailures(healthResults, mode);
  if (scripts.length === 0) {
    console.log("\n[fix] No failing check maps to a local refresh target (likely a third-party source outage) — skipping.");
    return;
  }
  for (const script of scripts) {
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
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`=== Data Health Check — ${new Date().toISOString()} (mode: ${MODE}) ===`);

  const stored = await checkSupabaseFreshness();
  checkPriceCoverage(stored);
  await checkMfRadar();
  await checkEtfPicks();
  await checkNiftyBenchmark();
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

  await writeSystemHealth();

  if (NOTIFY) {
    await sendAlerts();
  }

  console.log("─".repeat(50));

  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}

module.exports = { summarizeEtfBlob, bodySnippet, fixScriptsForFailures };
