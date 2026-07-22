const STORAGE_KEY = "latestCapture";
const canvas = document.querySelector("#editorCanvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const statusElement = document.querySelector("#editorStatus");
const colorPicker = document.querySelector("#colorPicker");
const sizePicker = document.querySelector("#sizePicker");
const toolButtons = [...document.querySelectorAll(".tool-button")];
const undoButton = document.querySelector("#undoButton");
const clearButton = document.querySelector("#clearButton");
const copyButton = document.querySelector("#copyButton");
const downloadButton = document.querySelector("#downloadButton");

let captureImage = null;
let currentTool = "rectangle";
let drawing = false;
let startPoint = null;
let lastPoint = null;
let snapshotBeforeDraw = null;
let historyStack = [];
let calloutCounter = 1;

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
  context.drawImage(captureImage, 0, 0);
  historyStack = [context.getImageData(0, 0, canvas.width, canvas.height)];
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

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  undoButton.addEventListener("click", undo);
  clearButton.addEventListener("click", resetCanvas);
  copyButton.addEventListener("click", copyImage);
  downloadButton.addEventListener("click", downloadImage);
}

function onPointerDown(event) {
  const point = getCanvasPoint(event);

  if (currentTool === "text") {
    placeText(point);
    return;
  }

  if (currentTool === "callout") {
    placeCallout(point);
    return;
  }

  drawing = true;
  startPoint = point;
  lastPoint = point;
  snapshotBeforeDraw = context.getImageData(0, 0, canvas.width, canvas.height);

  if (currentTool === "pen") {
    const strokeSize = Number(sizePicker.value);
    context.lineWidth = strokeSize;
    context.strokeStyle = colorPicker.value;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(point.x, point.y);
  }
}

function onPointerMove(event) {
  if (!drawing || !snapshotBeforeDraw) {
    return;
  }

  const previewPoint = getCanvasPoint(event);

  if (currentTool === "pen") {
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(previewPoint.x, previewPoint.y);
    context.stroke();
    lastPoint = previewPoint;
    return;
  }

  context.putImageData(snapshotBeforeDraw, 0, 0);
  drawAnnotation(startPoint, previewPoint);
}

function onPointerUp(event) {
  if (!drawing || !snapshotBeforeDraw) {
    return;
  }

  drawing = false;
  const endPoint = getCanvasPoint(event);

  if (currentTool === "pen") {
    if (lastPoint.x === startPoint.x && lastPoint.y === startPoint.y) {
      context.beginPath();
      context.fillStyle = colorPicker.value;
      context.arc(startPoint.x, startPoint.y, Number(sizePicker.value) / 2, 0, Math.PI * 2);
      context.fill();
    }
    commitHistory();
    snapshotBeforeDraw = null;
    startPoint = null;
    lastPoint = null;
    return;
  }

  context.putImageData(snapshotBeforeDraw, 0, 0);

  if (currentTool === "crop") {
    applyCrop(startPoint, endPoint);
    snapshotBeforeDraw = null;
    startPoint = null;
    lastPoint = null;
    return;
  }

  drawAnnotation(startPoint, endPoint);
  commitHistory();
  snapshotBeforeDraw = null;
  startPoint = null;
  lastPoint = null;
}

function drawAnnotation(from, to) {
  const color = colorPicker.value;
  const strokeSize = Number(sizePicker.value);

  context.lineWidth = strokeSize;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (currentTool === "rectangle") {
    const rect = normalizeRect(from, to);
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }

  if (currentTool === "highlight") {
    const rect = normalizeRect(from, to);
    context.save();
    context.globalAlpha = 0.28;
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.restore();
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }

  if (currentTool === "redact") {
    const rect = normalizeRect(from, to);
    if (rect.width < 2 || rect.height < 2) return;
    pixelateRect(rect);
    return;
  }

  if (currentTool === "crop") {
    const rect = normalizeRect(from, to);
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const width = Math.min(canvas.width - x, Math.floor(rect.width));
    const height = Math.min(canvas.height - y, Math.floor(rect.height));
    if (width < 1 || height < 1) return;
    const kept = context.getImageData(x, y, width, height);
    context.fillStyle = "rgba(0, 0, 0, 0.35)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.putImageData(kept, x, y);
    context.save();
    context.strokeStyle = "#fff";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.strokeRect(x, y, width, height);
    context.restore();
    return;
  }

  if (currentTool === "arrow") {
    drawArrow(from, to, strokeSize, color);
  }
}

function drawArrow(from, to, strokeSize, color) {
  const headLength = Math.max(14, strokeSize * 4);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  context.strokeStyle = color;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();

  context.beginPath();
  context.moveTo(to.x, to.y);
  context.lineTo(
    to.x - headLength * Math.cos(angle - Math.PI / 7),
    to.y - headLength * Math.sin(angle - Math.PI / 7)
  );
  context.lineTo(
    to.x - headLength * Math.cos(angle + Math.PI / 7),
    to.y - headLength * Math.sin(angle + Math.PI / 7)
  );
  context.closePath();
  context.fill();
}

function pixelateRect(rect) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(canvas.width - x, Math.floor(rect.width));
  const height = Math.min(canvas.height - y, Math.floor(rect.height));
  if (width < 2 || height < 2) return;

  const block = Math.max(8, Math.min(24, Math.round(Math.min(width, height) / 8)));
  const sw = Math.max(1, Math.floor(width / block));
  const sh = Math.max(1, Math.floor(height / block));
  const temp = document.createElement("canvas");
  temp.width = sw;
  temp.height = sh;
  const tempCtx = temp.getContext("2d");
  tempCtx.imageSmoothingEnabled = false;
  tempCtx.drawImage(canvas, x, y, width, height, 0, 0, sw, sh);
  context.imageSmoothingEnabled = false;
  context.drawImage(temp, 0, 0, sw, sh, x, y, width, height);
  context.imageSmoothingEnabled = true;
}

function placeCallout(point) {
  const color = colorPicker.value;
  const radius = Math.max(14, Number(sizePicker.value) * 4);
  const label = String(calloutCounter);

  context.beginPath();
  context.fillStyle = color;
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#fff";
  context.font = `700 ${Math.round(radius * 1.1)}px Georgia, serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, point.x, point.y + 1);
  context.textAlign = "start";
  context.textBaseline = "alphabetic";

  calloutCounter += 1;
  commitHistory();
  setStatus(`Callout ${label} placed.`);
}

function placeText(point) {
  const value = window.prompt("Enter annotation text:");

  if (!value) {
    return;
  }

  const color = colorPicker.value;
  const fontSize = Math.max(18, Number(sizePicker.value) * 5);

  context.fillStyle = color;
  context.font = `700 ${fontSize}px Georgia, serif`;
  context.textBaseline = "top";
  context.fillText(value, point.x, point.y);
  commitHistory();
  setStatus("Text annotation added.");
}

function applyCrop(from, to) {
  const rect = normalizeRect(from, to);
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(canvas.width - x, Math.floor(rect.width));
  const height = Math.min(canvas.height - y, Math.floor(rect.height));

  if (width < 4 || height < 4) {
    context.putImageData(snapshotBeforeDraw, 0, 0);
    setStatus("Crop area too small.");
    return;
  }

  const cropped = context.getImageData(x, y, width, height);
  canvas.width = width;
  canvas.height = height;
  context.putImageData(cropped, 0, 0);
  historyStack = [context.getImageData(0, 0, canvas.width, canvas.height)];
  calloutCounter = 1;
  setStatus("Image cropped.");
}

function undo() {
  if (historyStack.length <= 1) {
    setStatus("Nothing left to undo.");
    return;
  }

  historyStack.pop();
  const previous = historyStack[historyStack.length - 1];
  if (previous.width !== canvas.width || previous.height !== canvas.height) {
    canvas.width = previous.width;
    canvas.height = previous.height;
  }
  context.putImageData(previous, 0, 0);
  setStatus("Last annotation removed.");
}

function resetCanvas() {
  if (historyStack.length === 0) return;
  const base = historyStack[0];
  if (base.width !== canvas.width || base.height !== canvas.height) {
    canvas.width = base.width;
    canvas.height = base.height;
  }
  historyStack = [base];
  context.putImageData(base, 0, 0);
  calloutCounter = 1;
  setStatus("Annotations cleared.");
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

function commitHistory() {
  historyStack.push(context.getImageData(0, 0, canvas.width, canvas.height));
  if (historyStack.length > 50) {
    historyStack.shift();
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
