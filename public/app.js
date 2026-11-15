const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "virtual-browser-history";
const THEME_KEY = "virtual-browser-theme";
const SESSION_KEY = "virtual-browser-session";
const SESSION_MS = 20 * 60 * 1000;
const FRAME_LOAD_TIMEOUT_MS = 12000;
const LIVE_VIEW_FRESH_MS = 9 * 60 * 1000;
let lastUrl = null;
let lastRisky = false;
let liveSession = null;
let timerId = null;
let frameTimer = null;
let frameLoaded = false;
let busy = false;

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  $("theme-light").classList.toggle("active", theme === "light");
  $("theme-dark").classList.toggle("active", theme === "dark");
}
function initTheme() {
  let saved = "light";
  try { saved = localStorage.getItem(THEME_KEY) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); } catch (e) {}
  setTheme(saved);
}
$("theme-light").addEventListener("click", () => setTheme("light"));
$("theme-dark").addEventListener("click", () => setTheme("dark"));

function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
}
function saveHistory(entry) {
  try {
    const list = readHistory().filter((x) => x.url !== entry.url);
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 20)));
  } catch (e) {}
}
function loadHistory() {
  const list = readHistory();
  $("history").innerHTML = list.length ? list.map((x) => `
    <div class="history-row">
      <strong>${esc(x.verdict)}</strong>
      <span>${esc(x.title || x.url)}</span>
      <span class="muted">${new Date(x.at).toLocaleString()}</span>
      <button type="button" data-url="${esc(x.url)}">Open again</button>
    </div>`).join("") : "<p class='muted'>No links opened yet in this session.</p>";
  $("history").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    $("url").value = b.dataset.url;
    $("open-form").requestSubmit();
  }));
}
$("clear-history").addEventListener("click", () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
  loadHistory();
});

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  const name = t.dataset.tab;
  $("tab-text").classList.toggle("hidden", name !== "text");
  $("tab-links").classList.toggle("hidden", name !== "links");
}));

document.querySelectorAll(".examples button").forEach((b) => b.addEventListener("click", () => {
  $("url").value = b.dataset.url;
  $("open-form").requestSubmit();
}));

function shieldText(safety) {
  const label = safety.verdict === "safe" ? "Safe to open" : safety.verdict === "caution" ? "Be careful" : "Looks risky";
  return `${label}, score ${safety.score}/100. The site will see a remote browser, not your device, cookies or location.`;
}
function showSafety(safety) {
  const label = safety.verdict === "safe" ? "Looks safe" : safety.verdict === "caution" ? "Be careful" : "Looks risky";
  $("r-verdict").textContent = `${label} (${safety.score}/100)`;
  $("r-shield").textContent = shieldText(safety);
  $("r-safety").innerHTML = safety.reasons.map((r) => `<span>${esc(r)}</span>`).join("");
}

async function openPreview(url, force) {
  const [w, h] = $("viewport").value.split("x").map(Number);
  const res = await fetch("/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, forceHttps: $("force-https").checked, width: w, height: h }),
  });
  const d = await res.json();
  if (!res.ok) {
    $("open-error").textContent = d.error || "Preview failed.";
    $("open-error").classList.remove("hidden");
    $("r-loading").classList.add("hidden");
    return;
  }
  $("open-error").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("r-title").textContent = d.title || d.finalUrl || d.url;
  $("r-meta").textContent = `Opened as ${d.cleanedUrl} , final URL ${d.finalUrl} , status ${d.status == null ? "unknown" : d.status}`;
  showSafety(d.safety);
  $("r-original").href = d.cleanedUrl;
  lastUrl = d.cleanedUrl;
  lastRisky = d.safety.verdict === "risky";
  if (lastRisky && !force) {
    $("r-risky").classList.remove("hidden");
    $("r-preview").classList.add("hidden");
    $("session-start-wrap").classList.add("hidden");
  } else {
    $("r-risky").classList.add("hidden");
    $("r-preview").classList.remove("hidden");
    $("r-loading").classList.add("hidden");
    $("session-start-wrap").classList.remove("hidden");
    if (d.screenshotBase64) {
      $("r-shot").src = "data:image/png;base64," + d.screenshotBase64;
      $("r-shot").classList.remove("hidden");
    }
    $("tab-text").textContent = d.text || "No readable text on this page.";
    $("tab-links").innerHTML = (d.links || []).length
      ? d.links.map((l) => `<p><a href="#" data-link="${esc(l.href)}">${esc(l.text || l.href)}</a><br><span class="muted">${esc(l.href)}</span></p>`).join("")
      : "<p class='muted'>No links found on this page.</p>";
    $("tab-links").querySelectorAll("[data-link]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      $("url").value = a.dataset.link;
      $("open-form").requestSubmit();
    }));
  }
  refreshStartButton();
  saveHistory({ url: d.cleanedUrl, title: d.title || d.cleanedUrl, verdict: d.safety.verdict, at: Date.now() });
  loadHistory();
}

$("open-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  $("open-error").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("r-preview").classList.remove("hidden");
  $("r-risky").classList.add("hidden");
  $("session-start-wrap").classList.add("hidden");
  $("r-loading").classList.remove("hidden");
  $("r-shot").classList.add("hidden");
  $("r-title").textContent = "Opening...";
  $("r-verdict").textContent = "";
  $("r-shield").textContent = "";
  $("r-safety").innerHTML = "";
  $("open-btn").disabled = true;
  $("open-btn").textContent = "Opening...";
  try { await openPreview(url, false); } finally {
    $("open-btn").disabled = false;
    $("open-btn").textContent = "Open in a quiet window";
  }
});

$("open-anyway").addEventListener("click", async () => {
  if (!lastUrl) return;
  $("r-risky").classList.add("hidden");
  $("r-preview").classList.remove("hidden");
  $("r-loading").classList.remove("hidden");
  await openPreview(lastUrl, true);
});

// ---- Stage 2: interactive Live View sessions ----

function readStoredSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { return null; }
}
function storeSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
}
function clearStoredSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function fmtTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function refreshStartButton() {
  const btn = $("start-session");
  if (liveSession) {
    btn.disabled = true;
    btn.textContent = "Session running";
  } else {
    btn.disabled = busy;
    btn.textContent = "Start interactive session";
  }
}
function updateTimer() {
  if (!liveSession) return;
  const left = liveSession.expiresAt - Date.now();
  $("session-timer").textContent = fmtTime(left);
  if (left <= 0) endLiveSession("time");
}
function startTimer() {
  stopTimer();
  updateTimer();
  timerId = setInterval(updateTimer, 1000);
}
function stopTimer() {
  if (timerId) clearInterval(timerId);
  timerId = null;
}
function embedLiveView(url) {
  frameLoaded = false;
  $("session-fallback").classList.add("hidden");
  $("live-frame").src = url;
  $("live-new-tab").href = url;
  $("live-fallback-link").href = url;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(() => {
    if (!frameLoaded) $("session-fallback").classList.remove("hidden");
  }, FRAME_LOAD_TIMEOUT_MS);
}
$("live-frame").addEventListener("load", () => {
  frameLoaded = true;
  $("session-fallback").classList.add("hidden");
});
function showSessionPanel() {
  $("live-session").classList.remove("hidden");
  $("live-session").scrollIntoView({ behavior: "smooth", block: "start" });
}
function hideSessionPanel() {
  $("live-session").classList.add("hidden");
  if (frameTimer) clearTimeout(frameTimer);
  $("live-frame").removeAttribute("src");
}
function showSessionEnded(msg) {
  $("session-ended").textContent = msg;
  $("session-ended").classList.remove("hidden");
}

async function startSession() {
  if (liveSession) return;
  if (!lastUrl) return;
  $("session-error").classList.add("hidden");
  $("session-ended").classList.add("hidden");
  const btn = $("start-session");
  btn.disabled = true;
  btn.textContent = "Starting session...";
  const [w, h] = $("viewport").value.split("x").map(Number);
  try {
    const res = await fetch("/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: lastUrl, forceHttps: $("force-https").checked, width: w, height: h }),
    });
    const d = await res.json();
    if (!res.ok) {
      $("session-error").textContent = d.error || "Session start failed.";
      $("session-error").classList.remove("hidden");
      return;
    }
    liveSession = { sessionId: d.sessionId, liveViewUrl: d.liveViewUrl, expiresAt: d.expiresAt || Date.now() + SESSION_MS, startedAt: Date.now(), url: d.url || lastUrl };
    storeSession(liveSession);
    $("session-url").value = liveSession.url;
    $("session-status").textContent = "Live. Click and type inside the page.";
    showSessionPanel();
    embedLiveView(liveSession.liveViewUrl);
    startTimer();
  } catch (e) {
    $("session-error").textContent = "Session start failed. Check your connection and try again.";
    $("session-error").classList.remove("hidden");
  } finally {
    refreshStartButton();
  }
}
$("start-session").addEventListener("click", startSession);

$("session-nav-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!liveSession) return;
  const url = $("session-url").value.trim();
  if (!url) return;
  $("session-go").disabled = true;
  try {
    const res = await fetch("/api/session/navigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: liveSession.sessionId, url, forceHttps: $("force-https").checked }),
    });
    const d = await res.json();
    if (!res.ok) {
      if (res.status === 404) {
        clearLiveSessionLocal();
        $("session-error").textContent = "That session is gone. Start a new session to keep going.";
        $("session-error").classList.remove("hidden");
        return;
      }
      $("session-status").textContent = d.error || "Could not open that link in the session.";
      return;
    }
    liveSession.url = d.url;
    storeSession(liveSession);
    $("session-url").value = d.url;
    $("session-status").textContent = "Live. Click and type inside the page.";
    if (d.liveViewUrl && d.liveViewUrl !== liveSession.liveViewUrl) {
      liveSession.liveViewUrl = d.liveViewUrl;
      storeSession(liveSession);
      embedLiveView(d.liveViewUrl);
    }
  } catch (e) {
    $("session-status").textContent = "Could not open that link in the session. Check your connection.";
  } finally {
    $("session-go").disabled = false;
  }
});

function clearLiveSessionLocal() {
  liveSession = null;
  stopTimer();
  clearStoredSession();
  hideSessionPanel();
  refreshStartButton();
}
async function endLiveSession(reason) {
  const id = liveSession ? liveSession.sessionId : null;
  clearLiveSessionLocal();
  if (id) {
    try {
      await fetch("/api/session/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
    } catch (e) {}
  }
  showSessionEnded(reason === "time"
    ? "The 20 minutes ran out, so the session was closed. Nothing was kept."
    : "Session ended. The remote browser was closed and nothing was kept.");
}
$("end-live-session").addEventListener("click", () => endLiveSession("user"));

async function checkLimits() {
  try {
    const res = await fetch("/api/session/limits");
    if (!res.ok) return;
    const d = await res.json();
    const limits = d.limits || {};
    busy = typeof limits.allowedBrowserAcquisitions === "number" && limits.allowedBrowserAcquisitions === 0;
    $("session-busy").classList.toggle("hidden", !busy);
    refreshStartButton();
  } catch (e) {}
}
$("busy-retry").addEventListener("click", async () => {
  await checkLimits();
});

function restoreSession() {
  const s = readStoredSession();
  if (!s || !s.sessionId || !s.liveViewUrl || !s.expiresAt) { clearStoredSession(); return; }
  if (s.expiresAt <= Date.now() || Date.now() - (s.startedAt || 0) > LIVE_VIEW_FRESH_MS) { clearStoredSession(); return; }
  liveSession = s;
  $("session-url").value = s.url || "";
  $("session-status").textContent = "Session restored. Click and type inside the page.";
  showSessionPanel();
  embedLiveView(s.liveViewUrl);
  startTimer();
  refreshStartButton();
}

initTheme();
loadHistory();
restoreSession();
checkLimits();
