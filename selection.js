if (!window.__pagesnapSelectionLoaded) {
  window.__pagesnapSelectionLoaded = true;

  let overlay = null;
  let selectionBox = null;
  let active = false;
  let startX = 0;
  let startY = 0;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PING_SELECTION_OVERLAY") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "BEGIN_SELECTION") {
      activateSelection();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function activateSelection() {
    cleanup();

    overlay = document.createElement("div");
    overlay.id = "pagesnap-selection-overlay";
    overlay.innerHTML = `
      <div class="pagesnap-shade"></div>
      <div class="pagesnap-help">Drag to select an area. Press Esc to cancel.</div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #pagesnap-selection-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        cursor: crosshair;
        user-select: none;
      }
      #pagesnap-selection-overlay .pagesnap-shade {
        position: absolute;
        inset: 0;
        background: rgba(17, 17, 17, 0.28);
      }
      #pagesnap-selection-overlay .pagesnap-help {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        padding: 10px 14px;
        border-radius: 999px;
        background: rgba(20, 20, 20, 0.9);
        color: #fff;
        font: 600 13px/1.2 Arial, sans-serif;
      }
      #pagesnap-selection-overlay .pagesnap-box {
        position: absolute;
        border: 2px solid #ffb300;
        background: rgba(255, 179, 0, 0.18);
        box-shadow: 0 0 0 9999px rgba(17, 17, 17, 0.28);
      }
    `;

    overlay.appendChild(style);
    selectionBox = document.createElement("div");
    selectionBox.className = "pagesnap-box";
    selectionBox.hidden = true;
    overlay.appendChild(selectionBox);
    document.documentElement.appendChild(overlay);

    overlay.addEventListener("pointerdown", onPointerDown, true);
    overlay.addEventListener("pointermove", onPointerMove, true);
    overlay.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("keydown", onKeyDown, true);
  }

  function onPointerDown(event) {
    active = true;
    startX = event.clientX;
    startY = event.clientY;
    selectionBox.hidden = false;
    drawSelection(event.clientX, event.clientY);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!active) {
      return;
    }

    drawSelection(event.clientX, event.clientY);
    event.preventDefault();
  }

  async function onPointerUp(event) {
    if (!active) {
      return;
    }

    active = false;
    const rect = buildRect(startX, startY, event.clientX, event.clientY);
    cleanup();

    if (rect.width < 2 || rect.height < 2) {
      return;
    }

    try {
      await waitForOverlayToDisappear();
      const response = await chrome.runtime.sendMessage({
        type: "SELECTION_COMPLETE",
        rect: {
          ...rect,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Selected capture failed.");
      }
    } catch (error) {
      console.error("PageSnap selection failed:", error);
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      cleanup();
    }
  }

  function drawSelection(currentX, currentY) {
    const rect = buildRect(startX, startY, currentX, currentY);
    selectionBox.style.left = `${rect.left}px`;
    selectionBox.style.top = `${rect.top}px`;
    selectionBox.style.width = `${rect.width}px`;
    selectionBox.style.height = `${rect.height}px`;
  }

  function buildRect(x1, y1, x2, y2) {
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1)
    };
  }

  function cleanup() {
    active = false;
    window.removeEventListener("keydown", onKeyDown, true);

    if (overlay) {
      overlay.remove();
      overlay = null;
      selectionBox = null;
    }
  }

  function waitForOverlayToDisappear() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  }
}
