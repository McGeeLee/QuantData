import { expect, test } from "@playwright/test";
import { marketFixture as baseMarketFixture, sourcesFixture as baseSourcesFixture } from "../fixtures";

const sourcesFixture = baseSourcesFixture.map((source) => source.id === "tiingo" ? { ...source, configured: true } : source);
const marketFixture = { ...baseMarketFixture, meta: { ...baseMarketFixture.meta, source: "tiingo" as const, volumeUnit: "shares" as const } };

// These scenarios intentionally stub HTTP responses; they do not verify providers.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/sources**", (route) => route.fulfill({ json: { sources: sourcesFixture, disclaimer: "Test fixture" } }));
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ json: marketFixture }));
});

test("empty and invalid symbols never send a market request", async ({ page }) => {
  let calls = 0;
  page.on("request", (request) => { if (request.url().includes("/market-data")) calls += 1; });
  await page.goto("/");
  for (const symbol of ["", "   ", "AAPL?!"]) {
    await page.getByRole("textbox", { name: /^Symbol/ }).fill(symbol);
    await page.getByRole("button", { name: "Fetch market data" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  }
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.getByRole("alert")).toContainText("代码");
});

test("failed provider is localized and can be retried", async ({ page }) => {
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ status: 502, json: { error: { code: "UPSTREAM_ERROR", message: "Provider unavailable", requestId: "fixture-ray" } } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.getByRole("alert")).toContainText("fixture-ray");
  await expect(page.locator(".chart-grid")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.getByRole("alert")).toContainText("上游");
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ json: marketFixture }));
  await page.getByRole("button", { name: "获取行情数据" }).click();
  await expect(page.locator(".result-header h2")).toHaveText("AAPL");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("HTML failure and empty result have explicit states", async ({ page }) => {
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Gateway failure</h1>" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.getByRole("alert")).toContainText("unexpected response");
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ json: { ...marketFixture, meta: { ...marketFixture.meta, count: 0 }, bars: [] } }));
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".results .empty-state")).toHaveText("No bars were returned for this request.");
  await expect(page.locator(".chart-grid")).toHaveCount(0);
});

test("pending request is single-flight across repeated submit and language switch", async ({ page }) => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/market-data**", async (route) => {
    calls += 1;
    await gate;
    await route.fulfill({ json: marketFixture });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".results")).toHaveAttribute("aria-busy", "true");
  await page.locator("form").dispatchEvent("submit");
  await page.locator("form").dispatchEvent("submit");
  await expect(page.getByRole("textbox", { name: /^Symbol/ })).toBeDisabled();
  await page.getByRole("button", { name: "Switch language" }).click();
  release();
  await expect(page.locator(".data-freshness")).toContainText("历史日线数据 · 非实时行情");
  expect(calls).toBe(1);
  await expect(page.locator(".results")).toHaveAttribute("aria-busy", "false");
});

test("cache provenance and missing volume stay honest", async ({ page }) => {
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ json: {
    ...marketFixture,
    meta: { ...marketFixture.meta, cache: { status: "hit", ttlSeconds: 3600, ageSeconds: 45 } },
    bars: marketFixture.bars.map((bar) => ({ ...bar, volume: null })),
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".data-freshness")).toContainText("not a live quote");
  await expect(page.locator(".data-freshness")).toContainText("Served from edge cache");
  await expect(page.locator(".data-freshness time")).toHaveAttribute("datetime", marketFixture.meta.fetchedAt);
  await expect(page.locator(".metric-grid article").filter({ hasText: "Volume" }).locator("strong")).toHaveText("—");
});

test("source discovery failure stays separate from successful market data", async ({ page }) => {
  await page.route("**/api/v1/sources**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator(".source-feedback")).toContainText("Could not load source configuration");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".result-header h2")).toHaveText("AAPL");
  await expect(page.locator(".results [role=alert]")).toHaveCount(0);
  await page.route("**/api/v1/sources**", (route) => route.fulfill({ json: { sources: sourcesFixture, disclaimer: "Test fixture" } }));
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".source-feedback")).not.toContainText("Could not load source configuration");
  await page.locator("details.source-details > summary").click();
  await expect(page.locator(".source-status")).toContainText("Yahoo Finance Chart");
});

test("phone layouts fit both languages and documentation at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".chart-grid canvas").first()).toBeVisible();
  for (let i = 0; i < 2; i += 1) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator(".data-freshness")).toBeVisible();
    await expect(page.locator("footer a[href=\"/openapi.json\"]")).toBeVisible();
    await expect(page.locator("footer a[href^=\"/docs/\"]")).toBeVisible();
    await page.getByRole("button", { name: "Switch language" }).click();
  }
  for (const locale of ["en", "zh-CN"]) {
    await page.goto(`/docs/${locale}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator(".docs-content h1")).toBeVisible();
  }
});
