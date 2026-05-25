"use strict";
/**
 * One-shot: read existing mf_radar cache from Supabase and regenerate
 * rule-based rationales for ALL categories (not just top 10).
 * Run whenever picks change or after a schema fix.
 *
 * Usage: node backend/regen-rationales.js
 */

require("dotenv").config();
const { createClient }       = require("@supabase/supabase-js");
const { generateRationales } = require("./generate-rationales");
const WebSocket              = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

async function main() {
  console.log("Fetching mf_radar from Supabase…");
  const { data: row, error } = await supabase
    .from("radar_cache")
    .select("data, built_at")
    .eq("key", "mf_radar")
    .single();

  if (error) throw new Error(`Fetch failed: ${error.message}`);

  const mf      = row.data;
  const catCount = mf.categories.length;
  console.log(`Cache built at: ${row.built_at}`);
  console.log(`Categories: ${catCount}`);
  console.log();

  const rationales = generateRationales(mf);   // all categories
  const today      = new Date().toISOString().slice(0, 10);

  console.log(`Generating rationales for ${rationales.length} funds…\n`);

  for (const r of rationales) {
    const { error: upsertErr } = await supabase
      .from("pick_rationales")
      .upsert(
        { ...r, generated_at: new Date().toISOString(), run_date: today },
        { onConflict: "fund_code,run_date" }
      );

    if (upsertErr) {
      console.error(`  ✗ ${r.fund_name}: ${upsertErr.message}`);
    } else {
      console.log(`  ✓ #${r.rank} ${r.fund_name} (${r.category}) → ${r.analysis.verdict} [${r.analysis.confidence}]`);
    }
  }

  console.log(`\nDone. ${rationales.length} rationales written for ${today}.`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
