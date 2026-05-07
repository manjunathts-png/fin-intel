"use strict";

/**
 * Curated universe of Indian mutual funds per category.
 * Each entry is { code, label } where code is the AMFI scheme code.
 *
 * To add/remove funds, edit this file. Changes take effect after the
 * leaderboard cache TTL (~1 hour) or on server restart.
 *
 * Find scheme codes at: https://www.amfiindia.com/spages/NAVAll.txt
 * Or search: https://api.mfapi.in/mf/search?q=<fund+name>
 */
module.exports.CATEGORIES = {
  "Large Cap": [
    { code: "119018", label: "HDFC Large Cap" },
    { code: "118632", label: "Nippon India Large Cap" },
    { code: "118825", label: "Mirae Asset Large Cap" },
    { code: "120586", label: "ICICI Pru Large Cap" },
    { code: "119598", label: "SBI Large Cap" },
  ],
  "Mid Cap": [
    { code: "118989", label: "HDFC Mid Cap" },
    { code: "127042", label: "Motilal Oswal Midcap" },
    { code: "119775", label: "Kotak Midcap" },
    { code: "118668", label: "Nippon India Growth Mid Cap" },
    { code: "140228", label: "Edelweiss Mid Cap" },
  ],
  "Small Cap": [
    { code: "118778", label: "Nippon India Small Cap" },
    { code: "125497", label: "SBI Small Cap" },
    { code: "130503", label: "HDFC Small Cap" },
    { code: "125354", label: "Axis Small Cap" },
    { code: "120828", label: "Quant Small Cap" },
  ],
  "Flexi Cap": [
    { code: "122639", label: "Parag Parikh Flexi Cap" },
    { code: "118955", label: "HDFC Flexi Cap" },
    { code: "120166", label: "Kotak Flexicap" },
    { code: "120662", label: "UTI Flexi Cap" },
  ],
  "Defence": [
    { code: "151750", label: "HDFC Defence" },
    { code: "152712", label: "Motilal Oswal Nifty India Defence" },
  ],
  "PSU": [
    { code: "119732", label: "SBI PSU" },
    { code: "120395", label: "Invesco India PSU Equity" },
    { code: "147844", label: "Aditya Birla Sun Life PSU Equity" },
  ],
  "Technology": [
    { code: "120594", label: "ICICI Pru Technology" },
    { code: "135800", label: "Tata Digital India" },
    { code: "120539", label: "Aditya Birla Sun Life Digital India" },
    { code: "120578", label: "SBI Technology Opportunities" },
  ],
  "Pharma & Healthcare": [
    { code: "118759", label: "Nippon India Pharma" },
    { code: "119783", label: "SBI Healthcare Opportunities" },
    { code: "143783", label: "Mirae Asset Healthcare" },
    { code: "150930", label: "ICICI Pru Nifty Pharma Index" },
  ],
  "Banking & Financial": [
    { code: "120244", label: "ICICI Pru Banking & Financial Services" },
    { code: "118589", label: "Nippon India Banking & Financial Services" },
    { code: "135793", label: "Tata Banking & Financial Services" },
    { code: "119597", label: "Sundaram Financial Services Opp." },
  ],
  "Infrastructure": [
    { code: "120621", label: "ICICI Pru Infrastructure" },
    { code: "118763", label: "Nippon India Power & Infra" },
    { code: "119700", label: "SBI Infrastructure" },
    { code: "133801", label: "Kotak Infrastructure & Economic Reform" },
  ],
  "Manufacturing": [
    { code: "149841", label: "Kotak Manufacture in India" },
    { code: "133516", label: "Aditya Birla Sun Life Manufacturing Equity" },
  ],
  "Consumption": [
    { code: "118837", label: "Mirae Asset Great Consumer" },
    { code: "120587", label: "ICICI Pru FMCG" },
    { code: "120575", label: "SBI Consumption Opportunities" },
    { code: "118724", label: "Nippon India Consumption" },
  ],
  "Energy": [
    { code: "135813", label: "Tata Resources & Energy" },
    { code: "119028", label: "DSP Natural Resources & New Energy" },
  ],
  "Gold": [
    { code: "119788", label: "SBI Gold" },
    { code: "118663", label: "Nippon India Gold Savings" },
    { code: "119781", label: "Kotak Gold" },
    { code: "119132", label: "HDFC Gold ETF FoF" },
  ],
  "Micro Cap": [
    { code: "151814", label: "Motilal Oswal Nifty Microcap 250" },
    { code: "148519", label: "Nippon India Nifty Smallcap 250" },
    { code: "149283", label: "ICICI Pru Nifty Smallcap 250" },
    { code: "150677", label: "SBI Nifty Smallcap 250" },
    { code: "151727", label: "HDFC Nifty Smallcap 250" },
    { code: "147623", label: "Motilal Oswal Nifty Smallcap 250" },
  ],
  "Large & Mid Cap": [
    { code: "152156", label: "Zerodha Nifty LargeMidcap 250" },
    { code: "118834", label: "Mirae Asset Large & Midcap" },
    { code: "130498", label: "HDFC Large and Mid Cap" },
    { code: "119721", label: "SBI Large & Midcap" },
    { code: "152482", label: "ICICI Pru Nifty LargeMidcap 250" },
    { code: "152889", label: "HDFC Nifty LargeMidcap 250 Index" },
  ],
  "Value": [
    { code: "151113", label: "HSBC Value Fund" },
    { code: "120323", label: "ICICI Pru Value Discovery" },
    { code: "118784", label: "Nippon India Value" },
    { code: "148595", label: "DSP Value Fund" },
    { code: "118494", label: "Templeton India Value" },
  ],
  "ELSS": [
    { code: "120847", label: "Quant ELSS Tax Saver" },
    { code: "135781", label: "Mirae Asset ELSS Tax Saver" },
    { code: "120503", label: "Axis ELSS Tax Saver" },
    { code: "119242", label: "DSP ELSS Tax Saver" },
    { code: "118285", label: "Canara Robeco ELSS Tax Saver" },
    { code: "147481", label: "Parag Parikh ELSS Tax Saver" },
  ],
};
