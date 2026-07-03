# CONTEXT.md — Operational Context & Gotchas

Fast-start context for future sessions (human or AI). `CLAUDE.md` covers
architecture and commands; this file covers the things that repeatedly cost
debugging time: exact data shapes, source quirks, incident history, and the
debugging playbook. **Update this file whenever an incident teaches something new.**

---

## radar_cache blob shapes (exact)

Everything the frontend renders comes from the `radar_cache` table:
`{ key text PK, data jsonb, built_at timestamptz }`. Writers upsert whole
blobs; readers must match these shapes **exactly** — a shape mismatch here has
already caused one phantom incident (see Incident log).

| key | writer | shape (top level) |
|---|---|---|
| `stock_picks` | `refresh-cache.js` | `{ asOf, intradayAsOf?, universe, scanned, picks: [50], all: [200], discovery, niftyReturns, regime, warnings }` |
| `stock_radar` | `refresh-cache.js` | legacy stock momentum leaderboard |
| `mf_radar` | `momentum.js` via `refresh-cache.js` | `{ asOf, benchmarks, categories: [{ category, funds: [...] }], warnings }` |
| `etf_picks` | `etf_momentum.js` via `refresh-cache.js` | `{ asOf, types: [{ type, etfCount, median, etfs: [...] }], warnings }` — **ETFs are nested two levels down; there is no top-level `picks`/`etfs` array** |
| `system_health` | `data-health-check.js` | `{ checkedAt, mode, allPassed, results: [{check,status,detail,ts}], failCount, warnCount }` |
| `instrument_details.STOCK.<sym>` / `.MF.<code>` / `.ETF.<ticker>` | `instrument_details.js` | per-instrument detail payload for the drawer UI |

(FII/DII flows live in the standalone `macro_flows` **table** — written by
`ml/macro_features.py`, read by `FiiTracker.jsx` — not in `radar_cache`.)

Per-stock pick fields worth knowing: `symbol` (with `.NS`), `compositeScore`,
`eodBaseScore` (post-regime snapshot used by intraday), `eodCompositeScore`
(post-EMA anchor for intraday smoothing), `eodRet1w` / `eodRsVsNifty1M`
(anchors so repeated intraday runs don't compound today's move), `close`,
`intradayAsOf`, penalty fields (see sign conventions in CLAUDE.md),
`daysInTop50` (Core badge at ≥7).

Per-ETF fields: `ticker`, `label`, `type`, `latestPrice` (null ⇒ price fetch
failed), `latestNav`, `premiumPct`, `avgDailyVolume`, `liquidityFlag`
(`ok|small|thin|tiny|unknown`), `ret1w…ret1y`, `z1w`, `warnings[]`.
**ETF entries are written even when every price source fails** — count of
entries alone never detects an outage; check `latestPrice` coverage.

## Data source quirks (observed, not hypothetical)

- **NSE main site (`nseindia.com/api/*`)** — aggressively bot-blocked; HTTP
  403 or an HTML page instead of JSON is *normal* from CI runners. All callers
  must warm up cookies first and still expect failure. A 403 in the health
  check is a warning, not an incident.
- **NSE archives (`nsearchives.nseindia.com`)** — much more reliable than the
  API; 404 on non-trading days is expected.
- **Stooq** — free tier has a *daily hit limit*; when exceeded it returns an
  HTML notice (~800 bytes) instead of CSV. Health check warnings now include a
  body snippet. Stooq is the **primary** ETF/stock price source since
  `ae806d6`, with per-ticker Yahoo fallback — a Stooq outage degrades
  gracefully but doubles fetch time.
- **Yahoo Finance (`yahoo-finance2`)** — occasionally throws
  `QuoteSummaryResult` validation errors on schema drift (zeroed ETF prices on
  2026-07-03). The `chart()` endpoint is more stable than `quoteSummary()`.
- **mfapi.in** — returns `{}` or empty `data` for unknown scheme codes; NAVs
  are dd-mm-yyyy strings (must be re-ordered before `new Date()`); ~20 req/s
  is the polite ceiling (50 ms sleep between calls).
- **AMFI portal** — fallback for NAVs when mfapi is down (stale-on-error disk
  cache in backend).

## Notification / alerting path

- `refresh.yml` runs `node backend/data-health-check.js --mode <eod|intraday>
  --fix --notify` after every refresh. `--fix` re-runs the refresh once on
  failure; `--notify` sends email (Resend) / Telegram.
- Resend sends from `onboarding@resend.dev` (sandbox — only delivers to the
  account owner's address). A custom domain needs DNS verification first;
  unverified domains get HTTP 403 and the alert silently drops
  (this hid a broken health check for ~3 weeks — see Incident log).
- `health_check.yml` (separate workflow) runs ML quality + Playwright smoke +
  backend unit tests, daily 02:00 UTC and after each refresh completes.

## Incident log

- **2026-07-03 — phantom "0 ETFs" health alert.** `checkEtfPicks` counted
  `data.picks ?? data.etfs`, but the blob shape is `types[].etfs` — the count
  read 0 on every run since the check was written (2026-06-09). It only
  surfaced when the Resend sender fix made alerts deliverable. Fixed in #35 by
  `summarizeEtfBlob()` + a priced-coverage check. Lesson: when a writer and a
  reader of `radar_cache` disagree, freshness passes and count checks lie —
  always verify the shape against the writer, and prefer checks that assert on
  *content* (prices present) over *existence* (rows present).
- **2026-07-03 — real ETF price zero-out (earlier the same day).**
  `yahoo-finance2` validation error nulled all ETF prices; fixed by making
  Stooq primary with Yahoo fallback (`ae806d6`).
- **2026-06/07 — FII/DII `macro_flows` empty.** NSE `fiidiiTradeReact` returns
  a per-category payload that the original parser didn't understand, and
  bot-block pages made it fail silently. Fixed in #34 + diagnostics in
  `ae806d6`.
- **2026-07-03 — codebase sweep.** Intraday runs were compounding today's move
  into `ret1w`/`rsVsNifty1M` on every same-day run (each run added the
  cumulative day change to the previous run's already-adjusted value); fixed
  with `eodRet1w`/`eodRsVsNifty1M` anchors. Also fixed a one-bar misalignment
  in `detectMacdBullish` for short histories, throttled the per-symbol
  full-cache disk writes in `stock_momentum.js`, and parallelised intraday
  quote fetches (4 workers). Lesson: any field an intraday run rewrites needs
  an EOD anchor field, or repeat runs compound it.

## Debugging playbook

**A health-check alert arrived.** Read the failure line, then:
1. Freshness failed → the writer didn't run. Check the GitHub Actions run for
   `refresh.yml` (nightly 23:30 UTC) before touching code.
2. Count/coverage failed but freshness passed → the build ran but produced
   bad content, **or** the check reads the wrong shape. Diff the check's read
   path against the writer's output shape first (cheapest to rule out).
3. Source warnings (Stooq/NSE) alone, with Yahoo OK → tolerable; no action
   unless they persist across days.
4. To inspect live blobs without prod creds locally, use the Supabase SQL
   editor: `select key, built_at, jsonb_typeof(data), pg_column_size(data)
   from radar_cache;`

**Pipeline scores look wrong.** Re-read "Stock Scoring Pipeline" ordering in
CLAUDE.md — the classic mistakes are snapshotting `eodBaseScore` before
`applyRegime`, or violating the penalty sign convention (positive magnitudes
subtracted by caller; `overextensionPenalty` already negative).

**PostgREST returns "column not found".** A migration in `ml/migrate_0NN_*.sql`
hasn't been applied. Run it in the Supabase SQL editor; the pipeline strips
unknown columns and continues in the meantime.

## Testing & CI quick facts

- Backend: `cd backend && node --test` (unit tests colocated as `*.test.js`;
  modules under test must be importable — no top-level side effects; guard
  entry points with `require.main === module`).
- ML: `python3 -m pytest ml/tests -q`.
- Playwright smoke tests live in `tests/` and expect the **auth-gated** app —
  they assert the login page, not data tables.
- No Supabase credentials are available in local/agent environments — reason
  from code + this doc, or ask for a manual SQL-editor query.

## Conventions worth repeating

- Penalty sign convention: see CLAUDE.md (positive magnitudes, except
  `overextensionPenalty`).
- Every `ml/*.py` entry point goes through `script_runner.run(main)` —
  `os._exit()` avoids a supabase-py teardown segfault. Don't "clean this up".
- Snapshot fundamentals (P/E, ROE…) stay **out** of ML training features
  (point-in-time unsafe) but are used in the JS scoring layer.
- Disk caches (`*_cache.json` in backend/) are 24 h TTL with
  stale-on-error fallback — never write an error payload into them.
- `refresh-cache.js` skips the `stock_picks` upsert when a scan returns < 50
  stocks, preserving yesterday's data over writing garbage.
