import { DEFAULT_TEMPLATE, buildFilenameFrom } from "./shared.js";

const statusElement = document.querySelector("#status");
const toastEl = document.querySelector("#toast");
const buttons = [...document.querySelectorAll(".capture-button")];
const delaySelect = document.querySelector("#delaySelect");
const historySection = document.querySelector("#historySection");
const historyStrip = document.querySelector("#historyStrip");
const clearHistoryBtn = document.querySelector("#clearHistory");
const tplInput = document.querySelector("#filenameTemplate");
const colorInput = document.querySelector("#defaultColor");
const includeStickyInput = document.querySelector("#includeSticky");
const previewEl = document.querySelector("#filenamePreview");
let countdownTimer = null;
let toastTimer = null;

const SETTINGS_KEY = "snapCanvasSettings";
const HISTORY_KEY = "recentCaptures";
const CAPTURE_KEY = "latestCapture";
const LAST_ERROR_KEY = "lastCaptureError";
const DEFAULTS = { filenameTemplate: DEFAULT_TEMPLATE, defaultColor: "#43a047", includeSticky: false };

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

function updatePreview(){
  if(!previewEl || !tplInput) return;
  const tpl = tplInput.value.trim() || DEFAULT_TEMPLATE;
  const preview = buildFilenameFrom(tpl, { domain: "example.com", title: "Example Title", mode: "full" });
  const over = tpl.length > 80 ? " (template is long — final name is truncated)" : "";
  previewEl.textContent = `Preview: ${preview}${over}`;
}

async function loadSettings() {
  try {
    const { [SETTINGS_KEY]: s = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    const cur = { ...DEFAULTS, ...s };
    if (tplInput) tplInput.value = cur.filenameTemplate;
    if (colorInput) colorInput.value = cur.defaultColor;
    if (includeStickyInput) includeStickyInput.checked = !!cur.includeSticky;
    updatePreview();
    return cur;
  } catch { updatePreview(); return DEFAULTS; }
}
async function saveSettings() {
  const next = {
    filenameTemplate: tplInput?.value?.trim() || DEFAULTS.filenameTemplate,
    defaultColor: colorInput?.value || DEFAULTS.defaultColor,
    includeSticky: !!includeStickyInput?.checked
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  updatePreview();
  toast("Settings saved");
}

async function showLastErrorIfAny(){
  try{
    const { [LAST_ERROR_KEY]: err } = await chrome.storage.local.get(LAST_ERROR_KEY);
    if(err?.message && Date.now() - (err.at||0) < 30000){
      setStatus(err.message, true);
      toast(err.message);
      // clear after shown
      await chrome.storage.local.remove(LAST_ERROR_KEY);
      try{ await chrome.action.setBadgeText({text:""}); }catch{}
    }
  }catch{}
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
      btn.setAttribute("role","listitem");
      btn.tabIndex = 0;
      btn.title = `${item.domain} — ${new Date(item.capturedAt).toLocaleString()} (Enter to open)`;
      const img = document.createElement("img");
      img.src = item.thumbUrl || item.dataUrl;
      img.alt = "";
      img.loading = "lazy";
      const label = document.createElement("span");
      label.textContent = `${item.domain} · ${item.mode}`;
      btn.append(img, label);
      async function openHistory(){
        await chrome.storage.local.set({ [CAPTURE_KEY]: { dataUrl: item.dataUrl, mode: item.mode, capturedAt: new Date().toISOString(), domain: item.domain, title: item.title } });
        chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
      }
      btn.addEventListener("click", openHistory);
      btn.addEventListener("keydown", (e)=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); openHistory(); } });
      historyStrip.appendChild(btn);
    }
  } catch { historySection.hidden = true; }
}

function syncDelayForMode(mode){
  // Desktop UX: delay is meaningless for Selected area (you drag when ready). Show disabled state on hover/focus so laptop users discover it before clicking.
  const isSelected = mode === "selected";
  if(delaySelect){
    delaySelect.disabled = isSelected;
    delaySelect.title = isSelected ? "Delay does not apply to Selected area (you control timing by dragging)" : "";
  }
}
async function capture(mode) {
  const delayMs = (delaySelect?.disabled ? 0 : parseInt(delaySelect.value, 10) || 0);
  const includeSticky = !!includeStickyInput?.checked;
  delaySelect.disabled = mode === "selected";
  setStatus(`Starting ${mode} capture...`);
  buttons.forEach((b) => (b.disabled = true));
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.windowId) throw new Error("No active tab available.");
    const response = await chrome.runtime.sendMessage({ type: "START_CAPTURE", mode, tabId: tab.id, windowId: tab.windowId, delayMs, includeSticky });
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

buttons.forEach((b) => {
  b.addEventListener("click", () => capture(b.dataset.mode));
  // Laptop/desktop: hint that delay is ignored for Selected area before the user clicks
  b.addEventListener("mouseenter", () => syncDelayForMode(b.dataset.mode));
  b.addEventListener("focus", () => syncDelayForMode(b.dataset.mode));
});
// Reset delay UI when leaving actions area
const actionsEl = document.querySelector(".actions");
actionsEl?.addEventListener("mouseleave", () => { if(delaySelect) { delaySelect.disabled = false; delaySelect.title = ""; } });
document.querySelector(".options")?.addEventListener("mouseenter", () => { if(delaySelect) { delaySelect.disabled = false; delaySelect.title = ""; } });
// Laptop/desktop: keyboard accelerators 1/2/3 for Full/Visible/Selected
window.addEventListener("keydown", (e) => {
  if(e.target.closest && e.target.closest("input, select, textarea")) return;
  if(e.key==="1") capture("full");
  if(e.key==="2") capture("visible");
  if(e.key==="3") capture("selected");
  if(e.key==="Escape") window.close();
});
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
tplInput?.addEventListener("input", updatePreview);
tplInput?.addEventListener("change", saveSettings);
colorInput?.addEventListener("change", saveSettings);
includeStickyInput?.addEventListener("change", saveSettings);

// Init
loadSettings();
renderHistory();
showLastErrorIfAny();
chrome.storage.onChanged?.addListener((changes) => {
  if (changes[HISTORY_KEY]) renderHistory();
  if (changes[LAST_ERROR_KEY] && changes[LAST_ERROR_KEY].newValue) {
    const err = changes[LAST_ERROR_KEY].newValue;
    if(err?.message) { setStatus(err.message, true); toast(err.message); }
  }
});
