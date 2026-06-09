// @ts-check
import { test, expect } from "@playwright/test";

// Note: the app requires Google OAuth login. Playwright cannot authenticate via OAuth,
// so these tests only verify the public-facing shell (login page, JS bundle, branding).
// All data quality checks (table row counts, ML scores, freshness) are done server-side
// in tests/ml_quality_check.py using the Supabase service key.

// ── Site is up and login page renders ────────────────────────────────────────

test("site loads and shows login screen", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");

  // App branding must be visible
  await expect(page.getByText("Fin Intel")).toBeVisible({ timeout: 15_000 });

  // Login button must be present (app renders the auth wall correctly)
  await expect(
    page.getByRole("button", { name: /sign in|log in|login|google/i })
  ).toBeVisible({ timeout: 10_000 });

  // No JS crashes during initial render
  expect(errors, `Uncaught JS errors on load: ${errors.join(", ")}`).toHaveLength(0);
});

// ── JS bundle loads without errors on all main routes ────────────────────────

for (const route of ["/", "/mf/picks", "/stocks/picks", "/etf"]) {
  test(`no JS errors on ${route}`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const response = await page.goto(route);
    // Page must return a successful HTTP response (not 404/500)
    expect(response?.status(), `HTTP status for ${route}`).toBeLessThan(400);
    // Allow time for React to mount and any synchronous errors to fire
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    expect(errors, `JS errors on ${route}: ${errors.join(", ")}`).toHaveLength(0);
  });
}
