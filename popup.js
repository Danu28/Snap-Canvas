const statusElement = document.querySelector("#status");
const buttons = [...document.querySelectorAll(".capture-button")];
const delaySelect = document.querySelector("#delaySelect");
let countdownTimer = null;

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#8a1d12" : "#b94115";
}

async function capture(mode) {
  const delayMs = parseInt(delaySelect.value, 10) || 0;
  setStatus(`Starting ${mode} capture...`);
  buttons.forEach((button) => {
    button.disabled = true;
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !tab.windowId) {
      throw new Error("No active tab available.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      mode,
      tabId: tab.id,
      windowId: tab.windowId,
      delayMs
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Capture failed.");
    }

    if (mode === "selected") {
      setStatus("Select an area on the page.");
      return;
    }

    if (delayMs > 0) {
      // Keep the popup open to show the countdown; the timer itself is
      // background-owned, so closing the popup early still fires the capture.
      runCountdown(delayMs);
    } else {
      window.close();
    }
  } catch (error) {
    setStatus(error.message || "Capture failed.", true);
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

function runCountdown(totalMs) {
  const startedAt = Date.now();
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((totalMs - (Date.now() - startedAt)) / 1000));
    setStatus(remaining > 0 ? `Capturing in ${remaining}s…` : "Capturing…");
    if (remaining === 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      window.close();
    }
  }, 100);
}

buttons.forEach((button) => {
  button.addEventListener("click", () => capture(button.dataset.mode));
});
