# ROADMAP.md — Capability Roadmap

Where Fin Intel can go from here, grounded in what already exists (see
`CLAUDE.md` for architecture, `docs/CONTEXT.md` for operational reality).
Each item names the decision it improves, what it builds on, and rough size
(S ≈ a day, M ≈ a week, L ≈ multi-week). Sequenced so every phase compounds
on the previous one.

**Design rules that shaped this list**
- Prefer surfacing data the pipeline already collects over adding sources.
- Anything that changes scoring must be gated on measured edge (the
  `ml_blend.js` OOS-AUC gate is the template).
- Nightly precompute → `radar_cache` blob → thin UI. The browser never does
  heavy work or hits external APIs (DeepDive is the lone, deliberate exception).
- Every advisory feature must be auditable: show *why*, and let the track
  record judge it.

---

## Baseline (already shipped)

Nightly 6-layer scoring for Nifty-500 stocks, MF/ETF leaderboards, ML blend
gated on OOS AUC, regime filter, persona advisor, deep-dive analytics,
health checks with email/Telegram alerting, **track record** (realized pick
outcomes vs Nifty), **holdings watchlist** (hold/trim/exit verdicts),
**score attribution** on every pick.

---

## Phase 1 — Operationalize the signal (all S–M, no new data sources)

The system knows things during the day that users only discover by opening
the app. Close that gap.

| # | Capability | Decision it improves | Builds on | Size |
|---|---|---|---|---|
| 1.1 | **Market-event alerts** — new stock enters top 10, regime flips, watchlist holding turns EXIT/TRIM, ETF premium/discount blows out, FII flow streak crosses threshold | Act on entries/exits the day they happen, not days later | Resend/Telegram plumbing in `data-health-check.js`; all triggers are diffs of blobs the nightly run already builds | M |
| 1.2 | **Earnings-date risk flag** — mark picks reporting within N days | Don't take a momentum entry into an earnings coin-flip | `yahoo_fundamentals.js` already hits Yahoo per symbol; add `calendarEvents` | S |
| 1.3 | **Watchlist sync + trade journal** — move holdings from localStorage to a `user_holdings` table (auth already exists); log verdict-at-a-glance history per holding | Same watchlist on every device; "what did the system say when I bought?" becomes answerable | `useAuth` hook, RLS patterns from migrations 014/015, `exitSignals.js` verdicts | M |
| 1.4 | **Verdict outcomes in the track record** — extend `track_record.js` to also score watchlist-style verdicts retroactively (did EXIT calls avoid losses? did TRIM calls precede mean-reversion?) | Trust (or fix) the exit rules with evidence, same as entries | `pick_history` + `exitSignals.js` thresholds | M |

**Exit criteria:** a user who checks the app twice a week gets pushed the
handful of events that actually demand action.

## Phase 2 — Close the learning loop (M–L, model changes gated on evidence)

The pipeline measures its own signal quality but doesn't act on it yet.

| # | Capability | Decision it improves | Builds on | Size |
|---|---|---|---|---|
| 2.1 | **IC-adaptive signal weights** — down-weight (or zero) signals whose rolling IC flipped sign for 30+ days; conservative, capped, logged like the ML gate | Scoring self-corrects instead of decaying silently | `signal_ic_history` + `sign_flipped` flag from `ic_monitor.py`; gate pattern from `ml_blend.js` | M |
| 2.2 | **Stock-level news sentiment** — weekly Claude/GDELT sentiment for the top 50, surfaced as a chip + optional small score input (gated) | Catch narrative breaks momentum can't see | `ml/gdelt_sentiment.py` and `sentiment.py` (MF version) already exist | M |
| 2.3 | **Threshold calibration from realized outcomes** — periodically re-fit the magic numbers (overextension tiers, entry-gate, hysteresis ±10) against `pick_history` outcomes; propose, don't auto-apply | The hand-tuned constants stop drifting from reality | `track_record.js` aggregation + `backtest_stock_signals.py` | L |
| 2.4 | **Sector-relative valuation context** — P/E and ROE shown as sector percentile, flag momentum picks in the top valuation decile | "Great chart, insane price" becomes visible before entry | fundamentals already fetched for top 200 | S |

**Exit criteria:** every scoring constant is either measured-and-current or
explicitly marked legacy.

## Phase 3 — Portfolio intelligence (M–L, one new data source)

Move from per-instrument advice to portfolio-level truth.

| # | Capability | Decision it improves | Builds on | Size |
|---|---|---|---|---|
| 3.1 | **MF holdings overlap matrix** — monthly AMFI portfolio disclosures → overlap % between any two recommended funds; warn PersonaAdvisor when its slate overlaps > X% | Stop recommending three funds that own the same 20 stocks | New AMFI fetcher (the one genuinely new source worth adding); persona slate logic | L |
| 3.2 | **SIP outcome distributions in PersonaAdvisor** — for a persona allocation, show the historical 10th–90th percentile outcome across all rolling N-year windows, not a point estimate | Honest risk picture before committing a monthly SIP | DeepDive's rolling-window + XIRR math, persona allocations | M |
| 3.3 | **Portfolio risk dashboard** — combined watchlist + persona view: sector concentration, weighted overextension, regime exposure, expected drawdown from per-stock vol | See the portfolio the way the pipeline sees a single stock | `sectorBreakdown()`, vol columns in `stock_features`, watchlist | M |
| 3.4 | **Tax-aware exit guidance** — STCG/LTCG classification on every EXIT/TRIM verdict, "LTCG in N days" already exists; add estimated tax delta of selling now vs waiting | Exit timing accounts for the tax bill | Watchlist buy dates (1.3 makes them reliable) | S |

**Exit criteria:** PersonaAdvisor and Watchlist describe portfolios, not
lists of instruments.

## Phase 4 — Platform maturity (L, only after 1–3 prove out)

| # | Capability | Decision it improves | Builds on | Size |
|---|---|---|---|---|
| 4.1 | **Paper-trading mode** — one-click "follow the top-10 rotation" virtual portfolio, marked to market daily | Try the system risk-free; the track record gets a live, auditable twin | `track_record.js` rotation logic, `pick_history` | M |
| 4.2 | **Daily digest** — one morning email/Telegram: regime, top movers in/out, watchlist verdict changes, MF/ETF highlights | The app comes to the user | 1.1 alert infra, all existing blobs | M |
| 4.3 | **Multi-user hardening** — per-user rate limits, RLS audit, custom alert preferences | Safe to share beyond the household | auth + 1.3 tables | L |
| 4.4 | **Verified email domain + WhatsApp channel** — replace the Resend sandbox sender; WhatsApp Business API for alerts (India-first UX) | Alerts reliably reach people | 1.1 | S–M |

---

## Foundation debt (do opportunistically, before it bites)

- **Bhavcopy coverage check is any-symbol, not per-symbol** — newly added
  universe symbols can under-fill and lean on the rate-limited Yahoo
  fallback (`stock_momentum.js` `bulkFillFromBhavcopies`).
- **`report_summary` in `track_pick_outcomes.py` reads max 1000 rows** —
  log-only today, but fix before anyone quotes those numbers.
- **Frontend bundle > 1 MB** — code-split routes (Vite warns on every build).
- **Stooq daily-hit-limit exposure** — primary price source since `ae806d6`;
  consider rotating primaries by day or caching more aggressively in CI.
- **Playwright smoke tests only assert the login page** — extend to one
  authenticated data-render per major page as features accumulate.

## Explicitly not on the roadmap

- **Real-money execution / broker integration** — advisory only; execution
  changes the regulatory surface entirely.
- **Intraday trading signals** (sub-daily holding periods) — the data
  cadence (EOD + a few intraday refreshes) can't support it honestly.
- **Chat-with-your-portfolio LLM interface** — revisit only after the
  rule-based verdicts have a measured track record worth explaining.

---

*Update this file when a phase item ships (move it to Baseline) or when an
incident/backtest invalidates an assumption. Keep the "decision it improves"
column honest — a capability that doesn't change a decision is decoration.*
