# Virtual Browser

Open any link on a remote server, so you never have to open it in your own browser. Planned home: `browse.avenash-kumar.com`.

## Stage 1: safe link preview

A headless Chrome on Cloudflare's network (Browser Run, formerly Browser Rendering) opens the link and sends back a screenshot, the readable text, and the links on the page. Your browser never touches the site, so the site never sees your IP, your cookies, or your logins.

- `POST /api/preview` with `{ url, forceHttps, width, height }` returns the cleaned URL, final URL, status, title, readable text, links, a safety verdict, and a PNG screenshot as base64.
- `POST /api/safety` with `{ url }` returns only the safety verdict, scored from the link itself: HTTPS, raw IP host, punycode, credentials in the URL, subdomain depth, risky TLD, length, and sign-in wording.
- Before opening, tracking parameters (`utm_*`, `fbclid`, `gclid`, and friends) are stripped, and HTTP is upgraded to HTTPS when Force HTTPS is on.
- Risky links are not opened automatically. The UI shows the verdict and asks before opening anyway.
- Private and local addresses are blocked, same as HTTP Inspector.
- History is stored in the visitor's browser localStorage only, last 20. Nothing is kept on the server. There is no D1 database in this project.

## Stage 2: full interactive browser (later)

A real browser streamed to you as video, where you can click and type. That needs a server running Chrome per session, which Workers cannot do. Options: Hyperbeam, Browserbase, or a self-hosted Chrome with noVNC or WebRTC streaming. See `~/workspace/research_notes/virtual-browser-20261114/plan.md`.

## Limits

- The remote browser is identifiable as automation, so some sites will block it.
- Browser Run free plan: 10 browser minutes a day, 3 concurrent browsers. Paid: 10 hours a month included, then $0.09 per hour. Sessions idle out after 60 seconds by default.
- Screenshots are PNG, one viewport at a time. No login sessions persist between previews.

## Development

```bash
npm install
npm run typecheck
npm run dev
```

`wrangler dev` runs the browser against Chrome on your machine. Deploy with `wrangler deploy` after the repo exists and the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets are set in GitHub Secrets.

Do not paste tokens or account IDs in chat. Add them only in GitHub Secrets.

## E2E tests

Playwright tests in `e2e/` run against the live site by default (`https://browse.avenash-kumar.com`, override with `E2E_BASE_URL`). They only run after the first deploy, since the preview needs the live Worker with its browser binding.

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

## Design

Same improvised palette as the other tools: hero deep midnight #0B1526 to indigo #3730A3, primary #4F46E5, accent teal #2DD4BF, headings ink #0F172A, font Manrope. Light and dark mode, with a visible toggle.
