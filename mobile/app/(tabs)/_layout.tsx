import { Tabs } from "expo-router";
import { colors } from "../../src/lib/theme";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 60,
          paddingBottom: 8,
        },
        tabBarActiveTintColor: colors.blue,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 10, fontWeight: "600" },
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "700", fontSize: 17 },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Stocks", tabBarLabel: "Stocks", tabBarIcon: ({ color }) => <TabIcon emoji="📈" color={color} /> }}
      />
      <Tabs.Screen
        name="mf"
        options={{ title: "Mutual Funds", tabBarLabel: "MF Picks", tabBarIcon: ({ color }) => <TabIcon emoji="📊" color={color} /> }}
      />
      <Tabs.Screen
        name="etf"
        options={{ title: "ETFs", tabBarLabel: "ETFs", tabBarIcon: ({ color }) => <TabIcon emoji="🪙" color={color} /> }}
      />
      <Tabs.Screen
        name="advisor"
        options={{ title: "Persona Advisor", tabBarLabel: "Advisor", tabBarIcon: ({ color }) => <TabIcon emoji="🧭" color={color} /> }}
      />
      <Tabs.Screen
        name="deep-dive"
        options={{ title: "Fund Deep Dive", tabBarLabel: "Deep Dive", tabBarIcon: ({ color }) => <TabIcon emoji="🔍" color={color} /> }}
      />
    </Tabs>
  );
}

function TabIcon({ emoji, color }: { emoji: string; color: string }) {
  const { Text } = require("react-native");
  return <Text style={{ fontSize: 18, opacity: color === colors.blue ? 1 : 0.5 }}>{emoji}</Text>;
}
