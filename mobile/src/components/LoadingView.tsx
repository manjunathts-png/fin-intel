import React from "react";
import { ActivityIndicator, Text, View, StyleSheet } from "react-native";
import { colors } from "../lib/theme";

interface Props { message?: string }

export function LoadingView({ message = "Loading…" }: Props) {
  return (
    <View style={styles.wrap}>
      <ActivityIndicator size="large" color={colors.blue} />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

export function ErrorView({ message }: { message: string }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.errorIcon}>⚠️</Text>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  text:      { color: colors.textSub, fontSize: 14 },
  errorIcon: { fontSize: 32 },
  errorText: { color: colors.red, fontSize: 14, textAlign: "center" },
});
