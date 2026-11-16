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
// A shared Live View link is deliberately short-lived: the person receiving
// it has 5 minutes to open it. End session revokes it immediately.
const SHARE_VIEW_EXPIRES_MS = 300000;

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
// expiresInMs is only the deadline for STARTING a connection with the URL.
async function liveViewUrl(page: any, expiresInMs: number = LIVE_VIEW_EXPIRES_MS): Promise<string> {
  const cdp = await page.createCDPSession();
  const liveView = await cdp.send("Cloudflare.getLiveView", { mode: "tab", expiresInMs });
  return liveView.devtoolsFrontendUrl as string;
}

// Destination locking for sessions. Session guardrails are set when a
// session is acquired and latched for its lifetime: they cannot be changed
// or removed by later connections (see the Browser Run guardrails docs).
// So every session is born locked to the origin it starts on, plus its
// subdomains and the common-cdns set for page assets. A session can only
// ever request that origin, which is what makes sharing it safe: the
// person holding a share link cannot wander to another site. The trade-off
// is that logins which redirect to an identity provider on another host,
// and navigation to any other site, are blocked. A raw IP host has no
// subdomains, so it is listed on its own.
function sessionGuardrails(openUrl: URL): { allowedDomains: string[]; allowedDomainSets: string[] } {
  const host = openUrl.hostname;
  const allowedDomains = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? [host] : [host, `*.${host}`];
  return { allowedDomains, allowedDomainSets: ["common-cdns"] };
}

// The origin a locked session may use. The session can only ever be on
// that origin, so the current page URL is the locked origin.
function lockedOriginOf(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    return u.protocol.startsWith("http") ? u.origin : null;
  } catch {
    return null;
  }
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
        // Locked to the start origin from birth: guardrails are latched
        // at acquire and cannot be added later, so this is what makes a
        // shared session safe.
        browser = await puppeteer.launch(env.BROWSER, { keep_alive: SESSION_KEEP_ALIVE_MS, guardrails: sessionGuardrails(openUrl) });
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        const response = await page.goto(openUrl.toString(), { waitUntil: "networkidle0", timeout: PREVIEW_TIMEOUT_MS }).catch(() => null);
        const title = await page.title().catch(() => "");
        // A redirect to another host is blocked by the guardrails. The
        // block answers 403 with cf-mitigated: guardrails, which is how
        // it is told apart from a 403 from the site itself.
        if (response && response.status() === 403 && response.headers()["cf-mitigated"] === "guardrails") {
          await browser.close().catch(() => {});
          browser = null;
          return json({ error: `That link redirects to a site outside ${openUrl.origin}, and this session is locked to ${openUrl.origin}.`, safety }, 400);
        }
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
          lockedOrigin: openUrl.origin,
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
        // The session is locked to the origin it started on. The current
        // page can only ever be on that origin, so it is the locked one.
        // Refuse other origins here with a plain message instead of
        // letting the guardrails answer 403.
        const lockedOrigin = lockedOriginOf(page.url());
        if (lockedOrigin && new URL(openUrl.toString()).origin !== lockedOrigin) {
          return json({ error: `This session is locked to ${lockedOrigin}. That link goes somewhere else, so it was blocked.`, safety }, 403);
        }
        const navResponse = await page.goto(openUrl.toString(), { waitUntil: "networkidle0", timeout: PREVIEW_TIMEOUT_MS }).catch(() => null);
        if (navResponse && navResponse.status() === 403 && navResponse.headers()["cf-mitigated"] === "guardrails") {
          return json({ error: `This session is locked to ${lockedOrigin || "one site"}. That link goes somewhere else, so it was blocked.`, safety }, 403);
        }
        const title = await page.title().catch(() => "");
        // A fresh Live View URL for the same target, in case the old one
        // stopped working. The client keeps its embedded URL unless it
        // needs to re-embed.
        const viewUrl = await liveViewUrl(page);
        return json({ sessionId: body.sessionId, url: page.url(), title, liveViewUrl: viewUrl, safety, lockedOrigin });
      } catch (e: any) {
        return json({ error: `Navigate failed: ${e?.message || "unknown error"}`, safety }, 502);
      } finally {
        // Disconnect only. browser.close() here would kill the session.
        if (browser) await browser.disconnect().catch(() => {});
      }
    }

    if (path === "/api/session/share" && request.method === "POST") {
      const body = await request.json().catch(() => null) as any;
      if (!body || typeof body.sessionId !== "string") return json({ error: "sessionId is required" }, 400);

      let browser: any = null;
      try {
        browser = await puppeteer.connect(env.BROWSER, body.sessionId);
      } catch {
        const open: any[] = await puppeteer.sessions(env.BROWSER).catch(() => []);
        const stillOpen = open.some((s) => s.sessionId === body.sessionId);
        if (!stillOpen) return json({ error: "Session not found or already closed" }, 404);
        return json({ error: "Could not connect to the session to share it" }, 502);
      }
      try {
        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());
        // A fresh Live View URL with a short fuse: the person receiving
        // the link has 5 minutes to open it. The URL itself is never
        // logged anywhere.
        // Destination locking is NOT applied here: session guardrails are
        // latched when the session is acquired, so the session was locked
        // to its origin when it started. The lock is reported back so the
        // frontend can state it.
        // There is also no view-only option on this path: the Live View
        // guardrails { mode: "readonly" } setting is REST API only. The
        // CDP Cloudflare.getLiveView command takes only targetId, mode,
        // and expiresInMs, so every shared link is a fully interactive
        // one. The share box says so plainly.
        const shareUrl = await liveViewUrl(page, SHARE_VIEW_EXPIRES_MS);
        return json({
          sessionId: body.sessionId,
          shareUrl,
          expiresAt: Date.now() + SHARE_VIEW_EXPIRES_MS,
          expiresInMs: SHARE_VIEW_EXPIRES_MS,
          lockedOrigin: lockedOriginOf(page.url()),
        });
      } catch (e: any) {
        return json({ error: `Share failed: ${e?.message || "unknown error"}` }, 502);
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
        // The raw limits object carries activeSessions (with ids).
        // Those ids must never leave the Worker: a session id is a
        // bearer token, and anyone holding one could open, steer, or
        // end that live session through the session endpoints, which
        // have no other ownership check. So only the scalar fields
        // the UI needs are returned. It does NOT expose remaining
        // browser minutes, so a 429 on start stays the signal that
        // the daily minutes are used up.
        const limits: any = await puppeteer.limits(env.BROWSER);
        return json({ limits: {
          allowedBrowserAcquisitions: limits.allowedBrowserAcquisitions,
          maxConcurrentSessions: limits.maxConcurrentSessions,
          timeUntilNextAllowedBrowserAcquisition: limits.timeUntilNextAllowedBrowserAcquisition,
          usedBrowserTimeSeconds: limits.usedBrowserTimeSeconds,
        } });
      } catch (e: any) {
        return json({ error: `Could not read account limits: ${e?.message || "unknown error"}` }, 502);
      }
    }

    if (path === "/" || path === "/index.html") return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
