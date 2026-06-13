import React from "react";
import { Text, View, StyleSheet } from "react-native";
import { verdictBg, verdictColor } from "../lib/theme";

interface Props { verdict: string; small?: boolean }

export function VerdictBadge({ verdict, small }: Props) {
  const bg  = verdictBg[verdict]  ?? "#1f2937";
  const fg  = verdictColor[verdict] ?? "#9ca3af";
  return (
    <View style={[styles.badge, { backgroundColor: bg }, small && styles.small]}>
      <Text style={[styles.text, { color: fg }, small && styles.smallText]}>
        {verdict}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge:     { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: "flex-start" },
  small:     { paddingHorizontal: 6, paddingVertical: 2 },
  text:      { fontSize: 12, fontWeight: "700" },
  smallText: { fontSize: 10 },
});
