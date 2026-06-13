import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { colors } from "../../src/lib/theme";
import { LoadingView, ErrorView } from "../../src/components/LoadingView";
import { PctText } from "../../src/components/PctText";

interface NavRow { date: Date; nav: number }
interface Fund   { code: string; label: string; category: string }

const RISK_FREE = 7;

function parseNavDate(str: string): Date {
  const [d, m, y] = str.split("-");
  return new Date(`${y}-${m}-${d}`);
}

async function fetchNavs(code: string): Promise<NavRow[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(`https://api.mfapi.in/mf/${code}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return ((json.data ?? []) as { date: string; nav: string }[])
      .reverse()
      .map(e => ({ date: parseNavDate(e.date), nav: parseFloat(e.nav) }));
  } finally {
    clearTimeout(timer);
  }
}

function monthlyReturns(navs: NavRow[]) {
  const byMonth = new Map<string, number>();
  navs.forEach(({ date, nav }) => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    byMonth.set(key, nav);
  });
  const sorted = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
  const rets: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][1] > 0 && sorted[i - 1][1] > 0)
      rets.push(sorted[i][1] / sorted[i - 1][1] - 1);
  }
  return rets;
}

function rollingStats(rets: number[], windowMonths: number) {
  const results: number[] = [];
  for (let i = windowMonths; i <= rets.length; i++) {
    const compound = rets.slice(i - windowMonths, i).reduce((acc, r) => acc * (1 + r), 1);
    results.push((Math.pow(compound, 12 / windowMonths) - 1) * 100);
  }
  if (!results.length) return null;
  const mean = results.reduce((s, v) => s + v, 0) / results.length;
  const pctPos = results.filter(c => c > 0).length / results.length * 100;
  const pct15  = results.filter(c => c > 15).length / results.length * 100;
  return { mean, min: Math.min(...results), max: Math.max(...results), pctPos, pct15, n: results.length };
}

function riskStats(rets: number[]) {
  if (!rets.length) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const annMean = (Math.pow(1 + mean, 12) - 1) * 100;
  const variance = rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / rets.length;
  const annStd = Math.sqrt(variance) * Math.sqrt(12) * 100;
  const sharpe = annStd > 0 ? (annMean - RISK_FREE) / annStd : null;
  return { annMean, annStd, sharpe };
}

function maxDrawdown(navs: NavRow[]) {
  let peak = 0, maxDd = 0;
  for (const { nav } of navs) {
    if (nav > peak) peak = nav;
    const dd = peak > 0 ? (nav / peak - 1) * 100 : 0;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

export default function DeepDiveScreen() {
  const [funds,      setFunds]      = useState<Fund[]>([]);
  const [query,      setQuery]      = useState("");
  const [selected,   setSelected]   = useState<Fund | null>(null);
  const [navs,       setNavs]       = useState<NavRow[] | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navError,   setNavError]   = useState<string | null>(null);
  const [retryKey,   setRetryKey]   = useState(0);
  const [initLoading,setInitLoading]= useState(true);

  useEffect(() => {
    supabase.from("radar_cache").select("data").eq("key", "mf_radar").single().then(({ data }) => {
      const mfData = data?.data as any;
      const all: Fund[] = [];
      if (mfData?.categories) {
        for (const cat of mfData.categories) {
          for (const f of cat.funds ?? []) {
            all.push({ code: String(f.code), label: f.label, category: cat.category ?? f.category });
          }
        }
      }
      setFunds(all);
      if (all.length) setSelected(all[0]);
      setInitLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    setNavs(null); setNavLoading(true); setNavError(null);
    fetchNavs(selected.code)
      .then(setNavs)
      .catch(err => {
        setNavs([]);
        setNavError(err.name === "AbortError" ? "Request timed out" : (err.message ?? "Network error"));
      })
      .finally(() => setNavLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, retryKey]);

  const filtered = query.trim()
    ? funds.filter(f => f.label.toLowerCase().includes(query.toLowerCase()) || f.code.includes(query))
    : [];

  const rets    = navs?.length ? monthlyReturns(navs) : null;
  const risk    = rets ? riskStats(rets) : null;
  const maxDd   = navs?.length ? maxDrawdown(navs) : null;
  const calmar  = risk && maxDd ? Math.abs(risk.annMean / maxDd) : null;
  const roll1y  = rets && rets.length >= 12 ? rollingStats(rets, 12) : null;
  const roll3y  = rets && rets.length >= 36 ? rollingStats(rets, 36) : null;
  const roll5y  = rets && rets.length >= 60 ? rollingStats(rets, 60) : null;

  if (initLoading) return <LoadingView message="Loading fund universe…" />;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Search */}
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search fund name…"
            placeholderTextColor={colors.textMuted}
          />
        </View>

        {/* Search results */}
        {filtered.length > 0 && (
          <View style={styles.results}>
            {filtered.slice(0, 6).map(f => (
              <Pressable key={f.code} onPress={() => { setSelected(f); setQuery(""); }} style={styles.resultItem}>
                <Text style={styles.resultName}>{f.label}</Text>
                <Text style={styles.resultCat}>{f.category}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Selected fund header */}
        {selected && (
          <View style={styles.fundHeader}>
            <Text style={styles.fundName}>{selected.label}</Text>
            <Text style={styles.fundCat}>{selected.category}</Text>
          </View>
        )}

        {/* NAV loading */}
        {navLoading && (
          <View style={styles.navLoading}>
            <ActivityIndicator color={colors.blue} />
            <Text style={styles.navLoadingText}>Fetching NAV history…</Text>
          </View>
        )}

        {/* Nav error */}
        {navs?.length === 0 && navError && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>Could not load NAV history — {navError}</Text>
            <Pressable onPress={() => setRetryKey(k => k + 1)} style={styles.retryBtn}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* Analytics */}
        {navs && navs.length > 0 && !navLoading && (
          <>
            <View style={styles.statsGrid}>
              <StatCard label="Monthly data" value={`${rets?.length ?? 0}mo`} />
              <StatCard label="Daily NAVs" value={`${navs.length}`} />
              {navs[0] && <StatCard label="From" value={navs[0].date.getFullYear().toString()} />}
            </View>

            {risk && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Risk Metrics</Text>
                <View style={styles.statsGrid}>
                  <StatCard label="Ann. Return" value={`${risk.annMean >= 0 ? "+" : ""}${risk.annMean.toFixed(1)}%`} color={risk.annMean >= 0 ? colors.green : colors.red} />
                  <StatCard label="Volatility" value={`${risk.annStd.toFixed(1)}%`} color={risk.annStd > 25 ? colors.red : colors.yellow} />
                  <StatCard label="Sharpe" value={risk.sharpe != null ? risk.sharpe.toFixed(2) : "—"} color={risk.sharpe != null && risk.sharpe >= 1 ? colors.green : colors.yellow} />
                  {maxDd != null && <StatCard label="Max DD" value={`${maxDd.toFixed(1)}%`} color={colors.red} />}
                  {calmar != null && <StatCard label="Calmar" value={calmar.toFixed(2)} color={calmar >= 0.5 ? colors.green : colors.yellow} />}
                </View>
              </View>
            )}

            {roll1y && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Rolling 1Y Returns ({roll1y.n} windows)</Text>
                <View style={styles.statsGrid}>
                  <StatCard label="Avg CAGR"  value={`${roll1y.mean >= 0 ? "+" : ""}${roll1y.mean.toFixed(1)}%`} color={roll1y.mean >= 0 ? colors.green : colors.red} />
                  <StatCard label="Best"       value={`+${roll1y.max.toFixed(1)}%`} color={colors.green} />
                  <StatCard label="Worst"      value={`${roll1y.min.toFixed(1)}%`}  color={colors.red} />
                  <StatCard label="% Positive" value={`${roll1y.pctPos.toFixed(0)}%`} color={roll1y.pctPos >= 70 ? colors.green : colors.yellow} />
                  <StatCard label=">15% CAGR"  value={`${roll1y.pct15.toFixed(0)}%`} color={roll1y.pct15 >= 50 ? colors.green : colors.yellow} />
                </View>
              </View>
            )}

            {roll3y && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Rolling 3Y Returns ({roll3y.n} windows)</Text>
                <View style={styles.statsGrid}>
                  <StatCard label="Avg CAGR"  value={`${roll3y.mean >= 0 ? "+" : ""}${roll3y.mean.toFixed(1)}%`} color={roll3y.mean >= 0 ? colors.green : colors.red} />
                  <StatCard label="% Positive" value={`${roll3y.pctPos.toFixed(0)}%`} color={roll3y.pctPos >= 70 ? colors.green : colors.yellow} />
                  <StatCard label=">15% CAGR"  value={`${roll3y.pct15.toFixed(0)}%`} color={roll3y.pct15 >= 50 ? colors.green : colors.yellow} />
                </View>
              </View>
            )}

            {roll5y && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Rolling 5Y Returns ({roll5y.n} windows)</Text>
                <View style={styles.statsGrid}>
                  <StatCard label="Avg CAGR"  value={`${roll5y.mean >= 0 ? "+" : ""}${roll5y.mean.toFixed(1)}%`} color={roll5y.mean >= 0 ? colors.green : colors.red} />
                  <StatCard label="% Positive" value={`${roll5y.pctPos.toFixed(0)}%`} color={roll5y.pctPos >= 70 ? colors.green : colors.yellow} />
                  <StatCard label=">15% CAGR"  value={`${roll5y.pct15.toFixed(0)}%`} color={roll5y.pct15 >= 50 ? colors.green : colors.yellow} />
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatCard({ label, value, color = colors.text }: { label: string; value: string; color?: string }) {
  return (
    <View style={sc.card}>
      <Text style={[sc.value, { color }]}>{value}</Text>
      <Text style={sc.label}>{label}</Text>
    </View>
  );
}

const sc = StyleSheet.create({
  card:  { flex: 1, minWidth: "30%", backgroundColor: colors.card, borderRadius: 10, padding: 10, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  value: { fontSize: 16, fontWeight: "700" },
  label: { fontSize: 10, color: colors.textMuted, marginTop: 2, textAlign: "center" },
});

const styles = StyleSheet.create({
  safe:           { flex: 1, backgroundColor: colors.bg },
  scroll:         { padding: 14, gap: 10, paddingBottom: 40 },
  searchWrap:     { marginBottom: 4 },
  search:         { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: colors.text, fontSize: 14 },
  results:        { backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: "hidden", marginBottom: 8 },
  resultItem:     { padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  resultName:     { color: colors.text, fontSize: 13, fontWeight: "600" },
  resultCat:      { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  fundHeader:     { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
  fundName:       { color: colors.text, fontWeight: "700", fontSize: 15, lineHeight: 20 },
  fundCat:        { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  navLoading:     { flexDirection: "row", alignItems: "center", gap: 10, padding: 14 },
  navLoadingText: { color: colors.textSub, fontSize: 13 },
  errorBox:       { backgroundColor: "#7f1d1d22", borderWidth: 1, borderColor: "#7f1d1d", borderRadius: 12, padding: 14, gap: 10, alignItems: "center" },
  errorText:      { color: colors.red, fontSize: 13, textAlign: "center" },
  retryBtn:       { backgroundColor: colors.card, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  retryText:      { color: colors.text, fontSize: 13 },
  card:           { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border, gap: 10 },
  cardTitle:      { color: colors.textSub, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  statsGrid:      { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
