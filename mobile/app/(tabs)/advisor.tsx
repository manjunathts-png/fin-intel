import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { supabase } from "../../src/lib/supabase";
import { colors } from "../../src/lib/theme";
import { LoadingView, ErrorView } from "../../src/components/LoadingView";
import { VerdictBadge } from "../../src/components/VerdictBadge";

const PERSONAS = [
  { id: "aggressive",   label: "Aggressive 🚀",  color: "#ef4444", minScore: 60,
    desc: "Max growth, high risk. SmallCap 35%, MidCap 25%, Stocks 20%, Gold 5%." },
  { id: "growth",       label: "Growth 📈",       color: "#f97316", minScore: 55,
    desc: "Growth with moderate risk. MidCap 35%, LargeCap 20%, Stocks 20%." },
  { id: "balanced",     label: "Balanced ⚖️",     color: "#eab308", minScore: 50,
    desc: "Balanced risk/return. LargeCap 30%, MidCap 20%, Debt 20%, Stocks 15%." },
  { id: "conservative", label: "Conservative 🛡️", color: "#22c55e", minScore: 45,
    desc: "Capital preservation. Debt 40%, LargeCap 25%, Gold 15%." },
  { id: "dividend",     label: "Dividend 💰",     color: "#06b6d4", minScore: 45,
    desc: "Income focused. Dividend funds 40%, Conservative equity 30%." },
];

const ALLOCATION: Record<string, { mf: number; stocks: number; debt: number; gold: number }> = {
  aggressive:   { mf: 60, stocks: 20, debt: 5,  gold: 5 },
  growth:       { mf: 55, stocks: 20, debt: 15, gold: 5 },
  balanced:     { mf: 50, stocks: 15, debt: 20, gold: 10 },
  conservative: { mf: 35, stocks: 10, debt: 40, gold: 15 },
  dividend:     { mf: 70, stocks: 15, debt: 10, gold: 5 },
};

function fmtCr(n: number) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export default function AdvisorScreen() {
  const [persona, setPersona] = useState("balanced");
  const [corpus,  setCorpus]  = useState("1000000");
  const [funds,   setFunds]   = useState<any[]>([]);
  const [stocks,  setStocks]  = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ data: mfRadar }, { data: stockRats }] = await Promise.all([
        supabase.from("radar_cache").select("data").eq("key", "mf_radar").single(),
        supabase.from("stock_pick_rationales").select("symbol,rank,analysis")
          .order("run_date", { ascending: false }).order("rank").limit(50),
      ]);

      // Build fund list from radar_cache
      const mfData = mfRadar?.data as any;
      const allFunds: any[] = [];
      if (mfData?.categories) {
        for (const cat of mfData.categories) {
          const best = [...(cat.funds ?? [])].sort((a: any, b: any) => (b.ret3m ?? 0) - (a.ret3m ?? 0))[0];
          if (best && (cat.median?.z1w ?? 0) >= -0.5) {
            allFunds.push({ ...best, category: cat.category ?? cat.name });
          }
        }
      }
      setFunds(allFunds);

      const seenSymbols = new Set<string>();
      const deduped: any[] = [];
      for (const r of (stockRats ?? [])) {
        if (!seenSymbols.has(r.symbol)) { seenSymbols.add(r.symbol); deduped.push(r); }
      }
      setStocks(deduped);
      setError(null);
    } catch (err: any) {
      setError(err.message ?? "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const p = PERSONAS.find(x => x.id === persona)!;
  const alloc = ALLOCATION[persona];
  const corpusNum = Math.max(0, parseFloat(corpus.replace(/,/g, "")) || 0);

  const topFunds  = funds.slice(0, 5);
  const minScore  = p.minScore;
  const topStocks = stocks.filter(s => s.analysis?.verdict === "Strong Buy" || s.analysis?.verdict === "Buy").slice(0, 5);

  if (loading) return <LoadingView message="Building your portfolio…" />;
  if (error)   return <ErrorView message={error} />;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Persona selector */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Select your investor profile</Text>
          <View style={styles.personaGrid}>
            {PERSONAS.map(px => (
              <Pressable key={px.id} onPress={() => setPersona(px.id)}
                style={[styles.personaBtn, persona === px.id && { borderColor: px.color, backgroundColor: px.color + "22" }]}>
                <Text style={[styles.personaBtnText, persona === px.id && { color: px.color }]}>{px.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.personaDesc}>{p.desc}</Text>
        </View>

        {/* Corpus input */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Investment corpus (₹)</Text>
          <TextInput
            style={styles.input}
            value={corpus}
            onChangeText={setCorpus}
            keyboardType="numeric"
            placeholder="e.g. 1000000"
            placeholderTextColor={colors.textMuted}
          />
          {corpusNum > 0 && <Text style={styles.corpusHint}>= {fmtCr(corpusNum)}</Text>}
        </View>

        {/* Allocation breakdown */}
        {corpusNum > 0 && (
          <View style={[styles.section, styles.allocCard]}>
            <Text style={styles.sectionLabel}>Suggested allocation</Text>
            {[
              ["Mutual Funds", alloc.mf, colors.blue],
              ["Direct Stocks", alloc.stocks, colors.green],
              ["Debt / FD", alloc.debt, colors.yellow],
              ["Gold ETF", alloc.gold, colors.teal ?? "#2dd4bf"],
            ].map(([label, pct, color]) => (
              <View key={label as string} style={styles.allocRow}>
                <Text style={styles.allocLabel}>{label as string} ({pct as number}%)</Text>
                <Text style={[styles.allocAmt, { color: color as string }]}>{fmtCr(corpusNum * (pct as number) / 100)}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Top fund picks */}
        {topFunds.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Top fund picks for you</Text>
            <View style={styles.pickList}>
              {topFunds.map((f, i) => (
                <View key={f.code ?? i} style={styles.pickCard}>
                  <Text style={styles.pickRank}>#{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName} numberOfLines={2}>{f.label}</Text>
                    <Text style={styles.pickSub}>{f.category}</Text>
                  </View>
                  {corpusNum > 0 && (
                    <Text style={styles.pickAlloc}>{fmtCr(corpusNum * alloc.mf / 100 / topFunds.length)}</Text>
                  )}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Top stock picks */}
        {topStocks.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Top stock picks for you</Text>
            <View style={styles.pickList}>
              {topStocks.map((s, i) => (
                <View key={s.symbol} style={styles.pickCard}>
                  <Text style={styles.pickRank}>#{s.rank}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickName}>{s.symbol}</Text>
                  </View>
                  <VerdictBadge verdict={s.analysis?.verdict ?? "Hold"} small />
                  {corpusNum > 0 && (
                    <Text style={styles.pickAlloc}>{fmtCr(corpusNum * alloc.stocks / 100 / topStocks.length)}</Text>
                  )}
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const teal = "#2dd4bf";
const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: colors.bg },
  scroll:        { padding: 16, gap: 4, paddingBottom: 32 },
  section:       { marginBottom: 20 },
  sectionLabel:  { color: colors.textMuted, fontSize: 11, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  personaGrid:   { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  personaBtn:    { borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  personaBtnText:{ color: colors.textSub, fontSize: 13, fontWeight: "600" },
  personaDesc:   { marginTop: 10, color: colors.textSub, fontSize: 12, lineHeight: 18 },
  input:         { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: colors.text, fontSize: 16 },
  corpusHint:    { marginTop: 5, color: colors.textMuted, fontSize: 12 },
  allocCard:     { backgroundColor: colors.card, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.border },
  allocRow:      { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  allocLabel:    { color: colors.textSub, fontSize: 13 },
  allocAmt:      { fontWeight: "700", fontSize: 14 },
  pickList:      { gap: 6 },
  pickCard:      { flexDirection: "row", alignItems: "center", backgroundColor: colors.card, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: colors.border, gap: 8 },
  pickRank:      { color: colors.blue, fontWeight: "700", fontSize: 12, width: 24 },
  pickName:      { color: colors.text, fontWeight: "600", fontSize: 13, lineHeight: 17 },
  pickSub:       { color: colors.textMuted, fontSize: 11, marginTop: 1 },
  pickAlloc:     { color: colors.green, fontWeight: "700", fontSize: 12 },
});
