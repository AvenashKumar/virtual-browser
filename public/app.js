const $ = (id) => document.getElementById(id);
const HISTORY_KEY = "virtual-browser-history";
const THEME_KEY = "virtual-browser-theme";
let lastUrl = null;
let lastRisky = false;

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
$("end-session").addEventListener("click", () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
  loadHistory();
  $("result").classList.add("hidden");
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

function showSafety(safety) {
  const label = safety.verdict === "safe" ? "Looks safe" : safety.verdict === "caution" ? "Be careful" : "Looks risky";
  $("r-verdict").textContent = `${label} (${safety.score}/100)`;
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
  } else {
    $("r-risky").classList.add("hidden");
    $("r-preview").classList.remove("hidden");
    $("r-loading").classList.add("hidden");
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
  $("r-loading").classList.remove("hidden");
  $("r-shot").classList.add("hidden");
  $("r-title").textContent = "Opening...";
  $("r-verdict").textContent = "";
  $("r-safety").innerHTML = "";
  $("open-btn").disabled = true;
  $("open-btn").textContent = "Opening...";
  try { await openPreview(url, false); } finally {
    $("open-btn").disabled = false;
    $("open-btn").textContent = "Open safely";
  }
});

$("open-anyway").addEventListener("click", async () => {
  if (!lastUrl) return;
  $("r-risky").classList.add("hidden");
  $("r-preview").classList.remove("hidden");
  $("r-loading").classList.remove("hidden");
  await openPreview(lastUrl, true);
});

initTheme();
loadHistory();
