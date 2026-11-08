const main = document.querySelector('[role="main"], main') || document.body;
const message = '[data-message-id], [aria-roledescription="message"]';
const log = main.querySelector('[role="log"]');
const firstMessage = (log || main).querySelector(message);

function isScroller(node) {
  return node.clientHeight > 0 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY);
}

if (log || firstMessage) {
  for (let node = firstMessage?.parentElement || log; node; node = node.parentElement) {
    if (isScroller(node)) return node;
    if (node === main) break;
  }
  // A short conversation may have no scrollable ancestor.
  if (log) return log;
  return firstMessage.closest('[role="region"]') || main;
}

// Older layouts lack a message log. Score only scrollable chat candidates.
let best = null;
let bestScore = -Infinity;
for (const node of [main, ...main.querySelectorAll('main, section, article, div')]) {
  if (node.scrollHeight <= node.clientHeight || !isScroller(node)) continue;
  if (node.closest('[role="navigation"], [role="banner"]')) continue;
  const rect = node.getBoundingClientRect();
  if (rect.width < 180 || rect.height < 120 || rect.right <= 0 || rect.bottom <= 0) continue;
  const candidates = node.querySelectorAll('[dir="auto"]').length;
  if (!candidates) continue;
  const score = rect.width + rect.height + Math.min(candidates, 100) * 20
    + 1000 * rect.left / innerWidth;
  if (score > bestScore) {
    best = node;
    bestScore = score;
  }
}
return best;
