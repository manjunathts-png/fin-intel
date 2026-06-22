"use strict";

/**
 * Curated NSE-listed ETF universe.
 *
 * Each entry:
 *   code      — AMFI scheme code (for mfapi.in NAV/premium-discount). null = NAV
 *               fetch disabled; momentum still scored via Yahoo Finance price.
 *   ticker    — NSE ticker (required; used for yahoo-finance2 with .NS suffix).
 *   label     — Display name.
 *   aumCr     — Approx AUM in ₹ crore (hand-curated, refresh periodically).
 *   ter       — Total Expense Ratio %.
 *   benchmark — What the ETF tracks.
 *
 * AMFI code guidance:
 *   Only assign code when you have verified it from amfiindia.com/spages/NAVAll.txt.
 *   Many MF fund-of-fund and index-fund codes share names with ETFs but are NOT
 *   the same AMFI scheme — using the wrong code silently fetches wrong NAV history.
 *   When in doubt, leave code: null (Yahoo Finance price data is sufficient for
 *   momentum scoring; only premium/discount needs the correct AMFI ETF code).
 *
 * Find NSE tickers: https://www.nseindia.com/market-data/exchange-traded-funds-etf
 * Find AMFI codes:  https://www.amfiindia.com/spages/NAVAll.txt  (search "Exchange Traded")
 */

module.exports.ETF_TYPES = {
  // ─── EQUITY — BROAD ───────────────────────────────────────────────────────
  "Equity — Broad": [
    // Verified AMFI codes: only the pre-2010 Nippon BeES ETFs
    { code: "102885", ticker: "NIFTYBEES",   label: "Nippon Nifty 50 BeES",        aumCr: 39000, ter: 0.04, benchmark: "Nifty 50" },
    { code: "102934", ticker: "JUNIORBEES",  label: "Nippon Nifty Next 50 BeES",   aumCr: 6500,  ter: 0.15, benchmark: "Nifty Next 50" },
    { code: null,     ticker: "MIDCAPIETF",  label: "ICICI Pru Midcap 150 ETF",    aumCr: 600,   ter: 0.15, benchmark: "Nifty Midcap 150" },
    { code: null,     ticker: "NIF100IETF",  label: "ICICI Pru Nifty 100 ETF",     aumCr: 1500,  ter: 0.07, benchmark: "Nifty 100" },
    { code: null,     ticker: "IVZINNIFTY",  label: "Invesco India Nifty 100 ETF", aumCr: 700,   ter: 0.15, benchmark: "Nifty 100" },
    { code: null,     ticker: "UTINIFTETF",  label: "UTI Nifty 50 ETF",            aumCr: 5000,  ter: 0.06, benchmark: "Nifty 50" },
  ],

  // ─── EQUITY — SECTOR ──────────────────────────────────────────────────────
  "Equity — Sector": [
    // Verified AMFI code: Nippon Bank BeES (pre-2010)
    { code: "102883", ticker: "BANKBEES",    label: "Nippon Nifty Bank BeES",      aumCr: 9500,  ter: 0.19, benchmark: "Nifty Bank" },
    { code: null,     ticker: "ITBEES",      label: "Nippon Nifty IT BeES",        aumCr: 1100,  ter: 0.22, benchmark: "Nifty IT" },
    { code: null,     ticker: "PHARMABEES",  label: "Nippon Nifty Pharma BeES",    aumCr: 700,   ter: 0.20, benchmark: "Nifty Pharma" },
    { code: null,     ticker: "PSUBNKBEES",  label: "Nippon Nifty PSU Bank BeES",  aumCr: 1900,  ter: 0.49, benchmark: "Nifty PSU Bank" },
    { code: null,     ticker: "AUTOBEES",    label: "Nippon Nifty Auto BeES",      aumCr: 400,   ter: 0.20, benchmark: "Nifty Auto" },
    { code: null,     ticker: "FMCGIETF",    label: "Nippon Nifty FMCG ETF",       aumCr: 300,   ter: 0.21, benchmark: "Nifty FMCG" },
    { code: null,     ticker: "INFRABEES",   label: "Nippon Nifty Infra BeES",     aumCr: 350,   ter: 0.20, benchmark: "Nifty Infra" },
    { code: null,     ticker: "CONSUMBEES",  label: "Nippon Nifty Consumption",    aumCr: 250,   ter: 0.30, benchmark: "Nifty Consumption" },
    { code: null,     ticker: "DEFENCEIETF", label: "ICICI Pru Nifty India Defence ETF", aumCr: 1500, ter: 0.45, benchmark: "Nifty India Defence" },
    { code: null,     ticker: "HDFCDEF",     label: "HDFC Nifty India Defence ETF",aumCr: 500,   ter: 0.40, benchmark: "Nifty India Defence" },
  ],

  // ─── EQUITY — SMART BETA ──────────────────────────────────────────────────
  "Equity — Smart Beta": [
    { code: null, ticker: "MOMOMENTUM",  label: "Motilal Nifty 200 Momentum 30", aumCr: 4500, ter: 0.30, benchmark: "Nifty 200 Momentum 30" },
    { code: null, ticker: "LOWVOL1",     label: "ICICI Pru Nifty Low Vol 30",    aumCr: 1200, ter: 0.41, benchmark: "Nifty 100 Low Vol 30" },
    { code: null, ticker: "ALPHAETF",    label: "Nippon Nifty Alpha 50",         aumCr: 1100, ter: 0.40, benchmark: "Nifty Alpha 50" },
    { code: null, ticker: "QUAL30IETF",  label: "ICICI Pru Nifty 100 Quality 30",aumCr: 200,  ter: 0.40, benchmark: "Nifty 100 Quality 30" },
    { code: null, ticker: "NV20IETF",    label: "ICICI Pru NV20 ETF",            aumCr: 900,  ter: 0.18, benchmark: "Nifty 50 Value 20" },
    { code: null, ticker: "MOVALUE",     label: "Motilal Oswal Value ETF",       aumCr: 300,  ter: 0.35, benchmark: "Nifty 500 Value 50" },
    { code: null, ticker: "NIFTYQLITY",  label: "ICICI Pru Nifty Quality ETF",   aumCr: 500,  ter: 0.35, benchmark: "Nifty 200 Quality 30" },
  ],

  // ─── COMMODITY — GOLD ─────────────────────────────────────────────────────
  "Commodity — Gold": [
    { code: null, ticker: "GOLDBEES",    label: "Nippon India Gold BeES",      aumCr: 11500, ter: 0.79, benchmark: "Domestic Gold Price" },
    { code: null, ticker: "HDFCGOLD",    label: "HDFC Gold ETF",               aumCr: 4800,  ter: 0.59, benchmark: "Domestic Gold Price" },
    { code: null, ticker: "KOTAKGOLD",   label: "Kotak Gold ETF",              aumCr: 3500,  ter: 0.55, benchmark: "Domestic Gold Price" },
    { code: null, ticker: "AXISGOLD",    label: "Axis Gold ETF",               aumCr: 700,   ter: 0.56, benchmark: "Domestic Gold Price" },
    { code: null, ticker: "ICICIGOLD",   label: "ICICI Pru Gold ETF",          aumCr: 2000,  ter: 0.50, benchmark: "Domestic Gold Price" },
    { code: null, ticker: "SBIGOLD",     label: "SBI Gold ETF",                aumCr: 1200,  ter: 0.56, benchmark: "Domestic Gold Price" },
  ],

  // ─── COMMODITY — SILVER ───────────────────────────────────────────────────
  "Commodity — Silver": [
    { code: null, ticker: "SILVERBEES",  label: "Nippon Silver ETF",           aumCr: 1700, ter: 0.50, benchmark: "Domestic Silver Price" },
    { code: null, ticker: "SILVERIETF",  label: "ICICI Pru Silver ETF",        aumCr: 1500, ter: 0.40, benchmark: "Domestic Silver Price" },
    { code: null, ticker: "HDFCSILVER",  label: "HDFC Silver ETF",             aumCr: 800,  ter: 0.40, benchmark: "Domestic Silver Price" },
  ],

  // ─── INTERNATIONAL ────────────────────────────────────────────────────────
  // Verified AMFI code: Motilal Nasdaq 100 ETF (listed ~2011)
  "International": [
    { code: "147623", ticker: "MON100",     label: "Motilal Oswal Nasdaq 100 ETF",aumCr: 8500, ter: 0.58, benchmark: "Nasdaq 100" },
    { code: null,     ticker: "MAFANG",     label: "Mirae Asset NYSE FANG+",      aumCr: 2400, ter: 0.66, benchmark: "NYSE FANG+" },
    { code: null,     ticker: "HNGSNGBEES", label: "Nippon Hang Seng BeES",       aumCr: 600,  ter: 0.93, benchmark: "Hang Seng" },
    { code: null,     ticker: "MOSP500",    label: "Motilal Oswal S&P 500 ETF",   aumCr: 800,  ter: 0.50, benchmark: "S&P 500" },
  ],
};

/**
 * Flatten the universe into a single array for iteration, with type attached.
 */
module.exports.flatUniverse = function flatUniverse() {
  const out = [];
  for (const [type, etfs] of Object.entries(module.exports.ETF_TYPES)) {
    for (const etf of etfs) {
      out.push({ ...etf, type });
    }
  }
  return out;
};
