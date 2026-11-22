const el = arguments[0];
const before = el.scrollTop;
const pane = arguments[3] || el;
const height = el.scrollHeight;
const viewport = el.clientHeight;
const reversed = getComputedStyle(el).flexDirection === 'column-reverse';
const extent = Math.max(0, height - viewport);
const minimum = reversed ? -extent : 0;
const maximum = reversed ? 0 : extent;
const atEdge = direction < 0 ? before <= minimum + 2 : before >= maximum - 2;
const loading = Boolean(pane.closest('[aria-busy="true"]')) || Array.from(
  pane.querySelectorAll('[aria-busy="true"], [role="progressbar"]')
).some(node => !node.closest(captureExcluded) && captureRendered(node));
if (move && viewport > 0) {
  // Safari can report an offset beyond an edge during rubber-band scrolling.
  const clamped = Math.max(minimum, Math.min(maximum, before));
  el.scrollTop = Math.max(minimum, Math.min(maximum, clamped + direction * Math.floor(viewport * 0.72)));
}
return {before, height, viewport, atEdge, loading, after: el.scrollTop};
