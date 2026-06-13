import React from "react";
import { Text, TextStyle } from "react-native";
import { colors } from "../lib/theme";

interface Props { value: number | null | undefined; digits?: number; style?: TextStyle }

export function PctText({ value, digits = 1, style }: Props) {
  if (value == null) return <Text style={[{ color: colors.textMuted }, style]}>—</Text>;
  const color = value >= 0 ? colors.green : colors.red;
  return (
    <Text style={[{ color, fontVariant: ["tabular-nums"] }, style]}>
      {value >= 0 ? "+" : ""}{value.toFixed(digits)}%
    </Text>
  );
}
