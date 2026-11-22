const main = document.querySelector('[role="main"], main') || document.body;
const message = '[data-message-id], [aria-roledescription="message"]';
const panes = '[role="log"], [role="grid"]';
const visible = node => !node.closest('[hidden], [aria-hidden="true"]') && node.getClientRects().length > 0;
const firstMessage = [...main.querySelectorAll(message)].find(visible);
const pane = firstMessage?.closest(panes) || [...main.querySelectorAll(panes)].find(visible);

if (!firstMessage && !pane) return null;

for (let node = firstMessage?.parentElement || pane; node; node = node.parentElement) {
  if (node.clientHeight > 0 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
  if (node === main) break;
}
return pane || firstMessage.closest('[role="region"]') || main;
