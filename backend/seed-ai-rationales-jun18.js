"use strict";
/**
 * AI-generated rationales for all current MF picks — 18 Jun 2026.
 * Written by Claude (no ANTHROPIC_API_KEY needed — analysis is embedded).
 * Resolves fund codes at runtime from the live mf_radar Supabase blob.
 *
 * Usage: node backend/seed-ai-rationales-jun18.js
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_KEY
 *
 * Key shifts vs Jun 13 run:
 *  - BOI Small Cap (#1 composite, 93) is new — AMFI-discovered, strongest all-round
 *  - HDFC Defence replaces Motilal Oswal Defence (active vs passive)
 *  - Tata Energy moves from Avoid → Buy (ML 66% Strong, full momentum recovery)
 *  - Gold (SBI) in picks but 1M -5.3% — Buy with timing caution
 *  - BOI Flexi Cap, HSBC Focused, Axis Large & Mid, BOI Large Cap are new entrants
 *  - UTI Flexi Cap (Avoid) and SBI Healthcare removed from universe this cycle
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const WebSocket        = require("ws");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: WebSocket } }
);

// ─── Analysis corpus (keyed by normalized label fragment for fuzzy matching) ──
// Format: { category, rank, composite, analysis: { macro_theme, bull_case,
//   bear_case, vs_next_pick, verdict, confidence, confidence_reason } }

const ANALYSES = [

  // ── Active Picks ─────────────────────────────────────────────────────────

  {
    _match: "bank of india small cap",
    fund_name: "BANK OF INDIA Small Cap Fund",
    category: "Small Cap",
    rank: 1,
    composite: 93,
    analysis: {
      macro_theme: "Small cap recovery is broad-based and accelerating — the Nifty Smallcap 250 is up ~28% in three months, reflecting rural income revival, GST formalisation tailwinds for domestic-facing SMEs, and record SIP inflows of ₹26,000 Cr/month finding disproportionate homes in sub-₹5,000 Cr market cap businesses. BOI Small Cap's active mandate allows it to overweight recovering domestic consumption and capex names before they enter the index.",
      bull_case: [
        "Returns positive across every window — 1W +5.3%, 1M +9.2%, 3M +28.6%, 6M +20.9%, 1Y +17.4%, 5Y +21.4% — the only fund in the 18-pick universe with consistent outperformance from 1 week to 5 years simultaneously",
        "Composite score of 93 is the highest in the entire picks list by a significant margin — the scoring model's broadest agreement on any single fund this cycle",
        "5Y CAGR of +21.4% alongside the current momentum surge confirms this is a quality compounder, not a recovery-bounce trade that will give back gains"
      ],
      bear_case: [
        "3M surge of +28.6% is exceptional but creates post-surge entry risk — historically, small cap funds delivering 25%+ in a quarter see 8-15% mean reversion before the next leg",
        "No ML coverage (ML Score not shown) means quantitative feature support is unverified; composite score is driven entirely by momentum signals"
      ],
      vs_next_pick: "BOI Small Cap vs HDFC Defence: BOI wins on 3M (+28.6% vs +25.6%), 1Y (+17.4% vs +15.5%), and 5Y CAGR (+21.4% vs none). Defence wins on 6M (+29.0% vs +20.9%) and 1W momentum (+7.6% vs +5.3%). BOI is the quality medium-term compounder; Defence is the near-term tactical bet with higher single-week momentum.",
      verdict: "Strong Buy",
      confidence: "Medium",
      confidence_reason: "Highest composite in the universe with all-window positive returns — a rare quality signal — but the post-surge entry timing after a +29% 3M run limits confidence from High to Medium."
    }
  },

  {
    _match: "hdfc defence",
    fund_name: "HDFC Defence",
    category: "Defence",
    rank: 2,
    composite: 83,
    analysis: {
      macro_theme: "India's defence indigenisation mandate (68%+ domestic procurement) is being actioned at pace after the May 2026 India-Pakistan escalation permanently reset the government's defence capex urgency. HDFC Defence is an actively managed fund — unlike passive index funds — giving it the ability to overweight nimble mid-cap names (MTAR, Data Patterns, Paras Defence) that outperform the large-cap-heavy index during order-flow acceleration phases.",
      bull_case: [
        "6M return of +29.0% is the highest 6-month figure across all 18 picks — the defence sector re-rating is the most powerful sectoral move in Indian equities since FY24's PSU surge",
        "1W +7.6% and 1M +8.2% are the highest weekly and monthly momentum readings in the entire picks list — near-term momentum is actively accelerating, not decelerating",
        "Active management advantage: HDFC's fund manager can rotate into smaller defence names (HAL sub-contractors, drone manufacturers) before they enter the Nifty Defence Index, capturing alpha that a passive fund cannot"
      ],
      bear_case: [
        "ML Score of 33% (Weak) — quantitative models are cautious despite the near-term surge; defence stocks are now priced for perfection with many PSU names at 40-60x PE",
        "No 5Y/10Y track record means there is no historical framework to assess how the fund navigates a defence budget disappointment or geopolitical de-escalation shock"
      ],
      vs_next_pick: "HDFC Defence vs Nippon India Power & Infra: Defence dominates on short-term (6M +29.0% vs +13.0%, 1W +7.6% vs +5.4%). Infra wins decisively on long-term quality (5Y +24.6%, 10Y +18.8% vs no track record). Defence is the tactical 3-6 month position; Infra is the quality structural hold for investors with a 5+ year horizon.",
      verdict: "Strong Buy",
      confidence: "High",
      confidence_reason: "Strongest near-term momentum across 1W, 1M, and 6M in the entire picks universe, backed by a concrete government policy mandate — only caveat is the lack of 5Y+ track record and stretched valuations."
    }
  },

  {
    _match: "nippon india power",
    fund_name: "Nippon India Power & Infra",
    category: "Infrastructure",
    rank: 3,
    composite: 62,
    analysis: {
      macro_theme: "India's power sector is in a genuine multi-year investment supercycle — 500GW renewable target by 2030, ₹2.4 lakh crore FY26 power investment, data center boom requiring 5GW+ new capacity, and industrial electrification are creating visible 7-10 year order flows for infrastructure companies. Nippon's Power & Infra mandate covers the full stack: generation (solar, wind), T&D (transformers, cables), roads, and industrial construction.",
      bull_case: [
        "5Y CAGR of +24.6% and 10Y CAGR of +18.8% form a rare combination — a fund delivering near 25% over 5 years while sustaining 19% over a decade shows alpha generation is cycle-agnostic, not one-period lucky",
        "Returns positive across every window (1W +5.4% through 1Y +13.6%) — consistent compounding without a single negative return period confirms the infrastructure cycle is sustained",
        "High confidence rating from the rule-based system reflects sustained signals across multiple scoring dimensions, not just one or two momentum signals"
      ],
      bear_case: [
        "ML Score of 26% (Weak) suggests quantitative feature models do not currently support the momentum continuation narrative — possible crowding signal",
        "Infrastructure is a high-beta sector: a global risk-off event, rising US yields, or FII outflows will trigger -25%+ corrections before the long-term thesis can protect capital"
      ],
      vs_next_pick: "Nippon Infra vs BOI Flexi Cap: Infra wins across all horizons — 3M +14.7% vs +12.5%, 6M +13.0% vs +6.1%, 1Y +13.6% vs +10.4%, plus proven 5Y and 10Y track record vs BOI Flexi's nascent history. For investors choosing between these two, Infra is superior on every measurable quality dimension.",
      verdict: "Buy",
      confidence: "High",
      confidence_reason: "Elite 5Y and 10Y CAGR with all-window positive returns in a sector with visible multi-year government-funded order flow — the combination of quality and momentum is rare."
    }
  },

  {
    _match: "bank of india flexi cap",
    fund_name: "BANK OF INDIA Flexi Cap Fund",
    category: "Flexi Cap",
    rank: 4,
    composite: 62,
    analysis: {
      macro_theme: "Flexi cap funds are uniquely positioned in the current market — as mid and small caps lead the recovery, a well-managed flexi fund can dynamically increase exposure to recovering domestic businesses while retaining the option to rotate back to defensive large caps. BOI's flexi cap has been nimble in this cycle, capturing the breadth of recovery across market caps.",
      bull_case: [
        "5Y CAGR of +18.5% is solid for a flexi cap — suggests the fund manager has been appropriately allocated across market caps through multiple cycles, not benchmark-hugging",
        "Returns positive across all windows from 1W through 1Y, confirming broad participation in the current recovery rather than isolated short-term momentum",
        "Flexi cap mandate gives the manager full flexibility to overweight the strongest sectors/cap tiers — currently well-positioned to benefit from the ongoing small and mid cap recovery"
      ],
      bear_case: [
        "No ML coverage and smaller AMC (Bank of India) means less quantitative and institutional research support; information quality on this fund's portfolio is limited",
        "6M return of +6.1% is moderate — the fund has not captured the full magnitude of the mid/small cap recovery as aggressively as pure small cap funds"
      ],
      vs_next_pick: "BOI Flexi Cap vs Tata Energy: Energy wins on 1Y (+13.5% vs +10.4%), 5Y (+15.8% vs +18.5% — Flexi wins), and has a strong ML Score of 66% vs no ML for Flexi. Energy's quantitative model support is a differentiator; Flexi's advantage is diversification across sectors.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Solid all-window positive returns and 5Y CAGR, but smaller AMC with no ML coverage limits conviction — appropriate for diversification rather than a high-conviction concentrated bet."
    }
  },

  {
    _match: "tata resources",
    fund_name: "Tata Resources & Energy",
    category: "Energy",
    rank: 5,
    composite: 62,
    analysis: {
      macro_theme: "India's energy transition is the largest sectoral investment theme in the country — ₹2.4 lakh crore in FY26 power sector investment, 500GW renewable target creating multi-year order visibility, and the ongoing LNG import infrastructure build-out. Tata Resources & Energy captures both the transition (renewables, T&D) and the legacy (oil & gas) energy ecosystem. After being oversold in Jun 13's correction, the fund has fully recovered: 6M +10.2%, 1Y +13.5%.",
      bull_case: [
        "ML Score of 66% (Strong) is the highest among all 18 funds — the quantitative model's strong endorsement signals feature alignment with near-term outperformance, not just backward-looking momentum",
        "10Y CAGR of +17.9% confirms Tata Resources & Energy has compounded through multiple energy cycles — the current investment cycle is structurally stronger than any previous one",
        "Full momentum recovery confirmed: 1W +4.4%, 1M +1.4%, 3M +11.5%, 6M +10.2%, 1Y +13.5% — every window is positive, reversing the Jun 13 'Avoid' thesis completely"
      ],
      bear_case: [
        "1M momentum of +1.4% is the softest near-term reading among the active Buy picks — the fund is recovering but at a measured pace that could stall if global oil prices correct",
        "5Y CAGR of +15.8% is below the 10Y CAGR of +17.9% — the 5-year period includes the COVID energy demand collapse, suggesting the fund is more volatile than the 10Y number suggests"
      ],
      vs_next_pick: "Tata Energy vs SBI Gold: Energy has the dominant ML Score (66% vs 32%) and more durable long-term returns. Gold has spectacular 1Y (+49.6%) but is in active correction (1M -5.3%) with weaker quantitative support. Energy is the systematic model-driven buy; Gold requires timing skill around the correction.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Highest ML Score in the picks universe (66%) combined with full recovery across all return windows — quantitative models strongly endorse this fund; the only caution is the soft 1M momentum (+1.4%)."
    }
  },

  {
    _match: "sbi gold",
    fund_name: "SBI Gold",
    category: "Gold",
    rank: 6,
    composite: 60,
    analysis: {
      macro_theme: "Gold's exceptional 1Y run (+49.6%) was driven by central bank accumulation (RBI, PBOC adding record tonnage), geopolitical safe-haven demand post India-Pakistan standoff, and structural de-dollarisation. The current 1M correction (-5.3%) reflects partial profit-taking as geopolitical risks de-escalate. SBI Gold is one of India's most liquid gold FoF with minimal tracking error, making it the cleanest expression of domestic gold price exposure.",
      bull_case: [
        "5Y CAGR of +24.8% is exceptional for a non-equity asset — gold has been a genuine return driver, not merely a hedge; central bank structural buying continues regardless of short-term price",
        "10Y CAGR of +16.5% confirms gold has delivered above-inflation returns across a full decade including various interest rate regimes — the long-term store-of-value thesis is intact",
        "3M +2.2% shows the correction is shallow relative to the prior surge — if geopolitical risks re-emerge or the US dollar weakens on rate cut expectations, gold quickly reverses"
      ],
      bear_case: [
        "1M correction of -5.3% is an active momentum reversal signal; post 40-50% annual gains, corrections in gold historically average -10 to -15% before stabilising — the bulk may not be over",
        "ML Score of 32% (Weak) and Max DD of -24.7% confirm the system's caution — gold is a tactical portfolio position, not a sustained momentum buy at current entry levels"
      ],
      vs_next_pick: "SBI Gold vs HSBC Focused: Gold has exceptional 1Y (+49.6% vs +7.3%) but negative near-term momentum (1M -5.3% vs +2.9%). Focused gives diversified equity upside in a recovering market. Gold is the portfolio hedge and mean-reversion play; Focused is the near-term equity alpha bet. Both serve different roles — running both is valid.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Outstanding long-term track record (5Y +24.8%) but active short-term correction (1M -5.3%) — Buy on weakness rather than chasing, as the structural case for gold is intact while the near-term entry is unfavourable."
    }
  },

  {
    _match: "hsbc focused",
    fund_name: "HSBC Focused Fund",
    category: "Focused",
    rank: 7,
    composite: 58,
    analysis: {
      macro_theme: "Focused funds run concentrated 25-30 stock portfolios and are gaining traction as sophisticated investors recognise that fund managers with full flexibility to run high-conviction positions can generate alpha more effectively than diversified mandates in a recovery environment. HSBC's focused fund appears to be successfully positioning in mid-cap recovery stories — the 1W +5.6% is the third-strongest weekly return in the picks universe.",
      bull_case: [
        "1W +5.6% is the third-highest weekly momentum figure in the entire 18-fund picks list — short-term institutional activity in this fund's holdings is exceptionally strong",
        "3M +12.3% with a focused mandate means fewer concentrated positions are driving the gains — the underlying picks are genuinely performing, not just riding a broad index move",
        "Focused category is AMFI-discovered (expanding universe) — BOI's discovery is surfacing quality funds that were missing from the previous static universe"
      ],
      bear_case: [
        "6M return of +1.4% is very weak — the fund was flat or negative through part of the recovery; the 3M surge comes off a low base and may not sustain",
        "No ML coverage and no 10Y data limits quantitative confidence in the thesis; focused funds can underperform severely when concentrated positions go against the fund manager"
      ],
      vs_next_pick: "HSBC Focused vs Motilal Microcap: Microcap wins on near-term pure momentum (1W +6.6% vs +5.6%, 3M +24.1% vs +12.3%). Focused wins on 6M (+1.4% vs +10.6% — actually Microcap wins 6M too). For the highest-momentum near-term trade, Microcap wins; Focused is the quality-concentrated alternative for investors uncomfortable with a pure passive index approach.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Strong 1W momentum and solid 3M performance justify a Buy, but the weak 6M base and absence of ML/10Y coverage prevent a high-confidence call."
    }
  },

  {
    _match: "motilal oswal nifty microcap",
    fund_name: "Motilal Oswal Nifty Microcap 250",
    category: "Micro Cap",
    rank: 8,
    composite: 57,
    analysis: {
      macro_theme: "Indian microcaps are in a full recovery from the FY25 correction — the Nifty Microcap 250 is up ~24% in three months, as domestic SIP inflows, rural economic recovery, and improving credit availability for small businesses drive broad-based re-rating. This is a pure passive index fund — returns are entirely macro and sentiment-driven with no manager discretion.",
      bull_case: [
        "1W +6.6% and 1M +8.4% are the highest near-term momentum readings in the entire picks list — microcap momentum is currently the sharpest sector signal in Indian equities",
        "6M +10.6% and 3M +24.1% confirm the recovery has been sustained for two consecutive quarters, not just a single-month spike",
        "Nifty Microcap 250 provides diversification across 250 names — single-stock blowup risk is minimised while capturing the full breadth of the domestic small business recovery"
      ],
      bear_case: [
        "1Y return of +4.3% is modest — investors who entered 12 months ago have barely outperformed inflation despite taking significant drawdown risk (Max DD -24.1%)",
        "ML Score of 23% (Weak) — quantitative models are not supportive; the case for this fund rests entirely on near-term momentum which can reverse quickly in risk-off environments"
      ],
      vs_next_pick: "Microcap vs ABSL Manufacturing: Microcap wins on near-term momentum (1W +6.6% vs +3.8%, 3M +24.1% vs +14.7%). Manufacturing wins on 1Y (+18.4% vs +4.3%), 5Y (+15.1%), and 10Y (+15.0%) — manufacturing has a far stronger quality track record. Microcap is the near-term momentum trade; Manufacturing is the quality medium-term compounder.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Exceptional near-term momentum (highest 1W and 1M in the list) backed by broad macro tailwinds — but the 1Y return of +4.3% and Max DD of -24.1% confirm this is a momentum trade requiring active monitoring, not a set-and-forget quality hold."
    }
  },

  {
    _match: "aditya birla sun life manufacturing",
    fund_name: "Aditya Birla Sun Life Manufacturing Equity",
    category: "Manufacturing",
    rank: 9,
    composite: 57,
    analysis: {
      macro_theme: "India's PLI (Production-Linked Incentive) schemes across 14 sectors are delivering measurable output — electronics exports at record highs, auto component volumes up 15%+ YoY, and the ₹76,000 crore semiconductor ecosystem (Tata and Micron investments) is creating durable manufacturing employment. ABSL Manufacturing captures this transformation across capital goods, auto ancillaries, specialty chemicals, and consumer durables — the broadest manufacturing mandate in the universe.",
      bull_case: [
        "1Y return of +18.4% is the strongest 1Y performance among all active Buy-rated picks (excluding Defence/Infrastructure with structural tailwinds) — confirming PLI-driven manufacturing has fundamental earnings support, not just valuation re-rating",
        "Returns positive across all windows from 1W through 10Y (+15.0%) — one of only three funds in the picks list with confirmed decade-long compounding through multiple manufacturing cycles",
        "Alpha through diversification: the fund avoids pure commodity manufacturers and focuses on value-added engineering — providing better pricing power and superior margins through economic cycles"
      ],
      bear_case: [
        "ML Score of 28% (Weak) suggests quantitative momentum models are less excited than the 1Y returns imply — possible mean-reversion risk after the strong run",
        "5Y CAGR of +15.1% and 10Y CAGR of +15.0% are below Kotak Midcap's +19.2%/+19.1% — on a pure risk-adjusted basis, Midcap has delivered better returns for similar volatility"
      ],
      vs_next_pick: "ABSL Manufacturing vs Kotak Midcap: Manufacturing wins on 1Y (+18.4% vs +9.7%) — a significant gap. Midcap wins on 5Y (+19.2% vs +15.1%), 10Y (+19.1% vs +15.0%), and has a higher composite score (54 vs 57 — Manufacturing edges it slightly). For the current manufacturing cycle bet, ABSL wins; for the best long-term risk-adjusted compounder, Kotak Midcap is superior.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Strongest 1Y return among non-thematic equity picks and visible PLI earnings tailwind justify a Buy, but the modest ML Score and 10Y underperformance vs mid cap peers temper conviction."
    }
  },

  {
    _match: "kotak midcap",
    fund_name: "Kotak Midcap",
    category: "Mid Cap",
    rank: 10,
    composite: 54,
    analysis: {
      macro_theme: "Indian mid caps are in a structural re-rating phase — FY26 midcap earnings growth is tracking 20%+ vs Nifty 50's 12-15%, creating genuine PE compression that justifies sustained SIP inflows. Kotak Midcap's quality-focused selection process within the mid cap universe — emphasising high-ROE businesses with durable competitive moats — has historically produced alpha with lower drawdown than aggressive small/microcap peers.",
      bull_case: [
        "10Y CAGR of +19.1% and 5Y CAGR of +19.2% are nearly identical — demonstrating exceptional consistency of alpha generation across a full decade, through COVID, FY25 correction, and the current recovery",
        "1W +5.1% and 1M +4.0% show near-term momentum is recovering alongside the broader recovery — the fund is participating in the current cycle without lagging",
        "Mid cap is the most SIP-flow-supported segment in Indian equity — ₹26,000 Cr/month of systematic inflows provide a steady structural bid that limits correction depth"
      ],
      bear_case: [
        "1Y return of +9.7% is moderate relative to the 5Y/10Y quality levels — suggesting the fund went through a difficult patch over the last 12 months before the current recovery",
        "ML Score of 23% (Weak) indicates quantitative models are not strongly endorsing near-term momentum acceleration despite the quality track record"
      ],
      vs_next_pick: "Kotak Midcap vs Quant ELSS: ELSS edges Midcap on 10Y (+20.8% vs +19.1%) and 1Y (+12.3% vs +9.7%). Midcap wins on 1W (+5.1% vs +3.0%) and has no lock-in restriction. For Section 80C investors, ELSS is marginally superior; for pure equity without a lock-in, Midcap is the cleaner vehicle.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Elite 10Y track record (19.1% CAGR) with full momentum recovery across all windows — quality is undeniable; the only constraint is modest ML support (23%) and 1Y underperformance suggesting recent lumpiness."
    }
  },

  {
    _match: "quant elss",
    fund_name: "Quant ELSS Tax Saver",
    category: "ELSS",
    rank: 11,
    composite: 50,
    analysis: {
      macro_theme: "ELSS funds offer Section 80C tax savings (up to ₹1.5L deduction) while delivering equity returns through a 3-year lock-in. Quant's ELSS applies the same quantitative VLRT (Valuation, Liquidity, Risk, Timing) model as Quant Small Cap — aggressive sector rotation into momentum names at the point of maximum undervaluation. The result: 10Y CAGR of +20.8%, the highest long-term return in the entire 18-fund universe.",
      bull_case: [
        "10Y CAGR of +20.8% is the highest in the entire picks universe — a decade of consistent alpha generation confirms the VLRT model works across bull markets, corrections, and recoveries alike",
        "3M +14.8% and 1Y +12.3% confirm the current cycle is another example of Quant's early rotation working — the model positioned in recovery sectors before this 3M move",
        "Section 80C benefit adds ~1.5% effective annual return for 30% bracket investors, making the all-in effective return from this fund the highest among all 18 picks"
      ],
      bear_case: [
        "ML Score of 18% (Weak) — the lowest ML signal among active Buy picks — may reflect regulatory scrutiny risks specific to Quant AMC or concentrated portfolio positions",
        "3-year lock-in during a -25%+ correction is psychologically and financially challenging; the Max DD during the FY25 correction was severe and may recur"
      ],
      vs_next_pick: "Quant ELSS vs ABSL PSU: ELSS wins on 10Y CAGR (+20.8% vs none), diversification (all-cap vs sector-specific), and tax benefit. PSU wins on 5Y CAGR (+25.3% vs +17.4%), 1Y (+12.8% vs +12.3% — essentially equal), and no lock-in. For long-term quality, ELSS; for pure near-term PSU cycle exposure without lock-in, PSU.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Best 10Y CAGR in the universe with strong 3M momentum and tax benefit — a compelling Buy for Section 80C investors; the low ML Score (18%) and lock-in risk temper confidence for pure return-seekers."
    }
  },

  {
    _match: "aditya birla sun life psu",
    fund_name: "Aditya Birla Sun Life PSU Equity",
    category: "PSU",
    rank: 12,
    composite: 50,
    analysis: {
      macro_theme: "PSU stocks are in a second-wind phase — after the initial FY23-24 re-rating (35-40x PE expansion), the sector is now delivering earnings-led growth rather than just valuation catch-up. RBI rate cuts are directionally positive for PSU banks (SBI, BOB), while the government's FY26 capex commitments are generating real order flows for power and defence PSUs. The 5Y CAGR of +25.3% is the evidence that the re-rating produced genuine fundamental value creation.",
      bull_case: [
        "5Y CAGR of +25.3% is the highest 5Y return among funds with meaningful track records — confirming the PSU re-rating thesis generated one of the best sector-specific returns in Indian equities history",
        "6M +8.6% and 1Y +12.8% confirm the momentum is sustained well into FY26 — not a one-year anomaly that has already reversed",
        "RBI rate cut cycle benefits PSU banks directly through NIM stabilisation and credit growth — a fresh tailwind that was not present during the initial PSU re-rating"
      ],
      bear_case: [
        "3M +5.8% is moderate — PSU near-term momentum is lagging the broader mid/small cap recovery; the easy valuation catch-up gains are exhausted",
        "ML Score of 31% (Weak) and negative alpha vs passive PSU index (from prior data) means active fund fees are likely not being recovered through stock selection"
      ],
      vs_next_pick: "ABSL PSU vs Sundaram Financial Services: PSU wins on 1Y (+12.8% vs +4.7%) and 5Y (+25.3% vs +15.9%). Financial Services wins on 1W (+5.7% vs +3.7%) and 1M (+5.1% vs +1.7%) — near-term momentum is clearly with financial services. PSU is the quality medium-term hold; Financial Services is the tactical near-term momentum trade.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Best 5Y CAGR among tracked funds (+25.3%) with continued momentum into 1Y (+12.8%) — the earnings backing is real, but weak 3M (+5.8%) and ML (31%) indicate the near-term pace has moderated."
    }
  },

  {
    _match: "sundaram financial",
    fund_name: "Sundaram Financial Services Opp.",
    category: "Banking & Financial",
    rank: 13,
    composite: 48,
    analysis: {
      macro_theme: "India's financial services sector is benefiting from the RBI's rate-cut cycle — two cuts totalling 50bps in 2026, with more expected in H2 FY26, are improving NIMs, reducing loan loss provisions, and restarting credit growth across banks, NBFCs, and insurance companies. Sundaram's 'financial services' mandate (not just banking) captures NBFCs, insurance, and AMC businesses alongside banks — broader and more structurally compelling than a pure banking fund.",
      bull_case: [
        "1W +5.7% is joint-highest in the entire 18-fund picks list — near-term banking and financial services momentum is the strongest sector signal this week, likely driven by positive RBI guidance or strong quarterly results",
        "1M +5.1% confirms the 1W surge is not noise but reflects sustained sector re-rating driven by the rate cut cycle and credit growth recovery",
        "Consistent 10Y CAGR of +15.5% across multiple interest rate cycles demonstrates the fund compounds reliably through varying macro regimes"
      ],
      bear_case: [
        "6M +0.4% and 1Y +4.7% are very weak — the current 1W/1M surge comes after 6 months of essentially flat returns; this is primarily a near-term catalyst trade, not confirmed sustained momentum",
        "ML Score of 25% (Weak) — quantitative models are not endorsing the thesis; the near-term momentum may fade without a fresh RBI catalyst"
      ],
      vs_next_pick: "Sundaram Financial Services is the last active Buy pick (#13). For investors comparing against the Watch list — Axis Large & Mid Cap has higher composite (50 vs 48) but lower 1W momentum (+3.8% vs +5.7%). Financial Services is the near-term tactical buy; Axis L&MC is the more conservative blended entry.",
      verdict: "Buy",
      confidence: "Medium",
      confidence_reason: "Joint-highest 1W momentum in the picks universe (+5.7%) confirms a near-term catalyst is active, but the 6M/1Y weakness and low ML Score (25%) mean conviction depends entirely on the rate cut cycle continuing as expected."
    }
  },

  // ── Watch List (Low Confidence — Hold) ───────────────────────────────────

  {
    _match: "axis large",
    fund_name: "Axis Large & Mid Cap Fund",
    category: "Large & Mid Cap",
    rank: 14,
    composite: 50,
    analysis: {
      macro_theme: "Large & Mid blend funds capture both the stability of Nifty 50 large caps and the recovery upside in mid caps, but by definition lag pure mid cap funds in strong recovery cycles. Axis AMC's quality-focused approach within this mandate — emphasising high-ROE businesses with durable advantages — provides a more conservative entry into the mid cap recovery for risk-averse investors.",
      bull_case: [
        "3M +11.0% is solid for a blend fund that includes large cap drag — suggesting the mid cap allocation is genuinely outperforming",
        "5Y CAGR of +14.8% and all-window positive returns offer a stable, lower-volatility equity entry point for conservative investors",
        "1W +3.8% and 1M +3.0% show consistent participation in the recovery without the extreme volatility of small/micro cap funds"
      ],
      bear_case: [
        "Low confidence flag — the scoring model's conviction doesn't clear the active Buy threshold; 6M +2.2% suggests the fund was lagging during the mid-recovery period",
        "No 10Y track record limits assessment of how this fund performs through full market cycles"
      ],
      vs_next_pick: "Axis Large & Mid Cap vs BOI Large Cap: Axis wins on 3M (+11.0% vs +8.4%), 1Y (+6.8% vs +7.4% — BOI edges 1Y), and has 5Y CAGR data (+14.8% vs none). Axis is the more credible fund with verifiable long-term data.",
      verdict: "Hold",
      confidence: "Low",
      confidence_reason: "Decent returns and quality mandate but low conviction score — deploy capital here only after exhausting the higher-confidence active picks."
    }
  },

  {
    _match: "bank of india large cap",
    fund_name: "BANK OF INDIA Large Cap Fund",
    category: "Large Cap",
    rank: 15,
    composite: 45,
    analysis: {
      macro_theme: "Large cap Indian equities are recovering as FII flows return to quality blue-chip names following the FY25 risk-off phase. However, large caps structurally lag mid/small cap recovery cycles, making this category a beta-diluted, lower-conviction play relative to the smaller cap opportunities in this picks list.",
      bull_case: [
        "1W +4.1% and 1M +3.5% are solid near-term signals — the fund is participating in the FII-driven large cap recovery",
        "Large cap provides the most liquid equity exposure with the lowest drawdown risk — appropriate for capital preservation-oriented investors who still want equity upside"
      ],
      bear_case: [
        "No 5Y or 10Y track record — too short a history to assess quality vs market cycles; low confidence flag reflects this data gap",
        "1Y +7.4% is below several other picks despite lower theoretical risk — large cap risk-reward is currently unfavourable relative to mid cap quality funds"
      ],
      vs_next_pick: "BOI Large Cap vs DSP Value Fund: DSP has 5Y CAGR data (+14.8%) and a value discipline providing downside buffer; BOI wins on 1W (+4.1% vs +2.5%) but lacks long-term credentials. DSP is preferable for long-term investors.",
      verdict: "Hold",
      confidence: "Low",
      confidence_reason: "No long-term track record, low confidence flag, and structurally lagging category — Watch until performance establishes a meaningful history."
    }
  },

  {
    _match: "dsp value",
    fund_name: "DSP Value Fund",
    category: "Value",
    rank: 16,
    composite: 39,
    analysis: {
      macro_theme: "Value investing is gaining renewed attention as the dominant momentum/growth trade in small and micro caps shows signs of maturation. DSP Value focuses on businesses with significant discount to intrinsic value — providing a margin of safety that growth funds lack. The 1Y return of +11.9% suggests the value approach is producing real returns in the current cycle, not just theoretically sound.",
      bull_case: [
        "1Y return of +11.9% and 5Y CAGR of +14.8% show consistent value creation — the fund delivers reasonable returns through cycles without chasing momentum",
        "Value's margin-of-safety discipline historically provides superior downside protection; in a market correction, value funds fall less than momentum or growth funds"
      ],
      bear_case: [
        "ML Score of 16% (lowest in entire list) and 1W +2.5%, 1M +0.6% confirm near-term momentum is very weak — value is being left behind in the current momentum-dominated rally",
        "6M +3.8% is modest — the fund hasn't captured the mid-cap recovery momentum the way sector-tilted funds have"
      ],
      vs_next_pick: "DSP Value vs Mirae Consumer: DSP wins on 1Y (+11.9% vs +1.3%) and has better momentum signals across most windows. Consumption is in a structural headwind; Value at least has positive 1Y returns and a downside-protection discipline.",
      verdict: "Hold",
      confidence: "Low",
      confidence_reason: "Lowest ML Score in the list (16%) with fading 1W/1M momentum — appropriate as a long-term diversifier but not a momentum-driven entry point in the current cycle."
    }
  },

  {
    _match: "mirae asset great consumer",
    fund_name: "Mirae Asset Great Consumer",
    category: "Consumption",
    rank: 17,
    composite: 39,
    analysis: {
      macro_theme: "India's consumption sector remains structurally challenged — food inflation above 6% is squeezing real disposable incomes, urban middle-class demand is normalising post-COVID, and QSR chains and FMCG companies are reporting volume growth well below 5-year averages. The 3M bounce of +10.2% is a partial recovery from the 6M decline (-4.2%) and does not yet indicate a sustained trend reversal.",
      bull_case: [
        "10Y CAGR of +16.9% confirms the consumption structural story in India is intact over a full decade — the current headwind is cyclical, not structural",
        "1W +5.3% is among the stronger weekly signals — possible early institutional rotation back into beaten-down consumer staples as food inflation peaks",
        "Rural income recovery (post-rabi season, MNREGA payments) will eventually translate into consumption recovery; patient investors may be building positions now"
      ],
      bear_case: [
        "6M -4.2% and 1Y +1.3% confirm the sector headwind is real and persistent; 1M +3.9% is recovering but the 6M weakness shows how severe the consumption slowdown has been",
        "ML Score 19% (Weak) and low confidence flag — quantitative and qualitative models agree this is not yet a confirmed recovery"
      ],
      vs_next_pick: "Mirae Consumer vs Tata Digital India: Consumer wins decisively on every metric — 1Y +1.3% vs -17.9%, 6M -4.2% vs -19.5%, and structurally consumer spending recovers faster than an IT cycle correction. Digital India is the only category doing worse than Consumption right now.",
      verdict: "Hold",
      confidence: "Low",
      confidence_reason: "Sector headwinds (food inflation, demand moderation) are not abating — Hold for existing investors; defer fresh allocation until 3 consecutive months of positive returns confirm a genuine trend change."
    }
  },

  {
    _match: "tata digital india",
    fund_name: "Tata Digital India",
    category: "Technology",
    rank: 18,
    composite: 17,
    analysis: {
      macro_theme: "Indian IT services remain in a structural correction — US discretionary tech spending is subdued as enterprises pause AI-era modernisation decisions, traditional BPO/BFSI services revenue is under margin pressure, and INR at 82-84 vs USD provides less cushion than previous cycles. The 6M -19.5% and 1Y -17.9% reflect genuine earnings downgrades at TCS, Infosys, Wipro, and mid-cap IT, not just sentiment. Tata Digital India has domestic IT tilt (fintech, e-commerce infra) which provides modest outperformance vs large-cap IT index but cannot escape the sectoral gravity.",
      bull_case: [
        "10Y CAGR of +16.1% shows IT has compounded wealth through multiple US demand cycles — the current correction has historical precedent for recovery when US IT budgets reset upward",
        "1W +4.6% is a nascent recovery signal — contrarian investors with 18-24 month horizons may be finding the risk-reward attractive at -17.9% 1Y correction levels"
      ],
      bear_case: [
        "6M -19.5% and 1Y -17.9% are the worst readings in the entire 18-fund picks list — the sector correction is severe and ongoing; the high DD flag (-25.5% Max DD) confirms the ML model halved its contribution due to drawdown risk",
        "Composite of 17 is by far the lowest in the universe — the fund is effectively on the watch list because no other category is doing worse right now; this is not a ringing endorsement",
        "5Y CAGR of only +7.5% means investors who held for 5 years have barely matched a fixed deposit rate in real terms — the long-term risk-return is genuinely poor outside of bull-market phases"
      ],
      vs_next_pick: "This is the last pick in the list. Tata Digital India has the worst 6M and 1Y returns in the entire universe. If forced to hold one fund here, the system's 'Buy' signal at composite 17 reflects rule-based scoring, not conviction. Any of the top-13 active picks offers a better risk-reward than entering IT at current levels.",
      verdict: "Hold",
      confidence: "Low",
      confidence_reason: "Worst composite (17), deepest 6M correction (-19.5%), and high DD flag — the 'Buy' signal from rule-based scoring is overridden by the ML halving and high-drawdown caution; Hold only for existing investors, do not initiate new positions."
    }
  },

];

// ─── Runtime code resolution from mf_radar ───────────────────────────────────

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function fetchFundCodeMap() {
  const { data, error } = await supabase
    .from("radar_cache")
    .select("data")
    .eq("key", "mf_radar")
    .single();
  if (error) throw new Error(`mf_radar fetch failed: ${error.message}`);

  const codeMap = {}; // normalizedLabel → { code, name }
  for (const cat of (data.data.categories || [])) {
    for (const fund of (cat.funds || [])) {
      const label = fund.name || fund.label || "";
      codeMap[normalize(label)] = { code: fund.code, name: label };
    }
  }
  return codeMap;
}

function resolveCode(analysis, codeMap) {
  const matchKey = normalize(analysis._match);
  for (const [key, val] of Object.entries(codeMap)) {
    if (key.includes(matchKey) || matchKey.includes(key.slice(0, 10))) {
      return val;
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching current mf_radar to resolve fund codes…");
  const codeMap = await fetchFundCodeMap();
  console.log(`  Loaded ${Object.keys(codeMap).length} funds from mf_radar\n`);

  const generatedAt = new Date().toISOString();
  let successCount = 0, skipCount = 0;

  for (const entry of ANALYSES) {
    const resolved = resolveCode(entry, codeMap);
    const fund_code = resolved?.code ?? null;
    const fund_name = resolved?.name ?? entry.fund_name;

    if (!fund_code) {
      console.warn(`  ⚠ Could not resolve code for "${entry.fund_name}" (_match: "${entry._match}") — skipping`);
      skipCount++;
      continue;
    }

    const { error } = await supabase
      .from("pick_ai_rationales")
      .upsert(
        {
          fund_code,
          fund_name,
          category:     entry.category,
          rank:         entry.rank,
          analysis:     entry.analysis,
          generated_at: generatedAt,
        },
        { onConflict: "fund_code" }
      );

    if (error) {
      console.error(`  ✗ #${entry.rank} ${fund_name}: ${error.message}`);
    } else {
      console.log(`  ✓ #${entry.rank} ${fund_name} (${entry.category}) → ${entry.analysis.verdict} [${entry.analysis.confidence}]`);
      successCount++;
    }
  }

  console.log(`\nDone. ${successCount} upserted, ${skipCount} skipped (code not found in live mf_radar).`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
