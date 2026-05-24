import { Link } from "react-router-dom";

// ─── Metric definitions ───────────────────────────────────────────────────────

const METRICS = [
  {
    group: "Returns & CAGR",
    color: "border-blue-800/50 bg-blue-900/10",
    headerColor: "text-blue-400",
    items: [
      {
        term: "1W / 1M / 3M / 6M / 1Y Returns",
        short: "Price change over that window",
        detail: "The percentage gain or loss of the fund's NAV (or stock price) over the past 1 week, 1 month, 3 months, 6 months, or 1 year. Raw returns — not annualised. Short-term windows (1W, 1M) capture recent momentum; longer windows (3M–1Y) filter out noise.",
        good: "+3% 1M = fund outperformed most peers last month",
        bad:  "−5% 1M on a fund with 5Y CAGR of +18% can be a buying opportunity, not a red flag",
      },
      {
        term: "CAGR (Compound Annual Growth Rate)",
        short: "Annualised growth rate over multiple years",
        detail: "CAGR tells you the steady annual return that would produce the same outcome as the actual (lumpy) performance. A 3Y CAGR of +15% means the fund grew at 15% per year, compounded, over the last 3 years. Better than comparing absolute returns across different time horizons.",
        good: "Equity CAGR ≥ 12% over 5Y is considered solid in the Indian market",
        bad:  "CAGR hides volatility — a fund could have gone up 50% then down 20% and still report a decent CAGR",
      },
    ],
  },
  {
    group: "Risk Metrics",
    color: "border-purple-800/50 bg-purple-900/10",
    headerColor: "text-purple-400",
    items: [
      {
        term: "Sharpe Ratio",
        short: "Return per unit of total risk",
        detail: "Sharpe = (Fund CAGR − Risk-free rate) ÷ Volatility. We use 7% as the risk-free rate (approximate Indian 10Y g-sec yield). A Sharpe of 1.0 means you earned 1% extra return for every 1% of standard deviation you took. The higher the better.",
        good: "≥ 1.5 = excellent (strong return per unit of risk)",
        bad:  "< 0.5 = poor (you're taking a lot of risk for not much reward)",
      },
      {
        term: "Sortino Ratio",
        short: "Return per unit of downside risk only",
        detail: "Like Sharpe but only penalises downside volatility (months when the fund lost money). Upward swings are not counted against you. Useful for funds with asymmetric return profiles (lots of small gains, rare large losses).",
        good: "> 1.5 = excellent; better than Sharpe when the fund has high upside volatility",
        bad:  "A fund can have a great Sortino but a poor Sharpe if it has volatile upswings",
      },
      {
        term: "Calmar Ratio",
        short: "Annual return ÷ max drawdown",
        detail: "Calmar = CAGR ÷ |Max Drawdown|. If a fund returned +18% per year but fell −30% at its worst, Calmar = 0.60. It tells you how much return you get per unit of the worst pain you'd have endured as an investor.",
        good: "> 0.5 is solid; > 1.0 is exceptional",
        bad:  "Low Calmar means the fund's best years aren't worth its worst crash",
      },
      {
        term: "Max Drawdown (Max DD)",
        short: "Worst peak-to-trough decline over 5 years",
        detail: "The largest percentage drop from a high to a subsequent low. A Max DD of −35% means an investor who bought at the peak and held would have been down 35% at the worst point. Lower (less negative) is better.",
        good: "−10% to −15% = well-controlled drawdown for an equity fund",
        bad:  "−50% or worse = you'd need a +100% recovery just to break even",
      },
      {
        term: "Volatility (σ)",
        short: "Annualised standard deviation of monthly returns",
        detail: "Measures how much the fund's monthly returns fluctuate around their average. High volatility means wide swings — stomach-churning but also bigger upside. Low volatility means steadier (but often lower) returns.",
        good: "< 15% annualised = relatively stable for an equity fund",
        bad:  "> 25% annualised = high volatility; only suitable for high risk tolerance",
      },
      {
        term: "Consistency",
        short: "% of rolling 12-month periods that delivered ≥ 12% CAGR",
        detail: "We take every possible rolling 1-year window over the fund's history and count how many delivered ≥ 12% CAGR. 80% consistency means that in 8 out of 10 random one-year holds, you'd have earned at least 12%. Distinguishes genuine compounders from lucky timing.",
        good: "≥ 80% = highly consistent compounder",
        bad:  "< 40% = mostly timing-dependent; hard to rely on",
      },
    ],
  },
  {
    group: "Alpha & Benchmarks",
    color: "border-green-800/50 bg-green-900/10",
    headerColor: "text-green-400",
    items: [
      {
        term: "Alpha (α 5Y)",
        short: "Excess return over the benchmark index, 5-year annualised",
        detail: "Alpha = Fund 5Y CAGR − Benchmark 5Y CAGR. If the fund earned +16%/yr and its benchmark (e.g., Nifty Midcap 150) earned +13%/yr, alpha = +3 percentage points (pp). Positive alpha means the fund manager added value beyond just riding the market.",
        good: "≥ +3pp = meaningful alpha; fund is genuinely beating the market",
        bad:  "Negative alpha = index fund would have done better (and with lower fees)",
      },
      {
        term: "Z-Score (Momentum)",
        short: "How hot/cold this week's return is vs the trailing 90-day average",
        detail: "Z-Score = (this week's return − mean of trailing 90 weekly returns) ÷ standard deviation. A z-score of +2 means this week's return was 2 standard deviations above the 90-day average — abnormally strong momentum. Used to detect unusual accelerations or decelerations.",
        good: "≥ +1.5 = 🔥 Hot (unusual upswing); worth attention",
        bad:  "≤ −1.5 = ❄ Cold (unusual weakness); may be a stress signal",
      },
    ],
  },
  {
    group: "Stock Signals",
    color: "border-amber-800/50 bg-amber-900/10",
    headerColor: "text-amber-400",
    items: [
      {
        term: "Composite Score",
        short: "0–100 signal strength score for each stock",
        detail: "Our proprietary score combining 15+ signals: momentum (1W/1M/3M returns), relative strength vs Nifty, volume breakouts, technical patterns (Golden Cross, MACD, RSI), institutional activity (block/bulk deals, OI buildup), and 52-week high proximity. Higher = more signals firing simultaneously.",
        good: "≥ 60 = Strong Buy territory (multiple confirming signals)",
        bad:  "< 25 = few signals; more speculative",
      },
      {
        term: "RS vs Nifty (Relative Strength)",
        short: "Stock return minus Nifty return over the same window",
        detail: "RS 1M = stock's 1-month return minus Nifty 50's 1-month return. If the stock rose +12% and Nifty rose +5%, RS 1M = +7 percentage points. Positive RS means the stock is outperforming the broad market — the single most important filter for momentum investing.",
        good: "≥ +5pp over 1M or ≥ +10pp over 3M = genuine outperformance",
        bad:  "Negative RS in a rising market = the stock is underperforming even when the tide is high",
      },
      {
        term: "RSI (Relative Strength Index)",
        short: "Momentum oscillator measuring speed of price change (0–100)",
        detail: "RSI measures how fast a stock has risen or fallen over the last 14 trading days. Above 70 = overbought (may pull back). Below 30 = oversold (potential bounce setup). The number doesn't mean buy or sell by itself — it's best used with other signals.",
        good: "30–40 RSI with strong fundamentals = potential mean-reversion buy",
        bad:  "RSI > 80 on its own is not a sell signal — some trending stocks stay overbought for months",
      },
      {
        term: "Golden Cross",
        short: "50-day MA just crossed above 200-day MA",
        detail: "A Golden Cross fires when the 50-day moving average (short-term trend) crosses above the 200-day moving average (long-term trend) within the last 5 sessions. Widely watched as a bullish trend-change signal. The opposite (Death Cross) is bearish.",
        good: "Strong confirmation signal when combined with rising volume and positive RS",
        bad:  "Can produce false signals in sideways/choppy markets",
      },
      {
        term: "Volume Shock",
        short: "Today's volume ≥ 2× the 20-day average",
        detail: "Unusually high trading volume often precedes or confirms a directional move. A volume shock means at least twice the normal shares changed hands — this can indicate institutional accumulation, news-driven activity, or the start of a breakout.",
        good: "Volume shock + price breakout = high-conviction entry signal",
        bad:  "Volume shock without price movement = churn (buy and sell cancel out)",
      },
      {
        term: "Block / Bulk Deal",
        short: "Large institutional trade on exchange",
        detail: "Block deal: a single trade of ≥ ₹10 crore executed in a separate trading window. Bulk deal: a trade representing ≥ 0.5% of total equity in a session. Both signal that a large institutional player (MF, FII, HNI) is building or exiting a meaningful stake.",
        good: "Block BUY = direct institutional accumulation at current market price",
        bad:  "Block SELL = an institution is exiting — worth understanding their reason",
      },
    ],
  },
];

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({ item }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 space-y-2">
      <div>
        <h3 className="font-semibold text-gray-100">{item.term}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{item.short}</p>
      </div>
      <p className="text-xs text-gray-300 leading-relaxed">{item.detail}</p>
      <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
        <div className="rounded-lg bg-green-900/20 border border-green-800/30 px-3 py-2">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-500">✓ Good signal</div>
          <p className="text-[11px] text-green-300/80 leading-relaxed">{item.good}</p>
        </div>
        <div className="rounded-lg bg-amber-900/20 border border-amber-800/30 px-3 py-2">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-500">⚠ Watch out</div>
          <p className="text-[11px] text-amber-300/80 leading-relaxed">{item.bad}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Glossary() {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Metric Glossary</h1>
          <span className="rounded-full bg-blue-900/30 border border-blue-800/40 px-3 py-0.5 text-xs font-semibold text-blue-400">
            Plain English
          </span>
        </div>
        <p className="mt-2 text-sm text-gray-400 leading-relaxed">
          Every metric used in Fin Intel — what it means, how to read the numbers, and when to pay attention.
          These are analytical signals, not financial advice.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {METRICS.map((g) => (
            <a
              key={g.group}
              href={`#${g.group.replace(/\s+/g, "-")}`}
              className="rounded-full border border-gray-700 bg-gray-800 px-3 py-1 text-xs text-gray-300 hover:bg-gray-700 hover:text-white transition"
            >
              {g.group}
            </a>
          ))}
        </div>
      </div>

      {/* Metric groups */}
      {METRICS.map((g) => (
        <section key={g.group} id={g.group.replace(/\s+/g, "-")}>
          <div className={`mb-4 rounded-xl border p-3 ${g.color}`}>
            <h2 className={`text-sm font-bold uppercase tracking-wider ${g.headerColor}`}>{g.group}</h2>
          </div>
          <div className="space-y-3">
            {g.items.map((item) => (
              <MetricCard key={item.term} item={item} />
            ))}
          </div>
        </section>
      ))}

      {/* Footer */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-2">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-400">Data sources:</strong> MF NAV data from AMFI NAVAll.txt + mfapi.in.
          Stock price / technical data from NSE via Yahoo Finance. Institutional trades (bulk/block) from NSE bhavcopy.
          F&O OI data from NSE intraday feeds. All signals are computed by the Fin Intel backend and cached in Supabase.
        </p>
        <p className="text-[10px] text-gray-700">
          Not financial advice. Past performance does not guarantee future returns.
          Signals are momentum-based and may not account for fundamental deterioration.
        </p>
        <Link to="/mf/picks" className="text-xs text-blue-400 hover:text-blue-300 transition">
          ← Back to MF Picks
        </Link>
      </div>
    </div>
  );
}
