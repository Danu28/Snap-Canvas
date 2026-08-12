// Minimal CDP client + Chrome launcher (no deps, node >= 22 global WebSocket).
// Pattern proven in previous SnapCanvas sessions (real-input CDP driver).
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export function launchChrome({ port, headless = true, windowSize = "1200,800" }) {
  const userDataDir = mkdtempSync(join(tmpdir(), "pagesnap-cdp-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions-except=/nonexistent",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--disable-default-apps"
  ];
  if (headless) args.push("--headless=new");
  args.push(`--window-size=${windowSize}`);
  args.push("about:blank");
  const proc = spawn(CHROME, args, { stdio: "ignore" });
  return { proc, userDataDir };
}

export function stopChrome({ proc, userDataDir }) {
  try {
    // On Windows, kill("SIGKILL") only terminates the parent; child
    // renderer/GPU processes survive and keep the CDP port bound, so the next
    // run can attach to a stale instance. Kill the whole tree.
    if (proc.pid && process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}

async function waitForEndpoint(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Chrome CDP endpoint did not come up");
}

export async function findPageTarget(port, urlPrefix) {
  const targets = await waitForEndpoint(port);
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(urlPrefix));
  if (!page) throw new Error("page target not found: " + targets.map((t) => t.url).join(", "));
  return page;
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("WS connect failed"));
    });
    return new CDP(ws);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalJs(expression) {
    const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error("eval error: " + JSON.stringify(res.exceptionDetails));
    return res.result?.value;
  }

  async sleep(ms) {
    await new Promise((r) => setTimeout(r, ms));
  }

  async click(x, y, button = "left") {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount: 1
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1
    });
    await this.sleep(120);
  }

  async drag(x1, y1, x2, y2, steps = 8) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x1 + ((x2 - x1) * i) / steps,
        y: y1 + ((y2 - y1) * i) / steps,
        buttons: 1
      });
      await this.sleep(10);
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
    await this.sleep(120);
  }

  async key(key, modifiers = 0) {
    const KEY_CODES = { Enter: 13, Delete: 46, Backspace: 8, Escape: 27, Tab: 9, Space: 32 };
    const vk = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const down = { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    if (key === "Enter") down.text = "\r";
    await this.send("Input.dispatchKeyEvent", down);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
    await this.sleep(80);
  }

  async typeText(text) {
    await this.send("Input.insertText", { text });
    await this.sleep(80);
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.sleep(500);
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: true });
    await this.sleep(800);
  }

  runtimeErrors() {
    return this.events.filter(
      (e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    );
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// Inject a script that runs before any page script (chrome stub, counters).
export async function addInitScript(cdp, source) {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
}
