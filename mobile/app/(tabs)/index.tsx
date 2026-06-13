import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { colors } from "../../src/lib/theme";
import { LoadingView, ErrorView } from "../../src/components/LoadingView";
import { VerdictBadge } from "../../src/components/VerdictBadge";
import { PctText } from "../../src/components/PctText";

interface Rationale {
  symbol: string;
  rank: number;
  run_date: string;
  analysis: {
    verdict: string;
    confidence: string;
    confidence_reason: string;
    macro_theme: string;
    bull_case: string[];
    bear_case: string[];
  };
}

interface Prediction {
  symbol: string;
  p_top_quartile_3m: number | null;
  p_top_quartile_1m: number | null;
}

interface StockItem {
  rationale: Rationale;
  ml3m: number | null;
}

export default function StocksScreen() {
  const [items,     setItems]     = useState<StockItem[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [refreshing,setRefreshing]= useState(false);
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [{ data: rats, error: e1 }, { data: preds, error: e2 }] = await Promise.all([
        supabase.from("stock_pick_rationales").select("*")
          .order("run_date", { ascending: false }).order("rank").limit(50),
        supabase.from("stock_predictions")
          .select("symbol,p_top_quartile_3m,p_top_quartile_1m,prediction_date")
          .order("prediction_date", { ascending: false }).limit(500),
      ]);
      if (e1) throw new Error(e1.message);

      const latestPred = new Map<string, Prediction>();
      for (const p of (preds ?? [])) {
        if (!latestPred.has(p.symbol)) latestPred.set(p.symbol, p);
      }

      // Deduplicate rationales — keep latest run per symbol
      const seen = new Set<string>();
      const deduped: Rationale[] = [];
      for (const r of (rats ?? [])) {
        if (!seen.has(r.symbol)) { seen.add(r.symbol); deduped.push(r); }
      }

      setItems(deduped.map(r => ({
        rationale: r,
        ml3m: latestPred.get(r.symbol)?.p_top_quartile_3m ?? null,
      })));
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load stocks");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (symbol: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(symbol) ? s.delete(symbol) : s.add(symbol); return s; });

  if (loading) return <LoadingView message="Loading stock picks…" />;
  if (error)   return <ErrorView message={error} />;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <FlatList
        data={items}
        keyExtractor={i => i.rationale.symbol}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.blue} />}
        renderItem={({ item }) => {
          const { rationale: r, ml3m } = item;
          const open = expanded.has(r.symbol);
          const a = r.analysis;
          return (
            <Pressable onPress={() => toggle(r.symbol)} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rank}>#{r.rank}</Text>
                <View style={styles.info}>
                  <Text style={styles.symbol}>{r.symbol}</Text>
                  {a.macro_theme ? <Text style={styles.theme} numberOfLines={1}>{a.macro_theme}</Text> : null}
                </View>
                <View style={styles.right}>
                  <VerdictBadge verdict={a.verdict} small />
                  {ml3m != null && (
                    <Text style={styles.ml}>ML {Math.round(ml3m * 100)}%</Text>
                  )}
                </View>
              </View>

              {open && (
                <View style={styles.detail}>
                  {a.confidence_reason ? (
                    <Text style={styles.confReason}>💡 {a.confidence_reason}</Text>
                  ) : null}
                  {a.bull_case?.length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionLabel}>Bull case</Text>
                      {a.bull_case.map((b, i) => <Text key={i} style={styles.bullet}>• {b}</Text>)}
                    </View>
                  )}
                  {a.bear_case?.length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionLabel}>Bear case</Text>
                      {a.bear_case.map((b, i) => <Text key={i} style={[styles.bullet, { color: colors.red }]}>• {b}</Text>)}
                    </View>
                  )}
                  <Text style={styles.conf}>Confidence: <Text style={{ color: colors.yellow }}>{a.confidence}</Text></Text>
                </View>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No stock picks available yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: colors.bg },
  list:       { padding: 12, gap: 8, paddingBottom: 24 },
  card:       { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
  row:        { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  rank:       { color: colors.blue, fontWeight: "700", fontSize: 13, width: 28, paddingTop: 1 },
  info:       { flex: 1, gap: 3 },
  symbol:     { color: colors.text, fontWeight: "700", fontSize: 15 },
  theme:      { color: colors.textSub, fontSize: 11 },
  right:      { alignItems: "flex-end", gap: 4 },
  ml:         { color: colors.purple, fontSize: 11, fontWeight: "600" },
  detail:     { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 8 },
  confReason: { color: colors.textSub, fontSize: 12, fontStyle: "italic" },
  section:    { gap: 3 },
  sectionLabel:{ color: colors.textMuted, fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  bullet:     { color: colors.text, fontSize: 12, lineHeight: 18 },
  conf:       { color: colors.textMuted, fontSize: 11 },
  empty:      { color: colors.textMuted, textAlign: "center", marginTop: 60, fontSize: 14 },
});
