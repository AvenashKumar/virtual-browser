import puppeteer from "@cloudflare/puppeteer";
import { Buffer } from "node:buffer";

export interface Env {
  // Browser Run binding. workers-types does not export a stable type for it
  // in this version, so it is typed loosely; puppeteer.launch consumes it.
  BROWSER: any;
  ASSETS: Fetcher;
  BASE_URL: string;
}

const PREVIEW_TIMEOUT_MS = 20000;

// Stage 2 interactive sessions. keep_alive ceiling is 20 minutes per the
// current Cloudflare Puppeteer docs (updated 2026-11-11). The Live View URL
// expiry is only the deadline for STARTING a Live View connection, so 10
// minutes gives the frontend ample time to embed it after start returns.
const SESSION_KEEP_ALIVE_MS = 1200000;
const LIVE_VIEW_EXPIRES_MS = 600000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  return false;
}

const RISKY_TLDS = ["zip", "mov", "xyz", "top", "click", "link", "buzz", "cam", "rest", "quest", "tk", "ml", "ga", "cf", "gq"];

export type Verdict = "safe" | "caution" | "risky";

export function safetyCheck(rawUrl: string): { verdict: Verdict; score: number; reasons: string[]; cleanedUrl: string } {
  const reasons: string[] = [];
  let score = 100;
  let cleanedUrl = rawUrl;
  let u: URL | null = null;
  try {
    u = new URL(rawUrl);
  } catch {
    return { verdict: "risky", score: 0, reasons: ["Not a valid URL."], cleanedUrl: rawUrl };
  }
  // Strip tracking parameters, the same cleaning the frontend offers.
  const params = u.searchParams;
  let stripped = 0;
  for (const key of [...params.keys()]) {
    if (key.startsWith("utm_") || ["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"].includes(key)) {
      params.delete(key);
      stripped++;
    }
  }
  if (stripped > 0) {
    cleanedUrl = u.toString();
    reasons.push(`${stripped} tracking parameter${stripped === 1 ? "" : "s"} removed.`);
  }
  if (u.protocol === "http:") {
    score -= 25;
    reasons.push("Not HTTPS. Force HTTPS upgrades this to a secure connection when the site supports it.");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
    score -= 30;
    reasons.push("The host is a raw IP address, not a domain name.");
  }
  if (u.hostname.startsWith("xn--")) {
    score -= 30;
    reasons.push("The domain uses punycode, which can hide lookalike characters.");
  }
  if (u.username || u.password) {
    score -= 30;
    reasons.push("The URL contains a username or password.");
  }
  const parts = u.hostname.split(".");
  if (parts.length > 3) {
    score -= 15;
    reasons.push("Unusually deep subdomain chain.");
  }
  const tld = parts[parts.length - 1];
  if (RISKY_TLDS.includes(tld)) {
    score -= 15;
    reasons.push(`The .${tld} ending is often used by scam sites.`);
  }
  if (u.pathname.length + u.search.length > 150) {
    score -= 10;
    reasons.push("Unusually long URL.");
  }
  if (/sign[-_]?in|log[-_]?in|verify|account|secure|update/i.test(u.pathname + u.search)) {
    score -= 10;
    reasons.push("The path uses sign-in or account wording, common in phishing links.");
  }
  if (/sign[-_]?in|log[-_]?in|verify|account|secure/i.test(u.hostname)) {
    score -= 15;
    reasons.push("The host name uses sign-in or security wording, common in phishing links.");
  }
  const sld = parts.length >= 2 ? parts[parts.length - 2] : "";
  if (/[a-z]\d|\d[a-z]/i.test(sld)) {
    score -= 10;
    reasons.push("The domain name mixes letters and numbers, a common lookalike trick.");
  }
  score = Math.max(0, score);
  const verdict: Verdict = score >= 80 ? "safe" : score >= 50 ? "caution" : "risky";
  if (verdict === "safe" && reasons.length === 0) reasons.push("No risk signals found in the link itself.");
  return { verdict, score, reasons, cleanedUrl };
}

// Shared URL check for session endpoints: same validation as the preview,
// http or https only, private and local hosts blocked, tracking params
// stripped, http upgraded to https unless the caller opts out. Returns a
// Response to send on failure, or the cleaned URL and safety verdict.
function sessionUrl(body: any): Response | { openUrl: URL; safety: ReturnType<typeof safetyCheck> } {
  if (!body || typeof body.url !== "string") return json({ error: "url is required" }, 400);
  let target: URL;
  try {
    target = new URL(body.url);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("bad protocol");
  } catch {
    return json({ error: "Enter a valid http or https URL" }, 400);
  }
  if (isPrivateHost(target.hostname)) return json({ error: "Private and local addresses are blocked" }, 400);
  const safety = safetyCheck(target.toString());
  const openUrl = new URL(safety.cleanedUrl);
  if (openUrl.protocol === "http:" && body.forceHttps !== false) openUrl.protocol = "https:";
  return { openUrl, safety };
}

// Open a Live View URL in tab mode for a page already loaded in a session.
// The returned devtoolsFrontendUrl is the URL the frontend embeds.
async function liveViewUrl(page: any): Promise<string> {
  const cdp = await page.createCDPSession();
  const liveView = await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs: LIVE_VIEW_EXPIRES_MS });
  return liveView.devtoolsFrontendUrl as string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true });

    if (path === "/api/preview" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      if (!body || typeof body.url !== "string") return json({ error: "url is required" }, 400);
      let target: URL;
      try {
        target = new URL(body.url);
        if (!["http:", "https:"].includes(target.protocol)) throw new Error("bad protocol");
      } catch {
        return json({ error: "Enter a valid http or https URL" }, 400);
      }
      if (isPrivateHost(target.hostname)) return json({ error: "Private and local addresses are blocked" }, 400);

      const safety = safetyCheck(target.toString());
      const openUrl = new URL(safety.cleanedUrl);
      if (openUrl.protocol === "http:" && body.forceHttps !== false) openUrl.protocol = "https:";
      const width = Math.min(1600, Math.max(320, Number(body.width || 1280)));
      const height = Math.min(2000, Math.max(400, Number(body.height || 800)));

      let browser: any = null;
      try {
        browser = await puppeteer.launch(env.BROWSER);
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        const response = await page.goto(openUrl.toString(), { waitUntil: "networkidle0", timeout: PREVIEW_TIMEOUT_MS }).catch(() => null);
        const title = await page.title().catch(() => "");
        const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 5000) : "").catch(() => "");
        const links = await page.evaluate(() => {
          const out: { href: string; text: string }[] = [];
          for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 50)) {
            const href = (a as HTMLAnchorElement).href;
            const t = (a.textContent || "").trim().slice(0, 80);
            if (href.startsWith("http")) out.push({ href, text: t });
          }
          return out;
        }).catch(() => []);
        const shot = await page.screenshot({ type: "png" }).catch(() => null);
        const status = response ? response.status() : null;
        return json({
          url: target.toString(),
          cleanedUrl: openUrl.toString(),
          finalUrl: page.url(),
          status,
          title,
          text,
          links,
          safety,
          screenshotBase64: shot ? Buffer.from(shot as Uint8Array).toString("base64") : null,
        });
      } catch (e: any) {
        const msg = e?.message || "unknown error";
        if (/429|rate limit/i.test(msg)) {
          return json({ error: "Browser Rendering is busy right now. The free plan allows one new browser every 20 seconds, so try again in a few seconds.", safety }, 429);
        }
        return json({ error: `Preview failed: ${msg}`, safety }, 502);
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }

    if (path === "/api/safety" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      if (!body || typeof body.url !== "string") return json({ error: "url is required" }, 400);
      return json(safetyCheck(body.url));
    }

    // Stage 2: interactive browser sessions over Browser Run Live View.
    // One active session per visitor is enforced by the client, which holds
    // the sessionId in localStorage. The Worker has no shared state (no D1
    // or KV), so it cannot enforce a per-visitor limit server-side.

    if (path === "/api/session/start" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      const checked = sessionUrl(body);
      if (checked instanceof Response) return checked;
      const { openUrl, safety } = checked;
      const width = Math.min(1600, Math.max(320, Number(body.width || 1280)));
      const height = Math.min(2000, Math.max(400, Number(body.height || 800)));

      let browser: any = null;
      try {
        browser = await puppeteer.launch(env.BROWSER, { keep_alive: SESSION_KEEP_ALIVE_MS });
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        const response = await page.goto(openUrl.toString(), { waitUntil: "networkidle0", timeout: PREVIEW_TIMEOUT_MS }).catch(() => null);
        const title = await page.title().catch(() => "");
        const cdp = await page.createCDPSession();
        const session = await cdp.send("Cloudflare.getSessionId");
        const viewUrl = await liveViewUrl(page);
        // Do NOT close the browser here: the session must stay alive for
        // the visitor. It ends when the visitor calls /api/session/end, or
        // when the 20 minute keep_alive idle timeout reaps it.
        return json({
          sessionId: session.sessionId as string,
          liveViewUrl: viewUrl,
          expiresAt: Date.now() + SESSION_KEEP_ALIVE_MS,
          url: page.url(),
          status: response ? response.status() : null,
          title,
          safety,
        });
      } catch (e: any) {
        const msg = e?.message || "unknown error";
        // A failed start must not leak a half-started session.
        if (browser) await browser.close().catch(() => {});
        if (/429|rate limit/i.test(msg)) {
          return json({ error: "Browser Rendering is busy right now. The free plan allows one new browser every 20 seconds, so try again in a few seconds.", safety }, 429);
        }
        return json({ error: `Session start failed: ${msg}`, safety }, 502);
      }
    }

    if (path === "/api/session/navigate" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId is required" }, 400);
      const checked = sessionUrl(body);
      if (checked instanceof Response) return checked;
      const { openUrl, safety } = checked;

      let browser: any = null;
      try {
        browser = await puppeteer.connect(env.BROWSER, body.sessionId);
      } catch {
        return json({ error: "Session not found or already closed" }, 404);
      }
      try {
        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());
        await page.goto(openUrl.toString(), { waitUntil: "networkidle0", timeout: PREVIEW_TIMEOUT_MS }).catch(() => null);
        const title = await page.title().catch(() => "");
        // A fresh Live View URL for the same target, in case the old one
        // stopped working. The client keeps its embedded URL unless it
        // needs to re-embed.
        const viewUrl = await liveViewUrl(page);
        return json({ sessionId: body.sessionId, url: page.url(), title, liveViewUrl: viewUrl, safety });
      } catch (e: any) {
        return json({ error: `Navigate failed: ${e?.message || "unknown error"}`, safety }, 502);
      } finally {
        // Disconnect only. browser.close() here would kill the session.
        if (browser) await browser.disconnect().catch(() => {});
      }
    }

    if (path === "/api/session/end" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId is required" }, 400);

      let browser: any = null;
      try {
        browser = await puppeteer.connect(env.BROWSER, body.sessionId);
      } catch {
        // Connect failed: the session may already be gone (idle timeout
        // or an earlier close). Check the live session list before
        // reporting an error, so End Session stays idempotent.
        const open: any[] = await puppeteer.sessions(env.BROWSER).catch(() => []);
        const stillOpen = open.some((s) => s.sessionId === body.sessionId);
        if (!stillOpen) return json({ sessionId: body.sessionId, closed: true, alreadyClosed: true });
        return json({ error: "Could not connect to the session to close it" }, 502);
      }
      try {
        // browser.close() ends the session for real: it frees the
        // concurrency slot and stops billing, per the Browser Run docs
        // (a session closed this way is recorded as NormalClosure).
        await browser.close();
        return json({ sessionId: body.sessionId, closed: true });
      } catch (e: any) {
        return json({ error: `Close failed: ${e?.message || "unknown error"}` }, 502);
      }
    }

    if (path === "/api/session/limits" && request.method === "GET") {
      try {
        // The limits object carries activeSessions (with ids),
        // allowedBrowserAcquisitions, maxConcurrentSessions, and
        // timeUntilNextAllowedBrowserAcquisition. It does NOT expose
        // remaining browser minutes, so a 429 on start stays the signal
        // that the daily minutes are used up.
        const limits: any = await puppeteer.limits(env.BROWSER);
        return json({ limits });
      } catch (e: any) {
        return json({ error: `Could not read account limits: ${e?.message || "unknown error"}` }, 502);
      }
    }

    if (path === "/" || path === "/index.html") return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
