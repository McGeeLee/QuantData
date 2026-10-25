import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { marketFixture as baseMarketFixture, sourcesFixture as baseSourcesFixture } from "../fixtures";

const sourcesFixture = baseSourcesFixture.map((source) => source.id === "tiingo" ? { ...source, configured: true } : source);
const marketFixture = { ...baseMarketFixture, meta: { ...baseMarketFixture.meta, source: "tiingo" as const, volumeUnit: "shares" as const } };

const origin = "http://127.0.0.1:5187";

// This suite verifies navigation and presentation only. All API responses are
// fixtures, and unrecognized API requests and external hosts are blocked.
async function mockPages(page: Page) {
  const apiRequests: string[] = [];
  const aboutRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    apiRequests.push(url.pathname);
    if (new URL(page.url()).pathname === "/about") aboutRequests.push(url.pathname);
    if (url.pathname === "/api/v1/sources") {
      await route.fulfill({ json: { sources: sourcesFixture, disclaimer: "UI test fixture" } });
    } else if (url.pathname === "/api/v1/market-data") {
      await route.fulfill({ json: marketFixture });
    } else {
      await route.abort();
    }
  });
  return { apiRequests, aboutRequests };
}

async function expectNavigation(page: Page, locale: "en" | "zh-CN") {
  const nav = page.locator(".primary-nav");
  const labels = locale === "en" ? ["Dashboard", "About", "Docs"] : ["行情面板", "项目介绍", "文档"];
  for (const label of labels) await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
  await expect(nav.locator('a[href="/"]')).toBeInViewport();
  await expect(nav.locator('a[href="/about"]')).toBeInViewport();
  await expect(nav.locator(`a[href="/docs/${locale}"]`)).toBeInViewport();
}

async function saveFixtureScreenshot(page: Page, testInfo: TestInfo, filename: string, fullPage = false) {
  await page.evaluate(() => {
    const label = document.createElement("p");
    label.dataset.navigationFixtureLabel = "true";
    label.textContent = "UI verification · API fixtures / 界面验收 · 模拟接口";
    Object.assign(label.style, {
      position: "fixed", bottom: "6px", left: "6px", right: "6px", zIndex: "9999",
      margin: "0", padding: "5px 8px", background: "#fff2bf", color: "#4a3600",
      font: "12px/1.4 sans-serif", textAlign: "center", border: "1px solid #9a7100",
    });
    document.body.appendChild(label);
  });
  try {
    await page.screenshot({ path: testInfo.outputPath(filename), fullPage, animations: "disabled" });
  } finally {
    await page.locator("[data-navigation-fixture-label]").evaluate((label) => label.remove());
  }
}

test("the root opens directly to a usable dashboard on load and refresh", async ({ page }) => {
  const { apiRequests } = await mockPages(page);
  await page.goto("/");
  for (let visit = 0; visit < 2; visit += 1) {
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1, exact: true })).toBeInViewport();
    await expect(page.locator(".hero")).toHaveCount(0);
    await expect(page.locator(".developer-section")).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Data source", exact: true })).toBeInViewport();
    await expect(page.getByRole("combobox", { name: "Data source", exact: true })).toHaveValue("tiingo");
    await expect(page.getByRole("textbox", { name: /^Symbol/ })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Fetch market data" })).toBeInViewport({ ratio: 1 });
    await expect(page.locator("details.source-details")).toHaveJSProperty("open", false);
    await expectNavigation(page, "en");
    if (visit === 0) await page.reload();
  }
  expect(apiRequests.some((path) => path === "/api/v1/sources")).toBe(true);
  expect(apiRequests.filter((path) => path !== "/api/v1/sources")).toEqual([]);
});

test("about explains the project without data API calls and its CTA opens the dashboard", async ({ page }) => {
  const { apiRequests } = await mockPages(page);
  await page.goto("/about");
  await expect(page.getByRole("heading", { name: "Public market data, shaped for people and models.", level: 1 })).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.locator(".hero .about-cta")).toHaveText(/Open dashboard/);
  await expect(page.locator(".developer-section pre").first()).toContainText(`${origin}/api/v1/market-data`);
  await expectNavigation(page, "en");
  await page.waitForLoadState("networkidle");
  expect(apiRequests).toEqual([]);
  await page.locator(".hero .about-cta").click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch market data" })).toBeInViewport({ ratio: 1 });
  expect(apiRequests.filter((path) => path !== "/api/v1/sources")).toEqual([]);
});

test("language and theme survive navigation, refresh, and browser back", async ({ page }, testInfo) => {
  const { aboutRequests } = await mockPages(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await page.getByRole("button", { name: "Switch language" }).click();
  const expectPreferences = async () => {
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  };
  await expectPreferences();
  await expect(page.getByRole("button", { name: "获取行情数据" })).toBeInViewport({ ratio: 1 });
  await expect(page.locator("details.source-details")).toHaveJSProperty("open", false);
  await saveFixtureScreenshot(page, testInfo, "dashboard-zh-dark-fixture.png");

  await page.locator(".primary-nav").getByRole("link", { name: "项目介绍", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/about`);
  await expectPreferences();
  await expect(page.locator(".hero .about-cta")).toHaveText(/打开行情面板/);
  await saveFixtureScreenshot(page, testInfo, "about-zh-dark-fixture.png", true);
  await page.locator(".primary-nav").getByRole("link", { name: "文档", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/docs/zh-CN`);
  await expect(page.getByRole("heading", { name: "QuantData 文档", level: 1 })).toBeVisible();
  await expectPreferences();
  await page.locator(".primary-nav").getByRole("link", { name: "行情面板", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expectPreferences();
  await expect(page.getByRole("heading", { name: "行情面板", level: 1, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`${origin}/docs/zh-CN`);
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/about`);
  await page.reload();
  await expectPreferences();
  await expect(page.getByRole("heading", { name: "为用户与大模型而设计的公开行情数据。", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(aboutRequests).toEqual([]);
});

test("a direct Chinese docs entry keeps Chinese when returning to the dashboard", async ({ page }) => {
  await mockPages(page);
  await page.goto("/docs/zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.locator(".primary-nav").getByRole("link", { name: "行情面板", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("button", { name: "获取行情数据" })).toBeVisible();
});

test("all three pages retain visible navigation without horizontal overflow at 320px", async ({ page }) => {
  const { aboutRequests } = await mockPages(page);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const locale of ["en", "zh-CN"] as const) {
    await page.goto("/");
    if (locale === "zh-CN") await page.getByRole("button", { name: "Switch language" }).click();
    for (const path of ["/", "/about", `/docs/${locale}`]) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expectNavigation(page, locale);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  }
  expect(aboutRequests).toEqual([]);
});
