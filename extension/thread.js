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
    return /^[\p{L}\p{N}._:@+-]+$/u.test(decodeURIComponent(match[1])) ? url.origin + pathname : null;
  } catch {
    return null;
  }
}

function threadId(value) {
  const url = threadUrl(value);
  return url ? decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)) : null;
}

const captureRows = '[data-message-id], [aria-roledescription="message"]';
const capturePane = '[role="log"], [role="grid"]';
const threadBinding = '[data-thread-id], [data-conversation-id], [data-thread-key]';
const cleanTitle = value => (value || '').trim().replace(/\s+/g, ' ');

function conversationLinks() {
  const links = 'a[href*="/messages/"][href*="/t/"], a[href^="/t/"], a[href^="/e2ee/t/"], a[href*="messenger.com/"][href*="/t/"]';
  return [...document.querySelectorAll(links)].flatMap(link => {
    if (link.closest('[role="main"], main') && !link.closest('[role="navigation"], nav, aside')) return [];
    const sourceUrl = threadUrl(link.href);
    if (!sourceUrl || link.closest('[hidden], [aria-hidden="true"]')) return [];
    const name = cleanTitle(link.querySelector('[dir="auto"]')?.textContent
      || link.getAttribute('aria-label') || link.textContent);
    const selected = Boolean(link.closest('[aria-current="page"], [aria-current="true"], [aria-selected="true"]'));
    return [{id: threadId(sourceUrl), sourceUrl, name, selected}];
  });
}

function discoverConversations() {
  return [...new Map(conversationLinks().map(item => [item.id, item])).values()];
}

function rowEvidence(row) {
  const value = row.getAttribute('data-message-id');
  if (value) return 'id:' + value;
  const label = row.getAttribute('aria-label');
  const text = row.textContent?.trim();
  const time = row.querySelector('time[datetime]')?.getAttribute('datetime');
  const asset = row.querySelector('img[src],video[src],audio[src],a[download]')?.getAttribute('src');
  // Weak rows are still useful for detecting stale content during a transition.
  // They do not independently prove the conversation identity.
  if (!(label || time || text || asset)) return null;
  return JSON.stringify([label, time, text, asset?.split('?')[0]]);
}

function paneDetails(root, id) {
  const visible = candidate => !candidate.closest('[hidden], [aria-hidden="true"]')
    && candidate.getClientRects().length > 0;
  const candidates = [root, ...root.querySelectorAll(capturePane)]
    .filter(node => node.matches(capturePane) && visible(node) && node.querySelector(captureRows));
  const outerPanes = candidates.filter(candidate => !candidates.some(other => other !== candidate && other.contains(candidate)));
  if (outerPanes.length > 1) return null;
  const pane = outerPanes[0] || root;
  const binding = pane.closest(threadBinding);
  const bindingId = node => {
    const rawId = node?.getAttribute('data-thread-id') || node?.getAttribute('data-conversation-id')
      || node?.getAttribute('data-thread-key');
    return threadId(rawId) || rawId;
  };
  const boundId = bindingId(binding);
  const rows = [...pane.querySelectorAll(captureRows)]
    .filter(row => !row.parentElement.closest(captureRows) && visible(row));
  const boundRows = rows.map(bindingId);
  const allRowsBound = boundRows.length > 0 && boundRows.every(value => value === id);
  const main = root.closest('[role="main"], main') || root;
  const header = main.querySelector('header, [role="banner"]') || main;
  const heading = header.querySelector('[data-conversation-name], [role="heading"], h1, h2, h3');
  const listTitle = cleanTitle(pane.getAttribute('aria-label'));
  const headingTitle = cleanTitle(heading?.textContent);
  const listName = listTitle.replace(/^(?:messages (?:in conversation with|with|in|for)|conversation with)\s+/i, '');
  const links = boundId ? [] : conversationLinks();
  const selected = links.filter(link => link.selected);
  const active = selected.find(link => link.id === id);
  const unique = name => name && links.every(link => link.id === id || link.name !== name);
  const named = Boolean(active?.name && unique(active.name) && listName === active.name
    && (!headingTitle || headingTitle === listName)
    && !/^(?:messages|chats|messenger|conversation)$/i.test(listName));
  const participants = [...new Set([
    ...[...header.querySelectorAll('[data-participant-name]')].map(node =>
      cleanTitle(node.getAttribute('data-participant-name') || node.textContent)),
    ...rows.map(row => cleanTitle(row.getAttribute('data-sender-name'))),
  ].filter(Boolean))];
  const avatarEl = header === main ? null : header.querySelector('img[src]');
  const avatar = avatarEl ? avatarEl.currentSrc || avatarEl.src : null;
  return {
    pane, name: cleanTitle(binding?.getAttribute('data-conversation-name')) || (named ? listName : headingTitle),
    participants, avatar, rows, allRowsBound, provesIdentity: allRowsBound || (boundId ? boundId === id : named),
    conflicts: boundRows.some(value => value && value !== id)
      || (boundId ? boundId !== id : selected.some(link => link.id !== id) && !active),
  };
}

class ConversationGuard {
  #route = threadUrl(location.href);
  #documentRoute = threadUrl(globalThis.performance?.getEntriesByType('navigation')[0]?.name);
  #generation = 0;
  #root = null;
  #seenRows = new Set();
  #excludedRows = new Set();
  #excludedId = null;
  #readyGeneration = null;
  #pending = null;
  #conflict = false;
  #disposed = false;
  #navigate = event => {
    const destination = event.destination?.url;
    // Firefox can report a Blob download as a navigation without a download name.
    // A committed page change is still detected from location by refresh().
    if (event.downloadRequest != null || destination?.startsWith('blob:')) return;
    const next = threadUrl(destination);
    if (next !== this.#route && next !== this.#pending?.route) {
      this.#beginTransition();
      this.#pending = {route: next, until: Date.now() + 350};
    }
  };
  #pop = () => this.refresh();

  constructor() {
    globalThis.navigation?.addEventListener('navigate', this.#navigate);
    globalThis.addEventListener?.('popstate', this.#pop);
  }

  #beginTransition() {
    this.#generation++;
    if (this.#seenRows.size) {
      this.#excludedRows = this.#seenRows;
      this.#excludedId = threadId(this.#route);
      this.#seenRows = new Set();
    }
    this.#root = null;
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
    const base = {id, sourceUrl: this.#route, name: '', participants: [], avatar: null,
      ready: false, verified: false, generation: this.#generation};
    if (!id || this.#pending || this.#disposed) return base;
    const root = this.#root?.isConnected && !this.#root.closest('[hidden], [aria-hidden="true"]')
      ? this.#root : findContainer();
    if (!root) return base;
    const details = paneDetails(root, id);
    if (!details) return base;
    if (details.conflicts) {
      if (!this.#conflict && this.#readyGeneration === this.#generation) this.#beginTransition();
      this.#conflict = true;
      base.generation = this.#generation;
      return base;
    }
    this.#conflict = false;
    const hasPriorEvidence = this.#excludedId !== id && this.#excludedRows.size > 0;
    if (!details.provesIdentity || (!details.allRowsBound
      && id !== threadId(this.#documentRoute) && !hasPriorEvidence)) return base;
    const rows = new Set(details.rows.map(rowEvidence).filter(Boolean));
    if (!rows.size) {
      return {...base, verified: this.#readyGeneration === this.#generation};
    }
    if (hasPriorEvidence && [...rows].some(row => this.#excludedRows.has(row))) {
      if (this.#readyGeneration === this.#generation) {
        this.#generation++;
        this.#root = null;
        base.generation = this.#generation;
      }
      return base;
    }
    this.#root = root;
    for (const row of rows) {
      if (this.#seenRows.has(row)) continue;
      if (this.#seenRows.size >= 2048) this.#seenRows.delete(this.#seenRows.values().next().value);
      this.#seenRows.add(row);
    }
    const snapshot = {
      ...base, ready: true, verified: true, name: details.name || 'Messenger conversation',
      participants: details.participants, avatar: details.avatar,
    };
    Object.defineProperties(snapshot, {root: {value: root}, pane: {value: details.pane}});
    this.#readyGeneration = this.#generation;
    return snapshot;
  }

  matches(snapshot) {
    const current = this.inspect();
    return Boolean(current.verified && snapshot && current.id === snapshot.id && current.generation === snapshot.generation);
  }

  dispose() {
    this.#disposed = true;
    this.#root = null;
    this.#seenRows.clear();
    this.#excludedRows.clear();
    globalThis.navigation?.removeEventListener('navigate', this.#navigate);
    globalThis.removeEventListener?.('popstate', this.#pop);
  }
}
