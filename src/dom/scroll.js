const el = arguments[0];
const before = el.scrollTop;
const height = el.scrollHeight;
const viewport = el.clientHeight;
const atEdge = direction < 0 ? before <= 2 : before + viewport >= height - 2;
const loading = el.matches('[aria-busy="true"]') || Array.from(
  el.querySelectorAll('[aria-busy="true"], [role="progressbar"]')
).some(node => !node.closest('[role="toolbar"], [aria-hidden="true"]') && node.getClientRects().length);
if (move) el.scrollTop = before + direction * Math.max(1, Math.floor(viewport * 0.72));
return {before, height, viewport, atEdge, loading, after: el.scrollTop};
