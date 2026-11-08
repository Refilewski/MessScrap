const root = arguments[0];
const dumpSamples = arguments[2];
const maxSamples = arguments[4];
const captureInlineMedia = arguments[8];
const selector = '[data-message-id], [aria-roledescription="message"]';
const log = root.matches('[role="log"]') ? root : root.querySelector('[role="log"]');
const scope = log || root;
const rows = Array.from(scope.querySelectorAll(selector)).filter(row => !row.parentElement.closest(selector));
if (!rows.length) return null;
const inlineMedia = [];
if (captureInlineMedia) window.__messscrapInlineMedia = inlineMedia;

const ui = '[role="toolbar"], [role="menu"], [role="heading"], h1, h2, h3, h4, [hidden]';
const replyPattern = /^(?:go to\b|original message\b|przejdź do\b|oryginalna wiadomość\b)/i;
const reactionPattern = /\b(?:reacted|reactions?)\b|zareagowa|reakcj/i;
const receiptPattern = /^(?:seen(?: by\b|$)|read by\b|delivered$|sent(?:$| just now\b| \d+[smhd] ago\b)|wyświetlon|odczytan|dostarczon|wysłan)/i;
const profilePattern = /(?:profile (?:photo|picture)|zdjęcie profilowe)/i;
const selfPattern = /^(?:you|ty)$/i;
const emojiPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
const text = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const flat = value => text(value).replace(/\s+/g, ' ');
const label = el => flat(el.getAttribute('aria-label') || el.getAttribute('title'));
const stampTime = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm))?\b/i;
const stampDate = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)\b/;

function timestamp(raw) {
  const cleaned = flat(raw);
  const time = cleaned.match(stampTime)?.[0] || null;
  const rest = flat(time ? cleaned.replace(time, '') : cleaned)
    .replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s+(?:at|o)$/i, '');
  return {
    date: rest && (time || stampDate.test(rest)) ? rest : null,
    time,
    datetime_raw: cleaned || null,
  };
}

function messageLabel(raw) {
  let match = raw.match(/^(?:At|O)\s+(.+?),\s+(?=[^\d\s])([^:]+?)(?::\s*([\s\S]*))?$/i);
  if (!match) {
    match = raw.match(/^(?:Enter,\s*)?Message sent\s+(.+?)\s+by\s+([^:]+?)(?::\s*([\s\S]*))?$/i);
  }
  if (!match) return {author: null, sender: null, fallbackText: ''};
  const sender = flat(match[2]);
  return {
    ...timestamp(match[1]),
    sender,
    author: selfPattern.test(sender) ? null : sender,
    fallbackText: text(match[3]),
  };
}

function knownUrl(value, media = false) {
  if (!value) return null;
  try {
    const url = new URL(value, document.baseURI);
    if (url.protocol === 'http:' || url.protocol === 'https:' || (media && url.protocol === 'blob:')) {
      return url.href;
    }
  } catch {}
  return null;
}

function assetSource(el) {
  return el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src');
}

function mediaReference(source, field = 'url') {
  const dataType = source?.match(/^data:((?:image|audio|video)\/[\w.+-]+)[;,]/i)?.[1];
  if (!dataType) return {[field]: knownUrl(source, true)};
  const reference = {[field]: null, [field + '_scheme']: 'data', [field + '_mime_type']: dataType};
  if (captureInlineMedia) reference['_' + field + '_inline_index'] = inlineMedia.push(source) - 1;
  return reference;
}

function isAvatar(el) {
  return el.matches('img') && (profilePattern.test(el.alt)
    || Boolean(el.closest('[role="button"][aria-haspopup][aria-expanded]')));
}

function bodyText(el) {
  if (!el.querySelector('img[alt]')) return text(el.innerText ?? el.textContent);

  // The browser's innerText omits the alt text of inline emoji images.
  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(ui)) return '';
    if (node.tagName === 'IMG') return emojiPattern.test(node.alt) ? node.alt : '';
    if (node.tagName === 'BR') return '\n';
    const content = Array.from(node.childNodes, read).join('');
    return /^(DIV|P|LI|PRE|BLOCKQUOTE)$/.test(node.tagName) ? '\n' + content + '\n' : content;
  }
  return text(read(el)).replace(/\n{3,}/g, '\n\n');
}

function bodyParts(row, allowed) {
  const parts = [];
  for (const element of row.querySelectorAll('[dir="auto"]')) {
    if (!allowed(element)) continue;
    const parent = element.parentElement.closest('[dir="auto"]');
    if (parent && row.contains(parent) && allowed(parent)) continue;
    const content = bodyText(element);
    if (content) parts.push({element, content});
  }
  return parts;
}

function replyPreview(node) {
  if (!node) return null;
  const description = label(node);
  const owner = description.match(/^go to\s+(.+?)['’]s (?:original )?message$/i)?.[1];
  const parts = bodyParts(node, el => !el.closest(ui));
  return {
    source_message_id: node.getAttribute('data-reply-to-message-id')
      || node.querySelector('[data-message-id]')?.getAttribute('data-message-id') || null,
    author: owner && !selfPattern.test(owner) ? owner : null,
    text: parts.map(part => part.content).join('\n') || bodyText(node) || null,
    label: description || null,
  };
}

function attachment(kind, el, source = assetSource(el), extra = {}) {
  const duration = /^(AUDIO|VIDEO)$/.test(el.tagName) && Number.isFinite(el.duration)
    ? el.duration : null;
  return {
    kind,
    ...mediaReference(source),
    label: label(el) || flat(el.getAttribute('alt')) || null,
    duration_seconds: duration,
    ...extra,
  };
}

function assetsIn(row, allowed) {
  const assets = [];
  for (const media of row.querySelectorAll('img, video, audio, [role="img"], a[href][download], a[href][aria-label]')) {
    if (!allowed(media)) continue;
    const description = label(media) || flat(media.getAttribute('alt'));
    if (isAvatar(media) || receiptPattern.test(description)) continue;
    if (media.matches('video, audio')) {
      const source = assetSource(media) || assetSource(media.querySelector('source[src]') || media);
      assets.push(attachment(media.tagName.toLowerCase(), media, source,
        mediaReference(media.getAttribute('poster'), 'preview_url')));
    } else if (media.matches('a')) {
      if (media.hasAttribute('download') || /^(?:download|pobierz)\b/i.test(description)) {
        assets.push(attachment('file', media, media.getAttribute('href'), {
          filename: flat(media.getAttribute('download')) || null,
        }));
      }
    } else if (/sticker|naklejk/i.test(description)) {
      // An image inside a labelled sticker wrapper belongs to the same sticker.
      const child = media.querySelector('img');
      const background = media.style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/i)?.[1];
      assets.push(attachment('sticker', media, assetSource(child || media) || background));
    } else if (media.matches('img')) {
      const wrapper = media.parentElement.closest('[role="img"][aria-label]');
      if (wrapper && row.contains(wrapper) && /sticker|naklejk/i.test(label(wrapper))) continue;
      if (emojiPattern.test(media.alt) && media.closest('[dir="auto"]')) continue;
      const source = assetSource(media);
      const gif = /(?:^data:image\/gif[;,]|\.gif(?:[?#]|$))/i.test(source || '');
      assets.push(attachment(gif ? 'gif' : 'photo', media, source));
    }
  }
  if (!assets.some(item => item.kind === 'audio')) {
    const scrubber = Array.from(row.querySelectorAll('[role="slider"][aria-label]'))
      .find(el => allowed(el) && /audio|dźwięk|głos/i.test(label(el)));
    if (scrubber) assets.push(attachment('audio', scrubber));
  }
  return assets;
}

function classify(content, assets) {
  if (assets.length) return assets[0].kind === 'file' ? 'attachment' : assets[0].kind;
  if (/^(?:missed (?:audio |video )?call|(?:audio|video) call|nieodebrane połączenie|połączenie (?:głosowe|wideo))(?:$|[.,\n])/i.test(content)) return 'call';
  if (/^(?:you unsent a message|.+ unsent a message|cofnięto wysłanie wiadomości|wiadomość została usunięta)[.!]?$/i.test(content)) return 'event';
  return content ? 'text' : 'unknown';
}

window.__messscrapNodes ??= {ids: new WeakMap(), next: 0};
const nodeIds = window.__messscrapNodes;
const bounds = root.getBoundingClientRect();
const samples = [];
const records = [];

for (const row of rows) {
  if (row.closest('[hidden], [aria-hidden="true"]') || getComputedStyle(row).visibility === 'hidden') continue;
  const rect = row.getBoundingClientRect();
  if (!(rect.width || rect.height)) continue;
  const rawLabel = text(row.getAttribute('aria-label'));
  const meta = messageLabel(rawLabel);
  const labelled = Array.from(row.querySelectorAll('[aria-label], [title]'))
    .filter(el => !el.closest(ui));
  const quote = labelled.find(el => replyPattern.test(label(el)));
  const reactionNodes = new Set(labelled.filter(el => el.matches('button, [role="button"]') && reactionPattern.test(label(el))));
  const receiptNodes = new Set([
    ...labelled.filter(el => receiptPattern.test(label(el))),
    ...Array.from(row.querySelectorAll('img[alt]')).filter(el => receiptPattern.test(el.alt)),
  ]);
  const excluded = new Set([...reactionNodes, ...receiptNodes, ...(quote ? [quote] : [])]);
  const allowed = el => {
    if (el.closest(ui)) return false;
    for (let node = el; node !== row && node; node = node.parentElement) {
      if (excluded.has(node)) return false;
    }
    return true;
  };

  const parts = bodyParts(row, allowed);
  const attachments = assetsIn(row, allowed);
  const links = Array.from(row.querySelectorAll('a[href]')).filter(allowed).flatMap(el => {
    const url = knownUrl(el.getAttribute('href'));
    return url ? [{url, text: bodyText(el) || label(el) || null}] : [];
  });
  const reactions = Array.from(reactionNodes, el => ({
    label: label(el),
    emojis: Array.from(el.querySelectorAll('img[alt]'), img => flat(img.alt)).filter(Boolean),
    count: /^\d+$/.test(flat(el.innerText)) ? Number(flat(el.innerText)) : null,
  }));
  const receipts = Array.from(receiptNodes, el => label(el) || flat(el.alt)).filter(Boolean);
  const avatarImage = Array.from(row.querySelectorAll('img[alt]')).find(el => allowed(el) && isAvatar(el));
  const avatar = avatarImage ? {url: knownUrl(assetSource(avatarImage), true), alt: flat(avatarImage.alt)} : null;
  const content = parts.map(part => part.content).join('\n') || meta.fallbackText;
  const point = (parts[0]?.element || row.querySelector('video, audio, [role="img"]') || row).getBoundingClientRect();
  const side = (point.left + point.right - bounds.left - bounds.right) / 2;
  const direction = meta.sender ? (selfPattern.test(meta.sender) ? 'me' : 'other')
    : Math.abs(side) > bounds.width * 0.06 ? (side > 0 ? 'me' : 'other') : 'unknown';
  const timeElement = Array.from(row.querySelectorAll('time[datetime]')).find(allowed);
  if (!nodeIds.ids.has(row)) nodeIds.ids.set(row, ++nodeIds.next);

  records.push({
    source_message_id: row.getAttribute('data-message-id'),
    node_id: nodeIds.ids.get(row),
    structured: true,
    text: content,
    author: meta.author,
    direction,
    date: meta.date || null,
    time: meta.time || null,
    datetime_raw: meta.datetime_raw || null,
    timestamp: timeElement?.getAttribute('datetime') || null,
    accessibility_label: rawLabel || null,
    message_type: classify(content, attachments),
    avatar,
    reply_to: replyPreview(quote),
    attachments,
    links,
    reactions,
    receipts,
  });
  if (dumpSamples && samples.length < maxSamples) {
    samples.push({source_message_id: row.getAttribute('data-message-id'), outer_html: row.outerHTML.slice(0, 2500)});
  }
}
return {records, samples, skipped: []};
