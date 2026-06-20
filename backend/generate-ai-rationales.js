"use strict";
/**
 * Dynamically generates AI rationales for all current top MF picks.
 *
 * Fetches the live mf_radar blob from Supabase, sends each top pick to
 * Claude, and upserts results into pick_ai_rationales.
 *
 * Usage: node backend/generate-ai-rationales.js
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
 *
 * Replaces the manual seed-ai-rationales-*.js pattern — run this whenever
 * picks change significantly (suggested: weekly, after Monday 5 AM run).
 */

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const WebSocket = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Fetch current top picks from Supabase ────────────────────────────────────

async function fetchTopPicks() {
  const { data, error } = await supabase
    .from("radar_cache")
    .select("data")
    .eq("key", "mf_radar")
    .single();
  if (error) throw new Error(`Failed to fetch mf_radar: ${error.message}`);

  const mfData = data.data;
  // One best fund per category, sorted by composite score — mirrors MfPicks.jsx
  const picks = (mfData.categories || [])
    .map((cat) => {
      const top = [...(cat.funds || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (!top) return null;
      return { ...top, category: cat.category, catZ: cat.median?.z1w ?? 0, catMedian: cat.median };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // De-dup funds that appear in more than one category (same AMFI code) so we
  // don't burn a Claude call and clobber the upsert under the same fund_code.
  const seen = new Set();
  const deduped = picks.filter((p) => {
    if (p.code == null) return true;
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });

  return deduped;
}

// ─── Build prompt for a single pick ──────────────────────────────────────────

function buildPrompt(pick, nextPick, rank, total) {
  const fmt = (v) => (v == null ? "N/A" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const fmtN = (v, dec = 2) => (v == null ? "N/A" : v.toFixed(dec));

  const stats = [
    `1W: ${fmt(pick.ret1w)}`,
    `1M: ${fmt(pick.ret1m)}`,
    `3M: ${fmt(pick.ret3m)}`,
    `6M: ${fmt(pick.ret6m)}`,
    `1Y: ${fmt(pick.ret1y)}`,
    pick.ret3y != null ? `3Y CAGR: ${fmt(pick.ret3y)}` : null,
    pick.ret5y != null ? `5Y CAGR: ${fmt(pick.ret5y)}` : null,
    pick.ret10y != null ? `10Y CAGR: ${fmt(pick.ret10y)}` : null,
    pick.sharpe != null ? `Sharpe: ${fmtN(pick.sharpe)}` : null,
    pick.maxDd != null ? `Max DD: ${fmt(pick.maxDd)}` : null,
    pick.consistency != null ? `Consistency (≥12% windows): ${fmtN(pick.consistency * 100, 1)}%` : null,
    pick.alpha != null ? `Alpha vs benchmark: ${fmt(pick.alpha)}` : null,
    `Category z-score: ${fmtN(pick.catZ, 2)}`,
    `Composite score: ${fmtN(pick.score, 3)}`,
  ].filter(Boolean).join(" · ");

  const nextStats = nextPick ? [
    `${nextPick.name ?? nextPick.label} (${nextPick.category})`,
    `3M: ${fmt(nextPick.ret3m)}`,
    `1Y: ${fmt(nextPick.ret1y)}`,
    `Score: ${fmtN(nextPick.score, 2)}`,
  ].join(" | ") : "none (this is the last pick)";

  return `You are a seasoned Indian equity mutual fund analyst writing investment intelligence for sophisticated retail investors. Today is ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}.

Analyse this mutual fund pick and return a JSON object (no markdown, no prose, just the JSON):

Fund: ${pick.name ?? pick.label}
Category: ${pick.category}
Rank: #${rank} of ${total} top picks
Performance: ${stats}

Next pick for comparison: ${nextStats}

Return exactly this JSON structure:
{
  "macro_theme": "2-3 sentence macro/sector backdrop specific to India and this category right now. Mention current government policy, sector cycle, or macro driver. Be specific — no generic boilerplate.",
  "bull_case": [
    "Point 1: lead with a quantitative fact from the stats above",
    "Point 2: structural or fundamental reason",
    "Point 3: fund-specific or category-specific edge"
  ],
  "bear_case": [
    "Point 1: biggest quantitative risk from the stats",
    "Point 2: macro or sector headwind"
  ],
  "vs_next_pick": "2-3 sentences comparing this fund to the next-ranked pick. Be direct about which wins on which dimension and for which investor type.",
  "verdict": "Strong Buy|Buy|Hold|Avoid",
  "confidence": "High|Medium|Low",
  "confidence_reason": "One sentence explaining the confidence level, citing the most decisive stat."
}

Verdict rules: Strong Buy if score≥9 and z≥0.8 and all returns positive. Buy if score≥6 or z≥1.0. Hold if score 3–6. Avoid if score<3 or 1Y deeply negative.
Confidence rules: High if z≥1.5 and all return windows positive and score≥8. Low if z<0 or 1Y negative. Medium otherwise.
Keep prose tight — each bullet ≤20 words. No filler phrases.`;
}

// ─── Call Claude and parse response ──────────────────────────────────────────

async function generateAnalysis(pick, nextPick, rank, total) {
  const prompt = buildPrompt(pick, nextPick, rank, total);

  // max_tokens is a ceiling that INCLUDES adaptive-thinking tokens. At 1024 the
  // thinking budget could swallow most of it and truncate the JSON mid-object
  // (stop_reason "max_tokens" → JSON.parse fails → pick silently skipped). Give
  // ample headroom and stream so long turns don't hit the request timeout.
  const stream = anthropic.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "max_tokens") {
    throw new Error("response hit max_tokens — output likely truncated");
  }

  const text = msg.content.find((b) => b.type === "text")?.text ?? "";

  // Strip any accidental markdown fences
  const clean = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    // Try to extract JSON object from the text
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Claude returned unparseable JSON:\n${text.slice(0, 300)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to backend/.env or export it.");
    process.exit(1);
  }

  console.log("Fetching current top MF picks from Supabase…");
  const picks = await fetchTopPicks();
  console.log(`Found ${picks.length} top picks to analyse.\n`);

  const generatedAt = new Date().toISOString();
  let successCount = 0;

  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const nextPick = picks[i + 1] ?? null;
    const rank = i + 1;
    const name = pick.name ?? pick.label ?? pick.code;

    process.stdout.write(`  [${rank}/${picks.length}] ${name} … `);

    try {
      const analysis = await generateAnalysis(pick, nextPick, rank, picks.length);

      const { error } = await supabase.from("pick_ai_rationales").upsert(
        {
          fund_code:    pick.code,
          fund_name:    name,
          category:     pick.category,
          rank,
          analysis,
          generated_at: generatedAt,
        },
        { onConflict: "fund_code" }
      );

      if (error) {
        console.log(`✗ Supabase: ${error.message}`);
      } else {
        console.log(`✓ ${analysis.verdict} [${analysis.confidence}]`);
        successCount++;
      }
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }

    // 500ms between Claude calls — avoids rate limits on the API
    if (i < picks.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone. ${successCount}/${picks.length} rationales written to pick_ai_rationales.`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
