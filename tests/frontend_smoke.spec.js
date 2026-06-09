// @ts-check
import { test, expect } from "@playwright/test";

// ── Navigation / shell ────────────────────────────────────────────────────────

test("homepage redirects to MF picks and renders nav", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/mf\/picks/);
  await expect(page.getByText("Fin Intel")).toBeVisible();
  // All main nav tabs present
  for (const label of ["Mutual Funds", "Stocks", "ETFs"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
});

// ── Mutual funds ──────────────────────────────────────────────────────────────

test("MF picks table loads rows", async ({ page }) => {
  await page.goto("/mf/picks");
  // Table must have at least 5 data rows — confirms Supabase MF data is live
  const rows = page.locator("table tbody tr");
  await expect(rows.nth(4)).toBeVisible({ timeout: 25_000 });
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
});

// ── Stocks ────────────────────────────────────────────────────────────────────

test("Stocks picks table loads rows", async ({ page }) => {
  await page.goto("/stocks/picks");
  const rows = page.locator("table tbody tr");
  await expect(rows.nth(4)).toBeVisible({ timeout: 25_000 });
  const n = await rows.count();
  expect(n).toBeGreaterThan(5);
});

test("Stocks picks page shows ML score column", async ({ page }) => {
  await page.goto("/stocks/picks");
  // Wait for any table row first
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 25_000 });
  // ML score column header should be present (header text may vary — check for 'Score' or 'ML')
  const header = page.locator("table thead").getByText(/score|ml score|rank/i).first();
  await expect(header).toBeVisible();
});

// ── ETFs ──────────────────────────────────────────────────────────────────────

test("ETF page loads", async ({ page }) => {
  await page.goto("/etf");
  // Page must render something meaningful within the timeout
  await expect(page.getByText("Fin Intel")).toBeVisible({ timeout: 15_000 });
});

// ── No JS errors on key pages ─────────────────────────────────────────────────

test("no uncaught JS errors on stocks picks", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/stocks/picks");
  await page.locator("table tbody tr").first().waitFor({ timeout: 25_000 });
  expect(errors, `Uncaught JS errors: ${errors.join(", ")}`).toHaveLength(0);
});
