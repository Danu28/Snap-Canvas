/**
 * Redact rendering — blur / pixelate with per-annotation OffscreenCanvas cache.
 * Extracted from editor.js (P2 modularization). Keeps per-frame cost O(1)
 * instead of O(area) for pixelate or repeated blur filter.
 */

export const REDACT_RADIUS = 24;
export const REDACT_CELL = 12;
export const REDACT_TINT = "rgba(0, 0, 0, 0.18)";

/**
 * Build or reuse the offscreen cache for a redact annotation.
 * @param {object} a - redact annotation {x,y,width,height,mode}
 * @param {HTMLImageElement} captureImage
 * @returns {OffscreenCanvas}
 */
export function ensureRedactCache(a, captureImage) {
  if (a._cache && a._cacheW === a.width && a._cacheH === a.height) return a._cache;
  const w = Math.max(1, Math.round(a.width));
  const h = Math.max(1, Math.round(a.height));
  const off = new OffscreenCanvas(w, h);
  const octx = off.getContext("2d");
  octx.imageSmoothingEnabled = false;
  if (a.mode === "pixel") {
    for (let by = 0; by < h; by += REDACT_CELL) {
      const ch = Math.min(REDACT_CELL, h - by);
      for (let bx = 0; bx < w; bx += REDACT_CELL) {
        const cw = Math.min(REDACT_CELL, w - bx);
        octx.drawImage(
          captureImage,
          a.x + bx + cw / 2,
          a.y + by + ch / 2,
          1,
          1,
          bx,
          by,
          cw,
          ch
        );
      }
    }
  } else {
    const right = Math.min(captureImage.width, a.x + w + REDACT_RADIUS);
    const bottom = Math.min(captureImage.height, a.y + h + REDACT_RADIUS);
    const sx = Math.max(0, a.x - REDACT_RADIUS);
    const sy = Math.max(0, a.y - REDACT_RADIUS);
    const sw = right - sx;
    const sh = bottom - sy;
    octx.filter = `blur(${REDACT_RADIUS}px)`;
    octx.drawImage(captureImage, sx, sy, sw, sh, sx - a.x, sy - a.y, sw, sh);
    octx.filter = "none";
  }
  a._cache = off;
  a._cacheW = a.width;
  a._cacheH = a.height;
  return off;
}

export function invalidateRedactCache(a) {
  if (a) {
    delete a._cache;
    delete a._cacheW;
    delete a._cacheH;
  }
}

export function drawRedact(a, ctx, captureImage) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(a.x, a.y, a.width, a.height);
  ctx.clip();
  const cached = ensureRedactCache(a, captureImage);
  ctx.drawImage(cached, a.x, a.y);
  ctx.fillStyle = REDACT_TINT;
  ctx.fillRect(a.x, a.y, a.width, a.height);
  ctx.restore();
}
