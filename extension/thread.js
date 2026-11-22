function threadUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;

  const host = url.hostname.replace(/^(?:www|web|m)\./, '');
  const pathname = url.pathname.replace(/\/$/, '');
  const match = pathname.match(host === 'facebook.com'
    ? /^\/messages\/(?:e2ee\/)?t\/([^/]+)$/
    : /^\/(?:e2ee\/)?t\/([^/]+)$/);
  if (!match || !['facebook.com', 'messenger.com'].includes(host)) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return /^[\p{L}\p{N}._:@+-]+$/u.test(id) && id !== '.' && id !== '..' ? url.origin + pathname : null;
  } catch {
    return null;
  }
}

function threadId(value) {
  const url = threadUrl(value);
  return url ? decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)) : null;
}

const captureSurface = '[role="main"], main';
const capturePane = '[role="log"], [role="grid"]';
const threadAttributes = ['data-thread-id', 'data-conversation-id', 'data-thread-key'];
const threadBinding = threadAttributes.map(attribute => '[' + attribute + ']').join(', ');
const captureExcluded = 'nav, aside, header, footer, form, [role="navigation"], [role="complementary"], '
  + '[role="banner"], [role="toolbar"], [role="menu"], [role="dialog"], [role="alert"]';
const nativeCaptureRows = '[data-message-id], [aria-roledescription="message" i]';
const captureRowCandidates = nativeCaptureRows + ', [data-message-direction], [data-sender-name], '
  + '[aria-label^="At " i], [aria-label^="O " i], [aria-label^="Message sent " i], '
  + '[aria-label^="Enter, Message sent " i]';
const cleanTitle = value => (value || '').trim().replace(/\s+/g, ' ');

function captureMessageLabel(label) {
  return label.match(/^(?:At|O)\s+(.+?),\s+(?=[^\d\s])([^:]+?)(?::\s*([\s\S]*))?$/i)
    || label.match(/^(?:Enter,\s*)?Message sent\s+(.+?)\s+by\s+([^:]+?)(?::\s*([\s\S]*))?$/i);
}

function captureRendered(element) {
  return Boolean(element.getClientRects().length && !element.closest('[hidden], [aria-hidden="true"], [inert]')
    && !/^(hidden|collapse)$/.test(getComputedStyle(element).visibility));
}

function isCaptureRow(row) {
  if (row.getAttribute('data-message-id') || row.matches('[aria-roledescription="message" i]')) return true;
  const label = captureMessageLabel(row.getAttribute('aria-label') || '');
  if (label && /\b\d{1,2}:\d{2}\b/.test(label[1])) return true;
  const direction = row.getAttribute('data-message-direction');
  const sender = row.getAttribute('data-sender-name');
  return Boolean((sender || ['me', 'other', 'system'].includes(direction))
    && (row.getAttribute('data-timestamp') || row.getAttribute('data-utime') || row.querySelector('time[datetime]'))
    && row.querySelector('[dir="auto"], img[src], video, audio, a[download]'));
}

function conversationLinks() {
  const links = 'a[href*="/messages/"][href*="/t/"], a[href^="/t/"], a[href^="/e2ee/t/"], a[href*="messenger.com/"][href*="/t/"]';
  return [...document.querySelectorAll(links)].flatMap(link => {
    const navigation = link.closest('nav, aside, [role="navigation"], [role="complementary"]');
    const selected = Boolean(link.closest('[aria-current="page"], [aria-current="true"], [aria-selected="true"]'));
    const sourceUrl = threadUrl(link.href);
    if (!sourceUrl || !captureRendered(link)
      || (!navigation && link.closest(captureSurface) && (!selected || link.closest(capturePane + ', ' + captureExcluded)))) return [];
    const name = cleanTitle(link.querySelector('[dir="auto"]')?.textContent
      || link.getAttribute('aria-label') || link.textContent);
    return [{id: threadId(sourceUrl), sourceUrl, name, selected, link}];
  });
}

function discoverConversations() {
  return [...new Map(conversationLinks().map(({id, sourceUrl, name, selected}) =>
    [id, {id, sourceUrl, name, selected}])).values()];
}

function rowEvidence(row) {
  const value = row.getAttribute('data-message-id');
  if (value) return 'id:' + value;
  const label = row.getAttribute('aria-label');
  const text = row.textContent?.trim();
  const time = row.getAttribute('data-timestamp') || row.getAttribute('data-utime')
    || row.querySelector('time[datetime]')?.getAttribute('datetime');
  const asset = row.querySelector('img[src],video[src],audio[src],a[download]');
  const source = asset?.getAttribute('src') || asset?.getAttribute('href');
  // Weak observations can identify potentially stale content. A text
  // fingerprint does not prove which conversation produced the message.
  if (!(label || time || text || source)) return null;
  return JSON.stringify([label, time, text, source?.split('?')[0]]);
}

function bindingIds(node, until) {
  const ids = new Set();
  for (; node && node !== until; node = node.parentElement) {
    for (const attribute of threadAttributes) {
      const value = node.getAttribute(attribute)?.trim();
      if (value) ids.add(threadId(value) || value);
    }
  }
  return ids;
}

function paneDetails(pane, rows, id) {
  const surface = pane.closest(captureSurface);
  const paneIds = bindingIds(pane, surface?.parentElement || document.body);
  const rowIds = rows.map(row => bindingIds(row, pane));
  const allRowsBound = rowIds.length > 0 && rowIds.every(ids => ids.size === 1 && ids.has(id));
  const links = conversationLinks();
  const selected = links.filter(link => link.selected);
  const active = selected.find(link => link.id === id);
  const labelIds = (pane.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  const labelNodes = labelIds.map(key => document.getElementById(key)).filter(node => node && !pane.contains(node));
  const linkedTitle = cleanTitle(labelNodes.map(node => node.textContent).join(' '));
  const listName = (linkedTitle || cleanTitle(pane.getAttribute('aria-label')))
    .replace(/^(?:messages (?:in conversation with|with|in|for)|conversation with)\s+/i, '');
  const header = [...(surface?.querySelectorAll('header, [role="banner"]') || [])].find(node =>
    !pane.contains(node) && !node.closest('nav, aside, [role="navigation"], [role="complementary"]')
    && captureRendered(node));
  const heading = header?.querySelector('[data-conversation-name], [role="heading"], h1, h2, h3');
  const headingTitle = cleanTitle(heading?.textContent);
  const unique = name => name && links.every(link => link.id === id || link.name !== name);
  const named = Boolean(active?.name && unique(active.name) && listName === active.name
    && (!headingTitle || headingTitle === listName)
    && !/^(?:messages|chats|messenger|conversation)$/i.test(listName));
  const controlled = Boolean(active && pane.id
    && (active.link.getAttribute('aria-controls') || '').split(/\s+/).includes(pane.id));
  const participants = [...new Set([
    ...[...(header?.querySelectorAll('[data-participant-name]') || [])].map(node =>
      cleanTitle(node.getAttribute('data-participant-name') || node.textContent)),
    ...rows.map(row => cleanTitle(row.getAttribute('data-sender-name'))),
  ].filter(Boolean))];
  const avatarEl = header?.querySelector('img[src]');
  const avatar = avatarEl ? avatarEl.currentSrc || avatarEl.src : null;
  return {
    name: cleanTitle(pane.closest(threadBinding)?.getAttribute('data-conversation-name'))
      || (named ? listName : headingTitle),
    participants, avatar, allRowsBound, paneBound: paneIds.has(id),
    provesIdentity: allRowsBound || paneIds.has(id) || controlled || named,
    conflicts: [...paneIds, ...rowIds.flatMap(ids => [...ids])].some(value => value !== id)
      || selected.some(link => link.id !== id),
  };
}

function documentThreadUrl() {
  // A Navigation Timing entry is useful when it is available. A guard may
  // be installed after pushState has already switched the live document.
  const route = threadUrl(globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.name);
  const navigation = globalThis.navigation;
  const activation = navigation?.activation;
  const current = navigation?.currentEntry;
  const reloaded = activation?.navigationType === 'reload' && activation.entry?.id
    && activation.entry.id === current?.id;
  const history = navigation?.entries?.() || [];
  // A reload remounts the current entry even if earlier same-document entries
  // persist. A forward entry can still reveal a SPA visit followed by Back.
  if (history.some(entry => entry.sameDocument && threadUrl(entry.url) !== route
    && (!reloaded || entry.index >= current.index))) return null;
  return route;
}

class ConversationGuard {
  #route = threadUrl(location.href);
  #documentRoute = documentThreadUrl();
  #generation = 0;
  #verifiedPane = null;
  #transitionFrom = null;
  #seenRows = new Map();
  #paneOwners = new WeakMap();
  #pending = null;
  #conflict = false;
  #disposed = false;
  #navigate = event => {
    const destination = event.destination?.url;
    // Firefox can report a Blob download as a navigation without a download name.
    if (event.downloadRequest != null || destination?.startsWith('blob:')) return;
    const next = threadUrl(destination);
    if (next !== this.#route && next !== this.#pending?.route) {
      this.#beginTransition();
      this.#pending = {route: next, until: Date.now() + 350};
    }
  };
  #pop = () => this.refresh();
  #observer;

  constructor() {
    globalThis.navigation?.addEventListener?.('navigate', this.#navigate);
    globalThis.addEventListener?.('popstate', this.#pop);
    if (globalThis.MutationObserver && document.documentElement) {
      this.#observer = new MutationObserver(this.#pop);
      // Fallback for browsers without the Navigation API. Comparing the URL
      // also detects pushState when Messenger renders the next page.
      this.#observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true});
    }
  }

  #beginTransition() {
    this.#transitionFrom = this.#verifiedPane ? threadId(this.#route) : null;
    this.#generation++;
    this.#verifiedPane = null;
  }

  refresh() {
    const route = threadUrl(location.href);
    if (route !== this.#route) {
      if (!this.#pending) this.#beginTransition();
      this.#route = route;
      this.#pending = null;
      this.#conflict = false;
    } else if (this.#pending && Date.now() >= this.#pending.until) {
      this.#pending = null;
    }
    return this.#generation;
  }

  inspect() {
    this.refresh();
    const id = threadId(this.#route);
    const diagnostics = {
      status: 'unsupported_url', urlRecognized: Boolean(this.#route), threadIdentifierAvailable: Boolean(id),
      containerFound: false, visibleRows: 0, identity: 'unverified', strategy: null,
      reasonCode: null, timedOut: false,
    };
    const base = {id, sourceUrl: this.#route, name: '', participants: [], avatar: null,
      ready: false, verified: false, generation: this.#generation, diagnostics};
    const report = status => {
      diagnostics.status = status;
      return {...base, generation: this.#generation};
    };
    const conflict = reasonCode => {
      if (!this.#conflict && this.#verifiedPane) this.#beginTransition();
      this.#conflict = true;
      diagnostics.identity = 'conflicting';
      diagnostics.reasonCode = reasonCode;
      return report('identity_conflict');
    };
    if (this.#pending) return report('navigating');
    if (!id || this.#disposed) return base;
    const {root, pane, rows, strategy, ambiguous, rowCount, unsupported} = findContainer(this.#verifiedPane);
    if (unsupported) return report('unsupported_functionality');
    diagnostics.containerFound = Boolean(pane || ambiguous);
    diagnostics.visibleRows = rowCount ?? rows.length;
    diagnostics.strategy = strategy;
    if (ambiguous) return conflict('multiple_panes');
    if (!pane) return report(document.readyState === 'loading' ? 'loading' : 'container_missing');
    const details = paneDetails(pane, rows, id);
    if (details.conflicts) return conflict('conflicting_bindings');
    this.#conflict = false;

    const fingerprints = new Set(rows.map(rowEvidence).filter(Boolean));
    const known = this.#seenRows.get(id);
    const otherRows = [...this.#seenRows].filter(([thread]) => thread !== id).map(([, evidence]) => evidence);
    if ([...fingerprints].some(row => otherRows.some(evidence => evidence.has(row)))) return conflict('stale_rows');
    const continuous = pane === this.#verifiedPane;
    const owners = this.#paneOwners.get(pane);
    const reused = owners && [...owners].some(owner => owner !== id);
    const direct = !known && this.#generation === 0 && this.#route === this.#documentRoute;
    const transitioned = !reused && (known
      ? [...fingerprints].some(row => row.startsWith('id:') && known.has(row))
      : details.paneBound && !owners && this.#transitionFrom !== null && this.#transitionFrom !== id);
    // A named or pane-level binding can render before its message rows.
    // Require direct document context or observed row turnover when there
    // is no row-level thread binding. After returning to a previously seen
    // thread, require its own evidence before trusting a replaced list.
    const verifiedBinding = details.provesIdentity && (details.allRowsBound || continuous || direct || transitioned);
    const loading = document.readyState === 'loading' || Boolean(pane.closest('[aria-busy="true"]'))
      || Boolean(root.closest('[aria-busy="true"]'));
    if (!fingerprints.size || loading) {
      const current = report(loading ? 'loading' : 'rows_missing');
      if (!verifiedBinding || !continuous) return current;
      diagnostics.identity = 'verified';
      return {...current, verified: true};
    }
    if (!verifiedBinding) {
      diagnostics.reasonCode = reused ? 'reused_pane' : 'insufficient_binding';
      return report('identity_unproven');
    }

    this.#verifiedPane = pane;
    this.#paneOwners.set(pane, new Set([...(owners || []), id]));
    if (!known && this.#seenRows.size >= 8) this.#seenRows.delete(this.#seenRows.keys().next().value);
    const evidence = known || new Set();
    for (const row of fingerprints) {
      if (evidence.has(row)) continue;
      if (evidence.size >= 2048) evidence.delete(evidence.values().next().value);
      evidence.add(row);
    }
    this.#seenRows.set(id, evidence);
    diagnostics.identity = 'verified';
    const snapshot = {
      ...report('verified'), ready: true, verified: true, name: details.name || 'Messenger conversation',
      participants: details.participants, avatar: details.avatar,
    };
    Object.defineProperties(snapshot, {root: {value: root}, pane: {value: pane}, rows: {value: rows}});
    return snapshot;
  }

  matches(snapshot) {
    const current = this.inspect();
    return Boolean(current.verified && snapshot && current.id === snapshot.id && current.generation === snapshot.generation);
  }

  dispose() {
    this.#disposed = true;
    this.#verifiedPane = null;
    this.#seenRows.clear();
    this.#observer?.disconnect();
    globalThis.navigation?.removeEventListener?.('navigate', this.#navigate);
    globalThis.removeEventListener?.('popstate', this.#pop);
  }
}
