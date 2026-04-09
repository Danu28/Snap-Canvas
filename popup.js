const statusElement = document.querySelector("#status");
const buttons = [...document.querySelectorAll(".capture-button")];

function setStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#8a1d12" : "#b94115";
}

async function capture(mode) {
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
      windowId: tab.windowId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Capture failed.");
    }

    setStatus(mode === "selected" ? "Select an area on the page." : "Opening editor...");

    if (mode !== "selected") {
      window.close();
    }
  } catch (error) {
    setStatus(error.message || "Capture failed.", true);
    buttons.forEach((button) => {
      button.disabled = false;
    });
  }
}

buttons.forEach((button) => {
  button.addEventListener("click", () => capture(button.dataset.mode));
});
