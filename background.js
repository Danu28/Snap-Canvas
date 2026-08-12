const CAPTURE_STORAGE_KEY = "latestCapture";
const SELECTION_MESSAGE_TIMEOUT = 300;
// Chrome's hard floor is 2 captureVisibleTab calls/sec (500 ms); 520 keeps a
// small margin and the MAX_CAPTURE retry below is the backstop. At 600 ms the
// throttle padding dominated full-page wall time (~70% on an 8-tile page).
const CAPTURE_THROTTLE_MS = 520;
const SCROLL_SETTLE_MS = 120;
// After a scroll, images entering the viewport may still be loading; a tile
// captured then shows blank boxes. Bounded wait (below) covers that.
const SCROLL_IMAGE_WAIT_MS = 700;
const IMAGE_POLL_MS = 50;
const STITCH_CONCURRENCY = 4;

let lastCaptureAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_CAPTURE") {
    handleCapture(message).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message })
    );
    return true;
  }

  if (message?.type === "SELECTION_COMPLETE" || message?.type === "ELEMENT_SELECTED") {
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "pagesnap-capture-element",
      title: "Capture element",
      contexts: ["all"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "pagesnap-capture-element") return;
  if (!tab?.id || !tab?.windowId) return;

  try {
    const protocol = new URL(tab.url || "").protocol;
    if (protocol !== "http:" && protocol !== "https:") return;
  } catch {
    return;
  }

  try {
    await ensureElementPickerScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "BEGIN_ELEMENT_PICK" });
  } catch (error) {
    console.error("PageSnap element picker failed:", error);
  }
});

async function handleCapture({ mode, tabId, windowId, delayMs = 0 }) {
  // Delayed capture applies to full/visible only; the timer is owned here (in
  // the service worker), so it survives the popup closing mid-countdown.
  if (delayMs > 0 && mode !== "selected") {
    await delay(delayMs);
  }

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

async function ensureElementPickerScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING_ELEMENT_PICKER" });
  } catch (error) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["element-picker.js"]
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
  await injectScrollbarHide(tabId);
  await waitForPaint(tabId);

  let metrics;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const doc = document.documentElement;
        const body = document.body;

        // One forced style recalc up front: the per-element lookups below then
        // hit cached style data instead of each triggering incremental recalcs.
        void window.getComputedStyle(doc).position;

        // Live collection + index loop: avoids the static NodeList allocation of
        // querySelectorAll("*") on large pages. getComputedStyle must run per
        // node — position can come from any stylesheet rule, so there is no safe
        // way to skip resolution while keeping identical semantics.
        const all = doc.getElementsByTagName("*");
        for (let i = 0; i < all.length; i += 1) {
          const node = all[i];
          if (node.dataset.pagesnapHidden) {
            continue;
          }
          const style = window.getComputedStyle(node);
          if (style.position === "fixed" || style.position === "sticky") {
            node.dataset.pagesnapHidden = node.style.visibility || "__EMPTY__";
            node.style.visibility = "hidden";
          }
        }

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
    metrics = result;

    const xSteps = buildSteps(metrics.fullWidth, metrics.viewportWidth);
    const ySteps = buildSteps(metrics.fullHeight, metrics.viewportHeight);
    const tiles = [];

    for (const y of ySteps) {
      for (const x of xSteps) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (scrollX, scrollY) => window.scrollTo(scrollX, scrollY),
          args: [x, y]
        });

        await delay(SCROLL_SETTLE_MS);
        await waitForPaint(tabId);
        await waitForViewportImages(tabId);
        const dataUrl = await captureVisibleTabThrottled(windowId);
        tiles.push({ x, y, dataUrl });
      }
    }

    return stitchTiles(metrics, tiles);
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
      args: [metrics?.originalX ?? 0, metrics?.originalY ?? 0]
    });
    await removeScrollbarHide(tabId);
  }
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

async function injectScrollbarHide(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (document.getElementById("pagesnap-scrollbar-style")) return;
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
        /* Pages with scroll-behavior:smooth make window.scrollTo animate, so a
           tile can be captured mid-scroll (torn seam). Force instant jumps for
           the duration of the capture; removed with the rest of this style. */
        html {
          scroll-behavior: auto !important;
        }
      `;
      document.documentElement.appendChild(style);
    }
  });
}

async function removeScrollbarHide(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.getElementById("pagesnap-scrollbar-style")?.remove();
    }
  });
}

async function waitForPaint(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      })
  });
}

// Lazy/async images: after a scroll, images entering the viewport may still be
// loading, so an immediate capture shows blank boxes. Poll (bounded) until every
// viewport-visible img has loaded. Images that errored count as done
// (complete === true with no box growth), so a dead image can't stall capture;
// out-of-viewport images are ignored (their own tile will wait for them).
async function waitForViewportImages(tabId) {
  const deadline = Date.now() + SCROLL_IMAGE_WAIT_MS;
  for (;;) {
    const [{ result: ready }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vh = window.innerHeight;
        const imgs = document.getElementsByTagName("img");
        for (let i = 0; i < imgs.length; i += 1) {
          const img = imgs[i];
          if (img.complete) continue;
          const rect = img.getBoundingClientRect();
          if (rect.height > 0 && rect.bottom >= 0 && rect.top <= vh) {
            return false; // a visible image is still loading
          }
        }
        return true;
      }
    });
    if (ready) return;
    if (Date.now() >= deadline) return;
    await delay(IMAGE_POLL_MS);
  }
}

async function decodeBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none"
  });
}

async function captureTabWithoutScrollbars(tabId, windowId) {
  await injectScrollbarHide(tabId);

  try {
    await waitForPaint(tabId);
    return await captureVisibleTabThrottled(windowId);
  } finally {
    await removeScrollbarHide(tabId);
  }
}

async function stitchTiles(metrics, tiles) {
  // Tile 0 fixes the device-pixel scale before the canvas is sized; the rest
  // decode through a bounded worker pool (decode -> draw -> close) so peak
  // memory stays ~STITCH_CONCURRENCY tiles instead of every tile at once.
  const first = await decodeBitmap(tiles[0].dataUrl);
  const scaleX = first.width / metrics.viewportWidth;
  const scaleY = first.height / metrics.viewportHeight;
  const canvasWidth = Math.max(1, Math.round(metrics.fullWidth * scaleX));
  const canvasHeight = Math.max(1, Math.round(metrics.fullHeight * scaleY));
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = false;

  const drawTile = (bitmap, tile) => {
    const destX = Math.floor(tile.x * scaleX);
    const destY = Math.floor(tile.y * scaleY);
    const srcW = Math.min(bitmap.width, canvasWidth - destX);
    const srcH = Math.min(bitmap.height, canvasHeight - destY);
    if (srcW < 1 || srcH < 1) return;

    context.drawImage(bitmap, 0, 0, srcW, srcH, destX, destY, srcW, srcH);
  };

  drawTile(first, tiles[0]);
  first.close();

  let next = 1;
  const worker = async () => {
    while (next < tiles.length) {
      const tile = tiles[next];
      next += 1;
      const bitmap = await decodeBitmap(tile.dataUrl);
      try {
        drawTile(bitmap, tile);
      } finally {
        bitmap.close();
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(STITCH_CONCURRENCY, tiles.length - 1) }, worker)
  );

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function cropSelectedArea(dataUrl, rect) {
  const bitmap = await decodeBitmap(dataUrl);
  const scaleX = bitmap.width / rect.viewportWidth;
  const scaleY = bitmap.height / rect.viewportHeight;
  const sx = Math.max(0, Math.min(bitmap.width, Math.floor(rect.left * scaleX)));
  const sy = Math.max(0, Math.min(bitmap.height, Math.floor(rect.top * scaleY)));
  const ex = Math.max(sx + 1, Math.min(bitmap.width, Math.ceil((rect.left + rect.width) * scaleX)));
  const ey = Math.max(sy + 1, Math.min(bitmap.height, Math.ceil((rect.top + rect.height) * scaleY)));
  const width = ex - sx;
  const height = ey - sy;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  context.imageSmoothingEnabled = false;

  context.drawImage(bitmap, sx, sy, width, height, 0, 0, width, height);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function storeCaptureAndOpenEditor({ dataUrl, mode }) {
  try {
    await chrome.storage.local.set({
      [CAPTURE_STORAGE_KEY]: {
        dataUrl,
        mode,
        capturedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    throw new Error(
      `Unable to save the capture to storage (${error?.message || "storage error"}). Try a smaller region.`
    );
  }

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
