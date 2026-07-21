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
| `track_record` | `track_record.js` via `refresh-cache.js` | `{ asOf, params, cohorts, summary: {ret_5d/10d/21d: {top10,top50}}, rankBands, series, distribution, rotation }` — realized pick outcomes, rendered by `TrackRecord.jsx` |
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
`ret1w…ret1y` can each independently be null (thin-traded ticker, or the
latest print is too stale to treat as "now" — see `momentumFromPrices` in
`etf_momentum.js`); `momentumSource` is `null` (not `"price"`) when none of
them computed. Same pattern in `mf_radar` funds: `navStale`/`navStaleDays`
flag when a scheme's NAV feed has gone quiet (`navFreshness` in `momentum.js`).

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
- **2026-07-06 — mf_radar/etf_picks fail every Monday (recurring, self-resolving).**
  `mf_radar` and `etf_picks` are refreshed only by the nightly `all`/`mf`/`etf`
  targets (Mon-Fri 23:30 UTC) — unlike `stock_picks`, nothing touches them over
  the weekend, so `built_at` sits at Friday night's timestamp until Monday
  night's run. Both the GH Actions "ML Quality" job (`tests/ml_quality_check.py`)
  and `data-health-check.js`'s `checkMfRadar`/`checkEtfPicks` compared that gap
  against a flat 28h wall-clock threshold, so **every single Monday**, all
  three of that day's health checks (9:40am, 12:30pm, 3:45pm IST) failed on
  "mf_radar cache is 55-61h old" and fired a failure email, until the
  Monday-night `all` run incidentally fixed it ~10 hours later. The `--fix`
  step made it worse: it always re-ran `refresh-cache.js stocks` regardless of
  which check failed, which can never touch `mf_radar` — three wasted CI
  minutes on top of three false alerts, every week. Fixed by discounting
  weekend hours from the freshness comparison (`businessHoursAge` in
  `utils.js`, ported to Python as `business_hours_since`) and making `--fix`
  pick the refresh target that actually covers the failing check
  (`fixScriptsForFailures`). Lesson: a freshness threshold is really "how
  long since the thing that's supposed to refresh this last had a chance to
  run" — for anything on a weekday-only cron, that's not the same as
  wall-clock hours, and it's worth asking whether an "automatic fix" can
  actually address the specific failure before wiring it in.
- **2026-07-13 — the mf_radar/etf_picks Monday bug had a sibling in
  `stock_picks`.** The 2026-07-06 fix above patched `checkMfRadar`/
  `checkEtfPicks` but missed that `checkSupabaseFreshness`'s "stocks EOD
  freshness" check has the *identical* bug on a different field:
  `stored.asOf` (EOD signal-computation time) is set only by the "stocks"/
  "all" targets, same as `mf_radar`/`etf_picks` — intraday runs update
  `intradayAsOf` and `built_at` but never touch `asOf`. I'd wrongly assumed
  this check "self-heals via intraday `built_at` touches" without checking
  that `built_at` isn't actually what drives the pass/fail decision here
  (only `eodAge` from `asOf` is). Same Friday-night-to-Monday gap, same flat
  28h threshold, same fix: `eodAge` → `businessHoursAge`. Confirmed with the
  real numbers (built Sat 01:02 UTC, checked Mon 10:26 UTC, 57.4h raw →
  10.4h business-hours). **Lesson: when porting a fix across multiple
  similar checks, verify each one's actual pass/fail field, don't reason
  by analogy from a same-named field that turns out to serve a different
  purpose.**
- Same incident also caught a **"Nifty benchmark" false failure**:
  `checkNiftyBenchmark` only tried the NSE archive and Stooq before failing,
  but production's `nifty_benchmark.js` has a third fallback (Yahoo REST)
  that the health check never mirrored — so it could report "unreachable"
  in exactly the NSE-403 + Stooq-rate-limited situation the real pipeline
  already tolerates via Yahoo (the alert's own Yahoo *source* probe passed
  in the same run, supporting this). Added the same Yahoo fallback to the
  health check.
- **2026-07-07 — `label_stock_targets.py` statement timeout, 1M horizon.**
  `load_unlabeled()` paged through unlabeled `stock_features` rows with
  `OFFSET`, which costs Postgres more per page as the offset grows (it must
  scan-and-discard every earlier matching row on every page). Hit a 57014
  statement timeout at `offset=6000` for the 1M horizon — its cutoff date is
  more recent than 3M's, so it matches a bigger backlog. Because the step
  crashes instead of finishing, the backlog compounds run over run until
  fixed. Fixed by switching to keyset (cursor) pagination on
  `(as_of_date, symbol)` — each page seeks directly to just past the last row
  seen instead of re-scanning from the start, so cost stays flat regardless
  of depth. `symbol` had to join the cursor/order because up to ~500 rows
  share one `as_of_date` (one per stock); `as_of_date` alone isn't a stable
  sort key and could skip or duplicate rows within a date — a latent
  correctness bug the OFFSET version already had, independent of the
  timeout. **The same OFFSET pattern exists in `ml/ic_monitor.py`,
  `ml/label_targets.py`, `ml/track_pick_outcomes.py`, `ml/train.py`,
  `ml/train_stock.py`, and `backend/track_record.js`** — none have hit the
  timeout yet, but any of their backlogs growing large enough will produce
  the identical failure. Keyset pagination (this fix's pattern) is the
  remedy if one of them does.
- **2026-07-03 — codebase sweep.** Intraday runs were compounding today's move
  into `ret1w`/`rsVsNifty1M` on every same-day run (each run added the
  cumulative day change to the previous run's already-adjusted value); fixed
  with `eodRet1w`/`eodRsVsNifty1M` anchors. Also fixed a one-bar misalignment
  in `detectMacdBullish` for short histories, throttled the per-symbol
  full-cache disk writes in `stock_momentum.js`, and parallelised intraday
  quote fetches (4 workers). Lesson: any field an intraday run rewrites needs
  an EOD anchor field, or repeat runs compound it.
- **2026-07-20 — DEFENCEIETF/HDFCDEF/KOTAKGOLD/AXISGOLD showed every return
  horizon as null on the live ETF Picks page.** `buildEtfEntry` in
  `etf_momentum.js` required **≥30 total price rows before computing ANY
  horizon** — an all-or-nothing gate. Thin-traded ETFs (small gold ETFs
  printing only a few days a month; niche sector ETFs) never cleared 30
  rows within the 400-day lookback and so showed a blanket "—" even when a
  real 1W/1M return was computable from the rows they did have. The MF
  momentum path (`momentum.js` `computeFundStats`) never had this gate —
  it calls `pctReturn` per horizon and lets each one degrade independently
  — which is why this asymmetry was worth noticing: when one of two
  parallel modules is visibly more resilient than the other, that's a sign
  the stricter one over-corrected, not that the risk it's guarding against
  is real. Fixed by extracting the decision into `momentumFromPrices` (pure,
  unit tested) and dropping the blanket gate down to `MIN_PRICE_ROWS = 2`.
  That alone would risk fabricating a flat ~0% return from a long-stale
  "latest" price (pctReturn always treats the series' last row as "now"),
  so added `MAX_STALE_PRICE_DAYS = 10`: momentum is only computed if the
  latest available print is within 10 calendar days, otherwise a clear
  warning is recorded instead. Added the identical guard (`navFreshness`,
  `MAX_STALE_NAV_DAYS = 10`) to `momentum.js` for consistency, scoped only
  to the point-in-time return fields (ret1w..ret1y, z1w) — CAGR/drawdown/
  consistency look backward over the whole series and aren't distorted by
  a stale tail the same way, so they're left unguarded.
  Also replaced `etf_momentum.js`'s Yahoo fallback: it called the
  `yahoo-finance2` npm package's `.chart()`, which has schema validation
  that already caused a full ETF outage once before (`ae806d6`,
  2026-07-03). Rewrote it as a raw `fetch()` against Yahoo's REST endpoint
  (query1/query2 dual-host, defensive `?.`/`??` parsing) — the exact
  pattern already proven in `stock_momentum.js`/`nifty_benchmark.js`. A
  non-validating fetch can only succeed in more cases than a
  schema-validating library call for the same data, so this is a strict
  improvement even without live confirmation of which specific tickers it
  helps. **Could not verify live behavior for this incident** — this
  sandbox has no outbound network access to Stooq/Yahoo/Supabase/the live
  site (confirmed via the agent proxy's policy-denial log) — so the fix is
  reasoned from code + the codebase's own prior incidents, not from
  reproducing the failure directly. Watch the next few nightly refreshes'
  `etf_picks`/`mf_radar` warnings for these four tickers to confirm.
- **2026-07-21 — escalation: ALL 36 ETFs (not just the original 4) showed
  every return horizon as null**, i.e. the 2026-07-20 fix above wasn't
  enough. Confirmed via direct job-log inspection (`get_job_logs` on the
  completed "Refresh cache" step) that every single ticker hit the same
  pair of failures: `Stooq: no data from stooq (len=796)` then
  `Yahoo: 429 rate-limited` — and this repeated across multiple separate
  job runs hours apart (fresh runners, presumably different IPs), not just
  within one burst. That rules out the previous day's 200ms throttle
  (PR #42) as a complete fix: pacing one job's requests can't fix a limit
  that survives across jobs. Most likely explanation: Yahoo is rate-
  limiting GitHub Actions' shared runner IP pool at a level broader than
  this repo's own request volume; Stooq's `len=796` response is its
  separate, already-documented daily-limit page.
  Fix: stopped depending on Stooq/Yahoo as the *first* source for ETF
  prices. `stock_momentum.js`'s NSE Bhavcopy bulk archive
  (`nsearchives.nseindia.com`) has never shown bot-blocking from CI and
  already parses **every** EQ/BE-series NSE symbol for the stock pipeline —
  ETFs trade on the same cash segment under the same series codes, so that
  archive already contains them whenever the stock scan has run earlier in
  the same `all`/`stocks` job (confirmed execution order: stocks before
  ETF). Added `getCachedPrices(symbol)` to `stock_momentum.js` (a read-only
  accessor into its in-memory `cache.symbols`, no network trigger — returns
  null and falls through to Stooq/Yahoo if the symbol isn't present) and
  made `etf_momentum.js`'s `fetchTickerPrice` check it first, before any
  network call. Stooq → Yahoo remains as the fallback for any ETF the
  bhavcopy pass doesn't cover (or when ETF is dispatched standalone without
  a preceding stock run). Added
  `fetchTickerPrice uses the bhavcopy cache first, without touching
  Stooq/Yahoo` in `etf_momentum.test.js` — stubs `stock_momentum.js` via
  `require.cache` substitution so the test never makes a real network call.
  **Same sandbox network limitation as the 2026-07-20 entry applies** —
  verify via the next nightly run's `etf_picks` warnings that tickers now
  show `source: "bhavcopy"` instead of Stooq/Yahoo failures.

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
