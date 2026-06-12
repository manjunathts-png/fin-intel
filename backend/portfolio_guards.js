"use strict";

/**
 * Portfolio-level guards applied to the final ranked list.
 *
 * Per-stock scoring can't see concentration risk: in a sector-led rally the
 * whole top 50 drifts into one sector and a single sector-wide reversal takes
 * down the entire list. applySectorCap soft-caps how much of the published
 * window one sector can occupy — overflow names are docked (not removed), so
 * a genuinely dominant sector still shows up, just not wall-to-wall.
 */

// At most 30% of the published window from a single sector before docking.
const MAX_SECTOR_FRAC = 0.30;
const SECTOR_CAP_DOCK = 6;
const UNKNOWN_SECTOR  = "Unknown";

/**
 * Walk the list in rank order; within the top `topN` window, names beyond the
 * per-sector cap get `sectorCapped: true` and a SECTOR_CAP_DOCK score dock.
 * Mutates stocks in place and returns the number docked. Caller re-sorts.
 *
 * sectorCapPenalty is a positive magnitude (like regimePenalty, liquidityPenalty)
 * so callers can sum all penalty fields without sign confusion.
 *
 * Stocks outside the top-N window are untouched (the cap protects what gets
 * published, not the long tail).
 */
function applySectorCap(stocks, { topN = 50, maxFrac = MAX_SECTOR_FRAC, dock = SECTOR_CAP_DOCK } = {}) {
  const maxPerSector = Math.max(1, Math.floor(topN * maxFrac));
  const counts = {};
  let docked = 0;

  for (const s of stocks) {
    s.sectorCapped = false;
    s.sectorCapPenalty = 0;
  }

  // Rank order = current array order after the caller's sort.
  let slot = 0;
  for (const s of stocks) {
    if (slot >= topN) break;
    const sector = s.sector || UNKNOWN_SECTOR;
    const n = counts[sector] ?? 0;
    if (n >= maxPerSector) {
      s.sectorCapped = true;
      s.sectorCapPenalty = dock;                           // positive magnitude
      s.compositeScore = Math.max(0, s.compositeScore - dock);
      docked++;
      // Docked names still consume their slot this pass — the caller's
      // re-sort decides who actually replaces them in the window.
    } else {
      counts[sector] = n + 1;
    }
    slot++;
  }
  return docked;
}

/** Sector distribution of the top-N window, for logging/UI. */
function sectorBreakdown(stocks, topN = 50) {
  const counts = {};
  for (const s of stocks.slice(0, topN)) {
    const sector = s.sector || UNKNOWN_SECTOR;
    counts[sector] = (counts[sector] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([sector, count]) => ({ sector, count, pct: Math.round((count / Math.min(topN, stocks.length)) * 100) }));
}

module.exports = {
  applySectorCap,
  sectorBreakdown,
  _config: { MAX_SECTOR_FRAC, SECTOR_CAP_DOCK },
};
