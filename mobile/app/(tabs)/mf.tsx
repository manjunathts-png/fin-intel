import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { colors } from "../../src/lib/theme";
import { LoadingView, ErrorView } from "../../src/components/LoadingView";
import { VerdictBadge } from "../../src/components/VerdictBadge";
import { PctText } from "../../src/components/PctText";

interface Rationale {
  fund_code: string;
  rank: number;
  run_date: string;
  analysis: {
    verdict: string;
    confidence: string;
    confidence_reason?: string;
    macro_theme?: string;
    bull_case?: string[];
    bear_case?: string[];
  };
}

interface RadarFund {
  code: string;
  label: string;
  category: string;
  ret1w?: number; ret1m?: number; ret3m?: number; ret1y?: number;
}

interface MfItem {
  rationale: Rationale;
  fund?: RadarFund;
  ml3m: number | null;
}

export default function MfScreen() {
  const [items,     setItems]     = useState<MfItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [refreshing,setRefreshing]= useState(false);
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set());
  const [filter,    setFilter]    = useState<string>("All");
  const [categories,setCategories]= useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [{ data: rats, error: e1 }, { data: preds }, { data: radar }] = await Promise.all([
        supabase.from("pick_rationales").select("*")
          .order("run_date", { ascending: false }).order("rank").limit(50),
        supabase.from("mf_predictions")
          .select("scheme_code,p_top_quartile_3m,prediction_date")
          .not("p_top_quartile_3m", "is", null)
          .order("prediction_date", { ascending: false }).limit(300),
        supabase.from("radar_cache").select("data").eq("key", "mf_radar").single(),
      ]);
      if (e1) throw new Error(e1.message);

      // Build fund lookup from radar_cache
      const fundMap = new Map<string, RadarFund>();
      const mfData = radar?.data as any;
      if (mfData?.categories) {
        for (const cat of mfData.categories) {
          for (const f of cat.funds ?? []) {
            fundMap.set(String(f.code), { code: String(f.code), label: f.label, category: cat.category ?? f.category, ret1w: f.ret1w, ret1m: f.ret1m, ret3m: f.ret3m, ret1y: f.ret1y });
          }
        }
      }

      const latestPred = new Map<string, number>();
      for (const p of (preds ?? [])) {
        if (!latestPred.has(String(p.scheme_code))) latestPred.set(String(p.scheme_code), p.p_top_quartile_3m);
      }

      const seen = new Set<string>();
      const deduped: Rationale[] = [];
      for (const r of (rats ?? [])) {
        const key = String(r.fund_code);
        if (!seen.has(key)) { seen.add(key); deduped.push(r); }
      }

      const mapped: MfItem[] = deduped.map(r => ({
        rationale: r,
        fund: fundMap.get(String(r.fund_code)),
        ml3m: latestPred.get(String(r.fund_code)) ?? null,
      }));

      const cats = ["All", ...Array.from(new Set(mapped.map(i => i.fund?.category).filter(Boolean) as string[])).sort()];
      setCategories(cats);
      setItems(mapped);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load funds");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (code: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(code) ? s.delete(code) : s.add(code); return s; });

  const filtered = filter === "All" ? items : items.filter(i => i.fund?.category === filter);

  if (loading) return <LoadingView message="Loading fund picks…" />;
  if (error)   return <ErrorView message={error} />;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {/* Category filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chips} contentContainerStyle={styles.chipsInner}>
        {categories.map(cat => (
          <Pressable key={cat} onPress={() => setFilter(cat)}
            style={[styles.chip, filter === cat && styles.chipActive]}>
            <Text style={[styles.chipText, filter === cat && styles.chipTextActive]}>{cat}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <FlatList
        data={filtered}
        keyExtractor={i => String(i.rationale.fund_code)}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.blue} />}
        renderItem={({ item }) => {
          const { rationale: r, fund, ml3m } = item;
          const open = expanded.has(String(r.fund_code));
          const a = r.analysis;
          return (
            <Pressable onPress={() => toggle(String(r.fund_code))} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rank}>#{r.rank}</Text>
                <View style={styles.info}>
                  <Text style={styles.name} numberOfLines={2}>{fund?.label ?? `Fund ${r.fund_code}`}</Text>
                  {fund?.category && <Text style={styles.category}>{fund.category}</Text>}
                </View>
                <View style={styles.right}>
                  <VerdictBadge verdict={a.verdict} small />
                  {ml3m != null && <Text style={styles.ml}>ML {Math.round(ml3m * 100)}%</Text>}
                </View>
              </View>

              {/* Returns row */}
              {fund && (
                <View style={styles.returns}>
                  {[["1W", fund.ret1w], ["1M", fund.ret1m], ["3M", fund.ret3m], ["1Y", fund.ret1y]].map(([l, v]) => (
                    <View key={l as string} style={styles.returnCell}>
                      <Text style={styles.retLabel}>{l}</Text>
                      <PctText value={v as number | null} style={styles.retValue} />
                    </View>
                  ))}
                </View>
              )}

              {open && (
                <View style={styles.detail}>
                  {a.macro_theme && <Text style={styles.theme}>🌐 {a.macro_theme}</Text>}
                  {a.confidence_reason && <Text style={styles.confReason}>💡 {a.confidence_reason}</Text>}
                  {(a.bull_case ?? []).length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionLabel}>Bull case</Text>
                      {a.bull_case!.map((b, i) => <Text key={i} style={styles.bullet}>• {b}</Text>)}
                    </View>
                  )}
                  {(a.bear_case ?? []).length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionLabel}>Bear case</Text>
                      {a.bear_case!.map((b, i) => <Text key={i} style={[styles.bullet, { color: colors.red }]}>• {b}</Text>)}
                    </View>
                  )}
                  <Text style={styles.conf}>Confidence: <Text style={{ color: colors.yellow }}>{a.confidence}</Text></Text>
                </View>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No fund picks for this category.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:         { flex: 1, backgroundColor: colors.bg },
  chips:        { maxHeight: 46, borderBottomWidth: 1, borderBottomColor: colors.border },
  chipsInner:   { paddingHorizontal: 12, paddingVertical: 8, gap: 6, flexDirection: "row", alignItems: "center" },
  chip:         { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  chipActive:   { backgroundColor: "#1e3a5f", borderColor: colors.blue },
  chipText:     { color: colors.textSub, fontSize: 12, fontWeight: "600" },
  chipTextActive:{ color: colors.blue },
  list:         { padding: 12, gap: 8, paddingBottom: 24 },
  card:         { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
  row:          { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  rank:         { color: colors.blue, fontWeight: "700", fontSize: 13, width: 28, paddingTop: 2 },
  info:         { flex: 1, gap: 2 },
  name:         { color: colors.text, fontWeight: "600", fontSize: 13, lineHeight: 18 },
  category:     { color: colors.textMuted, fontSize: 11 },
  right:        { alignItems: "flex-end", gap: 4 },
  ml:           { color: colors.purple, fontSize: 11, fontWeight: "600" },
  returns:      { flexDirection: "row", marginTop: 10, gap: 0, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  returnCell:   { flex: 1, alignItems: "center" },
  retLabel:     { color: colors.textMuted, fontSize: 10 },
  retValue:     { fontSize: 12, fontWeight: "700" },
  detail:       { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 7 },
  theme:        { color: colors.textSub, fontSize: 12, fontStyle: "italic" },
  confReason:   { color: colors.textSub, fontSize: 12 },
  section:      { gap: 3 },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  bullet:       { color: colors.text, fontSize: 12, lineHeight: 18 },
  conf:         { color: colors.textMuted, fontSize: 11 },
  empty:        { color: colors.textMuted, textAlign: "center", marginTop: 60, fontSize: 14 },
});
