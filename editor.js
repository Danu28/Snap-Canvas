const STORAGE_KEY = "latestCapture";
const STROKE = 4;
const FONT_SIZE = 22;
const FONT_MIN = 8;
const FONT_MAX = 200;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
const HISTORY_LIMIT = 50;

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
const toolButtons = [...document.querySelectorAll(".tool-button")];
const colorSwatches = [...document.querySelectorAll(".color-swatch")];
const undoButton = document.querySelector("#undoButton");
const redoButton = document.querySelector("#redoButton");
const copyButton = document.querySelector("#copyButton");
const clearButton = document.querySelector("#clearButton");
const downloadButton = document.querySelector("#downloadButton");

let captureImage = null;
let currentTool = "rectangle";
let activeColor = "#43a047";
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
// measureText widths are deterministic per (value, fontSize) and zoom-independent
// (canvas-space metrics) — cached so select-mode pointermoves don't re-shape text.
const textWidthCache = new Map();

colorSwatches.forEach((btn) => {
  btn.style.setProperty("--swatch", btn.dataset.color);
});

initialize().catch((error) => {
  setStatus(error.message || "Unable to initialize editor.");
});

async function initialize() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const capture = stored[STORAGE_KEY];

  if (!capture?.dataUrl) {
    throw new Error("No captured image found. Take a screenshot first.");
  }

  captureImage = await loadImage(capture.dataUrl);
  canvas.width = captureImage.width;
  canvas.height = captureImage.height;
  // The photo lives in the <img> layer (browser-decoded once); the canvas
  // buffer holds only annotations, so per-move redraws never re-composite it.
  if (photo) {
    photo.src = capture.dataUrl;
  }
  fitToWidth();
  annotations = [];
  historyStack = [[]];
  redoStack = [];
  redraw();
  bindEvents();
  updateActionStates();
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

function bindEvents() {
  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentTool = button.dataset.tool;
      toolButtons.forEach((tool) => tool.classList.toggle("is-active", tool === button));
      canvas.classList.toggle("selecting", currentTool === "select");
      setStatus(`Tool selected: ${currentTool}.`);
    });
  });

  colorSwatches.forEach((button) => {
    button.addEventListener("click", () => {
      activeColor = button.dataset.color;
      colorSwatches.forEach((swatch) => swatch.classList.toggle("is-active", swatch === button));
      setStatus(`Color: ${(button.title || activeColor).toLowerCase()}.`);
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
  zoomInButton.addEventListener("click", () => setZoom(zoom * ZOOM_STEP));
  zoomOutButton.addEventListener("click", () => setZoom(zoom / ZOOM_STEP));
  fitButton.addEventListener("click", fitToWidth);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  fontSizeDec.addEventListener("click", () => applyFontSize(activeFontSize - 2));
  fontSizeInc.addEventListener("click", () => applyFontSize(activeFontSize + 2));
  fontSizeInput.addEventListener("input", () => {
    const value = parseInt(fontSizeInput.value, 10);
    if (Number.isFinite(value)) activeFontSize = value;
  });
  fontSizeInput.addEventListener("change", () => applyFontSize(fontSizeInput.value));
}

function onPointerDown(event) {
  if (textEditor) {
    return; // the blur handler commits the open text editor
  }

  const point = getCanvasPoint(event);

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
  if (panning) {
    panning = false;
    panStart = null;
    if (!spaceDown) {
      canvasWrap.classList.remove("panning");
    }
    return;
  }

  if (resizeState || dragTarget >= 0) {
    resizeState = null;
    dragTarget = -1;
    dragOffset = null;
    commitHistory();
    redraw();
    setStatus("Annotation updated.");
    return;
  }

  if (dragTextIndex >= 0) {
    dragTextIndex = -1;
    dragOffset = null;
    commitHistory();
    setStatus("Text moved.");
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
  const left = canvasRect.left + (point.x / captureImage.width) * canvasRect.width;
  const top = canvasRect.top + (point.y / captureImage.height) * canvasRect.height;

  textEditor = document.createElement("textarea");
  textEditor.className = "text-editor-overlay";
  textEditor.style.left = `${left}px`;
  textEditor.style.top = `${top}px`;
  textEditor.style.fontSize = `${activeFontSize}px`;
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
    const width = measureTextWidth(a.value, fontSize);
    const height = fontSize * 1.2;
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
    if (a.type === "rectangle") {
      if (
        point.x >= a.x - 4 &&
        point.x <= a.x + a.width + 4 &&
        point.y >= a.y - 4 &&
        point.y <= a.y + a.height + 4
      ) {
        return i;
      }
    } else if (a.type === "arrow") {
      if (
        distToSegment(point, { x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }) <= 10
      ) {
        return i;
      }
    } else if (a.type === "text" && hitTestText(point) === i) {
      return i;
    }
  }
  return -1;
}

function distToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function hitTestHandle(point) {
  if (selectedIndex < 0) {
    return null;
  }

  const a = annotations[selectedIndex];
  const RADIUS = 14;

  if (a.type === "rectangle") {
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
}

function drawHandles(ctx = context) {
  if (selectedIndex < 0) {
    return;
  }

  const a = annotations[selectedIndex];
  ctx.strokeStyle = "#ffb300";
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;

  if (a.type === "rectangle") {
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
    const width = measureTextWidth(a.value, fontSize, ctx);
    const height = fontSize * 1.2;
    const corners = [
      [a.x - 2, a.y - 2],
      [a.x + width + 2, a.y - 2],
      [a.x - 2, a.y + height + 2],
      [a.x + width + 2, a.y + height + 2]
    ];
    for (const [hx, hy] of corners) {
      drawHandleSquare(hx, hy, ctx);
    }
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
  drawHandles(compositeContext);
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
  }
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

  if (a.type === "arrow") {
    drawArrow(a.x1, a.y1, a.x2, a.y2, a.color, ctx);
    return;
  }

  if (a.type === "text") {
    ctx.font = `700 ${a.fontSize || FONT_SIZE}px Georgia, serif`;
    ctx.textBaseline = "top";
    ctx.fillText(a.value, a.x, a.y);
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
  redoStack.length = 0; // any new edit invalidates the redo history
  updateActionStates();
}

function cloneAnnotations(list) {
  return list.map((a) => ({ ...a }));
}

function downloadImage() {
  const link = document.createElement("a");
  link.href = renderComposite().toDataURL("image/png");
  link.download = `pagesnap-${Date.now()}.png`;
  link.click();
  setStatus("PNG download started.");
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
}

// Keep undo/redo/clear affordances honest: grey them out (but keep them
// clickable-safe) when there is nothing to act on.
function updateActionStates() {
  undoButton.disabled = historyStack.length <= 1;
  redoButton.disabled = redoStack.length === 0;
  clearButton.disabled = annotations.length === 0;
}

// Read a font-size value (px) clamped to [FONT_MIN, FONT_MAX]; keeps the input
// box and the text tool in sync. Empty/invalid input falls back to the current size.
function applyFontSize(value) {
  let size = parseInt(value, 10);
  if (!Number.isFinite(size)) size = activeFontSize || FONT_SIZE;
  size = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
  activeFontSize = size;
  fontSizeInput.value = String(size);
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
    parseFloat(wrapStyle.paddingLeft) + parseFloat(wrapStyle.paddingRight) +
    parseFloat(wrapStyle.borderLeftWidth) + parseFloat(wrapStyle.borderRightWidth) +
    parseFloat(areaStyle.paddingLeft) + parseFloat(areaStyle.paddingRight);
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
}

function startPan(event) {
  if (event.button === 1) {
    event.preventDefault(); // block middle-click autoscroll
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

function onKeyDown(event) {
  const activeTag = document.activeElement?.tagName || "";
  if (activeTag === "TEXTAREA" || activeTag === "INPUT") {
    return; // typing in the text editor — browser handles its own keys
  }

  if (event.code === "Escape" && selectedIndex >= 0) {
    selectedIndex = -1;
    redraw();
    setStatus("Deselected.");
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
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

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function normalizeRect(from, to) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y)
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
