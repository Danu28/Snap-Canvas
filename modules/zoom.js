/**
 * Zoom & pan helpers for SnapCanvas editor.
 * Extracted from editor.js (P2 modularization).
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;

/**
 * Clamp a zoom value to [ZOOM_MIN, ZOOM_MAX].
 */
export function clampZoom(value) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

/**
 * Compute fit-to-width zoom for the current canvas/canvasWrap/canvasArea geometry.
 * Pure calculation — caller applies to DOM.
 * @param {HTMLElement} canvasWrap
 * @param {HTMLElement} canvasArea
 * @param {{width:number,height:number}} captureImage
 * @returns {number} target zoom (0..1)
 */
export function computeFitZoom(canvasWrap, canvasArea, captureImage) {
  const wrapStyle = getComputedStyle(canvasWrap);
  const areaStyle = getComputedStyle(canvasArea);
  const sideChrome =
    parseFloat(wrapStyle.paddingLeft) +
    parseFloat(wrapStyle.paddingRight) +
    parseFloat(wrapStyle.borderLeftWidth) +
    parseFloat(wrapStyle.borderRightWidth) +
    parseFloat(areaStyle.paddingLeft) +
    parseFloat(areaStyle.paddingRight);
  const available = Math.max(1, canvasArea.clientWidth - sideChrome);
  const target = Math.min(available, captureImage.width);
  return Math.min(1, target / captureImage.width);
}
