# Fin Intel — UX Redesign Plan

A discussion document. Decisions captured at §10. Phase 1 ready to execute.

---

## 1. The problem in one sentence

> A new user lands on `/mf` and sees a wall of 12 numeric columns including z-score, Sharpe, MaxDD, and α 5Y — none of which mean anything without explanation. They bounce.

The current pages are *analysis tools for someone who already knows what they're looking for*. We need an *entry point for someone who doesn't*.

---

## 2. Who's using this & what do they want?

| Persona | Goal | Cognitive budget |
|---|---|---|
| **Newcomer** | "Tell me what to invest in" | Low — wants a short list with brief reasons |
| **Casual returning investor** | "What's hot this week? Any new picks?" | Medium — wants curated list + light context |
| **Power user (you)** | Drill into a specific fund, screen by Sharpe ≥ 1.2, find Golden Cross candidates | High — wants the full radar & filters |

**Today the app serves only the power user.** We need to layer the first two without hiding the third.

---

## 3. Design principles (we'll measure proposals against these)

1. **Curation before exploration** — the first view should be opinionated picks, not raw data
2. **Progressive disclosure** — start minimal, "Show more" reveals depth
3. **Plain English first, jargon optional** — every metric has a hover tooltip in plain language
4. **Cards over tables in default views** — easier to scan, mobile-friendly
5. **Don't strip features, hide them** — power-user filters still exist, just not above the fold
6. **Mobile is first-class** — currently several radar tables require horizontal scroll

---

## 4. Information architecture — three options

### Option A — Your suggestion, slightly tightened

```
Top Picks (default landing)
  ↳ Sub-tabs: MF · Stocks
MF Radar
  ↳ Sub-tabs: Category · Risk-Adjusted · Long-term
Stocks Radar
  ↳ Sub-tabs: Sector · All Stocks · Signal Hotspots
Simulator
Deep Dive
```
**6 top-nav items.** Picks is the entry point. Each radar still has its 3 tabs internally.

### Option B — Group by asset class

```
Mutual Funds
  ↳ Sub-tabs: 🏆 Picks (default) · 🌡 Radar · 🎯 Risk-Adjusted · 📈 Compounders
Stocks
  ↳ Sub-tabs: 🏆 Picks (default) · 🌡 Sector Radar · 🔍 All Stocks · 🔥 Hotspots
Simulator
Deep Dive
```
**4 top-nav items.** Cleaner. Picks is the default view inside each asset class. One less click than today to see picks; same number of clicks to reach radar.

### Option C — Single homepage feed + drilldowns

```
Today (default homepage)
  ↳ 3 MF picks + 3 stock picks + market mood
Mutual Funds → drill into all MF views
Stocks → drill into all stock views
Plan (= Simulator)
Research (= Deep Dive)
```
**5 top-nav items.** Most opinionated — homepage is the single curated feed across both asset classes. Newcomers never need to know what a "radar" is.

### Recommendation

**Option B** is the best fit for now:
- Clean nav (4 items)
- Picks is default per asset class — matches your stated goal
- No need to design a brand-new homepage (Option C requires that)
- Adds zero clicks for power users (sub-tabs are one tap)
- Easy to evolve into Option C later if we want a unified feed

Decision needed: **A, B, or C?**

---

## 5. Page-level simplifications (independent of which IA we pick)

### 5.1 Picks page (current `/picks` Stocks tab)

**Today:** Single dense card per pick with score badge, 7 signal chips, 5-cell fundamentals strip, 6-cell technicals strip, collapsible rule-based + AI rationale. **Lots of visible weight per card.**

**Proposal — 3 tiers of detail:**

| Tier | What shows | When |
|---|---|---|
| **Tier 1: Headline card** | Rank, name, sector, score, verdict, 1-line "why" | Default for all picks |
| **Tier 2: Expanded card** | + signal chips + fundamentals + technicals | Click "Details" or expand |
| **Tier 3: Full analysis** | + bull/bear case + AI rationale + benchmark | Click "Read analysis" |

Reduces visual weight ~70% in default view; deep dive available on demand.

**Mock of Tier 1 card:**
```
#1  Varun Beverages Ltd.                                          100 / Strong Buy
    FMCG  ·  ₹485.20  +2.34%
    9 signals · Outperforming Nifty by 26pp over 3M     [Details ▾]
```

### 5.2 MF Radar (current `/mf` Category Radar)

**Today:** 12-column heatmap right above the fold. New users see numbers like "α 5Y +3.1pp" and bounce.

**Proposal — staged view:**
1. **Hero row at top** — 3 cards: "🏆 Top sector by 5Y CAGR" · "⚠ Sector losing steam" · "Today's gainer" — each with a 1-line story
2. **Below: simplified table** — only 5 columns by default (Category · 1Y · 5Y CAGR · Sharpe · α 5Y)
3. **"Show all metrics" toggle** — expands to current 12-column view

This makes the page legible at a glance without removing the power-user data.

### 5.3 Stock Radar Sector tab

Same principle as MF Radar. Currently shows 7 columns; default to 4 (Sector · Avg Score · Strong Count · RS 1M).

### 5.4 Stock Picks Discovery section (5 widgets stacked)

**Today:** 5 widgets in a 2-column grid above the picks. **Too much scrolling.**

**Proposal:**
- Collapse Discovery into a single accordion: "🔭 NSE Discovery Feeds (3 active)" — collapsed by default
- Inside: 4-tile grid with each feed
- Once collapsed, picks appear right under the page header

### 5.5 Tooltips & glossary

- Every metric badge / header → `title` attribute with plain-English definition (already done for signal chips on /stocks; extend to Sharpe, Sortino, Calmar, α, RS, MaxDD, Consistency)
- New page: `/glossary` — short paragraph per metric
- "What does this mean?" links sprinkled into hero cards

---

## 6. Concrete first-step build plan (if we pick Option B)

**Phase 1 — IA + Picks-first navigation (2–3 hrs)**
1. Refactor nav: combine "MF Radar" + "Picks (MF tab)" → single "Mutual Funds" item
2. Same for Stocks
3. Picks becomes default sub-tab inside each
4. Existing radar/picks pages move into sub-tabs

**Phase 2 — Tier-1 picks card (2 hrs)**
1. Compact card variant of `StockPickCard` / `MfPickCard`
2. "Show details" toggle expands to current dense layout
3. AI/rule-based rationale stays as a third collapse layer

**Phase 3 — Hero rows on radar pages (1–2 hrs)**
1. 3-card hero strip at top of MF Category Radar
2. Same for Stock Sector Radar
3. Simplified default table + "Show all metrics" toggle

**Phase 4 — Discovery accordion (1 hr)**
1. Collapse 5 discovery widgets into single accordion section

**Phase 5 — Glossary + tooltips (1 hr)**
1. Hover tooltips on every metric header
2. `/glossary` page

**Total: ~8–10 hours of focused work.** Could ship Phase 1 first as a small, reversible change to test reaction.

---

## 7. Open questions for you

1. **IA preference: A, B, or C?** (B is recommended, C is the boldest)
2. **Should the default sort on Stock Picks change?** Today it's composite-score-desc — would you prefer "Today's biggest movers from picks universe" as the default, with composite as secondary?
3. **Mobile design:** any specific complaints? Most current pages require horizontal scroll on a phone. Worth a separate "Mobile pass" later.
4. **Glossary as separate page vs inline tooltips only?** Glossary page is easier to maintain but tooltips are more discoverable.
5. **Onboarding tour?** A one-time intro overlay ("This is your top pick. This is why we picked it. Click here to see analysis.") — useful for newcomers but adds complexity. Optional later.
6. **Brand/voice consistency:** any preference for "AI-curated" vs "rule-based" vs just "analysis"? Currently we expose both source labels per pick.
7. **Persistence:** should we remember a user's preferred default tab? (e.g., if you always go to Risk-Adjusted, that becomes your default)

---

## 8. What I'm NOT proposing (intentional)

- ❌ Removing any existing feature — everything stays, just gets re-layered
- ❌ Changing the backend signal/scoring logic — purely UX
- ❌ A landing page with marketing copy — the app is for logged-in users
- ❌ Mandatory onboarding flow — keeps the app fast to use for repeat visitors
- ❌ Dark/light theme toggle — dark works for finance dashboards, ship-blocker if we add later

---

## 9. Suggested next step

1. You read this, mark which option you prefer for §4 and answer the questions in §7
2. I update this doc with your decisions
3. We pick **one** phase from §6 to ship as a contained PR — gauge reaction
4. Iterate from there

No rush. Reply with thoughts on the IA options and the §7 questions and we'll converge on a plan.

---

## 10. Decisions captured

### From the §7 open questions

| # | Question | Decision |
|---|---|---|
| 1 | IA: A, B, or C? | **B** — 4 top-nav items, Picks default sub-tab inside each section |
| 2 | Default sort on Stock Picks | **Keep composite score** as default sort |
| 3 | Mobile horizontal scroll | Acknowledge, defer to later pass |
| 4 | Onboarding tour | **No** — simplify UI/UX instead |
| 5 | Tab persistence | **Use URL sub-routes** (`/mf/picks`, `/mf/radar`, etc.) — no per-user state, bookmarkable, Back/Forward works, no heuristic needed |
| 6 | "AI" vs "rule-based" label | (not answered — defer; current dual labels can stay) |
| 7 | Hide secondary tabs behind "More views" toggle | (not raised — current plan keeps all sub-tabs visible) |

### URL structure (from decision #5)

```
/                  → redirects to /mf/picks (or /stocks/picks if user pref later)

/mf                → redirects to /mf/picks
/mf/picks          → MF Top Picks (default)
/mf/radar          → MF Category Radar (current heatmap)
/mf/risk           → MF Risk-Adjusted table
/mf/compounders    → MF Long-Term Compounders

/stocks            → redirects to /stocks/picks
/stocks/picks      → Stock Top Picks + Discovery (default)
/stocks/radar      → Stock Sector Radar
/stocks/all        → All Stocks (filterable table)
/stocks/hotspots   → Signal Hotspots

/simulator         → unchanged
/deep-dive         → unchanged
/admin             → unchanged
```

### Top nav (4 items)

```
[💹 Fin Intel]   📊 Mutual Funds   📈 Stocks   🧮 Simulator   🔍 Deep Dive   [user]
```

Each section page renders a sub-tab strip immediately below the page header. Visiting the parent path (`/mf`) redirects to the default sub-tab (`/mf/picks`).

---

## 11. Phase-1 execution plan (locked, ready to build)

### Goal
Ship the IA change as a small, reversible PR. Picks-first navigation, sub-routes, no other visual changes yet (those come in Phase 2-5).

### Concrete diff

**`frontend/src/App.jsx`** — restructure routes:
- Parent routes for `/mf/*` and `/stocks/*` with index redirects
- Sub-routes wired to existing components (extracted from current Picks tabs)

**`frontend/src/components/Layout.jsx`** — top nav becomes 4 items:
- Mutual Funds (link to `/mf`)
- Stocks (link to `/stocks`)
- Simulator (unchanged)
- Deep Dive (unchanged)
- (Removed: standalone "Picks" tab — picks are now under MF and Stocks)

**`frontend/src/pages/Mf.jsx`** (new wrapper) — sub-tab strip + outlet
- Tabs: Picks · Radar · Risk-Adjusted · Compounders
- Uses NavLink to sub-routes; outlet renders the active sub-tab

**`frontend/src/pages/Stocks.jsx`** (new wrapper) — sub-tab strip + outlet
- Tabs: Picks · Sector Radar · All Stocks · Signal Hotspots

**`frontend/src/pages/MfPicks.jsx`** (new) — extracted from current `Picks.jsx` MF tab
- Renders the `MfPickCard` list with rule-based + AI rationale

**`frontend/src/pages/StockPicks.jsx`** (new) — extracted from current `Picks.jsx` Stocks tab
- Renders Discovery section + Stock pick cards

**Existing files reused unchanged:**
- `MfRadar.jsx` — moves into the radar sub-route, internal 3-tab structure becomes 3 sub-routes
  - Actually: `MfRadar.jsx` keeps its internal tabs OR we split its 3 tabs into 3 sub-route components — TBD during build
- `StockRadar.jsx` — same as above
- `Simulator.jsx`, `DeepDive.jsx`, `Admin.jsx` — unchanged

**Decision during build:** for the existing `MfRadar.jsx` / `StockRadar.jsx` 3-tab pages, do we keep them as single-page-with-internal-tabs (just wrapped in our new sub-tab) OR split into separate route components? **Recommendation:** split into separate route components — gives clean URLs (`/mf/risk` not `/mf/radar?tab=risk`) and matches the rest of the IA.

**The old `Picks.jsx`** gets deleted at the end (its functionality is fully migrated to `MfPicks.jsx` + `StockPicks.jsx`).

### Out of scope for Phase 1
- Tier-1/Tier-2 card simplification (Phase 2)
- Hero rows on radar pages (Phase 3)
- Discovery accordion (Phase 4)
- Glossary + tooltips (Phase 5)
- Mobile fixes (deferred)

### Estimate
~2-3 hours focused work. Touches 6 files (3 new wrappers, 2 extracted page components, App.jsx + Layout.jsx).

### Risks
- **Bookmarked /picks URLs would 404** → mitigation: add a redirect from `/picks` → `/mf/picks`
- **Deep Dive page already exists at `/deep-dive`** — no conflict
- **Admin route stays at `/admin`** — no conflict

### Reversibility
Pure URL/component refactor. No backend changes. If we don't like it, one revert commit undoes everything. The Supabase data layer and existing components keep working.

---

## 12. After Phase 1 lands

We then pick the next phase to ship one at a time, in this order:

1. **Phase 2 — 3-tier pick card disclosure** (biggest UX win after the IA change)
2. **Phase 3 — Hero rows on radar pages** (helps casual users)
3. **Phase 4 — Discovery accordion** (reduces scroll on /stocks/picks)
4. **Phase 5 — Tooltips + Glossary page** (polish layer)

Each phase is independently shippable and reversible.

---

## Ready to execute Phase 1?

Say the word and I'll start with the App.jsx route refactor + new wrapper components. I'll commit it as one atomic PR so you can review before we proceed to Phase 2.
