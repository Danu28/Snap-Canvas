const CAPTURE_STORAGE_KEY = "latestCapture";
const SELECTION_MESSAGE_TIMEOUT = 300;
const CAPTURE_THROTTLE_MS = 600;

let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_CAPTURE") {
    handleCapture(message).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message?.type === "SELECTION_COMPLETE") {
    handleSelectedCapture(message, sender).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener(async (command) => {
  const mode = { "full-page": "full", "visible-area": "visible", "selected-area": "selected" }[command];
  if (!mode) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab?.windowId) return;
  handleCapture({ mode, tabId: tab.id, windowId: tab.windowId }).catch(console.error);
});

async function handleCapture({ mode, tabId, windowId }) {
  if (mode === "visible") {
    const dataUrl = await captureTabWithoutScrollbars(tabId, windowId);
    await storeCaptureAndOpenEditor({ dataUrl, mode });
    return;
  }

  if (mode === "selected") {
    await ensureSelectionScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "BEGIN_SELECTION" });
    return;
  }

  if (mode === "full") {
    const dataUrl = await captureFullPage(tabId, windowId);
    await storeCaptureAndOpenEditor({ dataUrl, mode });
    return;
  }

  throw new Error(`Unsupported capture mode: ${mode}`);
}

async function ensureSelectionScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_SELECTION_OVERLAY" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["selection.js"]
    });
    await delay(SELECTION_MESSAGE_TIMEOUT);
  }
}

async function handleSelectedCapture({ rect }, sender) {
  if (!rect || rect.width < 2 || rect.height < 2) {
    throw new Error("Selection was too small to capture.");
  }

  const windowId = sender.tab?.windowId;
  if (typeof windowId !== "number") {
    throw new Error("Unable to resolve the selected tab window.");
  }

  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") {
    throw new Error("Unable to resolve the selected tab.");
  }

  const visibleDataUrl = await captureTabWithoutScrollbars(tabId, windowId);
  const croppedDataUrl = await cropSelectedArea(visibleDataUrl, rect);
  await storeCaptureAndOpenEditor({ dataUrl: croppedDataUrl, mode: "selected" });
}

async function captureFullPage(tabId, windowId) {
  const [{ result: metrics }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const doc = document.documentElement;
      const body = document.body;

      document.querySelectorAll("*").forEach((node) => {
        const style = window.getComputedStyle(node);
        if ((style.position === "fixed" || style.position === "sticky") && !node.dataset.pagesnapHidden) {
          node.dataset.pagesnapHidden = node.style.visibility || "__EMPTY__";
          node.style.visibility = "hidden";
        }
      });

      return {
        fullWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth),
        fullHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0, doc.clientHeight),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        originalX: window.scrollX,
        originalY: window.scrollY
      };
    }
  });

  const xSteps = buildSteps(metrics.fullWidth, metrics.viewportWidth);
  const ySteps = buildSteps(metrics.fullHeight, metrics.viewportHeight);
  const tiles = [];

  try {
    for (const y of ySteps) {
      for (const x of xSteps) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (scrollX, scrollY) => window.scrollTo(scrollX, scrollY),
          args: [x, y]
        });

        await delay(180);
        const dataUrl = await captureVisibleTabThrottled(windowId);
        tiles.push({ x, y, dataUrl });
      }
    }
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (scrollX, scrollY) => {
        document.querySelectorAll("[data-pagesnap-hidden]").forEach((node) => {
          const previousVisibility = node.dataset.pagesnapHidden;
          node.style.visibility = previousVisibility === "__EMPTY__" ? "" : previousVisibility;
          delete node.dataset.pagesnapHidden;
        });

        window.scrollTo(scrollX, scrollY);
      },
      args: [metrics.originalX, metrics.originalY]
    });
  }

  return stitchTiles(metrics, tiles);
}

function buildSteps(total, viewport) {
  if (total <= viewport) {
    return [0];
  }

  const values = [];
  let current = 0;

  while (current + viewport < total) {
    values.push(current);
    current += viewport;
  }

  values.push(total - viewport);
  return values;
}

async function captureVisibleTabThrottled(windowId) {
  const elapsed = Date.now() - lastCaptureAt;
  if (elapsed < CAPTURE_THROTTLE_MS) {
    await delay(CAPTURE_THROTTLE_MS - elapsed);
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    lastCaptureAt = Date.now();
    return dataUrl;
  } catch (error) {
    if (error?.message?.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
      await delay(CAPTURE_THROTTLE_MS);
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      lastCaptureAt = Date.now();
      return dataUrl;
    }

    throw error;
  }
}

async function captureTabWithoutScrollbars(tabId, windowId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const style = document.createElement("style");
      style.id = "pagesnap-scrollbar-style";
      style.textContent = `
        html, body {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        html::-webkit-scrollbar,
        body::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `;
      document.documentElement.appendChild(style);
    }
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
          });
        })
    });

    return await captureVisibleTabThrottled(windowId);
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        document.getElementById("pagesnap-scrollbar-style")?.remove();
      }
    });
  }
}

async function stitchTiles(metrics, tiles) {
  const images = await Promise.all(
    tiles.map(async (tile) => ({
      ...tile,
      bitmap: await createImageBitmap(await (await fetch(tile.dataUrl)).blob())
    }))
  );

  const scaleX = images[0].bitmap.width / metrics.viewportWidth;
  const scaleY = images[0].bitmap.height / metrics.viewportHeight;
  const canvasWidth = Math.max(1, Math.round(metrics.fullWidth * scaleX));
  const canvasHeight = Math.max(1, Math.round(metrics.fullHeight * scaleY));
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;

  for (const image of images) {
    const destX = Math.round(image.x * scaleX);
    const destY = Math.round(image.y * scaleY);
    const srcW = Math.min(image.bitmap.width, canvasWidth - destX);
    const srcH = Math.min(image.bitmap.height, canvasHeight - destY);
    if (srcW < 1 || srcH < 1) continue;

    context.drawImage(
      image.bitmap,
      0,
      0,
      srcW,
      srcH,
      destX,
      destY,
      srcW,
      srcH
    );
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function cropSelectedArea(dataUrl, rect) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scaleX = bitmap.width / rect.viewportWidth;
  const scaleY = bitmap.height / rect.viewportHeight;
  const sx = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.left * scaleX)));
  const sy = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.top * scaleY)));
  const width = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scaleX)));
  const height = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scaleY)));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = false;

  context.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function storeCaptureAndOpenEditor({ dataUrl, mode }) {
  await chrome.storage.local.set({
    [CAPTURE_STORAGE_KEY]: {
      dataUrl,
      mode,
      capturedAt: new Date().toISOString()
    }
  });

  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Unable to read image data."));
    reader.readAsDataURL(blob);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
