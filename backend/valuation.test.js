"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  scoreValuations, valuationPenalty, sectorValuationSummary,
  valuationMethod, percentile, VALUATION_PENALTY,
} = require("./valuation");

function stock(symbol, sector, f) {
  return { symbol, sector, fundamentals: { industry: "Software", ...f } };
}

function itGroup() {
  // 6 IT names: PE 10..60, ROE falling as PE rises
  return [10, 20, 30, 40, 50, 60].map((pe, i) => stock(`IT${i}`, "IT", {
    trailingPE: pe, priceToBook: 2 + i, enterpriseToEbitda: 8 + i * 4,
    returnOnEquity: 30 - i * 4, profitMargins: 20 - i * 2, debtToEquity: 10 + i * 10,
    earningsGrowth: 15 - i * 3, revenueGrowth: 12 - i * 2,
  }));
}

test("valuationMethod picks the sector-appropriate model", () => {
  assert.equal(valuationMethod("Banking & Finance", "Banks - Regional"), "lender");
  assert.equal(valuationMethod("Banking & Finance", "Credit Services"), "lender");
  assert.equal(valuationMethod("Banking & Finance", "Insurance - Life"), "financial");
  assert.equal(valuationMethod("IT", "Information Technology Services"), "standard");
  assert.equal(valuationMethod("IT", null), "standard");
});

test("percentile uses mid-rank for ties and 50 for a lone value", () => {
  assert.equal(percentile(1, [1, 2, 3]), 0);
  assert.equal(percentile(3, [1, 2, 3]), 100);
  assert.equal(percentile(2, [2, 2, 2]), 50);
  assert.equal(percentile(5, [5]), 50);
});

test("cheapest, highest-quality peer scores highest; priciest, weakest scores lowest", () => {
  const stocks = itGroup();
  assert.equal(scoreValuations(stocks), 6);
  const [best, , , , , worst] = stocks.map((s) => s.valuation);
  assert.equal(best.valueScore, 100);
  assert.equal(best.qualityScore, 100);
  assert.equal(worst.valueScore, 0);
  assert.equal(worst.qualityScore, 0);
  assert.equal(best.method, "standard");
  assert.equal(best.peers, 6);
  assert.equal(best.peerGroup, "IT");
});

test("loss-making names rank as the most expensive on earnings yield", () => {
  const stocks = itGroup();
  stocks.push(stock("LOSS", "IT", { trailingPE: null, profitMargins: -8, priceToBook: 3 }));
  scoreValuations(stocks);
  const loss = stocks.find((s) => s.symbol === "LOSS").valuation;
  assert.equal(loss.components.earningsYield, 0);
});

test("lenders are valued on book and returns, never on EBITDA or leverage", () => {
  // BK5 is the priciest and weakest bank on P/B, P/E, ROE and ROA, but has the
  // best EV/EBITDA and the lowest leverage. Neither may rescue its scores.
  const banks = [1, 1.5, 2, 2.5, 3, 4].map((pb, i) => stock(`BK${i}`, "Banking & Finance", {
    industry: "Banks - Regional", trailingPE: 8 + i * 3, priceToBook: pb,
    enterpriseToEbitda: 20 - i * 3, debtToEquity: 900 - i * 150,
    returnOnEquity: 18 - i, returnOnAssets: 1.8 - i * 0.2,
    earningsGrowth: 10, revenueGrowth: 10,
  }));
  scoreValuations(banks);
  assert.equal(banks[0].valuation.method, "lender");
  assert.equal(banks[0].valuation.valueScore, 100);
  const pricey = banks[5].valuation;
  assert.equal(pricey.components.ebitdaYield, 100);
  assert.equal(pricey.components.lowLeverage, 100);
  assert.equal(pricey.valueScore, 0);
  assert.ok(pricey.qualityScore <= 15, `quality ${pricey.qualityScore} should ignore leverage`);
});

test("small peer groups fall back to all stocks using the same method", () => {
  const stocks = itGroup();
  stocks.push(stock("TEX", "Textiles", { trailingPE: 5, returnOnEquity: 40 }));
  scoreValuations(stocks);
  const tex = stocks.find((s) => s.symbol === "TEX").valuation;
  // alone in Textiles, but ranked against all 7 'standard' names: cheapest P/E, best ROE
  assert.equal(tex.peers, 1);
  assert.equal(tex.components.earningsYield, 100);
  assert.equal(tex.components.roe, 100);
});

test("stocks without fundamentals are left untouched", () => {
  const stocks = [...itGroup(), { symbol: "NOF", sector: "IT" }];
  assert.equal(scoreValuations(stocks), 6);
  assert.equal(stocks[6].valuation, undefined);
});

test("penalty only when both expensive and weak vs peers", () => {
  assert.equal(valuationPenalty({ valueScore: 10, qualityScore: 20 }), VALUATION_PENALTY);
  assert.equal(valuationPenalty({ valueScore: 10, qualityScore: 80 }), 0);
  assert.equal(valuationPenalty({ valueScore: 90, qualityScore: 10 }), 0);
  assert.equal(valuationPenalty({ valueScore: null, qualityScore: 10 }), 0);
  assert.equal(valuationPenalty(undefined), 0);
});

test("sector summary compares each sector's median P/E with the market", () => {
  const cheap = [8, 9, 10, 11, 12].map((pe, i) => stock(`M${i}`, "Metals & Mining", { trailingPE: pe, priceToBook: 1.2 }));
  const fair = [18, 19, 20, 21, 22].map((pe, i) => stock(`A${i}`, "Auto & EV", { trailingPE: pe }));
  const rich = [50, 55, 60, 65, 70].map((pe, i) => stock(`F${i}`, "FMCG", { trailingPE: pe, returnOnEquity: 30 }));
  const tiny = [stock("T0", "Media", { trailingPE: 40 })];
  const { marketPE, sectors: summary } = sectorValuationSummary([...cheap, ...fair, ...rich, ...tiny]);

  assert.equal(marketPE, 20.5); // all 16 names, incl. the lone Media stock too small to summarise
  assert.deepEqual(summary.map((s) => s.sector), ["Metals & Mining", "Auto & EV", "FMCG"]);
  assert.equal(summary[0].label, "cheaper");
  assert.equal(summary[1].label, "in line");
  assert.equal(summary[2].label, "pricier");
  assert.equal(summary[0].medianPE, 10);
  assert.equal(summary[0].medianPB, 1.2);
  assert.equal(summary[2].medianROE, 30);
});

test("sector summary ignores loss-making P/E and returns [] without data", () => {
  const empty = { marketPE: null, sectors: [] };
  assert.deepEqual(sectorValuationSummary([]), empty);
  assert.deepEqual(sectorValuationSummary([{ symbol: "X", sector: "IT" }]), empty);
  const losers = [1, 2, 3, 4, 5].map((i) => stock(`L${i}`, "Media", { trailingPE: -10 }));
  assert.deepEqual(sectorValuationSummary(losers), empty);
});
