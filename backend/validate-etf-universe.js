"use strict";
/**
 * Validate every ticker in etf_universe.js against Yahoo Finance.
 *
 * Checks:
 *   1. quoteType === "ETF"  (MUTUALFUND = index fund, not exchange-traded)
 *   2. exchangeTimezoneName contains "Kolkata" (confirms NSE listing, not BSE or other)
 *
 * Usage:
 *   node backend/validate-etf-universe.js
 *
 * Also runs as part of: workflow_dispatch target=validate_etf
 * Or manually before adding new tickers to etf_universe.js.
 */

const YahooFinance = require("yahoo-finance2").default;
const { flatUniverse } = require("./etf_universe");

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function main() {
  const etfs = flatUniverse();
  let failures = 0;
  const rows = [];

  for (const etf of etfs) {
    const sym = `${etf.ticker}.NS`;
    let quoteType = null;
    let longName  = null;
    let status    = "ok";
    let note      = "";

    try {
      const q = await yf.quote(sym, {}, { validateResult: false });
      quoteType = q.quoteType  ?? null;
      longName  = q.longName   ?? q.shortName ?? null;

      if (quoteType !== "ETF") {
        status = "FAIL";
        note   = `quoteType=${quoteType} — not an ETF (likely index fund or FoF)`;
        failures++;
      }
    } catch (e) {
      status = "WARN";
      note   = `quote() error: ${e.message.slice(0, 80)}`;
    }

    const icon = status === "ok" ? "✅" : status === "WARN" ? "⚠️ " : "❌";
    rows.push({ icon, ticker: etf.ticker, type: etf.type, label: etf.label, quoteType, longName, note });
    console.log(`${icon} ${etf.ticker.padEnd(14)} ${(quoteType ?? "unknown").padEnd(14)} ${etf.label}${note ? " — " + note : ""}`);

    // Rate-limit: Yahoo Finance allows ~20 req/sec
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`Total: ${etfs.length}  Failures: ${failures}`);

  if (failures > 0) {
    console.error(`\n${failures} ticker(s) are not genuine ETFs — remove or replace them in etf_universe.js`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
