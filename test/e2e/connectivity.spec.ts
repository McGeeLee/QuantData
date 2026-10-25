import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import type { ConnectionCheck } from "../../worker/domain/connectivity";
import { marketFixture, sourcesFixture } from "../fixtures";

// Local UI contract tests only. External requests are blocked, and every API
// response is a fixture; these tests do not verify real provider connectivity.
async function mockDashboard(page: Page, configured = false) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://127.0.0.1:5187") {
      await route.abort();
    } else if (url.pathname === "/api/v1/sources") {
      await route.fulfill({ json: { sources: sourcesFixture.map((source) => ({ ...source, configured: configured || source.configured })) } });
    } else if (url.pathname === "/api/v1/market-data") {
      await route.fulfill({ json: marketFixture });
    } else if (url.pathname.startsWith("/api/")) {
      await route.abort();
    } else {
      await route.continue();
    }
  });
}

function connectionFixture(now: Date, overrides: Partial<ConnectionCheck> = {}): ConnectionCheck {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    source: "yahoo",
    status: "ok",
    checkedAt: now.toISOString(),
    durationMs: 245,
    cached: false,
    nextCheckAt: new Date(now.getTime() + 300_000).toISOString(),
    sample: { symbol: "AAPL", start, end, barCount: 21, latestBarDate: end },
    requestId: "connectivity-browser-fixture",
    ...overrides,
  };
}

async function saveFixtureScreenshot(page: Page, filename: string, testInfo: TestInfo) {
  const verificationDirectory = process.env.QUANT_DATA_VERIFICATION_DIR ?? testInfo.outputPath("verification");
  await mkdir(verificationDirectory, { recursive: true });
  const checks = page.locator(".connection-checks");
  await checks.evaluate((section: HTMLElement) => {
    const label = document.createElement("p");
    label.dataset.testFixtureLabel = "true";
    label.textContent = "Simulated API fixture — UI verification only / 模拟接口数据，仅用于界面验收";
    Object.assign(label.style, {
      display: "block", padding: "10px", margin: "0 0 12px", color: "#111827",
      background: "#fde68a", border: "2px solid #92400e", fontSize: "13px",
      fontWeight: "700", lineHeight: "1.5", overflowWrap: "anywhere",
    });
    section.insertAdjacentElement("afterbegin", label);
  });
  try {
    await checks.screenshot({ path: `${verificationDirectory}/${filename}`, animations: "disabled" });
  } finally {
    await checks.locator("[data-test-fixture-label]").evaluate((label) => label.remove());
  }
}

const checkPath = /\/api\/v1\/sources\/(yahoo|tushare|tiingo)\/check(?:\?|$)/;

async function openConnectionChecks(page: Page) {
  const details = page.locator("details.source-details");
  await expect(details).toHaveJSProperty("open", false);
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
}

test("source checks require a click and missing credentials disable their buttons", async ({ page }) => {
  await mockDashboard(page);
  let checks = 0;
  await page.route(checkPath, async (route) => {
    checks += 1;
    await route.fulfill({ json: connectionFixture(new Date()) });
  });
  await page.goto("/");
  await expect(page.locator('.connection-card[data-source="yahoo"] button')).toBeHidden();
  expect(checks).toBe(0);
  await openConnectionChecks(page);
  const yahoo = page.locator('.connection-card[data-source="yahoo"]');
  await expect(yahoo.getByRole("button")).toBeEnabled();
  await expect(yahoo.locator(".status-dot")).not.toHaveClass(/\bready\b/);
  await expect(page.locator('.connection-card[data-source="tushare"]').getByRole("button")).toBeDisabled();
  await expect(page.locator('.connection-card[data-source="tiingo"]').getByRole("button")).toBeDisabled();
  expect(checks).toBe(0);
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(yahoo.getByRole("button", { name: "检查连通性：Yahoo Finance Chart" })).toBeEnabled();
  expect(checks).toBe(0);
  // This case deliberately leaves both credentialed providers unconfigured.
  await page.getByRole("combobox", { name: "数据源", exact: true }).selectOption("yahoo");
  await page.getByRole("button", { name: "获取行情数据" }).click();
  await expect(page.locator(".result-header h2")).toHaveText("AAPL");
  expect(checks).toBe(0);
});

test("manual success shows its exact observation and cooldown never starts another request", async ({ page }, testInfo) => {
  await mockDashboard(page);
  const now = new Date();
  const result = connectionFixture(now);
  await page.clock.install({ time: now });
  let checks = 0;
  await page.route(checkPath, async (route) => {
    checks += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postData()).toBeNull();
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await openConnectionChecks(page);
  const yahoo = page.locator('.connection-card[data-source="yahoo"]');
  const button = yahoo.getByRole("button", { name: "Check connection: Yahoo Finance Chart" });
  await button.click();
  await expect(yahoo.locator(".connection-result")).toHaveAttribute("data-status", "ok");
  await expect(yahoo.locator(".status-dot")).toHaveClass(/\bready\b/);
  await expect(yahoo.locator(`time[datetime="${result.checkedAt}"]`)).toBeVisible();
  await expect(yahoo.locator(`time[datetime="${result.nextCheckAt}"]`)).toBeVisible();
  await expect(yahoo).toContainText("245");
  await expect(yahoo).toContainText("21");
  await expect(yahoo).toContainText("AAPL");
  await expect(yahoo).toContainText(result.sample.latestBarDate!);
  await expect(button).toBeDisabled();
  await button.dispatchEvent("click");
  expect(checks).toBe(1);
  await page.locator("details.source-details > summary").click();
  await expect(page.locator("details.source-details")).toHaveJSProperty("open", false);
  await openConnectionChecks(page);
  await expect(yahoo.locator(`time[datetime="${result.checkedAt}"]`)).toBeVisible();
  await expect(button).toBeDisabled();
  expect(checks).toBe(1);
  if (testInfo.project.name === "desktop") await saveFixtureScreenshot(page, "connectivity-desktop-fixture.png", testInfo);
  await page.clock.fastForward(301_000);
  await expect(button).toBeEnabled();
  expect(checks).toBe(1);
});

test("pending clicks are single-flight and language switching preserves a cached observation", async ({ page }) => {
  await mockDashboard(page);
  const now = new Date();
  const result = connectionFixture(now, { cached: true, checkedAt: new Date(now.getTime() - 120_000).toISOString() });
  let checks = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(checkPath, async (route) => {
    checks += 1;
    await gate;
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await openConnectionChecks(page);
  const yahoo = page.locator('.connection-card[data-source="yahoo"]');
  const button = yahoo.getByRole("button");
  try {
    await button.click();
    await expect(button).toBeDisabled();
    await button.dispatchEvent("click");
    await button.dispatchEvent("click");
    await page.getByRole("button", { name: "Switch language" }).click();
    release();
    await expect(yahoo.locator(`time[datetime="${result.checkedAt}"]`)).toBeVisible();
    await expect(yahoo).toContainText(/复用|缓存/);
    await expect(yahoo).toContainText(/成功|连通/);
    expect(checks).toBe(1);
    await page.getByRole("button", { name: "Switch language" }).click();
    await expect(yahoo).toContainText(/reused|cached/i);
    await expect(yahoo.locator(`time[datetime="${result.checkedAt}"]`)).toBeVisible();
    expect(checks).toBe(1);
  } finally {
    release();
  }
});

test("an HTML 403 is a site block, independent from provider status and market data", async ({ page }) => {
  await mockDashboard(page);
  await page.route(checkPath, (route) => route.fulfill({ status: 403, contentType: "text/html", body: "<html><h1>Access denied</h1></html>" }));
  await page.goto("/");
  await openConnectionChecks(page);
  const yahoo = page.locator('.connection-card[data-source="yahoo"]');
  await yahoo.getByRole("button").click();
  await expect(yahoo.locator(".connection-error")).toHaveAttribute("data-error", "SITE_REQUEST_BLOCKED");
  // A site block did not run a provider check, so its provider status stays unverified.
  await expect(yahoo.locator(".status-dot")).not.toHaveClass(/\bready\b/);
  await expect(yahoo).toContainText(/site.*blocked|blocked.*site/i);
  await expect(yahoo).not.toContainText(/Yahoo.*403|provider.*denied/i);
  await expect(yahoo.locator("time")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Data source", exact: true }).selectOption("yahoo");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  await expect(page.locator(".result-header h2")).toHaveText("AAPL");
  await expect(page.locator(".results [role=alert]")).toHaveCount(0);
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(yahoo).toContainText(/站点.*拦截/);
});

test("all check cards and result details fit at 320px in both languages", async ({ page }, testInfo) => {
  await mockDashboard(page, true);
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route(checkPath, async (route) => {
    const source = new URL(route.request().url()).pathname.split("/").at(-2) as ConnectionCheck["source"];
    const result = connectionFixture(new Date(), { source, requestId: "fixture-".repeat(12) });
    if (source === "tushare") result.sample.symbol = "600519.SH";
    await route.fulfill({ json: result });
  });
  await page.goto("/");
  await openConnectionChecks(page);
  for (const source of ["yahoo", "tushare", "tiingo"]) {
    const card = page.locator(`.connection-card[data-source="${source}"]`);
    await card.getByRole("button").click();
    await expect(card.locator("time").first()).toBeVisible();
  }
  for (let i = 0; i < 2; i += 1) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const source of ["yahoo", "tushare", "tiingo"]) {
      const bounds = await page.locator(`.connection-card[data-source="${source}"]`).boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
    }
    if (i === 1 && testInfo.project.name === "mobile") await saveFixtureScreenshot(page, "connectivity-mobile-fixture.png", testInfo);
    await page.getByRole("button", { name: "Switch language" }).click();
  }
});

test("project quota protection stays distinct from provider rate limits in both languages", async ({ page }) => {
  await mockDashboard(page, true);
  await page.setViewportSize({ width: 320, height: 740 });
  const statuses = { yahoo: "quota_exceeded", tushare: "quota_unavailable", tiingo: "rate_limited" } as const;
  let checks = 0;
  await page.route(checkPath, async (route) => {
    checks += 1;
    const source = new URL(route.request().url()).pathname.split("/").at(-2) as ConnectionCheck["source"];
    const fixture = connectionFixture(new Date(), { source });
    await route.fulfill({ json: {
      ...fixture,
      status: statuses[source],
      durationMs: source === "tiingo" ? 124 : 0,
      sample: { symbol: source === "tushare" ? "600519.SH" : "AAPL", start: fixture.sample.start, end: fixture.sample.end },
      error: source === "tiingo" ? { code: "UPSTREAM_RATE_LIMITED", upstreamStatus: 429 }
        : { code: source === "yahoo" ? "QUOTA_EXCEEDED" : "QUOTA_UNAVAILABLE" },
    } });
  });
  await page.goto("/");
  await openConnectionChecks(page);
  const quotaNote = page.getByTestId("quota-protection-note");
  await expect(quotaNote).toContainText(/all visitors.*share|shared.*all visitors/i);
  await expect(quotaNote).toContainText(/cache hits.*(do not|no).*provider/i);
  await expect(quotaNote.locator('a[href="/docs/en#quota-protection"]')).toBeVisible();
  for (const source of ["yahoo", "tushare", "tiingo"] as const) {
    const card = page.locator(`.connection-card[data-source="${source}"]`);
    await card.getByRole("button").click();
    await expect(card.locator(".connection-result")).toHaveAttribute("data-status", statuses[source]);
    if (source === "tiingo") {
      await expect(card).toContainText(/provider rate limited/i);
      await expect(card).toContainText("429");
      await expect(card.locator(".status-dot")).toHaveClass(/\bfailed\b/);
    } else {
      await expect(card).toContainText(/project.*free-tier.*paused/i);
      await expect(card.locator(".status-dot")).not.toHaveClass(/\b(ready|failed)\b/);
      await expect(card).not.toContainText("429");
    }
  }
  await expect(page.locator('.connection-card[data-source="tushare"]')).toContainText(/temporarily unavailable/i);
  expect(checks).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(quotaNote).toContainText(/所有访客.*共享/);
  await expect(quotaNote).toContainText(/缓存命中.*不.*供应商/);
  await expect(quotaNote.locator('a[href="/docs/zh-CN#quota-protection"]')).toBeVisible();
  await expect(page.locator('.connection-card[data-source="yahoo"]')).toContainText("项目免费额度保护已暂停请求，请稍后重试。");
  await expect(page.locator('.connection-card[data-source="tushare"]')).toContainText("项目免费额度保护暂不可用，已暂停请求，请稍后重试。");
  await expect(page.locator('.connection-card[data-source="tiingo"]')).toContainText("供应商对该样本请求进行了限流。");
  expect(checks).toBe(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
