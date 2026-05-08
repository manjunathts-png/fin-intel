"use strict";
/**
 * One-time seed: inserts the AI-generated rationales into Supabase.
 * Usage: node backend/seed-rationales.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const WebSocket        = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

const TODAY = new Date().toISOString().slice(0, 10);

const RATIONALES = [
  {
    fund_code: "152712",
    fund_name: "Motilal Oswal Nifty India Defence Index Fund Direct Plan Growth",
    category:  "Defence",
    rank:      1,
    score:     11.855,
    analysis: {
      macro_theme:       "India's defence sector is in a structural multi-year upcycle. The FY26 defence budget crossed ₹6.2 lakh crore with an explicit mandate for 50%+ indigenisation. Recent India-Pakistan tensions have added urgency to defence capex, translating directly into order flows for HAL, BEL, Cochin Shipyard, and Bharat Dynamics.",
      bull_case: [
        "Order pipelines at record levels — HAL alone has ~₹1 lakh crore in backlog; government defence procurement accelerating",
        "Geopolitical tensions create bipartisan political will to sustain or increase defence budgets regardless of party in power",
        "Strongest 1Y return (+36.93%) with a massive score gap vs #2 — momentum is sustained, not just recent"
      ],
      bear_case: [
        "Concentrated sector — only ~15 liquid defence stocks; heavy PSU weight amplifies policy and execution risk",
        "Valuations are stretched at 40–60x PE for several PSUs; a single order delay can drop NAV 10%+ in a week"
      ],
      vs_next_pick:       "Defence wins on every return timeframe vs Microcap. The macro narrative is far more concrete — a funded government policy rather than a broad market recovery bet. For a single high-conviction pick, Defence is the stronger call right now.",
      verdict:            "Strong Buy",
      confidence:         "High",
      confidence_reason:  "Structural policy tailwind (defence budget + indigenisation) backed by geopolitical urgency and sustained multi-timeframe performance."
    }
  },
  {
    fund_code: "151814",
    fund_name: "Motilal Oswal Nifty Microcap 250 Index Fund- Direct- Growth Option",
    category:  "Micro Cap",
    rank:      2,
    score:     8.888,
    analysis: {
      macro_theme:       "Microcap is in a sharp mean-reversion rally after a brutal H2 FY25 correction where many stocks fell 30–50%. Rural consumption recovery, GST collections at all-time highs, and domestic institutional SIP flows are finding their way into smaller names. The 6M return of only +1.73% reveals this is a bounce trade, not yet a sustained trend.",
      bull_case: [
        "Strong z-score (1.23) — this week's move is statistically above-average, suggesting institutional accumulation",
        "250-stock index provides diversification within the micro-end universe, reducing single-stock blowup risk",
        "In a broad bull market, microcaps historically deliver 2–3x the Nifty return"
      ],
      bear_case: [
        "6M return of only +1.73% shows this category was deeply in the red earlier — buyers may exit quickly if macro turns",
        "FII selling or credit tightening hits microcaps first and hardest; liquidity dries up fast in stress"
      ],
      vs_next_pick:       "Microcap has better 1W and 1M than Quant Small Cap, but similar 1Y. Microcap is higher risk/higher reward; Small Cap is a more stable variant of the same trade. Both work in a bull market, but Microcap will fall harder in a correction.",
      verdict:            "Buy",
      confidence:         "Medium",
      confidence_reason:  "Recovery momentum is real but the 6M flat return shows how quickly this category can reverse; hold size accordingly."
    }
  },
  {
    fund_code: "120828",
    fund_name: "quant Small Cap Fund - Growth Option - Direct Plan",
    category:  "Small Cap",
    rank:      3,
    score:     8.608,
    analysis: {
      macro_theme:       "Small cap recovery is broadening across Indian equities. Quant AMC's factor-based model has been identifying undervalued names before they re-rate. The category z-score of 1.38 is one of the stronger readings in the current radar, indicating broad-based momentum rather than just index-level moves.",
      bull_case: [
        "Category z-score of 1.38 — statistically significant momentum across the small cap universe",
        "Quant AMC's quant model has historically outperformed passive small cap indices by generating active alpha",
        "Better 3M return (+11.78%) than Microcap (+10.62%) with greater underlying liquidity"
      ],
      bear_case: [
        "Quant AMC has faced regulatory scrutiny in the past; any AMC-specific event creates headline and redemption risk",
        "1Y return (+14.78%) is modest — the 3M spike may be a technical bounce rather than earnings-led recovery"
      ],
      vs_next_pick:       "Quant Small Cap has better 3M than Mirae Healthcare but lower z-score. Small Cap is a market-recovery bet while Healthcare is a defensive-growth play. They serve different risk profiles — Small Cap for higher beta, Healthcare for durability.",
      verdict:            "Buy",
      confidence:         "Medium",
      confidence_reason:  "Strong category momentum and active alpha generation, but AMC-specific risk and modest 1Y returns temper conviction."
    }
  },
  {
    fund_code: "143783",
    fund_name: "Mirae Asset Healthcare Fund Direct Growth",
    category:  "Pharma & Healthcare",
    rank:      4,
    score:     8.172,
    analysis: {
      macro_theme:       "Pharma & Healthcare has the strongest category z-score in the entire top 10 (1.81) — this week's move is the most statistically unusual vs its trailing 90 days. US FDA approval pipeline is clearing; India's generic exports are recovering as USD strengthens; domestic healthcare spending grows at 15%+ driven by insurance penetration and hospital expansion.",
      bull_case: [
        "Highest category z-score (1.81) — institutional money rotating in right now with statistical strength",
        "Defensive-growth profile: healthcare outperforms in slowdowns and doesn't collapse in recessions like cyclicals",
        "Mirae's fund has best-in-category 1Y performance (+18% vs category median +13%)"
      ],
      bear_case: [
        "US FDA import alerts on Indian manufacturing facilities remain a tail risk — one bad inspection can hurt the whole sector",
        "Domestic hospital stocks at elevated valuations; any earnings miss triggers sharp sector-wide corrections"
      ],
      vs_next_pick:       "Healthcare has a far stronger z-score (1.81 vs 0.58 for Infra) and is more defensive. Infrastructure has better 1Y (+22.55%) and 6M, making it better for a 12-month horizon. For a 3-month view, Healthcare is the stronger pick; for a 1-year view, Infra competes.",
      verdict:            "Buy",
      confidence:         "High",
      confidence_reason:  "Strongest category z-score in the entire radar combined with defensive characteristics and fund-level alpha."
    }
  },
  {
    fund_code: "118763",
    fund_name: "Nippon India Power & Infra Fund - Direct Plan Growth Plan - Growth Option",
    category:  "Infrastructure",
    rank:      5,
    score:     7.582,
    analysis: {
      macro_theme:       "India's ₹111 lakh crore National Infrastructure Pipeline and ₹11.11 lakh crore capex budget are translating into real order flows for power, roads, and industrial construction. The 6M (+11.56%) and 1Y (+22.55%) returns show this is a durable trend — among the best long-term performers in this radar.",
      bull_case: [
        "Best 6M (+11.56%) and 1Y (+22.55%) returns in the top 5 — a sustained multi-quarter trend, not just a weekly spike",
        "Power sector capex is multi-year: renewable energy targets + data center boom + industrial electrification all compound",
        "Government infra spend is counter-cyclical and politically ring-fenced from budget cuts"
      ],
      bear_case: [
        "Weakest 1W (+2.48%) and z-score (0.62) in the top 5 — short-term momentum is fading relative to peers",
        "Execution delays are endemic in Indian infra; project slippage regularly disappoints quarterly earnings"
      ],
      vs_next_pick:       "Infrastructure has a better long-term track record (1Y: 22.55% vs Manufacturing: 25.55%), but Manufacturing edges it on 1Y. Both are capex-driven themes — Infra is more government-dependent while Manufacturing has private sector PLI pull. Infra suits conservative investors; Manufacturing suits those who want private capex exposure.",
      verdict:            "Buy",
      confidence:         "Medium",
      confidence_reason:  "Strong long-term returns validate the theme, but weakening short-term momentum (lowest 1W in top 5) warrants position sizing caution."
    }
  },
  {
    fund_code: "133516",
    fund_name: "Aditya Birla Sun Life Manufacturing Equity Fund - Direct Plan - Growth",
    category:  "Manufacturing",
    rank:      6,
    score:     6.933,
    analysis: {
      macro_theme:       "PLI schemes across 14 sectors are pulling manufacturing capex into India. China+1 diversification is a genuine multi-year trend with Apple, Samsung and others expanding India production. The 1Y return of +25.55% is the second-strongest in the entire top 10 after Defence, showing this is a story with fundamental backing.",
      bull_case: [
        "Second-best 1Y return (+25.55%) — manufacturing theme has fundamental earnings backing, not just sentiment",
        "PLI disbursements accelerating; semiconductor and electronics manufacturing creating new structural legs for the theme",
        "Broad diversification across capital goods, auto ancillaries, chemicals, and consumer durables reduces concentration risk"
      ],
      bear_case: [
        "Manufacturing theme is well-known and well-owned — limited fresh catalyst needed to sustain momentum from here",
        "Any INR appreciation or global slowdown reduces export-linked manufacturing competitiveness"
      ],
      vs_next_pick:       "Manufacturing has a better 1Y than Midcap (25.55% vs 19.67%) and tells a clearer sectoral story. Midcap is a broader bet on India growth; Manufacturing is a specific bet on India's industrial transformation. Manufacturing wins on fundamental strength; Midcap wins on breadth and SIP flow support.",
      verdict:            "Buy",
      confidence:         "Medium",
      confidence_reason:  "Strong 1Y returns and policy tailwind are compelling, but the theme is crowded and needs a fresh catalyst to outperform from current levels."
    }
  },
  {
    fund_code: "119775",
    fund_name: "Kotak Midcap Fund - Direct Plan - Growth",
    category:  "Mid Cap",
    rank:      7,
    score:     5.709,
    analysis: {
      macro_theme:       "Midcap is the most consistently SIP-flows-supported segment in Indian equity. However, the 3M return of only +5.5% vs +10–14% for small/microcap shows midcap has lagged its smaller peers in this particular recovery cycle.",
      bull_case: [
        "Category z-score of 1.10 — above-average momentum returning to the category",
        "Kotak Midcap has outperformed its category median 1Y (19.67% vs 17.62%) — consistent alpha generation",
        "Strong SIP flow support provides a steady bid for midcap stocks"
      ],
      bear_case: [
        "Weakest 3M in cap-size categories (+5.5%) — this recovery started later and with less force than Small/Microcap",
        "Midcap valuations are historically stretched; PE ratios well above long-term averages"
      ],
      vs_next_pick:       "Midcap has better 1Y than Quant ELSS but worse 3M and 1M. ELSS is primarily a tax-saving vehicle with a lock-in; Midcap is a pure investment call. For investors without 80C needs, Midcap is the better choice of the two on momentum and category strength.",
      verdict:            "Hold",
      confidence:         "Medium",
      confidence_reason:  "Solid long-term fund but lagging smaller cap peers in current recovery; better entry point may come."
    }
  },
  {
    fund_code: "120847",
    fund_name: "quant ELSS Tax Saver Fund - Growth Option - Direct Plan",
    category:  "ELSS",
    rank:      8,
    score:     5.697,
    analysis: {
      macro_theme:       "ELSS as a category is struggling — the median fund returned -1.4% over 3 months. Quant ELSS at +6.55% 3M is massively outperforming its category peers. This is an alpha story, not a category story. The fund is essentially running a small/midcap quant strategy inside an ELSS wrapper.",
      bull_case: [
        "Quant's factor model generating massive alpha vs ELSS median (3M: +6.55% vs category -1.4%)",
        "3-year lock-in forces long-term holding, which suits the current early-recovery setup",
        "Tax benefit (80C deduction up to ₹1.5L) makes the effective return even better for investors in the 30% bracket"
      ],
      bear_case: [
        "Only relevant if you need 80C deduction — otherwise capital is better deployed in Small Cap or Defence",
        "ELSS category median is negative 3M — broad ELSS headwinds mean this fund is swimming against the tide"
      ],
      vs_next_pick:       "ELSS vs Energy is a false comparison — they serve different purposes. ELSS is a tax-saving instrument; Energy is a sector bet. If you need tax saving, Quant ELSS is the best ELSS in the radar. If you don't need tax saving, Energy gives you more direct sector exposure.",
      verdict:            "Hold",
      confidence:         "Medium",
      confidence_reason:  "Strong alpha within a weak category; only a conviction buy if 80C tax benefit is the primary motivation."
    }
  },
  {
    fund_code: "135813",
    fund_name: "Tata Resources & Energy Fund-Direct Plan-Growth",
    category:  "Energy",
    rank:      9,
    score:     5.177,
    analysis: {
      macro_theme:       "Energy is benefiting from India's power sector boom and oil & gas capex recovery. The 1Y return of +20.24% shows the theme has worked over 12 months, but the category z-score of only 0.45 — the second-weakest in the top 10 — signals this week's move is barely above average. Momentum may be plateauing.",
      bull_case: [
        "India's energy transition capex is massive — renewables, grid modernisation, green hydrogen, and LNG terminals",
        "Oil & gas upstream capex recovering globally; ONGC and Reliance are major index weights with strong earnings",
        "Strong 1Y return (+20.24%) validates the multi-quarter thesis"
      ],
      bear_case: [
        "Weakest category z-score in the top 10 (0.45) — momentum signal is not statistically convincing this week",
        "Global oil price uncertainty; any crude correction hits energy sector funds hard and fast"
      ],
      vs_next_pick:       "Energy has better 1Y than PSU (20.24% vs 22.99% — actually PSU edges it on 1Y) and better 3M (6.75% vs 4.93%). Both sectors are heavily government-linked. Energy has a clearer global tailwind; PSU depends on domestic policy. Neither is a high-conviction pick vs the top 6.",
      verdict:            "Hold",
      confidence:         "Low",
      confidence_reason:  "Good 1Y performance but very weak current z-score — momentum is fading precisely when alternatives are accelerating."
    }
  },
  {
    fund_code: "147844",
    fund_name: "Aditya Birla Sun Life PSU Equity Fund-Direct Plan-Growth",
    category:  "PSU",
    rank:      10,
    score:     4.467,
    analysis: {
      macro_theme:       "PSU stocks re-rated sharply in FY24 on disinvestment optimism and budget expectations but have been range-bound since. The 3M of only +4.93% and the lowest momentum score in the entire top 10 (4.47) indicate this is the weakest current setup among all picks.",
      bull_case: [
        "Strong 1Y return (+22.99%) shows PSUs have re-rated and the structural case is intact",
        "Dividend yields and government ownership provide downside cushion vs pure private sector funds",
        "Any acceleration in disinvestment or PSU capex announcement could re-ignite the theme"
      ],
      bear_case: [
        "Lowest momentum score in the top 10 — every other category currently offers a better short-to-medium term setup",
        "Disinvestment pipeline has slowed significantly; government prefers stake dilution over strategic sales"
      ],
      vs_next_pick:       "PSU is ranked #10 — there is no next pick to compare. It scores lowest on momentum across every short-term window. If capital is constrained, this would be the first position to reduce in favour of higher-momentum alternatives like Defence or Healthcare.",
      verdict:            "Hold",
      confidence:         "Low",
      confidence_reason:  "Lowest momentum score with no near-term catalyst visible; acceptable to hold existing positions but not a fresh entry point."
    }
  }
];

async function main() {
  console.log(`Seeding ${RATIONALES.length} rationales for ${TODAY}…`);
  for (const r of RATIONALES) {
    const { error } = await supabase.from("pick_rationales").upsert(
      { ...r, generated_at: new Date().toISOString(), run_date: TODAY },
      { onConflict: "fund_code,run_date" }
    );
    if (error) {
      console.error(`  ✗ ${r.fund_name}: ${error.message}`);
    } else {
      console.log(`  ✓ #${r.rank} ${r.fund_name}`);
    }
  }
  console.log("Done.");
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
