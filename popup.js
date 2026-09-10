const statusElement = document.querySelector("#status");
const toastEl = document.querySelector("#toast");
const buttons = [...document.querySelectorAll(".capture-button")];
const delaySelect = document.querySelector("#delaySelect");
const historySection = document.querySelector("#historySection");
const historyStrip = document.querySelector("#historyStrip");
const clearHistoryBtn = document.querySelector("#clearHistory");
const tplInput = document.querySelector("#filenameTemplate");
const colorInput = document.querySelector("#defaultColor");
let countdownTimer = null;
let toastTimer = null;

const SETTINGS_KEY = "snapCanvasSettings";
const HISTORY_KEY = "recentCaptures";
const CAPTURE_KEY = "latestCapture";
const DEFAULTS = { filenameTemplate: "pagesnap-{domain}-{date}-{mode}", defaultColor: "#43a047" };

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#8a1d12" : "#b94115";
}
function toast(msg, ms = 2200) {
  if (!toastEl) return setStatus(msg);
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

async function loadSettings() {
  try {
    const { [SETTINGS_KEY]: s = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    const cur = { ...DEFAULTS, ...s };
    if (tplInput) tplInput.value = cur.filenameTemplate;
    if (colorInput) colorInput.value = cur.defaultColor;
    return cur;
  } catch { return DEFAULTS; }
}
async function saveSettings() {
  const next = {
    filenameTemplate: tplInput?.value?.trim() || DEFAULTS.filenameTemplate,
    defaultColor: colorInput?.value || DEFAULTS.defaultColor
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  toast("Settings saved");
}

async function renderHistory() {
  if (!historyStrip || !historySection) return;
  try {
    const { [HISTORY_KEY]: list = [] } = await chrome.storage.local.get(HISTORY_KEY);
    if (!list.length) { historySection.hidden = true; return; }
    historySection.hidden = false;
    historyStrip.innerHTML = "";
    for (const item of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";
      btn.title = `${item.domain} — ${new Date(item.capturedAt).toLocaleString()}`;
      const img = document.createElement("img");
      img.src = item.thumbUrl || item.dataUrl;
      img.alt = "";
      img.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = `${item.domain} · ${item.mode}`;
      btn.append(img, label);
      btn.addEventListener("click", async () => {
        await chrome.storage.local.set({ [CAPTURE_KEY]: { dataUrl: item.dataUrl, mode: item.mode, capturedAt: new Date().toISOString(), domain: item.domain, title: item.title } });
        chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
      });
      historyStrip.appendChild(btn);
    }
  } catch { historySection.hidden = true; }
}

async function capture(mode) {
  const delayMs = parseInt(delaySelect.value, 10) || 0;
  delaySelect.disabled = mode === "selected";
  setStatus(`Starting ${mode} capture...`);
  buttons.forEach((b) => (b.disabled = true));
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) throw new Error("No active tab available.");
    const response = await chrome.runtime.sendMessage({ type: "START_CAPTURE", mode, tabId: tab.id, windowId: tab.windowId, delayMs });
    if (!response?.ok) throw new Error(response?.error || "Capture failed.");
    if (mode === "selected") { window.close(); return; }
    if (delayMs > 0) runCountdown(delayMs);
    else { toast(mode === "visible" ? "Visible area captured" : "Full page captured"); setTimeout(() => window.close(), 300); }
  } catch (error) {
    setStatus(error.message || "Capture failed.", true);
    toast(error.message || "Capture failed.");
    delaySelect.disabled = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
function runCountdown(totalMs) {
  const startedAt = Date.now();
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((totalMs - (Date.now() - startedAt)) / 1000));
    setStatus(remaining > 0 ? `Capturing in ${remaining}s…` : "Capturing…");
    if (remaining === 0) { clearInterval(countdownTimer); countdownTimer = null; window.close(); }
  }, 100);
}

buttons.forEach((b) => b.addEventListener("click", () => capture(b.dataset.mode)));
// Double-click popup background = quick visible capture
document.addEventListener("dblclick", (e) => {
  if (e.target.closest("button, input, select, summary")) return;
  capture("visible");
});
clearHistoryBtn?.addEventListener("click", async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
  renderHistory();
  toast("History cleared");
});
tplInput?.addEventListener("change", saveSettings);
colorInput?.addEventListener("change", saveSettings);

// Init
loadSettings();
renderHistory();
chrome.storage.onChanged?.addListener((changes) => {
  if (changes[HISTORY_KEY]) renderHistory();
});
