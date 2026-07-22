const STORAGE_KEY = "latestCapture";
const STROKE = 4;
const FONT_SIZE = 22;
const FONT = `700 ${FONT_SIZE}px Georgia, serif`;

const canvas = document.querySelector("#editorCanvas");
const context = canvas.getContext("2d");
const statusElement = document.querySelector("#editorStatus");
const toolButtons = [...document.querySelectorAll(".tool-button")];
const colorSwatches = [...document.querySelectorAll(".color-swatch")];
const undoButton = document.querySelector("#undoButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");

let captureImage = null;
let currentTool = "rectangle";
let activeColor = "#e53935";
let annotations = [];
let historyStack = [[]];
let drawing = false;
let startPoint = null;
let dragTextIndex = -1;
let dragOffset = null;

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
  annotations = [];
  historyStack = [[]];
  redraw();
  bindEvents();
  setStatus(`Ready to annotate your ${capture.mode} capture.`);
}

function bindEvents() {
  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      currentTool = button.dataset.tool;
      toolButtons.forEach((tool) => tool.classList.toggle("is-active", tool === button));
      setStatus(`Tool selected: ${currentTool}.`);
    });
  });

  colorSwatches.forEach((button) => {
    button.addEventListener("click", () => {
      activeColor = button.dataset.color;
      colorSwatches.forEach((swatch) => swatch.classList.toggle("is-active", swatch === button));
      setStatus(activeColor === "#e53935" ? "Color: red." : "Color: green.");
    });
  });

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  undoButton.addEventListener("click", undo);
  copyButton.addEventListener("click", copyImage);
  downloadButton.addEventListener("click", downloadImage);
}

function onPointerDown(event) {
  const point = getCanvasPoint(event);

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

    placeText(point);
    return;
  }

  drawing = true;
  startPoint = point;
  canvas.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  const point = getCanvasPoint(event);

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

function placeText(point) {
  const value = window.prompt("Enter annotation text:");
  if (!value) {
    return;
  }

  annotations.push({
    type: "text",
    x: point.x,
    y: point.y,
    value,
    color: activeColor
  });
  commitHistory();
  redraw();
  setStatus("Text added. Click it to drag.");
}

function hitTestText(point) {
  context.font = FONT;
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const a = annotations[i];
    if (a.type !== "text") continue;
    const width = context.measureText(a.value).width;
    const height = FONT_SIZE * 1.2;
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

function redraw() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(captureImage, 0, 0);
  for (const a of annotations) {
    drawAnnotation(a);
  }
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

function drawAnnotation(a) {
  context.lineWidth = STROKE;
  context.strokeStyle = a.color;
  context.fillStyle = a.color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (a.type === "rectangle") {
    context.strokeRect(a.x, a.y, a.width, a.height);
    return;
  }

  if (a.type === "arrow") {
    drawArrow(a.x1, a.y1, a.x2, a.y2, a.color);
    return;
  }

  if (a.type === "text") {
    context.font = FONT;
    context.textBaseline = "top";
    context.fillText(a.value, a.x, a.y);
  }
}

function drawArrow(x1, y1, x2, y2, color) {
  const headLength = Math.max(14, STROKE * 4);
  const angle = Math.atan2(y2 - y1, x2 - x1);

  context.strokeStyle = color;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();

  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 7),
    y2 - headLength * Math.sin(angle - Math.PI / 7)
  );
  context.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 7),
    y2 - headLength * Math.sin(angle + Math.PI / 7)
  );
  context.closePath();
  context.fill();
}

function undo() {
  if (historyStack.length <= 1) {
    setStatus("Nothing left to undo.");
    return;
  }

  historyStack.pop();
  annotations = cloneAnnotations(historyStack[historyStack.length - 1]);
  redraw();
  setStatus("Last change undone.");
}

function commitHistory() {
  historyStack.push(cloneAnnotations(annotations));
  if (historyStack.length > 50) {
    historyStack.shift();
  }
}

function cloneAnnotations(list) {
  return list.map((a) => ({ ...a }));
}

function downloadImage() {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
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

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
