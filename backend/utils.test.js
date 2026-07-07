"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { businessHoursAge } = require("./utils");

const iso = (y, m, d, h, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min)).toISOString();

test("businessHoursAge equals wall-clock age when no weekend is crossed", () => {
  // Tuesday 10:00 -> Wednesday 14:00, no weekend in between
  const start = iso(2026, 7, 7, 10);
  const now   = new Date(iso(2026, 7, 8, 14)).getTime();
  assert.ok(Math.abs(businessHoursAge(start, now) - 28) < 1e-6);
});

test("businessHoursAge discounts a full weekend — the 2026-07-06 incident numbers", () => {
  // Real incident: mf_radar built Sat 2026-07-04 01:10 UTC (Friday night's
  // nightly run, landed just after midnight), checked Mon 2026-07-06 14:16 UTC.
  // Raw wall-clock age was 61.1h (correctly logged) but nothing was actually
  // broken — MF only refreshes on the nightly weekday cron. Business-hours
  // age should land safely under the 28h threshold.
  const start = iso(2026, 7, 4, 1, 10);
  const now   = new Date(iso(2026, 7, 6, 14, 16)).getTime();
  const age = businessHoursAge(start, now);
  assert.ok(age < 28, `expected business-hours age < 28h, got ${age.toFixed(1)}h`);
  assert.ok(Math.abs(age - 14.27) < 0.1, `expected ~14.3h, got ${age.toFixed(2)}h`);
});

test("businessHoursAge still flags a genuine multi-day outage spanning one weekend", () => {
  // A real 7-day outage (e.g. MF refresh broken all week) must not be
  // forgiven just because a weekend happened to fall inside it.
  const start = iso(2026, 6, 30, 1); // Tuesday
  const now   = new Date(iso(2026, 7, 7, 1)).getTime(); // following Tuesday
  const age = businessHoursAge(start, now);
  assert.ok(age > 28, `expected a genuine outage to still exceed 28h, got ${age.toFixed(1)}h`);
  assert.ok(Math.abs(age - 120) < 1e-6); // 168h wall-clock - 48h (one weekend)
});

test("businessHoursAge fully discounts time that falls entirely within a weekend day", () => {
  // Built and checked both within Saturday's UTC calendar day — 4h wall
  // clock, all of it inside the weekend → fully discounted.
  const start = iso(2026, 7, 4, 1); // Saturday
  const now   = new Date(iso(2026, 7, 4, 5)).getTime(); // same Saturday
  assert.ok(Math.abs(businessHoursAge(start, now) - 0) < 1e-6);
});

test("businessHoursAge only credits the weekend portion of a Fri-evening-to-Sat-morning span", () => {
  // Friday 23:00 -> Saturday 05:00 = 6h wall clock. Only the Sat 00:00-05:00
  // portion (5h) is weekend; the Fri 23:00-24:00 hour (1h) still counts.
  const start = iso(2026, 7, 3, 23); // Friday
  const now   = new Date(iso(2026, 7, 4, 5)).getTime(); // Saturday
  assert.ok(Math.abs(businessHoursAge(start, now) - 1) < 1e-6);
});

test("businessHoursAge handles null/invalid input like hoursAgo", () => {
  assert.strictEqual(businessHoursAge(null), Infinity);
  assert.strictEqual(businessHoursAge(undefined), Infinity);
  assert.strictEqual(businessHoursAge("not-a-date"), Infinity);
});

test("businessHoursAge is zero for a future or current timestamp", () => {
  const now = new Date(iso(2026, 7, 6, 12)).getTime();
  assert.strictEqual(businessHoursAge(iso(2026, 7, 6, 12), now), 0);
  assert.strictEqual(businessHoursAge(iso(2026, 7, 6, 13), now), 0); // 1h in the future
});
