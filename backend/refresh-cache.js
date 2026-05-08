"use strict";

/**
 * Run by GitHub Actions to build momentum data and persist to Supabase.
 * Usage: node refresh-cache.js [all|mf|stocks]
 */

require("dotenv").config();
const { createClient }          = require("@supabase/supabase-js");
const { getLeaderboard }        = require("./momentum");
const { getStockLeaderboard }   = require("./stock_momentum");
const { generateRationales }    = require("./generate-rationales");
const WebSocket                 = require("ws");

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
    console.log("Building stock radar…");
    const stocks = await getStockLeaderboard({ force: true });
    await upsert("stock_radar", stocks);
    console.log(`  ${stocks.sectors.length} sectors processed`);
    if (stocks.warnings?.length) console.warn("  warnings:", stocks.warnings);
  }

  console.log("Done.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
