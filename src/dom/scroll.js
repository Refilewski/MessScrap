const el = arguments[0];
const before = el.scrollTop;
const height = el.scrollHeight;
const viewport = el.clientHeight;
const reversed = before < -2 || getComputedStyle(el).flexDirection === 'column-reverse';
const extent = Math.max(0, height - viewport);
const minimum = reversed ? -extent : 0;
const maximum = reversed ? 0 : extent;
const atEdge = direction < 0 ? before <= minimum + 2 : before >= maximum - 2;
const loading = el.matches('[aria-busy="true"]') || Array.from(
  el.querySelectorAll('[aria-busy="true"], [role="progressbar"]')
).some(node => !node.closest('[role="toolbar"], [aria-hidden="true"]') && node.getClientRects().length);
if (move && viewport > 0) el.scrollTop = before + direction * Math.floor(viewport * 0.72);
return {before, height, viewport, atEdge, loading, after: el.scrollTop};
