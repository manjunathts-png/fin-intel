import { supabase } from "./supabase";

// Shared cache for radar_cache reads (mf_radar, stock_picks, etf_picks, …).
//
// Pages nested under the /mf and /stocks layouts already get their data via
// a single parent fetch shared through React Router's Outlet context. But
// several top-level pages (EtfPicks, Simulator, DeepDive, PersonaAdvisor)
// sit outside those layouts and each independently re-fetched the full JSON
// blob on every visit, even within the same browser tab, with no freshness
// check — the same waste Stocks.jsx had already fixed once for stock_picks
// (see its two-phase built_at-then-data comment). This generalizes that
// fix to every radar_cache consumer instead of just one.
const CACHE_TTL_MS = 10 * 60 * 1000; // data updates at most ~7x/day; 10 min
// caps the worst case (a fresh full-payload pull) while the built_at probe
// below (a few bytes) still catches a genuinely new build sooner than that.

const cache = new Map();    // key -> { data, built_at, ts }
const inflight = new Map(); // key -> Promise, de-dupes concurrent callers

export function getRadarCache(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return Promise.resolve({ data: cached.data, built_at: cached.built_at, error: null });
  }
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const { data: meta, error: metaErr } = await supabase
      .from("radar_cache").select("built_at").eq("key", key).maybeSingle();
    if (metaErr) return { data: null, built_at: null, error: metaErr };
    if (!meta) return { data: null, built_at: null, error: null };

    if (cached && meta.built_at === cached.built_at) {
      cache.set(key, { ...cached, ts: Date.now() });
      return { data: cached.data, built_at: cached.built_at, error: null };
    }

    const { data: row, error: rowErr } = await supabase
      .from("radar_cache").select("data,built_at").eq("key", key).maybeSingle();
    if (rowErr) return { data: null, built_at: null, error: rowErr };
    if (row) cache.set(key, { data: row.data, built_at: row.built_at, ts: Date.now() });
    return { data: row?.data ?? null, built_at: row?.built_at ?? null, error: null };
  })();

  inflight.set(key, promise);
  promise.finally(() => inflight.delete(key));
  return promise;
}
