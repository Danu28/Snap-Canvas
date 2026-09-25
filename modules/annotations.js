/**
 * Annotation geometry helpers for SnapCanvas editor.
 * Extracted from editor.js (P2 modularization). Pure, no DOM.
 */

export function normalizeRect(from, to) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

export function distToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

export function snapshotGeometry(a) {
  if (a.type === "arrow") return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
  return { x: a.x, y: a.y, width: a.width, height: a.height };
}

export function geometryChanged(a, snap) {
  if (!snap) return true;
  if (a.type === "arrow") return a.x1 !== snap.x1 || a.y1 !== snap.y1 || a.x2 !== snap.x2 || a.y2 !== snap.y2;
  return a.x !== snap.x || a.y !== snap.y || a.width !== snap.width || a.height !== snap.height;
}
