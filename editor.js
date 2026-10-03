import { buildFilenameFrom } from "./shared.js";
import { cloneAnnotations, HISTORY_LIMIT } from "./modules/history.js";
import {
  invalidateRedactCache as invalidateRedactCacheMod,
  drawRedact as drawRedactMod
} from "./modules/redact.js";
import { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from "./modules/zoom.js";
import {
  normalizeRect,
  distToSegment,
  snapshotGeometry,
  geometryChanged
} from "./modules/annotations.js";
import { idbGet as idbGetMod, idbPut as idbPutMod } from "./modules/idb.js";

const STORAGE_KEY = "latestCapture";
const STROKE = 4;
const FONT_SIZE = 22;
const FONT_MIN = 8;
const FONT_MAX = 200;
const AUTO_SAVE_KEY = "snapCanvasAutoSave";

const canvas = document.querySelector("#editorCanvas");
const photo = document.querySelector("#editorPhoto");
const canvasArea = document.querySelector(".canvas-area");
const canvasWrap = document.querySelector(".canvas-wrap");
const zoomLabel = document.querySelector("#zoomLabel");
const zoomInButton = document.querySelector("#zoomInButton");
const zoomOutButton = document.querySelector("#zoomOutButton");
const fitButton = document.querySelector("#fitButton");
const fontSizeInput = document.querySelector("#fontSizeInput");
const fontSizeDec = document.querySelector("#fontSizeDec");
const fontSizeInc = document.querySelector("#fontSizeInc");
const context = canvas.getContext("2d");
const statusElement = document.querySelector("#editorStatus");
const helpModal = document.querySelector("#helpModal");
const helpButton = document.querySelector("#helpButton");
const toastEl = document.querySelector("#toast");
const SETTINGS_KEY = "snapCanvasSettings";
const toolButtons = [...document.querySelectorAll(".tool-button")];
const colorSwatches = [...document.querySelectorAll(".color-swatch")];
const undoButton = document.querySelector("#undoButton");
const redoButton = document.querySelector("#redoButton");
const copyButton = document.querySelector("#copyButton");
const clearButton = document.querySelector("#clearButton");
const downloadButton = document.querySelector("#downloadButton");
const cropButton = document.querySelector("#cropButton");

let captureImage = null;
let currentTool = "rectangle";
let activeColor = "#43a047";
let captureMeta = null;
let toastTimer = null;
let annotations = [];
let historyStack = [[]];
let redoStack = [];
let drawing = false;
let startPoint = null;
let dragTextIndex = -1;
let dragOffset = null;
let zoom = 1;
let spaceDown = false;
let panning = false;
let panStart = null;
let activeFontSize = FONT_SIZE;
let textEditor = null;
let textEditorMeta = null;
let selectedIndex = -1;
let dragTarget = -1;
let resizeState = null;
let dragSnapshot = null; // annotation geometry at drag/resize start (no-op-commit suppression)
let cachedRect = null; // ponytail: cached bounding rect during drag to avoid layout thrash (invalidated on up/zoom)
// measureText widths are deterministic per (value, fontSize) and zoom-independent
// (canvas-space metrics) — cached so select-mode pointermoves don't re-shape text.
const textWidthCache = new Map();
let autoSaveTimer = null;
let nudgeTimer = null;
let nudgeGroupStart = null;
let nudgeGrouping = false;

colorSwatches.forEach((btn) => {
  btn.style.setProperty("--swatch", btn.dataset.color);
});

initialize().catch((error) => {
  setStatus(error.message || "Unable to initialize editor.");
});

function showToast(msg, ms = 2400) {
  if (!toastEl) return setStatus(msg);
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}
async function loadPresets() {
  try {
    const { [SETTINGS_KEY]: s = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    if (s.defaultColor) activeColor = s.defaultColor;
    if (typeof s.fontSize === "number")
      activeFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, s.fontSize));
  } catch {}
  // sync swatches
  colorSwatches.forEach((sw) => sw.classList.toggle("is-active", sw.dataset.color === activeColor));
  fontSizeInput.value = String(activeFontSize);
}
async function getCaptureDataUrl(capture) {
  if (capture?.dataUrl) return capture.dataUrl;
  if (capture?.idb && capture?.captureId) {
    try {
      const url = await idbGetMod(capture.captureId);
      if (url) return url;
    } catch {}
  }
  if (capture?.captureId) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "GET_CAPTURE_BLOB",
        id: capture.captureId
      });
      if (resp?.ok && resp.dataUrl) return resp.dataUrl;
    } catch {}
  }
  return null;
}
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      const payload = {
        captureId: captureMeta?.captureId || captureMeta?.capturedAt || "default",
        annotations: cloneAnnotations(annotations),
        at: Date.now()
      };
      if (chrome.storage.session) await chrome.storage.session.set({ [AUTO_SAVE_KEY]: payload });
      else await chrome.storage.local.set({ [AUTO_SAVE_KEY]: payload });
    } catch {}
  }, 800);
}
async function restoreAutoSave() {
  try {
    let stored = null;
    if (chrome.storage.session) {
      const r = await chrome.storage.session.get(AUTO_SAVE_KEY);
      stored = r[AUTO_SAVE_KEY];
    }
    if (!stored) {
      const r = await chrome.storage.local.get(AUTO_SAVE_KEY);
      stored = r[AUTO_SAVE_KEY];
    }
    if (!stored || !stored.annotations || !Array.isArray(stored.annotations)) return;
    const curId = captureMeta?.captureId || captureMeta?.capturedAt;
    if (stored.captureId !== curId) return;
    if (stored.annotations.length === 0) return;
    if (Date.now() - (stored.at || 0) > 3600000) return;
    showRestoreBanner(stored.annotations);
  } catch {}
}
// Non-blocking restore prompt. confirm() here would freeze the editor at load
// (and Playwright/harness auto-dismiss dialogs, making the path untestable).
function showRestoreBanner(pending) {
  const bar = document.createElement("div");
  bar.id = "restoreBanner";
  bar.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `Restore ${pending.length} unsaved annotation(s)?`;
  const yes = document.createElement("button");
  yes.textContent = "Restore";
  yes.className = "primary";
  yes.type = "button";
  const no = document.createElement("button");
  no.textContent = "Dismiss";
  no.type = "button";
  const close = async () => {
    bar.remove();
  };
  yes.addEventListener("click", () => {
    annotations = cloneAnnotations(pending);
    historyStack = [cloneAnnotations([]), cloneAnnotations(annotations)];
    redoStack = [];
    redraw();
    updateActionStates();
    setStatus("Restored unsaved work.");
    showToast("Restored");
    close();
  });
  no.addEventListener("click", () => {
    close();
    clearAutoSave();
  });
  bar.append(text, yes, no);
  document.body.appendChild(bar);
  setTimeout(() => {
    if (document.body.contains(bar)) close();
  }, 15000);
}
async function clearAutoSave() {
  try {
    if (chrome.storage.session) await chrome.storage.session.remove(AUTO_SAVE_KEY);
    await chrome.storage.local.remove(AUTO_SAVE_KEY);
  } catch {}
}
async function persistPreset() {
  try {
    const { [SETTINGS_KEY]: cur = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...cur, defaultColor: activeColor, fontSize: activeFontSize }
    });
  } catch {}
}
async function initialize() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  let capture = stored[STORAGE_KEY];

  if (!capture || (!capture.dataUrl && !capture.idb)) {
    throw new Error("No captured image found. Take a screenshot first.");
  }
  const dataUrl = await getCaptureDataUrl(capture);
  if (!dataUrl) throw new Error("Unable to load capture (storage expired). Take a new screenshot.");
  captureMeta = capture;
  captureImage = await loadImage(dataUrl);
  canvas.width = captureImage.width;
  canvas.height = captureImage.height;
  // The photo lives in the <img> layer (browser-decoded once); the canvas
  // buffer holds only annotations, so per-move redraws never re-composite it.
  if (photo) {
    photo.src = dataUrl;
  }
  await loadPresets();
  fitToWidth();
  annotations = [];
  historyStack = [[]];
  redoStack = [];
  redraw();
  bindEvents();
  updateActionStates();
  restoreAutoSave();
  updateFilenamePreview();
  chrome.storage.onChanged?.addListener((changes) => {
    if (changes[SETTINGS_KEY]) {
      const s = changes[SETTINGS_KEY].newValue || {};
      if (s.defaultColor && s.defaultColor !== activeColor) {
        activeColor = s.defaultColor;
        colorSwatches.forEach((sw) =>
          sw.classList.toggle("is-active", sw.dataset.color === activeColor)
        );
      }
      if (typeof s.fontSize === "number" && s.fontSize !== activeFontSize) {
        activeFontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, s.fontSize));
        fontSizeInput.value = String(activeFontSize);
      }
      updateFilenamePreview();
    }
  });
  setStatus(
    `Ready to annotate your ${capture.mode} capture.${getExtensionVersion() ? ` (v${getExtensionVersion()})` : ""}`
  );
  console.info("SnapCanvas editor ready", getExtensionVersion() || "(unknown version)");
}

function getExtensionVersion() {
  try {
    return chrome.runtime.getManifest?.().version || "";
  } catch {
    return "";
  }
}

function setActiveTool(tool) {
  currentTool = tool;
  toolButtons.forEach((btn) => {
    const on = btn.dataset.tool === tool;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  canvas.classList.toggle("selecting", currentTool === "select");
  updateActionStates();
  setStatus(`Tool selected: ${currentTool}.`);
}
function bindEvents() {
  toolButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTool(button.dataset.tool));
  });

  colorSwatches.forEach((button, idx) => {
    button.addEventListener("click", () => {
      activeColor = button.dataset.color;
      colorSwatches.forEach((swatch) => swatch.classList.toggle("is-active", swatch === button));
      persistPreset();
      if (selectedIndex >= 0) {
        const a = annotations[selectedIndex];
        if (a.color !== activeColor) {
          a.color = activeColor;
          commitHistory();
          redraw();
          setStatus("Color applied to selection.");
          showToast("Color updated");
          return;
        }
      }
      setStatus(`Color: ${(button.title || activeColor).toLowerCase()}.`);
    });
    // Laptop/desktop keyboard: arrow keys move focus across swatches, Enter/Space selects
    button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = (idx + dir + colorSwatches.length) % colorSwatches.length;
        colorSwatches[next].focus();
      }
    });
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  undoButton.addEventListener("click", undo);
  redoButton.addEventListener("click", redo);
  copyButton.addEventListener("click", copyImage);
  clearButton.addEventListener("click", clearAll);
  downloadButton.addEventListener("click", downloadImage);
  cropButton?.addEventListener("click", cropToSelection);
  zoomInButton.addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  zoomOutButton.addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  fitButton.addEventListener("click", fitToWidth);
  zoomLabel.addEventListener("click", () => setZoom(1));
  helpButton?.addEventListener("click", () => {
    helpModal?.showModal();
    trapFocus(helpModal);
  });
  helpModal?.addEventListener("close", () => {
    canvas.focus?.();
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  fontSizeDec.addEventListener("click", () => applyFontSize(activeFontSize - 2));
  fontSizeInc.addEventListener("click", () => applyFontSize(activeFontSize + 2));
  fontSizeInput.addEventListener("input", () => {
    const value = parseInt(fontSizeInput.value, 10);
    if (Number.isFinite(value)) activeFontSize = value;
  });
  fontSizeInput.addEventListener("change", () => {
    applyFontSize(fontSizeInput.value);
    persistPreset();
  });
}
function trapFocus(dialog) {
  if (!dialog) return;
  const focusables = [
    ...dialog.querySelectorAll(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"
    )
  ];
  if (!focusables.length) return;
  const first = focusables[0],
    last = focusables[focusables.length - 1];
  function onKey(e) {
    if (e.key !== "Tab") return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  dialog.addEventListener("keydown", onKey);
  dialog.addEventListener(
    "close",
    function cleanup() {
      dialog.removeEventListener("keydown", onKey);
      dialog.removeEventListener("close", cleanup);
    },
    { once: true }
  );
  setTimeout(() => first.focus(), 30);
}

// Geometry snapshot for no-op-commit suppression: capture the annotation's
// shape when a drag/resize/text-move begins; if it's unchanged on pointerup,
// skip commitHistory so undo never records a do-nothing edit.
function onPointerDown(event) {
  if (textEditor) {
    return; // the blur handler commits the open text editor
  }
  cachedRect = canvas.getBoundingClientRect();
  const point = getCanvasPoint(event, cachedRect);

  if (spaceDown || event.button === 1) {
    startPan(event);
    return;
  }

  if (currentTool === "text") {
    const hit = hitTestText(point);
    if (hit >= 0) {
      dragTextIndex = hit;
      const t = annotations[hit];
      dragOffset = { x: point.x - t.x, y: point.y - t.y };
      dragSnapshot = snapshotGeometry(t);
      canvas.setPointerCapture(event.pointerId);
      setStatus("Dragging text.");
      return;
    }

    // preventDefault stops the browser's mousedown focus-management from
    // stealing focus from the textarea we're about to create (which would blur
    // and instantly commit-cancel it).
    event.preventDefault();
    showTextEditor(point);
    return;
  }

  if (currentTool === "select") {
    const handle = hitTestHandle(point);
    if (handle) {
      resizeState = { index: selectedIndex, ...handle };
      dragSnapshot = snapshotGeometry(annotations[selectedIndex]);
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    const hit = hitTestAnnotation(point);
    if (hit >= 0) {
      selectedIndex = hit;
      dragTarget = hit;
      const a = annotations[hit];
      dragOffset =
        a.type === "arrow"
          ? { x: point.x - a.x1, y: point.y - a.y1 }
          : { x: point.x - a.x, y: point.y - a.y };
      dragSnapshot = snapshotGeometry(a);
      redraw();
      setStatus("Selected. Drag to move, drag handles to resize.");
    } else {
      selectedIndex = -1;
      redraw();
      setStatus("Nothing selected.");
    }
    canvas.setPointerCapture(event.pointerId);
    return;
  }

  drawing = true;
  startPoint = point;
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (panning && panStart) {
    canvasArea.scrollLeft = panStart.scrollLeft - (event.clientX - panStart.x);
    canvasArea.scrollTop = panStart.scrollTop - (event.clientY - panStart.y);
    return;
  }

  const point = getCanvasPoint(event);

  if (resizeState) {
    applyResize(resizeState, point);
    redraw();
    return;
  }

  if (dragTarget >= 0) {
    const a = annotations[dragTarget];
    invalidateRedactCache(a);
    if (a.type === "arrow") {
      const nextX1 = point.x - dragOffset.x;
      const nextY1 = point.y - dragOffset.y;
      a.x2 += nextX1 - a.x1;
      a.y2 += nextY1 - a.y1;
      a.x1 = nextX1;
      a.y1 = nextY1;
    } else {
      a.x = point.x - dragOffset.x;
      a.y = point.y - dragOffset.y;
    }
    redraw();
    return;
  }

  if (dragTextIndex >= 0) {
    const t = annotations[dragTextIndex];
    t.x = point.x - dragOffset.x;
    t.y = point.y - dragOffset.y;
    redraw();
    return;
  }

  if (!drawing || !startPoint) {
    return;
  }

  redraw();
  drawPreview(startPoint, point);
}

function onPointerUp(event) {
  cachedRect = null;
  if (panning) {
    panning = false;
    panStart = null;
    if (!spaceDown) {
      canvasWrap.classList.remove("panning");
    }
    return;
  }

  if (resizeState || dragTarget >= 0) {
    const target = resizeState ? annotations[resizeState.index] : annotations[dragTarget];
    const changed = geometryChanged(target, dragSnapshot);
    resizeState = null;
    dragTarget = -1;
    dragOffset = null;
    dragSnapshot = null;
    if (changed) {
      commitHistory();
      setStatus("Annotation updated.");
    } else {
      setStatus("No change.");
    }
    redraw();
    return;
  }

  if (dragTextIndex >= 0) {
    const changed = geometryChanged(annotations[dragTextIndex], dragSnapshot);
    dragTextIndex = -1;
    dragOffset = null;
    dragSnapshot = null;
    if (changed) {
      commitHistory();
      setStatus("Text moved.");
    } else {
      setStatus("No change.");
    }
    redraw();
    return;
  }

  if (!drawing || !startPoint) {
    return;
  }

  drawing = false;
  const endPoint = getCanvasPoint(event);
  const dx = Math.abs(endPoint.x - startPoint.x);
  const dy = Math.abs(endPoint.y - startPoint.y);

  if (dx >= 2 || dy >= 2) {
    if (currentTool === "rectangle") {
      const rect = normalizeRect(startPoint, endPoint);
      annotations.push({
        type: "rectangle",
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        color: activeColor
      });
    } else if (currentTool === "arrow") {
      annotations.push({
        type: "arrow",
        x1: startPoint.x,
        y1: startPoint.y,
        x2: endPoint.x,
        y2: endPoint.y,
        color: activeColor
      });
    } else if (currentTool === "blur" || currentTool === "pixel") {
      const rect = normalizeRect(startPoint, endPoint);
      annotations.push({ type: "redact", mode: currentTool, ...rect });
    }
    commitHistory();
    setStatus("Annotation added.");
  }

  startPoint = null;
  redraw();
}

function showTextEditor(point) {
  if (textEditor) {
    // Self-heal a stale editor left behind by a crashed commit (should not
    // normally happen; onPointerDown already early-returns while one is open).
    textEditor.remove();
    textEditor = null;
    textEditorMeta = null;
  }

  textEditorMeta = { x: point.x, y: point.y, color: activeColor, fontSize: activeFontSize };

  // Position the overlay at the canvas-space point, mapped to screen space at current zoom.
  const canvasRect = canvas.getBoundingClientRect();
  let left = canvasRect.left + (point.x / captureImage.width) * canvasRect.width;
  let top = canvasRect.top + (point.y / captureImage.height) * canvasRect.height;
  // Desktop clamp: keep editor inside viewport near edges (laptop window edges)
  const vw = window.innerWidth,
    vh = window.innerHeight;
  const margin = 12;
  left = Math.max(margin, Math.min(left, vw - 272));
  top = Math.max(margin, Math.min(top, vh - 96));

  textEditor = document.createElement("textarea");
  textEditor.className = "text-editor-overlay";
  textEditor.style.left = `${left}px`;
  textEditor.style.top = `${top}px`;
  textEditor.style.fontSize = `${activeFontSize * zoom}px`;
  textEditor.style.color = activeColor;
  document.body.appendChild(textEditor);
  textEditor.focus();

  textEditor.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeTextEditor(null);
      event.stopPropagation();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      closeTextEditor(textEditor.value);
      event.stopPropagation();
    }
  });

  textEditor.addEventListener("blur", () => {
    // Re-entrant blur fires synchronously from remove() inside closeTextEditor;
    // by then textEditor is already null, so skip (the caller is committing).
    if (textEditor) {
      closeTextEditor(textEditor.value);
    }
  });

  setStatus("Type text. Enter to place, Shift+Enter for a new line, Esc to cancel.");
}

function closeTextEditor(value) {
  if (!textEditor || !textEditorMeta) {
    return;
  }

  const meta = textEditorMeta;
  const editor = textEditor;
  // Clear state BEFORE remove(): remove() on the focused textarea fires a
  // synchronous blur, which re-enters closeTextEditor via the blur listener.
  // If the state is still set, the re-entrant call removes the already-removed
  // node and throws NotFoundError, aborting this commit.
  textEditor = null;
  textEditorMeta = null;
  editor.remove();

  if (value && value.trim()) {
    annotations.push({
      type: "text",
      x: meta.x,
      y: meta.y,
      value,
      color: meta.color,
      fontSize: meta.fontSize
    });
    commitHistory();
    redraw();
    setStatus("Text added. Click it to drag.");
  } else {
    setStatus("Text cancelled.");
  }
}

function measureTextWidth(value, fontSize, ctx = context) {
  const key = `${fontSize}:${value}`;
  let width = textWidthCache.get(key);
  if (width === undefined) {
    ctx.font = `700 ${fontSize}px Georgia, serif`;
    width = ctx.measureText(value).width;
    textWidthCache.set(key, width);
  }
  return width;
}

function hitTestText(point) {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const a = annotations[i];
    if (a.type !== "text") continue;
    const fontSize = a.fontSize || FONT_SIZE;
    const lineHeight = fontSize * 1.2;
    const lines = String(a.value).split("\n");
    const width = Math.max(...lines.map((l) => measureTextWidth(l, fontSize)), 0);
    const height = lineHeight * lines.length;
    if (
      point.x >= a.x - 4 &&
      point.x <= a.x + width + 4 &&
      point.y >= a.y - 4 &&
      point.y <= a.y + height + 4
    ) {
      return i;
    }
  }
  return -1;
}

function hitTestAnnotation(point) {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const a = annotations[i];
    if (a.type === "rectangle" || a.type === "redact") {
      if (
        point.x >= a.x - 4 &&
        point.x <= a.x + a.width + 4 &&
        point.y >= a.y - 4 &&
        point.y <= a.y + a.height + 4
      ) {
        return i;
      }
    } else if (a.type === "arrow") {
      if (distToSegment(point, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= 10) {
        return i;
      }
    } else if (a.type === "text" && hitTestText(point) === i) {
      return i;
    }
  }
  return -1;
}

function hitTestHandle(point) {
  if (selectedIndex < 0) {
    return null;
  }

  const a = annotations[selectedIndex];
  const RADIUS = 14;

  if (a.type === "rectangle" || a.type === "redact") {
    const corners = {
      nw: [a.x, a.y],
      ne: [a.x + a.width, a.y],
      sw: [a.x, a.y + a.height],
      se: [a.x + a.width, a.y + a.height]
    };
    for (const [name, [hx, hy]] of Object.entries(corners)) {
      if (Math.hypot(point.x - hx, point.y - hy) <= RADIUS) {
        return { kind: "rect", handle: name };
      }
    }
  } else if (a.type === "arrow") {
    if (Math.hypot(point.x - a.x1, point.y - a.y1) <= RADIUS) {
      return { kind: "arrow", handle: "start" };
    }
    if (Math.hypot(point.x - a.x2, point.y - a.y2) <= RADIUS) {
      return { kind: "arrow", handle: "end" };
    }
  }

  return null;
}

function applyResize(state, point) {
  const a = annotations[state.index];
  invalidateRedactCache(a);
  if (state.kind === "arrow") {
    if (state.handle === "start") {
      a.x1 = point.x;
      a.y1 = point.y;
    } else {
      a.x2 = point.x;
      a.y2 = point.y;
    }
    return;
  }

  const { x, y, width, height } = a;
  const handle = state.handle;
  let nextX = x;
  let nextY = y;
  let nextWidth = width;
  let nextHeight = height;

  if (handle.includes("e")) {
    nextWidth = Math.max(8, point.x - x);
  }
  if (handle.includes("s")) {
    nextHeight = Math.max(8, point.y - y);
  }
  if (handle.includes("w")) {
    const right = x + width;
    nextX = Math.min(point.x, right - 8);
    nextWidth = Math.max(8, right - nextX);
  }
  if (handle.includes("n")) {
    const bottom = y + height;
    nextY = Math.min(point.y, bottom - 8);
    nextHeight = Math.max(8, bottom - nextY);
  }

  Object.assign(a, { x: nextX, y: nextY, width: nextWidth, height: nextHeight });
  invalidateRedactCache(a);
}

function drawHandles(ctx = context) {
  if (selectedIndex < 0) {
    return;
  }

  const a = annotations[selectedIndex];
  ctx.strokeStyle = "#ffb300";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;

  if (a.type === "rectangle" || a.type === "redact") {
    const corners = [
      [a.x, a.y],
      [a.x + a.width, a.y],
      [a.x, a.y + a.height],
      [a.x + a.width, a.y + a.height]
    ];
    for (const [hx, hy] of corners) {
      drawHandleSquare(hx, hy, ctx);
    }
  } else if (a.type === "arrow") {
    drawHandleCircle(a.x1, a.y1, ctx);
    drawHandleCircle(a.x2, a.y2, ctx);
  } else if (a.type === "text") {
    const fontSize = a.fontSize || FONT_SIZE;
    const lineHeight = fontSize * 1.2;
    const lines = String(a.value).split("\n");
    const width = Math.max(...lines.map((l) => measureTextWidth(l, fontSize, ctx)), 0);
    const height = lineHeight * lines.length;
    // Text is not resizable — draw a plain dashed selection outline instead of
    // corner squares (which would imply a resize affordance that doesn't exist).
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(a.x - 2, a.y - 2, width + 4, height + 4);
    ctx.setLineDash([]);
  }
}

function drawHandleSquare(x, y, ctx = context) {
  ctx.beginPath();
  ctx.rect(x - 5, y - 5, 10, 10);
  ctx.fill();
  ctx.stroke();
}

function drawHandleCircle(x, y, ctx = context) {
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function redraw() {
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  for (const a of annotations) {
    drawAnnotation(a);
  }
  drawHandles();
  // Selection state changes go through redraw() on every pointer path; keep the
  // action buttons (crop needs a selected rect) in step here instead of asking
  // each caller to remember.
  updateActionStates();
}

// Full composite (photo + annotations) for download/copy only — rare,
// user-triggered ops; the interactive path never builds it. Re-renders in a
// willReadFrequently context: that hint selects a different anti-aliasing
// rounding path, and matching the original editor context keeps exported
// pixels bit-identical to the pre-layer-split output.
function renderComposite() {
  const composite = document.createElement("canvas");
  composite.width = canvas.width;
  composite.height = canvas.height;
  const compositeContext = composite.getContext("2d", { willReadFrequently: true });
  compositeContext.imageSmoothingEnabled = false;
  compositeContext.drawImage(captureImage, 0, 0);
  for (const a of annotations) {
    drawAnnotation(a, compositeContext);
  }
  return composite;
}

function drawPreview(from, to) {
  if (currentTool === "rectangle") {
    const rect = normalizeRect(from, to);
    drawAnnotation({
      type: "rectangle",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: activeColor
    });
  } else if (currentTool === "arrow") {
    drawAnnotation({
      type: "arrow",
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      color: activeColor
    });
  } else if (currentTool === "blur" || currentTool === "pixel") {
    const rect = normalizeRect(from, to);
    drawAnnotation({ type: "redact", mode: currentTool, ...rect });
  }
}

// Redact rendering delegates to modules/redact.js (single source). Wrappers bind captureImage.
function invalidateRedactCache(a) {
  return invalidateRedactCacheMod(a);
}
function drawRedact(a, ctx) {
  return drawRedactMod(a, ctx, captureImage);
}

function drawAnnotation(a, ctx = context) {
  ctx.lineWidth = STROKE;
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (a.type === "rectangle") {
    ctx.strokeRect(a.x, a.y, a.width, a.height);
    return;
  }

  if (a.type === "redact") {
    drawRedact(a, ctx);
    return;
  }

  if (a.type === "arrow") {
    drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, ctx);
    return;
  }

  if (a.type === "text") {
    const fontSize = a.fontSize || FONT_SIZE;
    ctx.font = `700 ${fontSize}px Georgia, serif`;
    ctx.textBaseline = "top";
    const lineHeight = fontSize * 1.2;
    String(a.value)
      .split("\n")
      .forEach((line, i) => ctx.fillText(line, a.x, a.y + i * lineHeight));
  }
}

function drawArrow(x1, y1, x2, y2, color, ctx = context) {
  const headLength = Math.max(14, STROKE * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 7),
    y2 - headLength * Math.sin(angle - Math.PI / 7)
  );
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 7),
    y2 - headLength * Math.sin(angle + Math.PI / 7)
  );
  ctx.closePath();
  ctx.fill();
}

function undo() {
  if (historyStack.length <= 1) {
    setStatus("Nothing left to undo.");
    return;
  }

  redoStack.push(cloneAnnotations(historyStack[historyStack.length - 1]));
  if (redoStack.length > HISTORY_LIMIT) {
    redoStack.shift();
  }
  historyStack.pop();
  annotations = cloneAnnotations(historyStack[historyStack.length - 1]);
  selectedIndex = -1;
  resetDragState();
  redraw();
  updateActionStates();
  setStatus("Last change undone.");
}

function redo() {
  if (redoStack.length === 0) {
    setStatus("Nothing left to redo.");
    return;
  }

  const state = redoStack.pop();
  historyStack.push(cloneAnnotations(state));
  if (historyStack.length > HISTORY_LIMIT) {
    historyStack.shift();
  }
  annotations = cloneAnnotations(state);
  selectedIndex = -1;
  resetDragState();
  redraw();
  updateActionStates();
  setStatus("Change redone.");
}

function deleteSelected() {
  if (selectedIndex < 0) {
    setStatus("Select an annotation to delete it.");
    return;
  }

  annotations.splice(selectedIndex, 1);
  selectedIndex = -1;
  resetDragState();
  commitHistory();
  redraw();
  setStatus("Annotation deleted.");
}

async function cropToSelection() {
  if (selectedIndex < 0) {
    showToast("Select a rectangle/redaction to crop");
    setStatus("Select a rectangle to crop.");
    return;
  }
  const sel = annotations[selectedIndex];
  if (sel.type !== "rectangle" && sel.type !== "redact") {
    showToast("Crop works on rectangle/redaction");
    return;
  }
  const rx = Math.max(0, Math.floor(sel.x));
  const ry = Math.max(0, Math.floor(sel.y));
  const rw = Math.max(1, Math.floor(sel.width));
  const rh = Math.max(1, Math.floor(sel.height));
  if (rx + rw > captureImage.width || ry + rh > captureImage.height) {
    showToast("Selection out of bounds");
    return;
  }
  const off = new OffscreenCanvas(rw, rh);
  const octx = off.getContext("2d");
  octx.drawImage(captureImage, rx, ry, rw, rh, 0, 0, rw, rh);
  const blob = await off.convertToBlob({ type: "image/png" });
  const newDataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onloadend = () => res(fr.result);
    fr.onerror = () => rej(new Error("crop failed"));
    fr.readAsDataURL(blob);
  });
  const nextAnnotations = [];
  for (const a of annotations) {
    if (a === sel) continue;
    if (a.type === "arrow") {
      const inside =
        a.x1 >= rx &&
        a.x1 <= rx + rw &&
        a.y1 >= ry &&
        a.y1 <= ry + rh &&
        a.x2 >= rx &&
        a.x2 <= rx + rw &&
        a.y2 >= ry &&
        a.y2 <= ry + rh;
      if (!inside) continue;
      nextAnnotations.push({ ...a, x1: a.x1 - rx, y1: a.y1 - ry, x2: a.x2 - rx, y2: a.y2 - ry });
    } else if (a.type === "text") {
      if (a.x < rx || a.x > rx + rw || a.y < ry || a.y > ry + rh) continue;
      nextAnnotations.push({ ...a, x: a.x - rx, y: a.y - ry });
    } else {
      const ax2 = a.x + a.width,
        ay2 = a.y + a.height;
      if (a.x < rx || a.y < ry || ax2 > rx + rw || ay2 > ry + rh) continue;
      nextAnnotations.push({ ...a, x: a.x - rx, y: a.y - ry });
    }
  }
  const newImg = await loadImage(newDataUrl);
  captureImage = newImg;
  canvas.width = newImg.width;
  canvas.height = newImg.height;
  if (photo) photo.src = newDataUrl;
  try {
    const id = captureMeta?.captureId || `cap-${Date.now()}`;
    captureMeta.captureId = id;
    captureMeta.dataUrl = newDataUrl;
    delete captureMeta.idb;
    await chrome.storage.local.set({ [STORAGE_KEY]: captureMeta });
    try {
      await idbPutMod(id, newDataUrl);
    } catch {}
  } catch {}
  annotations = nextAnnotations;
  selectedIndex = -1;
  resetDragState();
  historyStack.push(cloneAnnotations(annotations));
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
  redoStack.length = 0;
  scheduleAutoSave();
  fitToWidth();
  redraw();
  updateActionStates();
  showToast(`Cropped to ${rw}×${rh}`);
  setStatus("Cropped. Undo restores.");
}
// Clear every annotation in one click — undoable via the same history stack
// as any single edit (commitHistory pushes the pre-clear state).
function clearAll() {
  if (annotations.length === 0) {
    setStatus("Nothing to clear.");
    return;
  }

  annotations = [];
  selectedIndex = -1;
  resetDragState();
  commitHistory();
  redraw();
  setStatus("All annotations cleared. Undo restores them.");
}

// Destructive ops (undo/redo/delete) replace or shrink annotations[]; any
// in-flight drag/resize/draw must be abandoned or the next pointermove would
// dereference a stale index.
function resetDragState() {
  drawing = false;
  startPoint = null;
  dragTarget = -1;
  dragTextIndex = -1;
  dragOffset = null;
  dragSnapshot = null;
  resizeState = null;
}

function duplicateSelected() {
  if (selectedIndex < 0) {
    setStatus("Select an annotation to duplicate it.");
    return;
  }

  const copy = cloneAnnotations([annotations[selectedIndex]])[0];
  if (copy.type === "arrow") {
    copy.x1 += 20;
    copy.y1 += 20;
    copy.x2 += 20;
    copy.y2 += 20;
  } else {
    copy.x += 20;
    copy.y += 20;
  }
  annotations.push(copy);
  selectedIndex = annotations.length - 1;
  commitHistory();
  redraw();
  setStatus("Annotation duplicated.");
}

function commitHistory() {
  historyStack.push(cloneAnnotations(annotations));
  if (historyStack.length > HISTORY_LIMIT) {
    historyStack.shift();
  }
  redoStack.length = 0;
  updateActionStates();
  scheduleAutoSave();
}

function filenamePreviewEl() {
  return document.querySelector("#filenamePreview");
}
async function buildFilename() {
  try {
    const { [SETTINGS_KEY]: s = {} } = await chrome.storage.local.get(SETTINGS_KEY);
    return buildFilenameFrom(s.filenameTemplate, {
      domain: captureMeta?.domain || "page",
      title: captureMeta?.title || "",
      mode: captureMeta?.mode || "capture"
    });
  } catch {
    return `pagesnap-${Date.now()}.png`;
  }
}
async function updateFilenamePreview() {
  const el = filenamePreviewEl();
  if (!el) return;
  el.textContent = `Saves as: ${await buildFilename()}`;
}
async function downloadImage() {
  const link = document.createElement("a");
  link.href = renderComposite().toDataURL("image/png");
  link.download = await buildFilename();
  link.click();
  setStatus("PNG download started.");
  showToast(`Saved ${link.download}`);
}

async function copyImage() {
  setStatus("Copying image to clipboard...");

  if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
    setStatus("Clipboard API not supported in this browser. Use download instead.");
    return;
  }

  const blob = await new Promise((resolve) => renderComposite().toBlob(resolve, "image/png"));
  if (!blob) {
    setStatus("Unable to generate clipboard image. Use download instead.");
    return;
  }

  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setStatus("Image copied to clipboard.");
  } catch (error) {
    setStatus(error?.message || "Failed to copy image. Use download instead.");
  }
}

function setStatus(message) {
  statusElement.textContent = message;
  // also toast for important actions (errors already toasted via showToast where needed)
}

// Keep undo/redo/clear affordances honest: grey them out (but keep them
// clickable-safe) when there is nothing to act on.
function updateActionStates() {
  undoButton.disabled = historyStack.length <= 1;
  redoButton.disabled = redoStack.length === 0;
  clearButton.disabled = annotations.length === 0;
  if (cropButton) {
    const canCrop =
      selectedIndex >= 0 &&
      (annotations[selectedIndex]?.type === "rectangle" ||
        annotations[selectedIndex]?.type === "redact");
    cropButton.disabled = !canCrop;
    cropButton.title = canCrop
      ? "Crop to selected rectangle/redaction"
      : "Select a rectangle/redaction first";
  }
  toolButtons.forEach((btn) =>
    btn.setAttribute("aria-pressed", String(btn.dataset.tool === currentTool))
  );
  // Laptop/desktop: zoom limits feedback
  if (zoomInButton) zoomInButton.disabled = zoom >= ZOOM_MAX - 0.001;
  if (zoomOutButton) zoomOutButton.disabled = zoom <= ZOOM_MIN + 0.001;
  if (fontSizeDec) fontSizeDec.disabled = activeFontSize <= FONT_MIN;
  if (fontSizeInc) fontSizeInc.disabled = activeFontSize >= FONT_MAX;
  if (fontSizeInput) {
    fontSizeInput.title = `Text size ${activeFontSize}px (${FONT_MIN}–${FONT_MAX})`;
  }
}

// Read a font-size value (px) clamped to [FONT_MIN, FONT_MAX]; keeps the input
// box and the text tool in sync. Empty/invalid input falls back to the current size.
function applyFontSize(value) {
  let size = parseInt(value, 10);
  if (!Number.isFinite(size)) size = activeFontSize || FONT_SIZE;
  size = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  activeFontSize = size;
  fontSizeInput.value = String(size);
  persistPreset();
  updateActionStates();
  if (selectedIndex >= 0 && annotations[selectedIndex]?.type === "text") {
    annotations[selectedIndex].fontSize = size;
    commitHistory();
    redraw();
    showToast(`Text size ${size}px`);
  }
}

function fitToWidth() {
  // Fit the canvas-wrap's full box (wrap padding+border, plus area padding —
  // clientWidth already includes area padding) into the area's content box.
  // Measured, not hardcoded: the old constant (92) omitted the wrap border,
  // leaving a 2px horizontal overflow (scrollbar) exactly when fit lands just
  // below 1:1 — the browser-100%-zoom layout.
  const wrapStyle = getComputedStyle(canvasWrap);
  const areaStyle = getComputedStyle(canvasArea);
  const sideChrome =
    parseFloat(wrapStyle.paddingLeft) +
    parseFloat(wrapStyle.paddingRight) +
    parseFloat(wrapStyle.borderLeftWidth) +
    parseFloat(wrapStyle.borderRightWidth) +
    parseFloat(areaStyle.paddingLeft) +
    parseFloat(areaStyle.paddingRight);
  const available = Math.max(1, canvasArea.clientWidth - sideChrome);
  const target = Math.min(available, captureImage.width);
  setZoom(Math.min(1, target / captureImage.width));
  canvasArea.scrollLeft = 0;
  canvasArea.scrollTop = 0;
}

function setZoom(value) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
  canvas.style.width = `${Math.round(captureImage.width * zoom)}px`;
  canvas.style.height = `${Math.round(captureImage.height * zoom)}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  updateActionStates();
  // Keep canvas focus so laptop keyboard shortcuts keep working after zoom click
  try {
    canvas.focus({ preventScroll: true });
  } catch {}
}

function startPan(event) {
  if (event.button === 1) {
    event.preventDefault(); // block middle-click autoscroll
  }
  // Capture the pointer so panning keeps tracking even when the cursor leaves
  // the canvas element (e.g. dragging a narrow fit-to-width canvas sideways).
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch {
    // Pointer already released; nothing to capture.
  }
  panning = true;
  panStart = {
    x: event.clientX,
    y: event.clientY,
    scrollLeft: canvasArea.scrollLeft,
    scrollTop: canvasArea.scrollTop
  };
  canvasWrap.classList.add("panning");
}

function nudgeSelected(dx, dy) {
  if (selectedIndex < 0) return false;
  const a = annotations[selectedIndex];
  invalidateRedactCache(a);
  if (a.type === "arrow") {
    a.x1 += dx;
    a.y1 += dy;
    a.x2 += dx;
    a.y2 += dy;
  } else {
    a.x += dx;
    a.y += dy;
  }
  redraw();
  return true;
}
function commitNudgeGroup() {
  if (!nudgeGrouping) return;
  nudgeGrouping = false;
  const changed =
    nudgeGroupStart && selectedIndex >= 0
      ? geometryChanged(annotations[selectedIndex], nudgeGroupStart)
      : true;
  nudgeGroupStart = null;
  if (changed) {
    commitHistory();
  }
}
function onKeyDown(event) {
  const activeTag = document.activeElement?.tagName || "";
  if (activeTag === "TEXTAREA" || activeTag === "INPUT") {
    return; // typing in the text editor — browser handles its own keys
  }

  if (event.key === "?" && !event.ctrlKey && !event.metaKey) {
    helpModal?.showModal();
    event.preventDefault();
    return;
  }

  // Arrow nudge for selected annotation — grouped into one undo (Task 8)
  if (
    selectedIndex >= 0 &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
  ) {
    const step = event.shiftKey ? 10 : 1;
    let dx = 0,
      dy = 0;
    if (event.key === "ArrowUp") dy = -step;
    if (event.key === "ArrowDown") dy = step;
    if (event.key === "ArrowLeft") dx = -step;
    if (event.key === "ArrowRight") dx = step;
    if (!nudgeGrouping) {
      nudgeGrouping = true;
      nudgeGroupStart = snapshotGeometry(annotations[selectedIndex]);
    }
    if (nudgeSelected(dx, dy)) {
      event.preventDefault();
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => commitNudgeGroup(), 400);
      setStatus(`Nudged ${step}px`);
    }
    return;
  }

  if (event.code === "Escape" && selectedIndex >= 0) {
    selectedIndex = -1;
    redraw();
    setStatus("Deselected.");
    return;
  }

  if (event.code === "Escape" && helpModal?.open) {
    helpModal.close();
    return;
  }

  if (event.key === "Delete") {
    deleteSelected();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    redo();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
    event.preventDefault();
    duplicateSelected();
    return;
  }

  // Task 6: single-key tool accelerators
  const key = event.key.toLowerCase();
  const accel = { r: "rectangle", a: "arrow", t: "text", s: "select", b: "blur", p: "pixel" };
  if (accel[key] && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    setActiveTool(accel[key]);
    return;
  }
  // prettier-ignore
  if(key==="0" && !event.ctrlKey && !event.metaKey){
    event.preventDefault();
    fitToWidth();
    setStatus("Fit to width");
    return;
  }

  if (event.code !== "Space") {
    return;
  }

  spaceDown = true;
  canvasWrap.classList.add("panning");
  event.preventDefault();
}

function onKeyUp(event) {
  if (event.code !== "Space") {
    return;
  }

  spaceDown = false;
  if (!panning) {
    canvasWrap.classList.remove("panning");
  }
}

function getCanvasPoint(event, rect = cachedRect) {
  const r = rect || canvas.getBoundingClientRect();
  const scaleX = canvas.width / r.width;
  const scaleY = canvas.height / r.height;

  return {
    x: (event.clientX - r.left) * scaleX,
    y: (event.clientY - r.top) * scaleY
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load the captured image."));
    image.src = src;
  });
}
