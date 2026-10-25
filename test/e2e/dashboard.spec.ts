import { expect, test } from "@playwright/test";
import { marketFixture as baseMarketFixture, sourcesFixture as baseSourcesFixture } from "../fixtures";

const sourcesFixture = baseSourcesFixture.map((source) => source.id === "tiingo" ? { ...source, configured: true } : source);
const marketFixture = { ...baseMarketFixture, meta: { ...baseMarketFixture.meta, source: "tiingo" as const, volumeUnit: "shares" as const } };

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/sources**", (route) => route.fulfill({ json: { sources: sourcesFixture } }));
  await page.route("**/api/v1/market-data**", (route) => route.fulfill({ json: marketFixture }));
});

test("English and Chinese dashboard flow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1, exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Data source", exact: true })).toHaveValue("tiingo");
  const marketRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/v1/market-data");
  await page.getByRole("button", { name: "Fetch market data" }).click();
  expect(new URL((await marketRequest).url()).searchParams.get("source")).toBe("tiingo");
  await expect(page.getByText("AAPL", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".source-badge")).toHaveText("tiingo");
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.getByRole("heading", { name: "行情面板", level: 1, exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});

test("localized documentation route", async ({ page }) => {
  await page.goto("/docs/zh-CN");
  await expect(page.getByRole("heading", { name: "QuantData 文档" })).toBeVisible();
  await expect(page.getByText("get_market_data", { exact: true })).toBeVisible();
});

test("theme follows the system and persists the manual override", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("mcgeelee-theme"))).toBe("light");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("desktop layouts share one 1180px content rail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");

  for (const viewport of [
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const geometry = await page.evaluate(() => {
      const contentRail = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing ${selector}`);
        const box = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        const left = box.left + Number.parseFloat(styles.paddingLeft);
        const right = box.right - Number.parseFloat(styles.paddingRight);
        return { selector, left, right, width: right - left };
      };
      return {
        contentMax: getComputedStyle(document.documentElement).getPropertyValue("--content-max").trim(),
        viewportWidth: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth,
        rails: [".topbar", ".dashboard-heading", ".workspace", "footer"].map(contentRail),
      };
    });

    expect(geometry.contentMax).toBe("1180px");
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    for (const rail of geometry.rails) {
      expect(rail.left, rail.selector).toBeCloseTo(geometry.rails[0].left, 0);
      expect(rail.right, rail.selector).toBeCloseTo(geometry.rails[0].right, 0);
      expect(rail.width, rail.selector).toBeCloseTo(1180, 0);
    }
  }
});
