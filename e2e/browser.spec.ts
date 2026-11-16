import { test, expect, request } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL || "https://browse.avenash-kumar.com";
const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
const api = () => request.newContext(proxyServer ? { proxy: { server: proxyServer } } : {});

test.describe("Virtual Browser", () => {
  test("health returns ok", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/health`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await ctx.dispose();
  });

  test("homepage loads with URL bar, theme toggle, and favicon", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#url")).toBeVisible();
    await expect(page.locator("#open-btn")).toBeVisible();
    const fav = await page.request.get("/favicon.svg");
    expect(fav.status()).toBe(200);
    await page.locator("#theme-dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme-light").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("safety check flags a suspicious link and passes a safe one", async () => {
    const ctx = await api();
    const bad = await ctx.post(`${baseURL}/api/safety`, {
      data: { url: "http://secure-login.paypa1.com/signin?utm_source=mail&fbclid=abc123" },
    });
    expect(bad.status()).toBe(200);
    const badData = await bad.json();
    expect(badData.verdict).toBe("risky");
    expect(badData.cleanedUrl).not.toContain("utm_source");
    expect(badData.cleanedUrl).not.toContain("fbclid");
    const good = await ctx.post(`${baseURL}/api/safety`, { data: { url: "https://example.com" } });
    expect((await good.json()).verdict).toBe("safe");
    await ctx.dispose();
  });

  test("preview of example.com returns a screenshot and text", async () => {
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/preview`, {
      data: { url: "https://example.com", width: 1280, height: 800 },
    });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.status).toBe(200);
    expect(data.title).toContain("Example");
    expect(data.screenshotBase64).toBeTruthy();
    expect(data.text.length).toBeGreaterThan(0);
    expect(data.safety.verdict).toBe("safe");
    await ctx.dispose();
  });

  test("preview of a private address is rejected", async () => {
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/preview`, { data: { url: "http://localhost:3000/" } });
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });

  test("preview in the UI shows a screenshot and saves history", async ({ page }) => {
    // The API preview test above just created a browser. The free Browser
    // Rendering plan allows one new browser every 20 seconds, so wait before
    // opening another one, or this preview gets a 429.
    await new Promise((r) => setTimeout(r, 25000));
    await page.goto("/");
    await page.locator("#url").fill("https://example.com");
    await page.locator("#open-btn").click();
    await expect(page.locator("#r-shot")).toBeVisible({ timeout: 60000 });
    // History rows show the page title, not the URL.
    await expect(page.locator("#history")).toContainText("Example Domain");
  });
});

// Stage 2 interactive sessions. The three tests share one session on purpose:
// each CI run should open as few browsers as possible, since the free plan
// allows 10 browser minutes a day. These tests need the deployed Worker;
// they fail against a site that does not have the session endpoints yet.
test.describe("Virtual Browser sessions", () => {
  let sessionId: string | null = null;
  let startLiveViewUrl: string | null = null;

  test.afterAll(async () => {
    if (!sessionId) return;
    const ctx = await api();
    await ctx.post(`${baseURL}/api/session/end`, { data: { sessionId } }).catch(() => null);
    await ctx.dispose();
    sessionId = null;
  });

  test("start returns a liveViewUrl @api", async () => {
    // The UI preview test above just created a browser. The free plan
    // allows one new browser every 20 seconds, so wait before starting
    // a session, or start gets a 429.
    await new Promise((r) => setTimeout(r, 25000));
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/start`, {
      data: { url: "https://example.com", width: 1280, height: 800 },
    });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.liveViewUrl).toContain("live.browser.run");
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(data.safety.verdict).toBe("safe");
    expect(data.lockedOrigin).toBe("https://example.com");
    sessionId = data.sessionId;
    startLiveViewUrl = data.liveViewUrl;
    await ctx.dispose();
  });

  test("share returns a fresh share URL with a short expiry @api", async () => {
    test.skip(!sessionId, "no session from the start test");
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/share`, { data: { sessionId } });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.shareUrl).toContain("live.browser.run");
    expect(data.shareUrl).not.toBe(startLiveViewUrl);
    expect(data.expiresInMs).toBe(300000);
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    expect(data.expiresAt - Date.now()).toBeLessThanOrEqual(300000);
    expect(data.lockedOrigin).toBe("https://example.com");
    await ctx.dispose();
  });

  test("share for an unknown session returns 404 @api", async () => {
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/share`, {
      data: { sessionId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.status()).toBe(404);
    await ctx.dispose();
  });

  test("navigate changes the URL in the same session @api", async () => {
    test.skip(!sessionId, "no session from the start test");
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/navigate`, {
      data: { sessionId, url: "https://www.example.com" },
    });
    expect(res.status(), await res.text()).toBe(200);
    const data = await res.json();
    expect(data.url).toContain("example.com");
    await ctx.dispose();
  });

  test("navigate outside the locked origin is blocked @api", async () => {
    test.skip(!sessionId, "no session from the start test");
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/navigate`, {
      data: { sessionId, url: "https://example.org" },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toContain("locked to");
    await ctx.dispose();
  });

  test("end closes, and closing again is idempotent @api", async () => {
    test.skip(!sessionId, "no session from the start test");
    const ctx = await api();
    const first = await ctx.post(`${baseURL}/api/session/end`, { data: { sessionId } });
    expect(first.status()).toBe(200);
    expect((await first.json()).closed).toBe(true);
    const second = await ctx.post(`${baseURL}/api/session/end`, { data: { sessionId } });
    expect(second.status()).toBe(200);
    const secondData = await second.json();
    expect(secondData.closed).toBe(true);
    expect(secondData.alreadyClosed).toBe(true);
    sessionId = null;
    await ctx.dispose();
  });

  test("start with a private host is rejected @api", async () => {
    const ctx = await api();
    const res = await ctx.post(`${baseURL}/api/session/start`, { data: { url: "http://localhost:3000/" } });
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });

  test("limits returns its shape @api", async () => {
    const ctx = await api();
    const res = await ctx.get(`${baseURL}/api/session/limits`);
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(typeof data.limits.allowedBrowserAcquisitions).toBe("number");
    expect(typeof data.limits.maxConcurrentSessions).toBe("number");
    await ctx.dispose();
  });
});
