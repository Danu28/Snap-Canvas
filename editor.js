const STORAGE_KEY = "latestCapture";
const canvas = document.querySelector("#editorCanvas");
const context = canvas.getContext("2d", { willReadFrequently: true });
const statusElement = document.querySelector("#editorStatus");
const colorPicker = document.querySelector("#colorPicker");
const sizePicker = document.querySelector("#sizePicker");
const toolButtons = [...document.querySelectorAll(".tool-button")];
const undoButton = document.querySelector("#undoButton");
const clearButton = document.querySelector("#clearButton");
const downloadButton = document.querySelector("#downloadButton");

let captureImage = null;
let baseState = null;
let currentTool = "rectangle";
let drawing = false;
let startPoint = null;
let snapshotBeforeDraw = null;
let historyStack = [];

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
  baseState = context.getImageData(0, 0, canvas.width, canvas.height);
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
  downloadButton.addEventListener("click", downloadImage);
}

function onPointerDown(event) {
  const point = getCanvasPoint(event);

  if (currentTool === "text") {
    placeText(point);
    return;
  }

  drawing = true;
  startPoint = point;
  snapshotBeforeDraw = context.getImageData(0, 0, canvas.width, canvas.height);
}

function onPointerMove(event) {
  if (!drawing || !snapshotBeforeDraw) {
    return;
  }

  const previewPoint = getCanvasPoint(event);
  context.putImageData(snapshotBeforeDraw, 0, 0);
  drawAnnotation(startPoint, previewPoint);
}

function onPointerUp(event) {
  if (!drawing || !snapshotBeforeDraw) {
    return;
  }

  drawing = false;
  const endPoint = getCanvasPoint(event);
  context.putImageData(snapshotBeforeDraw, 0, 0);
  drawAnnotation(startPoint, endPoint);
  commitHistory();
  snapshotBeforeDraw = null;
  startPoint = null;
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

function undo() {
  if (historyStack.length <= 1) {
    setStatus("Nothing left to undo.");
    return;
  }

  historyStack.pop();
  context.putImageData(historyStack[historyStack.length - 1], 0, 0);
  setStatus("Last annotation removed.");
}

function resetCanvas() {
  if (!baseState) {
    return;
  }

  historyStack = [baseState];
  context.putImageData(baseState, 0, 0);
  setStatus("Annotations cleared.");
}

function downloadImage() {
  const link = document.createElement("a");
  link.href = canvas.toDataURL("image/png");
  link.download = `pagesnap-${Date.now()}.png`;
  link.click();
  setStatus("PNG download started.");
}

function commitHistory() {
  historyStack.push(context.getImageData(0, 0, canvas.width, canvas.height));
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
