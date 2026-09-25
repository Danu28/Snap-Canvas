/**
 * History helpers for SnapCanvas editor — undo/redo stack.
 * Extracted from editor.js (P2 modularization) to keep the 1356-line
 * file maintainable. Pure functions; no DOM access.
 */

export const HISTORY_LIMIT = 50;

/**
 * Deep-clone an annotation list, stripping transient offscreen caches.
 * Redact annotations carry `_cache` (OffscreenCanvas) which must not be
 * cloned — it is rebuilt lazily via ensureRedactCache.
 */
export function cloneAnnotations(list) {
  return list.map((a) => {
    const { _cache, _cacheW, _cacheH, ...rest } = a;
    return { ...rest };
  });
}

/**
 * Create a fresh history state.
 * @returns {{stack: Array, redo: Array}}
 */
export function createHistory() {
  return { stack: [[]], redo: [] };
}

/**
 * Push a new snapshot onto the history stack, respecting limit and clearing redo.
 */
export function pushHistory(stack, redo, annotations, limit = HISTORY_LIMIT) {
  stack.push(cloneAnnotations(annotations));
  if (stack.length > limit) stack.shift();
  redo.length = 0;
}
