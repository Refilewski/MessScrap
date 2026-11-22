const preferredPane = arguments[0];
const empty = {root: null, pane: null, rows: [], strategy: null};
if (!document.querySelectorAll || typeof globalThis.getComputedStyle !== 'function') {
  return {...empty, unsupported: true};
}

const groups = new Map();
const hasMain = [...document.querySelectorAll(captureSurface)].some(node => captureRendered(node));

function scrollport(node) {
  return node.clientHeight > 0 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY);
}

function locate(row) {
  const parent = row.parentElement;
  const surface = parent.closest(captureSurface);
  if (hasMain && !surface) return null;
  // A plain wrapper can only be used inside the conversation surface or an
  // explicitly bound region. A document-wide scrollport can include previews.
  const binding = parent.closest(threadBinding);
  const scope = binding && (!surface || surface.contains(binding)) ? binding : surface;
  const semantic = parent.closest(capturePane);
  if (semantic && (!scope || scope.contains(semantic))) return {pane: semantic, strategy: 'semantic'};
  if (!scope || scope === document.body || scope === document.documentElement) return null;
  const region = parent.closest('[role="region"]');
  for (let node = parent; node; node = node.parentElement) {
    if (node !== surface && scrollport(node)) return {pane: node, strategy: 'scroll'};
    if (node === region || node === scope) break;
  }
  if (region && scope.contains(region)) return {pane: region, strategy: 'region'};
  if (scope === binding && (scope !== surface || row.matches(threadBinding))) {
    return {pane: binding, strategy: 'bound'};
  }
  if (surface && row.matches(threadBinding)) return {pane: surface, strategy: 'bound'};
  return null;
}

const rows = new Set();
for (const candidate of document.querySelectorAll(captureRowCandidates)) {
  if (candidate.closest(captureExcluded) || threadUrl(candidate.closest('a[href]')?.href)
    || !captureRendered(candidate) || !isCaptureRow(candidate)) continue;
  // Replies and media can carry their own message markers. The outer row
  // remains the unit passed to the extractor.
  let nested = false;
  for (let parent = candidate.parentElement; parent; parent = parent.parentElement) {
    if (rows.has(parent)) {
      nested = true;
      break;
    }
  }
  if (!nested) rows.add(candidate);
}

for (const row of rows) {
  const location = locate(row);
  if (!location) continue;
  const {pane, strategy} = location;
  if (!groups.has(pane)) groups.set(pane, {pane, strategy, rows: []});
  groups.get(pane).rows.push(row);
}

if (!groups.size && preferredPane?.isConnected && captureRendered(preferredPane)
  && !preferredPane.closest(captureExcluded)) {
  const strategy = preferredPane.matches(capturePane) ? 'semantic'
    : scrollport(preferredPane) ? 'scroll' : preferredPane.matches('[role="region"]') ? 'region' : 'bound';
  groups.set(preferredPane, {pane: preferredPane, strategy, rows: []});
}
if (!groups.size) {
  // Keep an empty semantic pane in view for hydration and continuity. An
  // unmarked, empty wrapper cannot independently identify a message list.
  for (const pane of document.querySelectorAll(capturePane + ', ' + threadBinding)) {
    if ((hasMain && !pane.closest(captureSurface)) || pane === document.body || pane === document.documentElement || isCaptureRow(pane)
      || pane.closest(captureExcluded) || threadUrl(pane.closest('a[href]')?.href)
      || !captureRendered(pane)) continue;
    const strategy = pane.matches(capturePane) ? 'semantic' : 'bound';
    if (strategy === 'bound' && pane.querySelector(capturePane)) continue;
    groups.set(pane, {pane, strategy, rows: []});
  }
  // A nested grid and log can be the same empty viewport.
  for (const {pane} of groups.values()) {
    if ([...groups.keys()].some(candidate => pane !== candidate && pane.contains(candidate))) groups.delete(pane);
  }
}

if (!groups.size) return empty;
if (groups.size > 1) {
  return {...empty, ambiguous: true, rowCount: [...groups.values()].reduce((count, item) => count + item.rows.length, 0)};
}

const selected = groups.values().next().value;
const {pane} = selected;
const surface = pane.closest(captureSurface);
let innerScroll = null;
if (selected.rows.length && selected.rows.every(row => pane.contains(row))) {
  // Some panes mark the list on the outside and put the scrollport inside.
  for (let node = selected.rows[0].parentElement; node && node !== pane; node = node.parentElement) {
    if (scrollport(node) && selected.rows.every(row => node.contains(row))) {
      innerScroll = node;
      break;
    }
  }
}
if (innerScroll) return {...selected, root: innerScroll};

for (let node = pane; node && node !== document.body; node = node.parentElement) {
  if (scrollport(node)) return {...selected, root: node};
  if (node === surface || node === document.documentElement) break;
}
const documentScroll = document.scrollingElement;
if (documentScroll?.scrollHeight > documentScroll.clientHeight + 2) return {...selected, root: documentScroll};
return {...selected, root: pane};
