import { createRequire } from "node:module";
import { join } from "node:path";

/** What a screenshot found, besides the image. */
export interface Capture {
  httpStatus?: number;
  /** Uncaught errors the page threw, at most 5. */
  pageErrors: string[];
}

/** Takes full-page screenshots. Playwright in production, a fake in tests. */
export interface ScreenshotBrowser {
  capture(url: string, file: string): Promise<Capture>;
  close(): Promise<void>;
}

/** The few Playwright calls the receipt makes, so playwright-core need not be a dependency. */
interface PlaywrightPage {
  on(event: "pageerror", listener: (error: Error) => void): void;
  goto(
    url: string,
    options: { waitUntil: "load"; timeout: number },
  ): Promise<{
    status(): number;
  } | null>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  screenshot(options: { path: string; fullPage: boolean; timeout: number }): Promise<unknown>;
  close(): Promise<void>;
}
interface PlaywrightBrowser {
  newContext(options: { viewport: { width: number; height: number } }): Promise<{
    newPage(): Promise<PlaywrightPage>;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(options: { headless: boolean }): Promise<PlaywrightBrowser> };
}

const TIMEOUT_MS = 30_000;

/**
 * Loads playwright-core (or playwright): from `modulePath` when given (the action installs it
 * next to itself and passes SELFHOST_RECEIPT_PLAYWRIGHT), else from the repository under test.
 */
function loadPlaywright(root: string, modulePath?: string): PlaywrightModule {
  const require = createRequire(join(root, "package.json"));
  const tried: string[] = [];
  for (const name of [modulePath, "playwright-core", "playwright"]) {
    if (!name) continue;
    try {
      return require(name) as PlaywrightModule;
    } catch {
      tried.push(name);
    }
  }
  throw new Error(`Playwright is not installed (tried ${tried.join(", ")})`);
}

/** Starts headless Chromium through Playwright, at a 1280 by 800 viewport. */
export async function launchBrowser(root: string, modulePath?: string): Promise<ScreenshotBrowser> {
  const playwright = loadPlaywright(root, modulePath);
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return {
    async capture(url, file) {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (pageErrors.length < 5) pageErrors.push(error.message.split("\n")[0] ?? "");
      });
      try {
        const response = await page.goto(url, { waitUntil: "load", timeout: TIMEOUT_MS });
        // Let client-side rendering settle; a page that keeps polling is captured anyway.
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await page.screenshot({ path: file, fullPage: true, timeout: TIMEOUT_MS });
        return { ...(response ? { httpStatus: response.status() } : {}), pageErrors };
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close().catch(() => {});
      await browser.close();
    },
  };
}
