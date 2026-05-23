"use strict";

/**
 * Run by GitHub Actions to build momentum data and persist to Supabase.
 * Usage: node refresh-cache.js [all|mf|stocks]
 */

require("dotenv").config();
const { createClient }              = require("@supabase/supabase-js");
const { getLeaderboard }            = require("./momentum");
const { getStockLeaderboard }       = require("./stock_momentum");
const { buildSignalsLeaderboard }   = require("./stock_signals");
const { getDeliveryMap }            = require("./stock_bhavcopy");
const { getDiscovery, buildSymbolBonuses } = require("./nse_discovery");
const { getNifty500 }               = require("./nifty500_universe");
const { getNiftyReturns }           = require("./nifty_benchmark");
const { getFundamentalsBatch }      = require("./yahoo_fundamentals");
const { generateRationales }        = require("./generate-rationales");
const { generateStockRationales }   = require("./generate-stock-rationales");
const WebSocket                     = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth:     { persistSession: false },
    realtime: { transport: WebSocket },
  }
);

const target = process.argv[2] || "all";

async function upsert(key, data) {
  const { error } = await supabase
    .from("radar_cache")
    .upsert({ key, data, built_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase upsert failed for ${key}: ${error.message}`);
  const kb = (JSON.stringify(data).length / 1024).toFixed(1);
  console.log(`✓ ${key} saved (${kb} KB)`);
}

async function main() {
  console.log(`Target: ${target} | ${new Date().toISOString()}`);

  if (target === "all" || target === "mf") {
    console.log("Building MF radar…");
    const mf = await getLeaderboard({ force: true });
    await upsert("mf_radar", mf);
    console.log(`  ${mf.categories.length} categories processed`);
    if (mf.warnings?.length) console.warn("  warnings:", mf.warnings);

    console.log("Generating rule-based rationales…");
    const today      = new Date().toISOString().slice(0, 10);
    const rationales = generateRationales(mf, 10);
    for (const r of rationales) {
      const { error } = await supabase
        .from("pick_rationales")
        .upsert({ ...r, generated_at: new Date().toISOString(), run_date: today },
                { onConflict: "fund_code,run_date" });
      if (error) console.warn(`  ✗ rationale for ${r.fund_name}: ${error.message}`);
      else       console.log(`  ✓ #${r.rank} ${r.fund_name} → ${r.analysis.verdict}`);
    }
  }

  if (target === "all" || target === "stocks") {
    console.log("Building stock radar (curated 84-stock sector view)…");
    const stocks = await getStockLeaderboard({ force: true });
    await upsert("stock_radar", stocks);
    console.log(`  ${stocks.sectors.length} sectors processed`);
    if (stocks.warnings?.length) console.warn("  warnings:", stocks.warnings);

    console.log("Fetching NSE bhavcopy for delivery %…");
    let deliveryMap = {};
    try {
      const bhav = await getDeliveryMap({ force: true });
      deliveryMap = bhav.symbols ?? {};
      console.log(`  ✓ bhavcopy for ${bhav.date} (${bhav.count} symbols)`);
    } catch (e) {
      console.warn(`  ⚠ bhavcopy unavailable: ${e.message}`);
    }

    console.log("Fetching NSE discovery feeds…");
    let discovery = null, discBonuses = {};
    try {
      discovery = await getDiscovery({ force: true });
      discBonuses = buildSymbolBonuses(discovery);
      console.log(`  ✓ 52wHi=${discovery.highs52w.length} gainers=${discovery.topGainers.length} ` +
                  `bulk=${discovery.bulkDeals.length} block=${discovery.blockDeals.length} ` +
                  `oiLong=${discovery.oiBuildup.longBuildup.length}`);
    } catch (e) {
      console.warn(`  ⚠ discovery feeds unavailable: ${e.message}`);
    }

    console.log("Loading Nifty 500 universe…");
    let universe;
    try {
      universe = await getNifty500();
      console.log(`  ✓ ${universe.length} stocks in Nifty 500`);
    } catch (e) {
      console.warn(`  ⚠ Nifty 500 fetch failed (${e.message}) — falling back to curated 84-stock list`);
    }

    console.log("Fetching Nifty 50 benchmark for relative-strength…");
    let niftyReturns = null;
    try {
      niftyReturns = await getNiftyReturns();
      console.log(`  ✓ Nifty 1M=${niftyReturns.ret1m?.toFixed(1)}% 3M=${niftyReturns.ret3m?.toFixed(1)}% 1Y=${niftyReturns.ret1y?.toFixed(1)}%`);
    } catch (e) {
      console.warn(`  ⚠ Nifty benchmark unavailable: ${e.message}`);
    }

    console.log("Computing stock signals across universe (this can take a few minutes)…");
    const signals = await buildSignalsLeaderboard({
      deliveryMap, discBonuses, niftyReturns, universe, concurrency: 6,
    });

    console.log("Fetching fundamentals for top 200 picks…");
    let fundamentals = {};
    try {
      const topSymbols = signals.all.slice(0, 200).map((p) => p.symbol);
      fundamentals = await getFundamentalsBatch(topSymbols, { concurrency: 5 });
      console.log(`  ✓ fundamentals for ${Object.values(fundamentals).filter(Boolean).length} of ${topSymbols.length}`);
    } catch (e) {
      console.warn(`  ⚠ fundamentals unavailable: ${e.message}`);
    }

    // Attach fundamentals + small mcap penalty + quality bonus
    for (const p of signals.all) {
      const f = fundamentals[p.symbol];
      if (!f) continue;
      p.fundamentals = f;
      if (f.marketCapCr != null && f.marketCapCr < 500) {
        // Penalize tiny micro-caps to keep picks investable
        p.compositeScore = Math.max(0, p.compositeScore - 10);
      } else if (f.marketCapCr != null && f.marketCapCr >= 5000) {
        // Large-cap quality bonus
        p.compositeScore = Math.min(100, p.compositeScore + 3);
      }
      // Earnings-growth bonus
      if (f.earningsGrowth != null && f.earningsGrowth >= 20) {
        p.compositeScore = Math.min(100, p.compositeScore + 5);
      }
      // High RoE bonus
      if (f.returnOnEquity != null && f.returnOnEquity >= 20) {
        p.compositeScore = Math.min(100, p.compositeScore + 3);
      }
    }
    // Re-sort after fundamental adjustments
    signals.all.sort((a, b) => b.compositeScore - a.compositeScore || b.signalCount - a.signalCount);
    signals.all.forEach((s, i) => { s.rank = i + 1; });
    signals.picks = signals.all.slice(0, 50);

    await upsert("stock_picks", {
      asOf:      signals.asOf,
      universe:  signals.universe,
      scanned:   signals.scanned,
      picks:     signals.picks,
      all:       signals.all.slice(0, 200),     // top 200 only — cache size
      discovery: discovery ?? null,
      niftyReturns,
      warnings:  signals.warnings.slice(0, 20),
    });
    console.log(`  ✓ ${signals.picks.length} top picks ranked (${signals.scanned} of ${signals.universe} stocks scanned)`);
    if (signals.warnings?.length) console.warn(`  warnings (${signals.warnings.length} total, first 5):`, signals.warnings.slice(0, 5));

    console.log("Generating rule-based stock rationales…");
    const today = new Date().toISOString().slice(0, 10);
    const stockRationales = generateStockRationales(signals.picks, 25);
    for (const r of stockRationales) {
      const { error } = await supabase
        .from("stock_pick_rationales")
        .upsert(
          { ...r, generated_at: new Date().toISOString(), run_date: today },
          { onConflict: "symbol,run_date" }
        );
      if (error) console.warn(`  ✗ rationale for ${r.symbol}: ${error.message}`);
      else       console.log(`  ✓ #${r.rank} ${r.stock_name} (score ${r.composite_score}) → ${r.analysis.verdict}`);
    }
  }

  console.log("Done.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
