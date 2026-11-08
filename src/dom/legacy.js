const root = arguments[0];
const debug = Boolean(arguments[1]);
const dumpDomSamples = Boolean(arguments[2]);
const debugLite = Boolean(arguments[3]);
const textElements = Array.from(root.querySelectorAll('[dir="auto"]'));
const seen = new Set();
const rootRect = root.getBoundingClientRect();
const records = [];
const skipped = [];
const samples = [];
const BAD_AUTHORS = new Set(['go to', 'go to message', 'open', 'see more']);
window.__messscrapNodes ??= {ids: new WeakMap(), next: 0};
const nodeIds = window.__messscrapNodes;

function normalize(text) {
  return String(text || '').replace(/[\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

let dateContext = '';
let timeContext = '';
let datetimeRawContext = '';

function shortText(text, maxLength) {
  const cleaned = normalize(text);
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength) + '...';
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0
    && rect.bottom >= 0
    && rect.top <= window.innerHeight
    && rect.right >= 0
    && rect.left <= window.innerWidth;
}

function summarizeElement(el, reason, text) {
  if (!debug || skipped.length >= 500) return;
  if (!shouldKeepDebugItem('skipped', reason)) return;

  const interactive = findInteractiveAncestor(el);
  const target = interactive || el;
  skipped.push({
    kind: 'skipped',
    reason,
    text: normalize(text || el.innerText || el.textContent || ''),
    ariaLabel: normalize(target.getAttribute('aria-label')),
    role: normalize(target.getAttribute('role')),
    className: normalize(target.className),
  });
}

function addDebug(reason, payload) {
  if (!debug || skipped.length >= 500) return;
  if (!shouldKeepDebugItem('debug', reason)) return;
  skipped.push(Object.assign({kind: 'debug', reason}, payload || {}));
}

function shouldKeepDebugItem(kind, reason) {
  if (!debugLite) return true;

  if (kind === 'skipped') {
    return reason.startsWith('reply-preview')
      || reason === 'message-status-text'
      || reason === 'weekday-time-context'
      || reason === 'message-action-text'
      || reason === 'message-ui-junk';
  }

  return reason.startsWith('reply-candidate')
    || reason.startsWith('reply-preview')
    || reason === 'weekday-time-context-detected'
    || reason === 'date-context-detected'
    || reason === 'suspicious-unknown-direction'
    || reason === 'message-ui-junk';
}

function rectData(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function nodeInfo(el) {
  return {
    tag: (el.tagName || '').toLowerCase(),
    ariaLabel: normalize(el.getAttribute('aria-label')),
    title: normalize(el.getAttribute('title')),
    role: normalize(el.getAttribute('role')),
    className: shortText(el.className, 300),
    text_short: shortText(el.innerText || el.textContent || '', 300),
  };
}

function isInComposerOrChrome(el) {
  return Boolean(el.closest(
    '[role="navigation"], [role="banner"], textarea, input, [contenteditable="true"]'
  ));
}

function hasVisibleNestedDirAuto(el) {
  return Array.from(el.querySelectorAll('[dir="auto"]')).some((child) => {
    return child !== el && isVisible(child) && normalize(child.innerText || child.textContent);
  });
}

function findInteractiveAncestor(el) {
  let current = el;
  let depth = 0;

  while (current && current !== root && depth < 8) {
    const role = normalize(current.getAttribute('role')).toLowerCase();
    const tag = current.tagName ? current.tagName.toLowerCase() : '';
    if (tag === 'a' || role === 'link' || role === 'button') {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }

  return null;
}

function collectLabels(el) {
  const labels = [];
  let current = el;
  let depth = 0;

  while (current && current !== root && depth < 7) {
    for (const attr of ['aria-label', 'title']) {
      const value = normalize(current.getAttribute(attr));
      if (value) labels.push(value);
    }
    current = current.parentElement;
    depth += 1;
  }

  return Array.from(new Set(labels));
}

function looksLikeReplyPreview(el, text, labels) {
  const labelText = labels.join(' | ').toLowerCase();
  if (
    labelText.includes('original message')
    || labelText.includes('replied to themself')
    || labelText.includes('replied to herself')
    || labelText.includes('replied to himself')
    || labelText.includes('replied to you')
    || labelText.includes('you replied to')
    || labelText.includes('go to message')
    || labelText.startsWith('go to ')
  ) {
    return 'reply-preview-label';
  }

  const interactive = findInteractiveAncestor(el);
  if (interactive) {
    const role = normalize(interactive.getAttribute('role')).toLowerCase();
    const ariaLabel = normalize(interactive.getAttribute('aria-label'));
    const loweredLabel = ariaLabel.toLowerCase();
    const loweredText = normalize(text).toLowerCase();

    if (
      loweredLabel === 'go to'
      || loweredLabel === 'go to message'
      || loweredLabel.startsWith('go to ')
    ) {
      return 'reply-preview-go-to';
    }

    if (
      (role === 'link' || (interactive.tagName || '').toLowerCase() === 'a')
      && (
        loweredLabel.includes('reply')
        || loweredLabel.includes('original message')
        || loweredText.includes('original message:')
      )
    ) {
      return 'reply-preview-link';
    }
  }

  const textLower = normalize(text).toLowerCase();
  if (
    textLower.startsWith('original message:')
    || textLower.includes('original message')
    || textLower.includes('replied to themself')
    || textLower.includes('replied to herself')
    || textLower.includes('replied to himself')
    || textLower.includes('replied to you')
    || textLower === 'replied to you'
    || textLower.startsWith('you replied to')
  ) {
    return 'reply-preview-text';
  }

  return null;
}

function looksLikeStatusText(text) {
  const cleaned = normalize(text);
  return /^Sent \d+[smhd] ago$/i.test(cleaned)
    || /^Sent just now$/i.test(cleaned)
    || /^Delivered$/i.test(cleaned)
    || /^Seen$/i.test(cleaned)
    || /^Seen by .+/i.test(cleaned);
}

function parseWeekdayTimeContext(text) {
  const cleaned = normalize(text);
  const match = cleaned.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
  if (!match) return null;

  return {
    date: match[1],
    time: normalize(match[2]),
    datetime_raw: cleaned,
  };
}

function looksLikeActionText(text) {
  const cleaned = normalize(text);
  return /^Call back$/i.test(cleaned);
}

function looksLikeReplyStatusText(text) {
  const cleaned = normalize(text).toLowerCase();
  return cleaned.includes('original message')
    || cleaned.includes('you replied to')
    || cleaned.includes('replied to you')
    || cleaned.includes('replied to themself')
    || cleaned.includes('replied to herself')
    || cleaned.includes('replied to himself');
}

function looksLikeDateSeparator(text) {
  const cleaned = normalize(text);
  if (!cleaned || cleaned.length > 60) return false;
  if (looksLikeStatusText(cleaned)) return false;
  if (parseWeekdayTimeContext(cleaned)) return false;
  if (/^\d{1,2}:\d{2}\s?(?:am|pm)?$/i.test(cleaned)) return false;

  const lowered = cleaned.toLowerCase();
  if (/^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(cleaned)) {
    return true;
  }

  if (/^(jan\.?|january|feb\.?|february|mar\.?|march|apr\.?|april|may|jun\.?|june|jul\.?|july|aug\.?|august|sep\.?|sept\.?|september|oct\.?|october|nov\.?|november|dec\.?|december)\s+\d{1,2}(?:,?\s+\d{4})?$/i.test(cleaned)) {
    return true;
  }

  const polishMonths = [
    'stycznia',
    'lutego',
    'marca',
    'kwietnia',
    'maja',
    'czerwca',
    'lipca',
    'sierpnia',
    'wrze\u015bnia',
    'wrzesnia',
    'pa\u017adziernika',
    'pazdziernika',
    'listopada',
    'grudnia',
  ];
  const polishPattern = new RegExp(
    '^\\d{1,2}\\s+(' + polishMonths.join('|') + ')(?:\\s+\\d{4})?$',
    'i'
  );
  return polishPattern.test(lowered);
}

function cleanAuthor(author) {
  const cleaned = normalize(author);
  if (!cleaned) return null;

  const lowered = cleaned.toLowerCase();
  if (
    lowered === 'you'
    || lowered === 'messenger'
    || lowered === 'facebook'
    || BAD_AUTHORS.has(lowered)
    || lowered.startsWith('go to ')
    || lowered.startsWith('open ')
    || lowered.startsWith('see more')
  ) {
    return null;
  }

  return cleaned;
}

function splitDatetimeRaw(raw) {
  const cleaned = normalize(raw);
  if (!cleaned) {
    return {date: null, time: null, datetime_raw: null};
  }

  const timePattern = /\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/i;
  const numericDatePattern = /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/;
  const wordDatePattern = /\b(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan\.?|feb\.?|mar\.?|apr\.?|may|jun\.?|jul\.?|aug\.?|sep\.?|sept\.?|oct\.?|nov\.?|dec\.?)\b(?:\s+\d{1,2})?(?:,?\s+\d{4})?/i;

  const timeMatch = cleaned.match(timePattern);
  const numericDateMatch = cleaned.match(numericDatePattern);
  const wordDateMatch = cleaned.match(wordDatePattern);

  return {
    date: normalize((numericDateMatch && numericDateMatch[0]) || (wordDateMatch && wordDateMatch[0]) || '') || null,
    time: normalize((timeMatch && timeMatch[0]) || '') || null,
    datetime_raw: cleaned,
  };
}

function parseAuthorAndMessage(rest, currentText) {
  const cleanedRest = normalize(rest);
  const current = normalize(currentText);
  if (!cleanedRest) return {author: null, message: null};

  if (current) {
    const loweredRest = cleanedRest.toLowerCase();
    const loweredCurrent = current.toLowerCase();
    if (loweredRest.endsWith(loweredCurrent)) {
      const beforeText = normalize(cleanedRest.slice(0, cleanedRest.length - current.length));
      if (beforeText.endsWith(':')) {
        return {
          author: cleanAuthor(beforeText.slice(0, -1)),
          message: current,
        };
      }
    }
  }

  const colonIndex = cleanedRest.indexOf(':');
  if (colonIndex >= 0) {
    return {
      author: cleanAuthor(cleanedRest.slice(0, colonIndex)),
      message: normalize(cleanedRest.slice(colonIndex + 1)) || null,
    };
  }

  return {
    author: cleanAuthor(cleanedRest),
    message: null,
  };
}

function parseMessageMeta(labels, text) {
  const current = normalize(text);

  for (const label of labels) {
    const cleaned = normalize(label);
    if (!cleaned) continue;

    const atPrefix = cleaned.match(/^At\s+(.+?),\s*(.+)$/i);
    if (atPrefix) {
      const datetime = splitDatetimeRaw(atPrefix[1]);
      const parsed = parseAuthorAndMessage(atPrefix[2], current);
      return {
        author: parsed.author,
        date: datetime.date,
        time: datetime.time,
        datetime_raw: datetime.datetime_raw,
      };
    }

    const sentPrefix = cleaned.match(/^Enter,\s*Message sent\s+(.+?)\s+by\s+(.+)$/i);
    if (sentPrefix) {
      const datetime = splitDatetimeRaw(sentPrefix[1]);
      const parsed = parseAuthorAndMessage(sentPrefix[2], current);
      return {
        author: parsed.author,
        date: datetime.date,
        time: datetime.time,
        datetime_raw: datetime.datetime_raw,
      };
    }
  }

  return null;
}

function extractAuthor(labels, text) {
  const meta = parseMessageMeta(labels, text);
  if (meta && meta.author) return meta.author;

  const joined = labels.join(' | ');
  if (/\byou sent\b|\bsent by you\b/i.test(joined)) return null;

  const patterns = [
    /(?:message from|from|sent by)\s+([^,|.]{1,80})/i,
    /^([^,|.]{1,80})\s+(?:sent|replied|said)\b/i
  ];

  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match && match[1]) {
      const author = cleanAuthor(match[1]);
      if (author && !/^you$/i.test(author)) return author;
    }
  }

  return null;
}

function extractDatetime(labels, text) {
  const meta = parseMessageMeta(labels, text);
  if (meta && (meta.date || meta.time || meta.datetime_raw)) {
    return {
      date: meta.date || null,
      time: meta.time || null,
      datetime_raw: meta.datetime_raw || null,
    };
  }

  const timePattern = /\b\d{1,2}:\d{2}\s?(?:am|pm)?\b/i;
  const numericDatePattern = /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}\b/;
  const wordDatePattern = /\b(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan\.?|feb\.?|mar\.?|apr\.?|may|jun\.?|jul\.?|aug\.?|sep\.?|sept\.?|oct\.?|nov\.?|dec\.?)\b(?:\s+\d{1,2})?(?:,?\s+\d{4})?/i;

  for (const label of labels) {
    const cleaned = normalize(label.split(text).join(' '));
    if (!cleaned) continue;

    const timeMatch = cleaned.match(timePattern);
    const numericDateMatch = cleaned.match(numericDatePattern);
    const wordDateMatch = cleaned.match(wordDatePattern);

    if (timeMatch || numericDateMatch || wordDateMatch) {
      return {
        date: normalize((numericDateMatch && numericDateMatch[0]) || (wordDateMatch && wordDateMatch[0]) || ''),
        time: normalize((timeMatch && timeMatch[0]) || ''),
        datetime_raw: cleaned,
      };
    }
  }

  return {
    date: null,
    time: null,
    datetime_raw: null,
  };
}

function detectDirection(el, labels) {
  const rect = el.getBoundingClientRect();
  const center = rect.left + rect.width / 2;
  const rootCenter = rootRect.left + rootRect.width / 2;
  const clearSideOffset = rootRect.width * 0.05;

  if (center > rootCenter + clearSideOffset) return 'me';
  if (center < rootCenter - clearSideOffset) return 'other';

  const joined = labels.join(' | ');
  if (/\byou sent\b|\bsent by you\b/i.test(joined)) return 'me';
  if (/\bmessage from\b|\bsent by\b/i.test(joined) && !/\bsent by you\b/i.test(joined)) {
    return 'other';
  }

  return 'unknown';
}

function findBubbleElement(el) {
  let current = el;
  let bubble = el;
  let depth = 0;

  while (current && current !== root && depth < 8) {
    if (isVisible(current)) {
      const rect = current.getBoundingClientRect();
      if (
        rect.width > 0
        && rect.width <= rootRect.width * 0.78
        && rect.height > 0
        && rect.height <= window.innerHeight * 0.5
      ) {
        bubble = current;
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  return bubble;
}

function detectMessageType(el, bubble, text, labels) {
  const cleanedText = normalize(text);
  const loweredText = cleanedText.toLowerCase();
  const labelText = labels.join(' | ').toLowerCase();

  if (loweredText === 'photo') return 'photo';
  if (loweredText === 'attachment') return 'attachment';
  if (loweredText.includes('missed audio call') || loweredText.includes('missed video call')) return 'call';
  if (loweredText === 'call back') return 'call_action';
  if (loweredText.includes('voice message') || loweredText.includes('voice clip')) return 'audio';

  if (labelText.includes('missed audio call') || labelText.includes('missed video call')) return 'call';
  if (labelText.includes('voice') || labelText.includes('audio')) return 'audio';
  if (labelText.includes('sticker')) return 'sticker';
  if (labelText.includes('photo') || labelText.includes('image')) return 'photo';
  if (labelText.includes('attachment') || labelText.includes('file')) return 'attachment';

  const images = Array.from(bubble.querySelectorAll('img')).filter(isVisible);
  for (const img of images) {
    const alt = normalize(img.getAttribute('alt'));
    const rect = img.getBoundingClientRect();
    if (isEmojiLike(alt)) return 'sticker';
    if (rect.width > 64 || rect.height > 64 || alt.toLowerCase().includes('photo') || alt.toLowerCase().includes('image')) {
      return 'photo';
    }
  }

  if (text) return 'text';
  return 'unknown';
}

function isEmojiLike(text) {
  const cleaned = normalize(text);
  if (!cleaned) return false;
  return cleaned.length <= 8 && !/[A-Za-z0-9]/.test(cleaned);
}

function findMessageGroup(bubble) {
  let current = bubble;
  let group = bubble;
  let depth = 0;

  while (current && current !== root && depth < 7) {
    if (isVisible(current)) {
      const rect = current.getBoundingClientRect();
      if (
        rect.width > 0
        && rect.width <= rootRect.width * 0.9
        && rect.height > 0
        && rect.height <= window.innerHeight * 0.65
      ) {
        group = current;
      }
    }
    current = current.parentElement;
    depth += 1;
  }

  return group;
}

function isNearRect(rect, targetRect, extraY) {
  return rect.bottom >= targetRect.top - extraY
    && rect.top <= targetRect.bottom + extraY
    && rect.right >= rootRect.left
    && rect.left <= rootRect.right;
}

function parentChain(el) {
  const chain = [];
  let current = el;
  let depth = 0;

  while (current && current !== root && depth < 10) {
    chain.push(nodeInfo(current));
    current = current.parentElement;
    depth += 1;
  }

  return chain;
}

function nearbyImageElements(group, bubble, extraY) {
  const bubbleRect = bubble.getBoundingClientRect();
  const candidates = new Set([
    ...Array.from(group.querySelectorAll('img')),
    ...Array.from(root.querySelectorAll('img')).filter((img) => {
      if (!isVisible(img)) return false;
      return isNearRect(img.getBoundingClientRect(), bubbleRect, extraY);
    }),
  ]);

  return Array.from(candidates).filter(isVisible);
}

function nearbyInteractiveElements(group, bubble, extraY) {
  const bubbleRect = bubble.getBoundingClientRect();
  const selector = 'a, [role="button"], [role="link"]';
  const candidates = new Set([
    ...Array.from(group.querySelectorAll(selector)),
    ...Array.from(root.querySelectorAll(selector)).filter((node) => {
      if (!isVisible(node)) return false;
      return isNearRect(node.getBoundingClientRect(), bubbleRect, extraY);
    }),
  ]);

  return Array.from(candidates).filter(isVisible);
}

function nearbyImages(group, bubble) {
  return nearbyImageElements(group, bubble, 80).slice(0, 12).map((img) => {
    const rect = img.getBoundingClientRect();
    return {
      src: shortText(img.currentSrc || img.src || img.getAttribute('src') || '', 500),
      alt: normalize(img.getAttribute('alt')),
      ariaLabel: normalize(img.getAttribute('aria-label')),
      title: normalize(img.getAttribute('title')),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      className: shortText(img.className, 300),
    };
  });
}

function nearbyButtonsOrLinks(group, bubble) {
  return nearbyInteractiveElements(group, bubble, 80).slice(0, 16).map((node) => ({
    text: shortText(node.innerText || node.textContent || '', 300),
    ariaLabel: normalize(node.getAttribute('aria-label')),
    title: normalize(node.getAttribute('title')),
    role: normalize(node.getAttribute('role')),
    className: shortText(node.className, 300),
  }));
}

function nearbyMessageActionLabels(group, bubble, text) {
  const current = normalize(text).toLowerCase();
  if (!current) return [];

  const labels = [];
  for (const node of nearbyInteractiveElements(group, bubble, 64)) {
    const label = normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || '');
    const lowered = label.toLowerCase();
    if (!lowered.startsWith('enter, message sent')) continue;
    if (!lowered.includes(current)) continue;
    labels.push(label);
  }

  return Array.from(new Set(labels));
}

function addDomSample(el, bubble, group, text, direction) {
  if (!dumpDomSamples || samples.length >= 30) return;

  samples.push({
    text,
    direction,
    outerHTML_short: shortText(group.outerHTML || bubble.outerHTML || '', 3000),
    ariaLabel: normalize(bubble.getAttribute('aria-label')),
    title: normalize(bubble.getAttribute('title')),
    role: normalize(bubble.getAttribute('role')),
    className: shortText(bubble.className, 300),
    rect: rectData(bubble),
    parent_chain: parentChain(bubble),
    nearby_images: nearbyImages(group, bubble),
    nearby_buttons_or_links: nearbyButtonsOrLinks(group, bubble),
  });
}

function extractAvatar(bubble, direction) {
  if (direction === 'me') {
    addDebug('avatar-not-used-own-message', {});
    return null;
  }

  const bubbleRect = bubble.getBoundingClientRect();
  const group = findMessageGroup(bubble);
  const images = nearbyImageElements(group, bubble, 96);
  const candidates = [];

  for (const img of images) {
    if (!isVisible(img)) continue;

    const src = normalize(img.currentSrc || img.src || img.getAttribute('src'));
    const alt = normalize(img.getAttribute('alt'));
    const ariaLabel = normalize(img.getAttribute('aria-label'));
    const title = normalize(img.getAttribute('title'));
    const rect = img.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const centerY = rect.top + height / 2;
    const bubbleCenterY = bubbleRect.top + bubbleRect.height / 2;
    const verticalDistance = Math.abs(centerY - bubbleCenterY);
    const loweredAlt = alt.toLowerCase();
    const loweredLabels = `${alt} ${ariaLabel} ${title}`.toLowerCase();

    if (!src || src.startsWith('data:')) {
      addDebug('avatar-rejected-data-or-empty-src', {alt});
      continue;
    }

    if (width < 18 || height < 18 || width > 64 || height > 64) {
      addDebug('avatar-rejected-size', {alt, width: Math.round(width), height: Math.round(height)});
      continue;
    }

    if (
      loweredAlt.startsWith('seen by ')
      || loweredLabels.includes('message seen')
      || loweredLabels.includes('read receipt')
    ) {
      addDebug('avatar-rejected-read-receipt', {alt});
      continue;
    }

    if (isEmojiLike(alt)) {
      addDebug('avatar-rejected-emoji-alt', {alt});
      continue;
    }

    if (bubble.contains(img) || (rect.left > bubbleRect.left && rect.right < bubbleRect.right)) {
      addDebug('avatar-rejected-inside-bubble', {alt});
      continue;
    }

    if (verticalDistance > Math.max(64, bubbleRect.height * 1.2)) {
      addDebug('avatar-rejected-vertical-distance', {alt});
      continue;
    }

    const isLeftOfBubble = rect.right <= bubbleRect.left + 18;
    if (!isLeftOfBubble) {
      addDebug('avatar-rejected-not-beside-bubble', {alt});
      continue;
    }

    candidates.push({
      url: src,
      alt: alt || null,
      score: (verticalDistance * 4) + Math.abs(rect.right - bubbleRect.left),
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  const selected = candidates[0] || null;
  if (selected) {
    addDebug('avatar-selected', {alt: selected.alt, url: selected.url});
    return {
      url: selected.url,
      alt: selected.alt,
    };
  }

  addDebug('avatar-not-found', {});
  return null;
}

function cleanReplyPreviewText(rawText, currentText) {
  const current = normalize(currentText).toLowerCase();
  const lines = String(rawText || '')
    .split(/\n+/)
    .map(normalize)
    .filter(Boolean);
  const kept = [];

  for (const line of lines) {
    const lowered = line.toLowerCase();
    if (lowered === current) continue;
    if (lowered === 'attachment') continue;
    if (lowered === 'original message:') continue;
    if (lowered.startsWith('original message:')) {
      const stripped = normalize(line.replace(/^original message:\s*/i, ''));
      const strippedLowered = stripped.toLowerCase();
      if (
        stripped
        && strippedLowered !== current
        && strippedLowered !== 'attachment'
        && strippedLowered !== 'message unavailable'
        && strippedLowered !== 'attachment unavailable'
      ) {
        kept.push(stripped);
      }
      continue;
    }
    if (lowered.startsWith('original message')) continue;
    if (
      lowered === 'replied to you'
      || lowered.startsWith('you replied to')
      || lowered.includes('replied to themself')
      || lowered.includes('replied to herself')
      || lowered.includes('replied to himself')
      || lowered.includes('replied to you')
    ) continue;
    if (lowered.startsWith('go to')) continue;
    kept.push(line);
  }

  return kept.join('\n').trim();
}

function findReplyGroup(bubble) {
  let current = bubble;
  let depth = 0;

  while (current && current !== root && depth < 10) {
    const role = normalize(current.getAttribute('role')).toLowerCase();
    if (role === 'article') {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }

  return findMessageGroup(bubble);
}

function isBeforeInDom(first, second) {
  if (!first || !second || first === second) return false;
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function isReplyCandidate(node) {
  const ariaLabel = normalize(node.getAttribute('aria-label'));
  const title = normalize(node.getAttribute('title'));
  const rawText = normalize(node.innerText || node.textContent || '');
  const label = `${ariaLabel} ${title}`.toLowerCase();
  const loweredText = rawText.toLowerCase();

  return label.includes('go to replied message')
    || label.includes('go to message')
    || label.includes('original message')
    || label.includes('reply')
    || loweredText.startsWith('original message:');
}

function messageTextElementsInGroup(group) {
  return Array.from(group.querySelectorAll('[dir="auto"]')).filter((node) => {
    if (!isVisible(node)) return false;
    if (hasVisibleNestedDirAuto(node)) return false;
    if (isInComposerOrChrome(node)) return false;

    const nodeText = normalize(node.innerText || node.textContent || '');
    if (!nodeText || nodeText.length > 1500) return false;
    if (looksLikeStatusText(nodeText)) return false;

    const labels = collectLabels(node);
    return !looksLikeReplyPreview(node, nodeText, labels);
  });
}

function isFirstMessageBubbleAfterReplyCandidate(candidate, bubble, currentEl, replyGroup, replyText) {
  if (!replyGroup.contains(candidate)) return false;
  if (!isBeforeInDom(candidate, bubble)) {
    addDebug('reply-preview-not-before-bubble', {
      ariaLabel: normalize(candidate.getAttribute('aria-label')),
      role: normalize(candidate.getAttribute('role')),
      text: replyText,
    });
    return false;
  }

  const candidateRect = candidate.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  if (candidateRect.top > bubbleRect.bottom || candidateRect.bottom > bubbleRect.bottom + 2) {
    addDebug('reply-preview-not-above-bubble', {
      ariaLabel: normalize(candidate.getAttribute('aria-label')),
      role: normalize(candidate.getAttribute('role')),
      text: replyText,
    });
    return false;
  }

  const between = [];
  for (const node of messageTextElementsInGroup(replyGroup)) {
    if (node === currentEl || bubble.contains(node)) continue;

    const otherBubble = findBubbleElement(node);
    if (!replyGroup.contains(otherBubble) || otherBubble === bubble) continue;

    if (isBeforeInDom(candidate, otherBubble) && isBeforeInDom(otherBubble, bubble)) {
      between.push(otherBubble);
    }
  }

  if (between.length > 0) {
    addDebug('reply-preview-ambiguous-multiple-bubbles', {
      ariaLabel: normalize(candidate.getAttribute('aria-label')),
      role: normalize(candidate.getAttribute('role')),
      text: replyText,
      bubbles_between: between.length,
    });
    return false;
  }

  return true;
}

function extractReplyTo(bubble, currentText, currentEl) {
  const replyGroup = findReplyGroup(bubble);
  const candidates = Array.from(replyGroup.querySelectorAll('[aria-label], [title], [role="button"], [role="link"], a'))
    .filter((candidate) => candidate !== bubble && isVisible(candidate) && isReplyCandidate(candidate));

  for (const candidate of candidates) {
    const ariaLabel = normalize(candidate.getAttribute('aria-label'));
    const title = normalize(candidate.getAttribute('title'));
    const rawText = normalize(candidate.innerText || candidate.textContent || '');

    const replyText = cleanReplyPreviewText(rawText, currentText);
    if (!replyText) {
      addDebug('reply-candidate-not-attached-no-text', {
        ariaLabel,
        role: normalize(candidate.getAttribute('role')),
        text: rawText,
      });
      continue;
    }

    if (!isFirstMessageBubbleAfterReplyCandidate(candidate, bubble, currentEl, replyGroup, replyText)) {
      continue;
    }

    const reply = {
      target_index: null,
      target_message_id: null,
      author: null,
      text: replyText,
      date: null,
      time: null,
    };
    addDebug('reply-candidate-attached', {
      ariaLabel,
      role: normalize(candidate.getAttribute('role')),
      text: replyText,
      author: reply.author,
    });
    return reply;
  }

  return null;
}

for (let domIndex = 0; domIndex < textElements.length; domIndex += 1) {
  const el = textElements[domIndex];
  if (!isVisible(el)) {
    continue;
  }
  if (isInComposerOrChrome(el)) {
    summarizeElement(el, 'composer-or-browser-ui', '');
    continue;
  }
  if (hasVisibleNestedDirAuto(el)) {
    continue;
  }

  const text = (el.innerText || el.textContent || '').trim();
  if (!text) continue;
  const weekdayTimeContext = parseWeekdayTimeContext(text);
  if (weekdayTimeContext) {
    dateContext = weekdayTimeContext.date;
    timeContext = weekdayTimeContext.time;
    datetimeRawContext = weekdayTimeContext.datetime_raw;
    summarizeElement(el, 'weekday-time-context', text);
    addDebug('weekday-time-context-detected', weekdayTimeContext);
    continue;
  }
  if (looksLikeDateSeparator(text)) {
    dateContext = text;
    timeContext = '';
    datetimeRawContext = '';
    addDebug('date-context-detected', {date: dateContext});
    continue;
  }
  if (looksLikeStatusText(text)) {
    summarizeElement(el, 'message-status-text', text);
    continue;
  }
  if (looksLikeActionText(text)) {
    summarizeElement(el, 'message-action-text', text);
    continue;
  }
  if (looksLikeReplyStatusText(text)) {
    summarizeElement(el, 'message-ui-junk', text);
    continue;
  }

  const initialLabels = collectLabels(el);
  const previewReason = looksLikeReplyPreview(el, text, initialLabels);
  if (previewReason) {
    summarizeElement(el, previewReason, text);
    continue;
  }

  const bubble = findBubbleElement(el);
  const group = findMessageGroup(bubble);
  const labels = Array.from(new Set([
    ...initialLabels,
    ...nearbyMessageActionLabels(group, bubble, text),
  ]));
  const bubbleRect = bubble.getBoundingClientRect();
  const direction = detectDirection(bubble, labels);
  const datetime = extractDatetime(labels, text);
  const messageDate = datetime.date || dateContext || null;
  const messageTime = datetime.time || timeContext || null;
  const messageDatetimeRaw = datetime.datetime_raw || datetimeRawContext || null;
  const messageType = detectMessageType(el, bubble, text, labels);
  const avatar = extractAvatar(bubble, direction);
  const replyTo = extractReplyTo(bubble, text, el);
  const author = extractAuthor(labels, text);
  addDomSample(el, bubble, group, text, direction);
  if (direction === 'unknown') {
    addDebug('suspicious-unknown-direction', {
      text,
      message_type: messageType,
    });
  }
  if (author) {
    addDebug('author-detected', {author});
  } else {
    addDebug('author-not-detected', {});
  }
  if (datetime.datetime_raw) {
    addDebug('timestamp-detected', {
      datetime_raw: messageDatetimeRaw,
      date: messageDate,
      time: messageTime,
    });
  } else {
    addDebug('timestamp-not-detected', {});
  }
  const position = Math.round((root.scrollTop + bubbleRect.top - rootRect.top) / 24);
  const key = [
    text.toLocaleLowerCase(),
    direction,
    position,
    domIndex
  ].join('|');
  if (seen.has(key)) continue;
  seen.add(key);

  if (!nodeIds.ids.has(el)) nodeIds.ids.set(el, ++nodeIds.next);
  records.push({
    node_id: nodeIds.ids.get(el),
    text,
    author,
    direction,
    date: messageDate,
    time: messageTime,
    datetime_raw: messageDatetimeRaw,
    message_type: messageType,
    avatar,
    reply_to: replyTo,
    position,
    domIndex
  });
}

records.sort((a, b) => {
  if (a.position !== b.position) return a.position - b.position;
  return a.domIndex - b.domIndex;
});

return {records, skipped, samples};
