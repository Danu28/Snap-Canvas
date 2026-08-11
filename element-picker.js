if (!window.__pagesnapElementPickerLoaded) {
  window.__pagesnapElementPickerLoaded = true;

  let overlay = null;
  let highlight = null;
  let currentTarget = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PING_ELEMENT_PICKER") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "BEGIN_ELEMENT_PICK") {
      activatePicker();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function activatePicker() {
    cleanup();

    overlay = document.createElement("div");
    overlay.id = "pagesnap-element-picker";
    overlay.innerHTML = `
      <div class="pagesnap-picker-help">Hover an element, then click to capture it. Press Esc to cancel.</div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #pagesnap-element-picker {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        cursor: crosshair;
        user-select: none;
        pointer-events: none;
      }
      #pagesnap-element-picker .pagesnap-picker-help {
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
      #pagesnap-element-picker .pagesnap-picker-outline {
        position: absolute;
        border: 2px solid #ffb300;
        background: rgba(255, 179, 0, 0.12);
        box-shadow: 0 0 0 9999px rgba(17, 17, 17, 0.18);
      }
    `;

    overlay.appendChild(style);
    highlight = document.createElement("div");
    highlight.className = "pagesnap-picker-outline";
    highlight.hidden = true;
    overlay.appendChild(highlight);
    document.documentElement.appendChild(overlay);

    // Listen on window (capture phase): the overlay has pointer-events: none so
    // elementFromPoint keeps returning real page elements under the cursor.
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
  }

  // Walk up from the deepest element to a sensible capture target: skip
  // document scaffolding and zero-size wrappers.
  function pickTarget(x, y) {
    let node = document.elementFromPoint(x, y);
    while (node && node !== document.documentElement) {
      const tag = node.tagName;
      if (
        !/^(HTML|BODY|SCRIPT|STYLE|NOSCRIPT|HEAD|META|LINK|TITLE)$/i.test(tag) &&
        (node.offsetWidth > 0 || node.offsetHeight > 0)
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function onPointerMove(event) {
    const target = pickTarget(event.clientX, event.clientY);
    if (target !== currentTarget) {
      currentTarget = target;
      drawHighlight(target);
    }
  }

  function drawHighlight(target) {
    if (!target) {
      highlight.hidden = true;
      return;
    }

    const rect = target.getBoundingClientRect();
    highlight.hidden = false;
    highlight.style.left = `${rect.left}px`;
    highlight.style.top = `${rect.top}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  async function onPointerDown(event) {
    if (!currentTarget) {
      return;
    }

    // Keep the click from reaching the page.
    event.preventDefault();
    event.stopPropagation();

    const rect = currentTarget.getBoundingClientRect();
    const capturedRect = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
    cleanup();

    try {
      await waitForOverlayToDisappear();
      const response = await chrome.runtime.sendMessage({
        type: "ELEMENT_SELECTED",
        rect: capturedRect
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Element capture failed.");
      }
    } catch (error) {
      console.error("PageSnap element picker failed:", error);
    }
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      cleanup();
    }
  }

  function cleanup() {
    currentTarget = null;
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);

    if (overlay) {
      overlay.remove();
      overlay = null;
      highlight = null;
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
