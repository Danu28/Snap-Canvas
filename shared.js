// Shared filename helpers — imported by popup.js and editor.js (both type=module).
// background.js keeps its own copy: harness/*.mjs loads background.js as a
// classic script, so an `import` there would break the harness.
export function sanitize(s) {
  return String(s ?? "page").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

export const DEFAULT_TEMPLATE = "pagesnap-{domain}-{date}-{mode}";

// Task 9: single source of truth for the export filename — popup preview and
// editor download must agree, or the preview is a lie.
export function buildFilenameFrom(template, { domain = "page", title = "", mode = "capture" } = {}, now = new Date()) {
  const tpl = String(template || DEFAULT_TEMPLATE).trim() || DEFAULT_TEMPLATE;
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let name = tpl
    .replaceAll("{domain}", sanitize(domain))
    .replaceAll("{date}", date)
    .replaceAll("{mode}", sanitize(mode))
    .replaceAll("{title}", title ? sanitize(title) : "");
  name = name.replace(/[^a-z0-9-_.]+/gi, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) name = "pagesnap";
  if (!name.toLowerCase().endsWith(".png")) name += ".png";
  return name;
}
