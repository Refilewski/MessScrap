export function viewerRuntime(calculateStatistics) {
  'use strict';

  const {archive, initialStatistics, icons} = JSON.parse(document.getElementById('archive-data').textContent);
  const messages = archive.messages;
  const app = document.getElementById('app');
  const rail = document.getElementById('rail');
  const view = document.getElementById('view');
  const search = document.getElementById('search');
  const filter = document.getElementById('filter-panel');
  const calendar = document.getElementById('calendar-panel');
  const number = new Intl.NumberFormat();
  const precise = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});
  const dayFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeZone: 'UTC'});
  const timeFormat = new Intl.DateTimeFormat(undefined, {hour: 'numeric', minute: '2-digit', timeZone: 'UTC'});
  const weekdayFormat = new Intl.DateTimeFormat(undefined, {weekday: 'short', timeZone: 'UTC'});
  const attachments = {image: 'Image', video: 'Video', gif: 'GIF', sticker: 'Sticker', voice: 'Voice message', audio: 'Audio', file: 'File'};
  const statusNames = {archived: 'Available', unavailable: 'Unavailable', failed: 'Download failed', skipped: 'Download skipped'};
  const timelinePageSize = 100;
  const collectionPageSize = 60;
  const everyone = 'Everyone';
  const authorOf = message => message.author || (message.direction === 'outgoing' ? 'You' : 'Unknown sender');
  const titleCase = value => String(value || '').replace(/[_-]/g, ' ').replace(/^./, first => first.toUpperCase());
  const dayOf = message => message.timestamp?.slice(0, 10) || (/^\d{4}-\d{2}-\d{2}$/.test(message.date || '') ? message.date : '');
  const timeOf = message => message.timestamp ? timeFormat.format(new Date(message.timestamp)) : message.time || '';
  const prettyDay = day => day && !Number.isNaN(Date.parse(day)) ? dayFormat.format(new Date(day)) : 'Unknown date';
  const shortTime = message => [prettyDay(dayOf(message)), timeOf(message)].filter(Boolean).join(' · ');
  const messageById = new Map(messages.map((message, index) => [message.id, index]));
  const participants = new Map(archive.conversation.participants.map(participant => [participant.name, participant]));
  for (const message of messages) if (message.author && !participants.has(message.author)) participants.set(message.author, {name: message.author});
  const names = [...participants.keys()];
  const all = messages.map((_, index) => index);
  const searchIndex = [];
  const totalAttachments = messages.reduce((total, message) => total + message.attachments.length, 0);
  let active = 'messages';
  let selected = all;
  let terms = [];
  let searchText = '';
  let searchCursor = -1;
  let timelineStart = Math.max(0, messages.length - timelinePageSize);
  let collectionPage = 0;
  let collectionFilter = '';
  let collectionSort = 'newest';
  let mediaKind = '';
  let period = 'month';
  let statsCache = {selection: all, data: initialStatistics};
  let searchTimer;
  let toastTimer;
  let drawerHasFocus = false;

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function icon(key) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = icons[key] || '';
    return svg;
  }

  function button(label, callback, symbol, iconOnly = false) {
    const control = element('button', iconOnly ? 'icon-button' : 'action');
    control.type = 'button';
    if (symbol) control.append(icon(symbol));
    if (iconOnly) {
      control.title = label;
      control.setAttribute('aria-label', label);
    } else control.append(label);
    control.addEventListener('click', callback);
    return control;
  }

  function select(label, options, selectedValue, onChange) {
    const control = element('select');
    control.setAttribute('aria-label', label);
    for (const [value, caption] of options) {
      const option = element('option', '', caption);
      option.value = value;
      control.append(option);
    }
    control.value = selectedValue;
    control.addEventListener('change', () => onChange(control.value));
    return control;
  }

  function labeled(caption, control) {
    const label = element('label', '', caption);
    label.append(control);
    return label;
  }

  function attachmentName(attachment) {
    return attachment.filename || attachment.label || attachments[attachment.kind] || 'Attachment';
  }

  function localPath(path) {
    if (typeof path !== 'string') return null;
    const parts = path.split('/');
    if (parts.length < 2 || parts[0] !== 'media' || parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f]/u.test(part))) return null;
    return `./${parts.map(encodeURIComponent).join('/')}`;
  }

  function externalUrl(value) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url;
    } catch { /* Invalid archived URL */ }
    return null;
  }

  function externalLink(url, label, className = '') {
    const link = element('a', className, label);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    return link;
  }

  function avatar(name, image, compact = false) {
    const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map(word => [...word][0]).join('').toUpperCase();
    const node = element('span', compact ? 'avatar message-avatar' : 'avatar', initials || '?');
    node.setAttribute('aria-hidden', 'true');
    const path = localPath(typeof image === 'string' ? image : image?.path);
    if (path) {
      const img = element('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => { node.textContent = initials || '?'; }, {once: true});
      img.src = path;
      node.replaceChildren(img);
    }
    return node;
  }

  function empty(symbol, title, text) {
    const node = element('div', 'empty');
    node.append(icon(symbol), element('h2', '', title), element('p', '', text));
    return node;
  }

  function notify(text) {
    const node = document.getElementById('toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2800);
  }

  async function copy(url) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url.href);
      else throw new Error('Clipboard is not available');
    } catch {
      const field = element('textarea', 'visually-hidden', url.href);
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) {
        window.prompt('Copy this URL', url.href);
        return;
      }
    }
    notify('Link copied');
  }

  function plural(total, one, many = `${one}s`) {
    return `${number.format(total)} ${total === 1 ? one : many}`;
  }

  function fold(value) {
    return String(value ?? '').normalize('NFC').toLowerCase();
  }

  function searchable(index) {
    if (searchIndex[index] === undefined) {
      const item = messages[index];
      searchIndex[index] = fold([item.text, item.author, item.reply?.text, ...item.attachments.map(attachmentName), ...item.links.map(link => link.url)].filter(Boolean).join('\n'));
    }
    return searchIndex[index];
  }

  function markText(node, text) {
    if (!terms.length) {
      node.textContent = text;
      return;
    }
    const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const expression = new RegExp(escaped.join('|'), 'giu');
    let cursor = 0;
    for (const match of text.matchAll(expression)) {
      node.append(text.slice(cursor, match.index), element('mark', '', match[0]));
      cursor = match.index + match[0].length;
    }
    node.append(text.slice(cursor));
  }

  const types = [...new Set(messages.map(message => message.type).filter(Boolean))].sort();
  const authorFilter = select('Participant', [['', everyone], ...names.map(name => [name, name])], '', applyFilters);
  const fromFilter = document.getElementById('date-from');
  const untilFilter = document.getElementById('date-until');
  const typeFilter = select('Message type', [['', 'All types'], ...types.map(type => [type, titleCase(type)])], '', applyFilters);
  const attachmentFilter = select('Attachments', [['', 'Any message'], ['any', 'Has attachments'], ['none', 'No attachments'], ...Object.entries(attachments)], '', applyFilters);
  filter.prepend(labeled('Participant', authorFilter));
  filter.insertBefore(labeled('Message type', typeFilter), document.getElementById('reset-filters'));
  filter.insertBefore(labeled('Attachments', attachmentFilter), document.getElementById('reset-filters'));

  function updateSearchTools() {
    const count = document.getElementById('search-count');
    document.getElementById('search-tools').hidden = !searchText;
    count.textContent = !selected.length ? 'No results' : `${number.format(Math.max(0, searchCursor) + 1)} of ${plural(selected.length, 'result')}`;
    document.getElementById('previous-result').disabled = selected.length < 2;
    document.getElementById('next-result').disabled = selected.length < 2;
  }

  function applyFilters() {
    const start = fromFilter.value;
    const end = untilFilter.value;
    const author = authorFilter.value;
    const kind = attachmentFilter.value;
    const type = typeFilter.value;
    const reversedDates = start && end && start > end;
    document.getElementById('filter-error').hidden = !reversedDates;
    document.getElementById('toggle-filter').classList.toggle('has-filter', Boolean(start || end || author || kind || type));
    selected = !author && !kind && !type && !start && !end && !terms.length ? all : all.filter(index => {
      const message = messages[index];
      const day = dayOf(message);
      if (reversedDates || (start && (!day || day < start)) || (end && (!day || day > end))) return false;
      if ((author && authorOf(message) !== author) || (type && message.type !== type)) return false;
      if (kind === 'any' && !message.attachments.length) return false;
      if (kind === 'none' && message.attachments.length) return false;
      if (kind && !['any', 'none'].includes(kind) && !message.attachments.some(attachment => attachment.kind === kind)) return false;
      return terms.every(term => searchable(index).includes(term));
    });
    collectionPage = 0;
    searchCursor = selected.length - 1;
    timelineStart = Math.max(0, selected.length - timelinePageSize);
    updateSearchTools();
    render(active === 'messages');
  }

  function resetFilters(clearSearch = false) {
    for (const control of [authorFilter, fromFilter, untilFilter, typeFilter, attachmentFilter]) control.value = '';
    if (clearSearch) {
      search.value = '';
      searchText = '';
      terms = [];
    }
    applyFilters();
  }

  function selectView(viewName) {
    if (active !== viewName) {
      active = viewName;
      collectionPage = 0;
      collectionFilter = '';
    }
    for (const item of rail.querySelectorAll('[data-view]')) {
      if (item.dataset.view === active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    const description = names.length ? names.join(', ') : 'Participants unavailable';
    const caption = document.getElementById('view-caption');
    caption.textContent = active === 'messages' ? description : `${titleCase(active)} · ${description}`;
    caption.title = description;
    view.setAttribute('aria-label', titleCase(active));
  }

  function drawer(open) {
    const toggle = document.getElementById('mobile-menu');
    rail.toggleAttribute('data-open', open);
    document.getElementById('mobile-backdrop').toggleAttribute('data-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      search.focus();
      drawerHasFocus = true;
    } else if (drawerHasFocus) {
      toggle.focus();
      drawerHasFocus = false;
    }
  }

  function jumpToPosition(position) {
    if (position < 0 || position >= selected.length) return;
    selectView('messages');
    drawer(false);
    if (position < timelineStart || position >= timelineStart + timelinePageSize || !view.querySelector('.timeline')) {
      timelineStart = Math.max(0, Math.min(position - Math.floor(timelinePageSize / 2), selected.length - timelinePageSize));
      render();
    }
    searchCursor = position;
    updateSearchTools();
    const row = document.getElementById(`message-${selected[position]}`);
    view.querySelector('.highlight')?.classList.remove('highlight');
    if (row) {
      row.classList.add('highlight');
      row.scrollIntoView({block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
      row.focus({preventScroll: true});
    }
  }

  function jumpToMessage(index) {
    let position = selected.indexOf(index);
    if (position < 0) {
      resetFilters(true);
      position = selected.indexOf(index);
    }
    jumpToPosition(position);
  }

  function jumpResult(direction) {
    if (!selected.length) return;
    jumpToPosition((searchCursor + direction + selected.length) % selected.length);
  }

  function fileBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${number.format(bytes)} B`;
    if (bytes < 1024 ** 2) return `${precise.format(bytes / 1024)} KiB`;
    if (bytes < 1024 ** 3) return `${precise.format(bytes / 1024 ** 2)} MiB`;
    return `${precise.format(bytes / 1024 ** 3)} GiB`;
  }

  function mediaElement(attachment, mode) {
    const path = localPath(attachment.path);
    const name = attachmentName(attachment);
    if (!path) return null;
    if (['image', 'gif', 'sticker'].includes(attachment.kind)) {
      const img = element('img');
      img.alt = name;
      img.loading = mode === 'dialog' ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.src = path;
      return img;
    }
    if (['video', 'voice', 'audio'].includes(attachment.kind)) {
      const tag = attachment.kind === 'video' ? 'video' : 'audio';
      const media = element(tag, `inline-media ${tag}`);
      media.controls = true;
      media.preload = 'none';
      media.playsInline = true;
      media.setAttribute('aria-label', name);
      media.src = path;
      return media;
    }
    return null;
  }

  function mediaFallback(attachment, status) {
    const node = element('span', 'unavailable');
    node.append(icon(attachment.kind === 'video' || attachment.kind === 'voice' || attachment.kind === 'audio' ? 'play' : 'media'), element('span', '', status || statusNames[attachment.status] || 'Unavailable'));
    return node;
  }

  function showPreview(attachment) {
    const dialog = document.getElementById('preview');
    const content = document.getElementById('preview-content');
    const media = mediaElement(attachment, 'dialog');
    if (!media) return;
    media.addEventListener('error', () => content.replaceChildren(mediaFallback(attachment, 'Local file unavailable')), {once: true});
    content.replaceChildren(media);
    document.getElementById('preview-title').textContent = attachmentName(attachment);
    dialog.showModal();
  }

  function mediaPreview(attachment, container) {
    const preview = mediaElement(attachment);
    if (!preview) return mediaFallback(attachment);
    preview.addEventListener('error', () => {
      if (container) container.replaceChildren(mediaFallback(attachment, 'Local file unavailable'));
      else previewBox.replaceWith(fileCard(attachment, 'Local file unavailable'));
    }, {once: true});
    const previewBox = preview.tagName === 'IMG' ? element('button', 'media-preview') : preview;
    if (preview.tagName === 'IMG') {
      previewBox.type = 'button';
      previewBox.title = `View ${attachmentName(attachment)} fullscreen`;
      previewBox.append(preview);
      previewBox.addEventListener('click', () => showPreview(attachment));
    }
    return previewBox;
  }

  function downloadLink(attachment, className = 'action') {
    const path = localPath(attachment.path);
    if (!path) return null;
    const link = element('a', className);
    link.href = path;
    link.download = attachmentName(attachment);
    link.append(icon('download'), 'Save file');
    return link;
  }

  function fileCard(attachment, error) {
    const card = element('div', 'file-card');
    const meta = element('div');
    const path = error ? null : localPath(attachment.path);
    if (path) {
      const link = element('a', 'message-link', attachmentName(attachment));
      link.href = path;
      link.download = attachmentName(attachment);
      meta.append(link);
    } else meta.append(element('div', '', attachmentName(attachment)));
    meta.append(element('small', '', [error || (path ? 'Available' : statusNames[attachment.status] || 'Unavailable'), fileBytes(attachment.size)].filter(Boolean).join(' · ')));
    card.append(icon('files'), meta);
    return card;
  }

  function messageRow(item, index, continuation, lastInGroup) {
    const row = element('article', 'message');
    row.id = `message-${index}`;
    row.tabIndex = -1;
    if (item.type === 'system') {
      row.classList.add('system');
      markText(row, item.text || 'System message');
      return row;
    }
    if (item.direction === 'outgoing') row.classList.add('outgoing');
    if (continuation) row.classList.add('continuation');
    const user = authorOf(item);
    const isOutgoing = item.direction === 'outgoing';
    const person = !isOutgoing && !continuation ? avatar(user, item.avatar || participants.get(user)?.avatar, true) : element('span', 'message-spacer');
    const body = element('div', 'message-body');
    if (!continuation && !isOutgoing) body.append(element('strong', 'message-author', user));
    const bubble = element('div', 'bubble');
    if (item.forwarded) bubble.append(element('span', 'message-flag', 'Forwarded'));
    if (item.reply && (item.reply.author || item.reply.text || item.reply.messageId)) {
      const quote = element('blockquote', 'quote');
      const target = messageById.get(item.reply.messageId);
      if (target !== undefined) {
        const jump = element('button', '', item.reply.author || 'View original message');
        jump.type = 'button';
        jump.title = 'Jump to quoted message';
        jump.addEventListener('click', () => jumpToMessage(target));
        quote.append(jump);
      } else quote.append(element('strong', '', item.reply.author || 'Reply'));
      if (item.reply.text) quote.append(element('span', 'quote-text', item.reply.text));
      bubble.append(quote);
    }
    if (item.text) {
      const text = element('p', 'message-text');
      markText(text, item.text);
      bubble.append(text);
    }
    for (const attachment of item.attachments) {
      const hasMedia = attachment.kind !== 'file' && localPath(attachment.path);
      bubble.append(hasMedia ? mediaPreview(attachment) : fileCard(attachment));
    }
    for (const link of item.links) {
      const url = externalUrl(link.url);
      if (url) bubble.append(externalLink(url, link.label || url.href, 'message-link'));
    }
    if (!bubble.childNodes.length) bubble.append(element('span', 'message-flag', titleCase(item.type || 'Message')));
    body.append(bubble);
    if (item.reactions.length) {
      const reactions = element('div');
      for (const reaction of item.reactions) {
        const pill = element('span', 'reaction', reaction.emoji || reaction.label || 'Reaction');
        if (reaction.author) pill.title = reaction.author;
        reactions.append(pill);
      }
      body.append(reactions);
    }
    if (lastInGroup || item.edited) {
      const timestamp = element('time', 'timestamp', [timeOf(item), item.edited && 'Edited'].filter(Boolean).join(' · '));
      if (item.timestamp) timestamp.dateTime = item.timestamp;
      body.append(timestamp);
    }
    row.append(person, body);
    return row;
  }

  function sameGroup(left, right) {
    if (!left || !right || left.type === 'system' || right.type === 'system' || !left.author) return false;
    if (left.author !== right.author || left.direction !== right.direction || !left.timestamp || !right.timestamp || dayOf(left) !== dayOf(right)) return false;
    const distance = Date.parse(right.timestamp) - Date.parse(left.timestamp);
    return distance >= 0 && distance <= 5 * 60_000;
  }

  function timeline() {
    const container = element('div', 'timeline');
    if (!selected.length) {
      container.append(empty('messages', messages.length ? 'No matching messages' : 'No messages in this archive', messages.length ? 'Adjust your search or filters.' : 'Captured messages appear here.'));
      return container;
    }
    const finish = Math.min(selected.length, timelineStart + timelinePageSize);
    if (timelineStart > 0) {
      const earlier = element('div', 'pager');
      earlier.append(button('Earlier messages', () => {
        timelineStart = Math.max(0, timelineStart - timelinePageSize);
        render(true);
      }, 'previous'));
      container.append(earlier);
    }
    let lastDay;
    for (let offset = timelineStart; offset < finish; offset++) {
      const index = selected[offset];
      const item = messages[index];
      const day = dayOf(item);
      if (lastDay !== day) {
        container.append(element('div', 'date-divider', prettyDay(day)));
        lastDay = day;
      }
      const previous = offset > timelineStart ? messages[selected[offset - 1]] : null;
      const next = offset + 1 < finish ? messages[selected[offset + 1]] : null;
      container.append(messageRow(item, index, sameGroup(previous, item), !sameGroup(item, next)));
    }
    if (finish < selected.length) {
      const later = element('div', 'pager');
      later.append(button('Later messages', () => {
        timelineStart = finish;
        render();
      }, 'next'));
      container.append(later);
    }
    return container;
  }

  function collectionToolbar({label, options, placeholder} = {}) {
    const toolbar = element('div', 'toolbar');
    if (options) toolbar.append(labeled(label, select(label, options, mediaKind, value => {
      mediaKind = value;
      collectionPage = 0;
      render();
    })));
    if (placeholder) {
      const input = element('input');
      input.type = 'search';
      input.placeholder = placeholder;
      input.value = collectionFilter;
      input.addEventListener('input', () => {
        collectionFilter = input.value;
        collectionPage = 0;
        document.getElementById('collection-content').replaceChildren(renderCollectionEntries());
      });
      toolbar.append(labeled(placeholder, input));
    }
    const sortLabel = labeled('Sort by', select('Sort by', [['newest', 'Newest first'], ['oldest', 'Oldest first']], collectionSort, value => {
      collectionSort = value;
      collectionPage = 0;
      render();
    }));
    sortLabel.classList.add('push');
    toolbar.append(sortLabel);
    return toolbar;
  }

  function originalMessageButton(index) {
    return button('View message', () => jumpToMessage(index), 'messages');
  }

  function mediaCard(attachment, index) {
    const card = element('article', 'gallery-card');
    const preview = element('div', 'thumb');
    preview.append(mediaPreview(attachment, preview));
    const info = element('div', 'gallery-meta');
    const message = messages[index];
    info.append(element('strong', '', attachmentName(attachment)), element('small', '', [authorOf(message), shortTime(message)].join(' · ')), originalMessageButton(index));
    card.append(preview, info);
    return card;
  }

  function linkCard(url, label, index) {
    const message = messages[index];
    const row = element('article', 'entry');
    const info = element('div', 'entry-info');
    if (label && label !== url.href) info.append(element('strong', '', label));
    info.append(externalLink(url, url.href), element('small', '', [url.hostname, authorOf(message), shortTime(message)].join(' · ')));
    const actions = element('div', 'entry-actions');
    actions.append(button('Copy link', () => copy(url), 'copy', true), originalMessageButton(index));
    const openLink = externalLink(url, 'Open link', 'action');
    openLink.prepend(icon('external'));
    actions.append(openLink);
    row.append(icon('links'), info, actions);
    return row;
  }

  function fileEntry(attachment, index) {
    const message = messages[index];
    const row = element('article', 'entry');
    const info = element('div', 'entry-info');
    const access = downloadLink(attachment);
    const status = access ? 'Available' : statusNames[attachment.status] || 'Unavailable';
    const type = attachment.mimeType || attachments[attachment.kind] || 'File';
    info.append(element('strong', '', attachmentName(attachment)), element('small', '', [type, fileBytes(attachment.size), status, authorOf(message), shortTime(message)].filter(Boolean).join(' · ')));
    const actions = element('div', 'entry-actions');
    if (access) actions.append(access);
    actions.append(originalMessageButton(index));
    row.append(icon('files'), info, actions);
    return row;
  }

  function renderCollectionEntries() {
    const key = active;
    const container = element('div');
    const matches = fold(collectionFilter).trim();
    const filters = {
      media: ({kind}) => kind !== 'file' && (!mediaKind || kind === mediaKind),
      files: attachment => attachment.kind === 'file' && (!matches || fold([attachmentName(attachment), attachment.mimeType || ''].join(' ')).includes(matches)),
    };
    const entries = [];
    let count = 0;
    const start = collectionPage * collectionPageSize;
    const end = start + collectionPageSize;
    const newestFirst = collectionSort === 'newest';
    for (let offset = 0; offset < selected.length; offset++) {
      const index = selected[newestFirst ? selected.length - 1 - offset : offset];
      const item = messages[index];
      if (key === 'links') {
        for (const link of item.links) {
          const url = externalUrl(link.url);
          if (!url || (matches && !fold([url.href, link.label || '', authorOf(item)].join(' ')).includes(matches))) continue;
          if (count >= start && count < end) entries.push(linkCard(url, link.label, index));
          count++;
        }
      } else {
        for (const attachment of item.attachments) {
          if (!filters[key](attachment)) continue;
          if (count >= start && count < end) entries.push(key === 'media' ? mediaCard(attachment, index) : fileEntry(attachment, index));
          count++;
        }
      }
    }
    if (!count) {
      container.append(empty(key, 'No ' + key + ' to display', 'Change the filters or choose another view.'));
      return container;
    }
    const names = {media: ['media item', 'media items'], links: ['link', 'links'], files: ['file', 'files']};
    const section = element('div', 'section-title');
    section.append(element('h2', '', titleCase(key)), element('small', '', plural(count, ...names[key])));
    const list = element('div', key === 'media' ? 'grid' : 'entry-list');
    list.append(...entries);
    container.append(section, list);
    if (count > collectionPageSize) {
      const pager = element('div', 'pager');
      const pageCount = Math.ceil(count / collectionPageSize);
      const move = direction => {
        collectionPage += direction;
        document.getElementById('collection-content').replaceChildren(renderCollectionEntries());
        view.scrollTop = 0;
      };
      const previous = button('Previous page', () => move(-1), 'previous', true);
      const next = button('Next page', () => move(1), 'next', true);
      previous.disabled = collectionPage === 0;
      next.disabled = collectionPage + 1 >= pageCount;
      pager.append(previous, element('span', 'pagination-label', number.format(collectionPage + 1) + ' of ' + number.format(pageCount)), next);
      container.append(pager);
    }
    return container;
  }

  function collection() {
    const container = element('div', 'inner');
    const content = element('section');
    content.id = 'collection-content';
    let options = {};
    if (active === 'media') options = {label: 'Media type', options: [['', 'All media'], ...Object.entries(attachments).filter(([kind]) => kind !== 'file')]};
    if (active === 'links') options = {placeholder: 'Search links'};
    if (active === 'files') options = {placeholder: 'Search files'};
    content.append(renderCollectionEntries());
    container.append(collectionToolbar(options), content);
    return container;
  }

  function scanDateRange() {
    let first = '';
    let last = '';
    for (const message of messages) {
      const day = dayOf(message);
      if (!day) continue;
      if (!first || day < first) first = day;
      if (!last || day > last) last = day;
    }
    return [first, last];
  }

  function overview() {
    const container = element('div', 'inner');
    const summary = element('section', 'overview-card');
    summary.append(element('h2', '', 'Overview'));
    const [oldest, newest] = scanDateRange();
    const scan = archive.scan || {};
    const facts = element('div', 'facts');
    for (const [label, value] of [
      ['Messages', number.format(messages.length)], ['Attachments', number.format(totalAttachments)],
      ['Oldest captured', prettyDay(oldest)], ['Newest captured', prettyDay(newest)],
      ['Scan status', scan.status ? titleCase(scan.status) : 'Unknown'], ['Archive schema', String(archive.schemaVersion)],
    ]) {
      const fact = element('div', 'fact');
      fact.append(element('small', '', label), element('strong', '', value));
      facts.append(fact);
    }
    summary.append(facts);
    if (scan.reason) summary.append(element('p', 'chart-note', scan.reason));
    const people = element('section', 'overview-card');
    people.append(element('h2', '', 'Participants'));
    const list = element('div', 'overview-people');
    for (const [name, person] of participants) {
      const item = element('div', 'overview-person');
      item.append(avatar(name, person.avatar, true), element('span', '', name));
      list.append(item);
    }
    people.append(names.length ? list : element('small', '', 'No participant details captured'));
    container.append(summary, people);
    return container;
  }

  function displayMetric(value, format = number) {
    return Number.isFinite(value) ? format.format(value) : 'Unavailable';
  }

  function metricCard(label, value) {
    const node = element('div', 'stat-card');
    node.append(element('span', '', label), element('strong', '', value));
    return node;
  }

  function statsBlock(title, wide = false) {
    const node = element('section', wide ? 'stat-block wide' : 'stat-block');
    node.append(element('h3', '', title));
    return node;
  }

  function percentage(value, maximum) {
    if (!maximum || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value / maximum * 100));
  }

  function barList(entries, {percentages = false, limit = 10, sampleCount} = {}) {
    const list = element('div');
    if (!entries.length) return element('p', 'muted', 'No data for this selection.');
    const maximum = percentages ? sampleCount : Math.max(...entries.slice(0, limit).map(entry => entry.count));
    for (const {label, count} of entries.slice(0, limit)) {
      const row = element('div', 'bar-row');
      const track = element('div', 'bar-track');
      const fill = element('div', 'bar-fill');
      const ratio = percentage(count, maximum);
      fill.style.width = ratio + '%';
      track.append(fill);
      const value = number.format(count) + (percentages ? ' · ' + precise.format(ratio) + '%' : '');
      row.append(element('span', '', label), track, element('span', 'mono', value));
      list.append(row);
    }
    return list;
  }

  function chart(buckets, label, caption) {
    const wrap = element('div');
    if (!buckets.length) return element('p', 'muted', 'No dated activity for this selection.');
    const maximum = Math.max(...buckets.map(bucket => bucket.count));
    const plot = element('div', 'chart-plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', label);
    for (const {label, count} of buckets) {
      const bar = element('span', 'chart-bar');
      bar.style.height = percentage(count, maximum) + '%';
      bar.title = label + ' · ' + plural(count, 'message');
      plot.append(bar);
    }
    const labels = element('div', 'chart-labels');
    labels.append(element('span', '', buckets[0].label), element('span', '', buckets.at(-1).label));
    wrap.append(plot, labels);
    if (caption) wrap.append(element('p', 'chart-note', caption));
    return wrap;
  }

  function heatmap(days) {
    if (!days.length) return element('p', 'muted', 'No dated activity for this selection.');
    const counts = new Map(days.map(({label, count}) => [label, count]));
    const lastDay = new Date(days.at(-1).label);
    const end = Date.UTC(lastDay.getUTCFullYear(), lastDay.getUTCMonth(), lastDay.getUTCDate());
    const dayMs = 86_400_000;
    const first = end - (51 * 7 + lastDay.getUTCDay()) * dayMs;
    let maximum = 1;
    const map = element('div', 'heatmap');
    map.setAttribute('role', 'img');
    map.setAttribute('aria-label', 'Daily activity during the year leading up to the latest captured message');
    for (let at = first; at <= end; at += dayMs) {
      const day = new Date(at).toISOString().slice(0, 10);
      maximum = Math.max(maximum, counts.get(day) || 0);
    }
    for (let at = first; at <= end; at += dayMs) {
      const day = new Date(at).toISOString().slice(0, 10);
      const count = counts.get(day) || 0;
      const cell = element('span', count ? 'heat-cell active' : 'heat-cell');
      if (count) cell.style.setProperty('--heat-opacity', String(0.3 + 0.7 * Math.sqrt(count / maximum)));
      cell.title = prettyDay(day) + ' · ' + plural(count, 'message');
      map.append(cell);
    }
    const wrap = element('div');
    wrap.append(map, element('p', 'chart-note', prettyDay(new Date(first).toISOString().slice(0, 10)) + ' – ' + prettyDay(lastDay.toISOString().slice(0, 10))));
    return wrap;
  }

  function metricsList(pairs) {
    const node = element('dl', 'metrics-list');
    for (const [name, value] of pairs) {
      const item = element('div');
      item.append(element('dt', '', name), element('dd', 'mono', value));
      node.append(item);
    }
    return node;
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds)) return 'Unavailable';
    if (seconds < 60) return precise.format(seconds) + ' s';
    if (seconds < 3600) return precise.format(seconds / 60) + ' min';
    if (seconds < 86_400) return precise.format(seconds / 3600) + ' hr';
    return precise.format(seconds / 86_400) + ' days';
  }

  function statisticView() {
    if (statsCache.selection !== selected || !statsCache.data) {
      const restrictMessageKinds = terms.length || typeFilter.value || attachmentFilter.value;
      const dateRange = {participant: authorFilter.value, start: fromFilter.value, end: untilFilter.value};
      const data = restrictMessageKinds
        ? calculateStatistics({...archive, messages: selected.map(index => messages[index])})
        : calculateStatistics(archive, dateRange);
      if (restrictMessageKinds) data.responseTimes = {sampleCount: null, averageSeconds: null, medianSeconds: null};
      statsCache = {selection: selected, data};
    }
    const stats = statsCache.data;
    const container = element('div', 'inner');
    const heading = element('header', 'stat-head');
    heading.append(element('h2', '', 'Conversation statistics'), element('p', '', 'Activity buckets use UTC. Counts describe captured messages.'));
    const primary = element('div', 'stat-cards');
    primary.append(metricCard('Total messages', displayMetric(stats.totalMessages)), metricCard('Words exchanged', displayMetric(stats.totalWords)), metricCard('Conversation age', Number.isFinite(stats.conversationAgeDays) ? plural(stats.conversationAgeDays, 'day') : 'Unavailable'), metricCard('Longest streak', Number.isFinite(stats.longestStreakDays) ? plural(stats.longestStreakDays, 'day') : 'Unavailable'));
    const grid = element('div', 'stat-grid');
    const people = statsBlock('Messages by participant');
    people.append(barList(stats.participants.map(person => ({label: person.name, count: person.count})), {percentages: true, sampleCount: stats.totalMessages, limit: stats.participants.length}));
    const activity = statsBlock('Messages over time');
    const timeControls = element('div', 'period-controls');
    timeControls.append(element('span', 'muted', 'Group by'), select('Activity period', [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']], period, value => {
      period = value;
      render();
    }));
    const series = stats.periods[period];
    activity.append(timeControls, chart(series.slice(-80), 'Messages by ' + period, series.length > 80 ? 'Showing the 80 latest periods with activity.' : ''));
    const hours = statsBlock('Activity by hour');
    hours.append(chart(stats.byHour.map((count, hour) => ({label: String(hour).padStart(2, '0') + ':00', count})), 'Messages grouped by hour of the day'));
    const weekdays = statsBlock('Activity by weekday');
    weekdays.append(barList(stats.byWeekday.map((count, offset) => ({label: weekdayFormat.format(new Date(Date.UTC(2025, 0, 5 + offset))), count}))));
    const calendar = statsBlock('Calendar activity', true);
    calendar.append(heatmap(stats.periods.day));
    const dates = statsBlock('Most active dates');
    dates.append(barList(stats.mostActiveDates.map(item => ({...item, label: prettyDay(item.label)}))));
    const length = statsBlock('Message lengths');
    length.append(metricsList([['Total characters', displayMetric(stats.totalCharacters)], ['Average characters', displayMetric(stats.averageMessageLength, precise)], ['Median characters', displayMetric(stats.medianMessageLength, precise)]]));
    const replies = statsBlock('Estimated response times');
    replies.append(metricsList([['Average', duration(stats.responseTimes.averageSeconds)], ['Median', duration(stats.responseTimes.medianSeconds)], ['Timed transitions', displayMetric(stats.responseTimes.sampleCount)]]));
    const streaks = statsBlock('Streaks and gaps');
    streaks.append(metricsList([['Longest activity streak', Number.isFinite(stats.longestStreakDays) ? plural(stats.longestStreakDays, 'day') : 'Unavailable'], ['Longest inactive gap', Number.isFinite(stats.longestInactivityDays) ? plural(stats.longestInactivityDays, 'day') : 'Unavailable']]));
    const words = statsBlock('Most used words');
    words.append(barList(stats.words));
    const emojis = statsBlock('Most used emojis');
    emojis.append(barList(stats.emojis));
    const media = statsBlock('Attachments');
    const kindEntries = Object.entries(stats.attachments.byKind).map(([label, count]) => ({label: attachments[label] || titleCase(label), count}));
    media.append(element('p', 'muted', plural(stats.attachments.total, 'attachment')), barList(kindEntries), metricsList(Object.entries(stats.attachments.byStatus).map(([label, count]) => [statusNames[label] || titleCase(label), number.format(count)])));
    const links = statsBlock('Shared links');
    links.append(element('p', 'muted', plural(stats.links.total, 'link')), barList(stats.links.domains));
    const reactions = statsBlock('Reactions');
    reactions.append(element('p', 'muted', plural(stats.reactions.total, 'reaction')), barList(stats.reactions.types));
    grid.append(people, activity, hours, weekdays, calendar, dates, length, replies, streaks, words, emojis, media, links, reactions);
    container.append(heading, primary, grid);
    return container;
  }

  function render(toEnd = false) {
    const renderers = {messages: timeline, overview, statistics: statisticView, files: collection, media: collection, links: collection};
    view.replaceChildren(renderers[active]());
    view.scrollTop = toEnd ? view.scrollHeight : 0;
  }

  function togglePanel(name) {
    const panels = {calendar, filter};
    const panel = panels[name];
    const show = panel.hidden;
    for (const [key, area] of Object.entries(panels)) {
      area.hidden = key !== name || !show;
      document.getElementById('toggle-' + key).setAttribute('aria-expanded', String(!area.hidden));
    }
    if (show) panel.querySelector('input,select')?.focus();
  }

  function bindIcon(id, key) {
    document.getElementById(id).prepend(icon(key));
  }

  const nav = rail.querySelector('nav');
  for (const name of ['overview', 'messages', 'media', 'links', 'files', 'statistics']) {
    const control = button(titleCase(name), () => {
      if (searchTimer) searchMessages();
      selectView(name);
      drawer(false);
      render(name === 'messages');
    }, name);
    control.dataset.view = name;
    nav.append(control);
  }
  for (const [id, symbol] of Object.entries({
    'brand-icon': 'archive', 'search-icon': 'search', 'status-icon': 'archive',
    'toggle-calendar': 'calendar', 'toggle-filter': 'filter', 'mobile-menu': 'menu',
    'theme-icon': 'sun', 'close-preview': 'close', 'previous-result': 'previous', 'next-result': 'next',
  })) bindIcon(id, symbol);

  const name = archive.conversation.name || 'Conversation';
  document.getElementById('conversation-title').textContent = name;
  document.getElementById('conversation-label').textContent = name;
  document.getElementById('conversation-count').textContent = plural(messages.length, 'message');
  document.getElementById('conversation-card').prepend(avatar(name, archive.conversation.avatar));
  document.getElementById('status-messages').textContent = plural(messages.length, 'message');
  document.getElementById('status-attachments').textContent = plural(totalAttachments, 'attachment');
  const theme = document.getElementById('theme');
  function setTheme() {
    if (theme.value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme.value;
  }
  try {
    const savedTheme = localStorage.getItem('messscrap.archive.theme');
    theme.value = ['light', 'dark'].includes(savedTheme) ? savedTheme : 'system';
  } catch { /* File storage is optional */ }
  setTheme();
  theme.addEventListener('change', () => {
    setTheme();
    try { localStorage.setItem('messscrap.archive.theme', theme.value); } catch { /* File storage is optional */ }
  });
  const dialog = document.getElementById('preview');
  document.getElementById('close-preview').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => document.getElementById('preview-content').replaceChildren());
  document.getElementById('mobile-menu').addEventListener('click', () => drawer(!rail.hasAttribute('data-open')));
  document.getElementById('mobile-backdrop').addEventListener('click', () => drawer(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && rail.hasAttribute('data-open')) drawer(false);
  });

  function searchMessages() {
    clearTimeout(searchTimer);
    searchTimer = null;
    searchText = search.value.trim();
    terms = [...new Set(fold(searchText).split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
    selectView('messages');
    applyFilters();
  }
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (search.value.trim()) searchTimer = setTimeout(searchMessages, 110);
    else searchMessages();
  });
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchMessages();
    jumpToPosition(searchCursor);
  });
  document.getElementById('previous-result').addEventListener('click', () => jumpResult(-1));
  document.getElementById('next-result').addEventListener('click', () => jumpResult(1));
  document.getElementById('toggle-calendar').addEventListener('click', () => togglePanel('calendar'));
  document.getElementById('toggle-filter').addEventListener('click', () => togglePanel('filter'));
  for (const control of [fromFilter, untilFilter]) control.addEventListener('change', applyFilters);
  document.getElementById('reset-filters').addEventListener('click', () => resetFilters());
  document.getElementById('jump-earliest').addEventListener('click', () => jumpToPosition(0));
  document.getElementById('jump-latest').addEventListener('click', () => jumpToPosition(selected.length - 1));
  document.getElementById('jump-date').addEventListener('click', () => {
    const date = document.getElementById('target-date').value;
    if (!date) return;
    const position = selected.findIndex(index => dayOf(messages[index]) >= date);
    if (position < 0) notify('No captured messages on or after that date.');
    else jumpToPosition(position);
  });
  selectView('messages');
  render(true);
  app.removeAttribute('aria-busy');
}
