"use strict";

/**
 * Curated NSE-listed ETF universe.
 *
 * Each entry has:
 *   code      — AMFI scheme code (for mfapi.in NAV history). null if not on mfapi.
 *   ticker    — NSE ticker (for yahoo-finance2 with .NS suffix).
 *   label     — Display name.
 *   aumCr     — Approx AUM in ₹ crore (hand-curated, refresh periodically).
 *   ter       — Total Expense Ratio % (hand-curated).
 *   benchmark — What the ETF tracks (for popup context).
 *
 * Three top-level types: Equity, Commodity, International.
 *
 * Find AMFI scheme codes at: https://www.amfiindia.com/spages/NAVAll.txt
 *   (search the file for the fund name)
 * Find NSE tickers at: https://www.nseindia.com/market-data/exchange-traded-funds-etf
 */

module.exports.ETF_TYPES = {
  // ─── EQUITY ETFs ──────────────────────────────────────────────────────────
  "Equity — Broad": [
    { code: "102885", ticker: "NIFTYBEES",   label: "Nippon Nifty 50 BeES",        aumCr: 39000, ter: 0.04, benchmark: "Nifty 50" },
    { code: "102934", ticker: "JUNIORBEES",  label: "Nippon Nifty Next 50 BeES",   aumCr: 6500,  ter: 0.15, benchmark: "Nifty Next 50" },
    { code: "152057", ticker: "MIDCAPIETF",  label: "ICICI Pru Midcap 150 ETF",    aumCr: 600,   ter: 0.15, benchmark: "Nifty Midcap 150" },
    { code: "151750", ticker: "SMALLCAP",    label: "Nippon Nifty Smallcap 250",   aumCr: 900,   ter: 0.32, benchmark: "Nifty Smallcap 250" },
    { code: "147623", ticker: "MOM100",      label: "Motilal Oswal Nasdaq 100",    aumCr: 8500,  ter: 0.58, benchmark: "Nasdaq 100" },
  ],

  "Equity — Sector": [
    { code: "102883", ticker: "BANKBEES",    label: "Nippon Nifty Bank BeES",      aumCr: 9500,  ter: 0.19, benchmark: "Nifty Bank" },
    { code: "152043", ticker: "ITBEES",      label: "Nippon Nifty IT BeES",        aumCr: 1100,  ter: 0.22, benchmark: "Nifty IT" },
    { code: "150930", ticker: "PHARMABEES",  label: "Nippon Nifty Pharma BeES",    aumCr: 700,   ter: 0.20, benchmark: "Nifty Pharma" },
    { code: "152714", ticker: "PSUBNKBEES",  label: "Nippon Nifty PSU Bank BeES",  aumCr: 1900,  ter: 0.49, benchmark: "Nifty PSU Bank" },
    { code: "152712", ticker: "AUTOBEES",    label: "Nippon Nifty Auto BeES",      aumCr: 400,   ter: 0.20, benchmark: "Nifty Auto" },
    { code: "152044", ticker: "FMCGIETF",    label: "Nippon Nifty FMCG ETF",       aumCr: 300,   ter: 0.21, benchmark: "Nifty FMCG" },
    { code: "151794", ticker: "INFRABEES",   label: "Nippon Nifty Infra BeES",     aumCr: 350,   ter: 0.20, benchmark: "Nifty Infra" },
    { code: "151814", ticker: "CONSUMBEES",  label: "Nippon Nifty Consumption",    aumCr: 250,   ter: 0.30, benchmark: "Nifty Consumption" },
    { code: "152712", ticker: "DEFENCEIETF", label: "Motilal Nifty India Defence", aumCr: 1500,  ter: 0.45, benchmark: "Nifty India Defence" },
  ],

  "Equity — Smart Beta": [
    { code: "147481", ticker: "MOMOMENTUM",  label: "Motilal Nifty 200 Momentum 30", aumCr: 4500, ter: 0.30, benchmark: "Nifty 200 Momentum 30" },
    { code: "148595", ticker: "LOWVOL1",     label: "ICICI Pru Nifty Low Vol 30",    aumCr: 1200, ter: 0.41, benchmark: "Nifty 100 Low Vol 30" },
    { code: "148519", ticker: "ALPHAETF",    label: "Nippon Nifty Alpha 50",         aumCr: 1100, ter: 0.40, benchmark: "Nifty Alpha 50" },
    { code: "149283", ticker: "QUAL30IETF",  label: "ICICI Pru Nifty 100 Quality 30",aumCr: 200,  ter: 0.40, benchmark: "Nifty 100 Quality 30" },
    { code: "150677", ticker: "NV20IETF",    label: "ICICI Pru NV20 ETF",            aumCr: 900,  ter: 0.18, benchmark: "Nifty 50 Value 20" },
  ],

  // ─── COMMODITY ETFs ───────────────────────────────────────────────────────
  "Commodity — Gold": [
    { code: "102885", ticker: "GOLDBEES",    label: "Nippon India Gold BeES",      aumCr: 11500, ter: 0.79, benchmark: "Domestic Gold Price" },
    { code: "119788", ticker: "HDFCGOLD",    label: "HDFC Gold ETF",               aumCr: 4800,  ter: 0.59, benchmark: "Domestic Gold Price" },
    { code: "119781", ticker: "KOTAKGOLD",   label: "Kotak Gold ETF",              aumCr: 3500,  ter: 0.55, benchmark: "Domestic Gold Price" },
    { code: "119132", ticker: "AXISGOLD",    label: "Axis Gold ETF",               aumCr: 700,   ter: 0.56, benchmark: "Domestic Gold Price" },
  ],

  "Commodity — Silver": [
    { code: "151794", ticker: "SILVERBEES",  label: "Nippon Silver ETF",           aumCr: 1700,  ter: 0.50, benchmark: "Domestic Silver Price" },
    { code: "152889", ticker: "SILVERIETF",  label: "ICICI Pru Silver ETF",        aumCr: 1500,  ter: 0.40, benchmark: "Domestic Silver Price" },
    { code: "152482", ticker: "HDFCSILVER",  label: "HDFC Silver ETF",             aumCr: 800,   ter: 0.40, benchmark: "Domestic Silver Price" },
  ],

  // ─── INTERNATIONAL ETFs ───────────────────────────────────────────────────
  "International": [
    { code: "147623", ticker: "MON100",      label: "Motilal Oswal Nasdaq 100",    aumCr: 8500,  ter: 0.58, benchmark: "Nasdaq 100" },
    { code: "152156", ticker: "MAFANG",      label: "Mirae Asset NYSE FANG+",      aumCr: 2400,  ter: 0.66, benchmark: "NYSE FANG+" },
    { code: null,      ticker: "HNGSNGBEES", label: "Nippon Hang Seng BeES",       aumCr: 600,   ter: 0.93, benchmark: "Hang Seng" },
    { code: null,      ticker: "MOSP500",    label: "Motilal Oswal S&P 500",       aumCr: 800,   ter: 0.50, benchmark: "S&P 500" },
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
