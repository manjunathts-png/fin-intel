# Fin Intel — Mobile App

React Native (Expo) app for Android & iOS. Same data as the web app at fin-intel.pages.dev.

## Setup

```bash
cd mobile
npm install

# Copy env file and fill in your Supabase credentials
cp .env.example .env
```

Your `.env`:
```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

These are the same values as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in the web app's `.env`.

## Run

```bash
# Expo Go (fastest — install Expo Go from App Store / Play Store)
npm start          # scan QR with Expo Go

# Simulators (requires Xcode / Android Studio)
npm run ios
npm run android
```

## Build for production

Install EAS CLI and log in:
```bash
npm install -g eas-cli
eas login
eas build --platform android   # APK / AAB
eas build --platform ios       # IPA (requires Apple Developer account)
```

## Screens

| Tab | What it shows |
|-----|--------------|
| 📈 Stocks | Top-50 stock picks — rank, verdict, ML probability, bull/bear case |
| 📊 MF Picks | Top mutual fund picks by category — returns, verdict, ML score |
| 🪙 ETFs | 30 curated ETFs across 6 types — returns, TER, liquidity, premium |
| 🧭 Advisor | Persona-based portfolio builder — 5 profiles, corpus input, fund+stock picks |
| 🔍 Deep Dive | Fund NAV history — rolling 1Y/3Y/5Y returns, Sharpe, Calmar, max drawdown |

## Architecture

```
mobile/
  app/
    _layout.tsx          Root layout (SafeAreaProvider, StatusBar)
    (tabs)/
      _layout.tsx        Bottom tab bar
      index.tsx          Stocks screen
      mf.tsx             Mutual Funds screen
      etf.tsx            ETF screen
      advisor.tsx        Persona Advisor screen
      deep-dive.tsx      Fund Deep Dive screen
  src/
    lib/
      supabase.ts        Supabase client (AsyncStorage session)
      theme.ts           Color palette + verdict colors
    components/
      VerdictBadge.tsx   Colored Strong Buy / Buy / Hold / Avoid badge
      PctText.tsx        Green/red +/-% text
      LoadingView.tsx    Spinner + error views
```

Data source: same Supabase tables as the web app (anon key, read-only).
Deep Dive NAV history fetches directly from `api.mfapi.in` (same as web).
