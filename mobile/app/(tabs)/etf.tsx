import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { colors } from "../../src/lib/theme";
import { LoadingView, ErrorView } from "../../src/components/LoadingView";
import { PctText } from "../../src/components/PctText";

interface Etf {
  ticker: string;
  name: string;
  type: string;
  ret1w?: number; ret1m?: number; ret3m?: number; ret1y?: number;
  liquidityFlag?: string;
  ter?: number;
  premiumPct?: number;
  score?: number;
}

interface EtfGroup { typeName: string; etfs: Etf[] }

const LIQUIDITY_COLOR: Record<string, string> = {
  ok:   colors.green,
  small: colors.yellow,
  thin: "#fb923c",
  tiny: colors.red,
};

export default function EtfScreen() {
  const [groups,    setGroups]    = useState<EtfGroup[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [refreshing,setRefreshing]= useState(false);
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { data, error: e } = await supabase.from("radar_cache").select("data").eq("key", "etf_picks").single();
      if (e) throw new Error(e.message);
      const raw = data?.data as any;
      setGroups(raw?.types ?? []);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load ETFs");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (ticker: string) =>
    setExpanded(prev => { const s = new Set(prev); s.has(ticker) ? s.delete(ticker) : s.add(ticker); return s; });

  if (loading) return <LoadingView message="Loading ETFs…" />;
  if (error)   return <ErrorView message={error} />;

  const flatItems: Array<{ type: "header"; typeName: string } | { type: "etf"; etf: Etf }> = [];
  for (const g of groups) {
    flatItems.push({ type: "header", typeName: g.typeName });
    for (const e of g.etfs) flatItems.push({ type: "etf", etf: e });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <FlatList
        data={flatItems}
        keyExtractor={(item, i) => item.type === "header" ? `h-${item.typeName}` : `e-${item.etf.ticker}-${i}`}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.blue} />}
        renderItem={({ item }) => {
          if (item.type === "header") {
            return <Text style={styles.groupHeader}>{item.typeName}</Text>;
          }
          const { etf } = item;
          const open = expanded.has(etf.ticker);
          const liqColor = LIQUIDITY_COLOR[etf.liquidityFlag ?? "ok"] ?? colors.textMuted;
          const premium = etf.premiumPct;
          return (
            <Pressable onPress={() => toggle(etf.ticker)} style={styles.card}>
              <View style={styles.row}>
                <View style={styles.info}>
                  <View style={styles.nameRow}>
                    <Text style={styles.ticker}>{etf.ticker}</Text>
                    {etf.liquidityFlag && etf.liquidityFlag !== "ok" && (
                      <Text style={[styles.liqBadge, { color: liqColor }]}>{etf.liquidityFlag}</Text>
                    )}
                    {premium != null && Math.abs(premium) > 1 && (
                      <Text style={[styles.premiumBadge, { color: premium > 0 ? colors.red : colors.green }]}>
                        {premium > 0 ? "+" : ""}{premium.toFixed(1)}% {premium > 0 ? "prem" : "disc"}
                      </Text>
                    )}
                  </View>
                  <Text style={styles.etfName} numberOfLines={1}>{etf.name}</Text>
                </View>
                <PctText value={etf.ret1m} style={styles.ret1m} digits={1} />
              </View>

              <View style={styles.returns}>
                {[["1W", etf.ret1w], ["1M", etf.ret1m], ["3M", etf.ret3m], ["1Y", etf.ret1y]].map(([l, v]) => (
                  <View key={l as string} style={styles.returnCell}>
                    <Text style={styles.retLabel}>{l}</Text>
                    <PctText value={v as number | null} style={styles.retValue} />
                  </View>
                ))}
              </View>

              {open && etf.ter != null && (
                <View style={styles.detail}>
                  <Text style={styles.detailText}>
                    TER: <Text style={{ color: etf.ter < 0.2 ? colors.green : etf.ter > 1 ? colors.red : colors.yellow }}>{etf.ter.toFixed(2)}%</Text>
                    {etf.ter < 0.2 ? "  (low cost ✓)" : etf.ter > 1 ? "  (expensive)" : ""}
                  </Text>
                  {premium != null && (
                    <Text style={styles.detailText}>
                      NAV premium/discount: <PctText value={premium} style={{ fontSize: 13 }} />
                      {Math.abs(premium) > 1 ? (premium > 0 ? "  — trading above NAV" : "  — discount opportunity") : "  — fair value"}
                    </Text>
                  )}
                  <Text style={styles.detailText}>Type: {etf.type}</Text>
                </View>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={styles.empty}>No ETF data available yet.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: colors.bg },
  list:        { padding: 12, gap: 6, paddingBottom: 24 },
  groupHeader: { color: colors.blue, fontWeight: "700", fontSize: 13, marginTop: 10, marginBottom: 2, paddingHorizontal: 2, textTransform: "uppercase", letterSpacing: 0.5 },
  card:        { backgroundColor: colors.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: colors.border },
  row:         { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  info:        { flex: 1, gap: 2 },
  nameRow:     { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  ticker:      { color: colors.text, fontWeight: "700", fontSize: 14 },
  liqBadge:    { fontSize: 10, fontWeight: "600" },
  premiumBadge:{ fontSize: 10, fontWeight: "600" },
  etfName:     { color: colors.textSub, fontSize: 11 },
  ret1m:       { fontWeight: "700", fontSize: 15, paddingLeft: 8 },
  returns:     { flexDirection: "row", marginTop: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 7 },
  returnCell:  { flex: 1, alignItems: "center" },
  retLabel:    { color: colors.textMuted, fontSize: 10 },
  retValue:    { fontSize: 12, fontWeight: "700" },
  detail:      { marginTop: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, gap: 5 },
  detailText:  { color: colors.textSub, fontSize: 12, flexDirection: "row" },
  empty:       { color: colors.textMuted, textAlign: "center", marginTop: 60, fontSize: 14 },
});
