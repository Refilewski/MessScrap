import {csvRow} from './csv.mjs';
import {txtChunks} from './transcript.mjs';

export {statistics, statisticsCsv} from './statistics.mjs';
export const SCHEMA_VERSION = 2;

const statuses = new Set(['initializing', 'scanning', 'paused', 'completed', 'partial', 'cancelled', 'failed']);
const mediaStatuses = new Set(['archived', 'unavailable', 'failed', 'skipped']);
const directions = new Set(['incoming', 'outgoing', 'unknown']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const string = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
const optional = value => string(value).trim() || null;
const identifier = value => Number.isSafeInteger(value) ? String(value) : optional(value);

export function safeLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid URL. */ }
  return null;
}

function sourceMedia(value) {
  const url = safeLink(value);
  if (url) return url;
  if (typeof value === 'string' && /^blob:https?:\/\//i.test(value) && safeLink(value.slice(5))) return value;
  return null;
}

export function safeLocalPath(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\:%?#\u0000-\u001f\u007f]/u.test(value)) return null;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..'
    && !/[. ]$/.test(segment) && !windowsReserved(segment) && !/[<>"|*]/.test(segment)) ? value : null;
}

function windowsReserved(name) {
  return /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(name);
}

export function safeFilename(value, fallback = 'conversation') {
  let filename = string(value).normalize('NFC').replace(/[\\/<>:"|?*%#\u0000-\u001f\u007f]/gu, '_')
    .replace(/^\.+/u, '').trim().replace(/[. ]+$/u, '');
  if (windowsReserved(filename)) filename = '_' + filename;
  if (new TextEncoder().encode(filename).length > 224) {
    const extension = filename.match(/\.[\p{L}\p{N}]{1,12}$/u)?.[0] || '';
    filename = Array.from(filename.slice(0, filename.length - extension.length)).slice(0, 60).join('') + extension;
  }
  return filename || (fallback === 'conversation' ? fallback : safeFilename(fallback));
}

function conversationRoute(value) {
  const link = safeLink(value);
  if (!link) return null;
  const url = new URL(link);
  if (url.protocol !== 'https:' || url.port) return null;
  const host = url.hostname.replace(/^(?:www|web|m)\./, '');
  const prefix = host === 'facebook.com' ? '/messages' : host === 'messenger.com' ? '' : null;
  if (prefix === null || !url.pathname.startsWith(prefix)) return null;
  const match = url.pathname.slice(prefix.length).match(/^\/(?:e2ee\/)?t\/([^/]+)\/?$/u);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[1]);
    if (!/^[\p{L}\p{N}._:@+-]+$/u.test(id) || id === '.' || id === '..') return null;
    return {id, url: url.origin + url.pathname.replace(/\/$/, '')};
  } catch { return null; }
}

export function conversationId(value) {
  return conversationRoute(value)?.id || null;
}

function timestamp(value) {
  if (typeof value === 'string') {
    // Localized DOM labels and timezone-free clocks do not identify an instant.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
    const day = new Date(value.slice(0, 10) + 'T00:00:00.000Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  } else if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 0 && date.getUTCFullYear() <= 9999
    ? date.toISOString() : null;
}

function avatar(value) {
  return safeLocalPath(record(value) ? value.path || value.local_path : value);
}

function participantsFor(values, messages, conversationAvatar, conversationName) {
  const participants = new Map();
  const namesWithIds = new Set(list(values).filter(person => record(person) && identifier(person.id))
    .map(person => optional(person.name)));
  const authors = new Set();
  for (const message of messages) if (message.author) authors.add(message.author);
  for (const person of [...list(values), ...authors]) {
    const name = optional(record(person) ? person.name : person);
    if (!name) continue;
    const id = record(person) ? identifier(person.id) : null;
    if (!id && namesWithIds.has(name)) continue;
    const key = id ? 'id:' + id : 'name:' + name;
    if (!participants.has(key)) participants.set(key, {
      name, id, avatar: avatar(person?.avatar) || (name === conversationName ? conversationAvatar : null),
    });
  }
  return [...participants.values()];
}

const kindAliases = new Map([
  ['photo', 'image'], ['attachment', 'file'], ['document', 'file'], ['voice_message', 'voice'],
]);

function attachment(entry) {
  const kind = optional(entry.kind) || 'file';
  const path = safeLocalPath(entry.path ?? entry.local_path);
  const size = entry.size ?? entry.size_bytes;
  const duration = entry.durationSeconds ?? entry.duration_seconds;
  const mime = optional(entry.mimeType ?? entry.mime_type ?? entry.url_mime_type);
  const error = optional(entry.errorCode ?? entry.download_error);
  const status = path ? 'archived' : mediaStatuses.has(entry.status) && entry.status !== 'archived' ? entry.status
    : error ? 'failed' : 'unavailable';
  const item = {
    kind: kindAliases.get(kind) ?? kind,
    filename: optional(entry.filename),
    label: optional(entry.label),
    mimeType: mime && /^[\w.+-]+\/[\w.+-]+$/u.test(mime) ? mime.toLowerCase() : null,
    size: Number.isSafeInteger(size) && size >= 0 ? size : null,
    durationSeconds: Number.isFinite(duration) && duration >= 0 ? duration : null,
    path,
    status,
  };
  if (typeof entry.sha256 === 'string' && /^[a-f\d]{64}$/.test(entry.sha256) && path) item.sha256 = entry.sha256;
  if (error && /^[a-z][a-z0-9_-]{0,63}$/i.test(error)) item.errorCode = error;
  const sourceUrl = sourceMedia(entry.sourceUrl ?? entry.url);
  const previewSourceUrl = sourceMedia(entry.previewSourceUrl ?? entry.preview_url);
  const inlineKey = identifier(entry.inlineKey ?? entry.inline_key);
  const previewInlineKey = identifier(entry.previewInlineKey ?? entry.preview_inline_key);
  if (sourceUrl) item.sourceUrl = sourceUrl;
  if (previewSourceUrl) item.previewSourceUrl = previewSourceUrl;
  if (inlineKey) item.inlineKey = inlineKey;
  if (previewInlineKey) item.previewInlineKey = previewInlineKey;
  return item;
}

function messageFrom(item, keepMediaSources) {
  const attachments = list(item.attachments).filter(record).map(attachment);
  const text = string(item.text ?? item.content);
  const links = new Map();
  const mediaSources = new Set(attachments.flatMap(entry => [entry.sourceUrl, entry.previewSourceUrl]).filter(Boolean));
  for (const entry of list(item.links)) {
    const url = safeLink(record(entry) ? entry.url : entry);
    if (url && !mediaSources.has(url)) links.set(url, {
      url, label: optional(entry?.label ?? entry?.text),
    });
  }
  for (const match of text.matchAll(/(?:\bhttps?:\/\/|\bwww\.)[^\s<>"']+/giu)) {
    const raw = match[0].replace(/[.,;!?]+$/u, '');
    const url = safeLink(/^www\./i.test(raw) ? 'https://' + raw : raw);
    if (url && !mediaSources.has(url) && !links.has(url)) links.set(url, {url, label: null});
  }
  if (!keepMediaSources) {
    for (const entry of attachments) {
      delete entry.sourceUrl;
      delete entry.previewSourceUrl;
      delete entry.inlineKey;
      delete entry.previewInlineKey;
    }
  }
  const type = optional(item.type ?? item.message_type) || (text ? 'text' : 'unknown');
  const direction = directions.has(item.direction) ? item.direction
    : item.direction === 'me' ? 'outgoing' : item.direction === 'other' ? 'incoming' : 'unknown';
  const reply = item.reply ?? item.reply_to;
  return {
    id: identifier(item.id ?? item.message_id),
    nativeId: identifier(item.nativeId ?? item.source_message_id),
    author: optional(item.author ?? item.sender_name),
    timestamp: timestamp(item.timestamp ?? item.timestamp_ms),
    date: optional(item.date),
    time: optional(item.time),
    datetimeRaw: optional(item.datetimeRaw ?? item.datetime_raw),
    direction,
    text,
    type: kindAliases.get(type) ?? type,
    attachments,
    links: [...links.values()],
    reactions: list(item.reactions).filter(record).map(reaction => ({
      label: optional(reaction.label ?? reaction.reaction),
      emoji: optional(reaction.emoji ?? reaction.reaction),
      emojis: list(reaction.emojis).map(optional).filter(Boolean),
      author: optional(reaction.author ?? reaction.actor),
      count: Number.isSafeInteger(reaction.count) && reaction.count > 0 ? reaction.count : null,
    })),
    receipts: list(item.receipts).map(optional).filter(Boolean),
    reply: record(reply) && {
      messageId: identifier(reply.messageId ?? reply.target_message_id),
      nativeId: identifier(reply.nativeId ?? reply.source_message_id),
      author: optional(reply.author),
      text: optional(reply.text),
      label: optional(reply.label),
      targetIndex: Number.isSafeInteger(reply.target_index) ? reply.target_index : null,
    } || null,
    avatar: avatar(item.avatar),
    edited: item.edited === true,
    forwarded: item.forwarded === true,
  };
}

function assignIds(messages) {
  const duplicates = new Set();
  const occupied = new Set(messages.map(message => message.id).filter(Boolean));
  const assigned = new Set();
  for (const [index, message] of messages.entries()) {
    const preferred = message.id;
    if (preferred && !assigned.has(preferred)) {
      assigned.add(preferred);
      continue;
    }
    if (preferred) duplicates.add(preferred);
    let id = 'local-' + (index + 1);
    while (occupied.has(id) || assigned.has(id)) id += '-';
    message.id = id;
    assigned.add(id);
  }
  return duplicates;
}

function chronological(messages) {
  let previous = '';
  const outOfOrder = messages.some(message => {
    if (!message.timestamp) return false;
    const reversed = message.timestamp < previous;
    previous = message.timestamp;
    return reversed;
  });
  if (!outOfOrder) return messages;
  // Preserve recorded positions of undated messages, while ordering known instants.
  const dated = messages.filter(message => message.timestamp).sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
  let index = 0;
  return messages.map(message => message.timestamp ? dated[index++] : message);
}

function resolveReplies(messages, duplicates) {
  if (!messages.some(message => message.reply)) return;
  const byId = new Set(messages.map(message => message.id));
  const byNative = new Map(messages.filter(message => message.nativeId).map(message => [message.nativeId, message.id]));
  const byText = new Map();
  const byAuthor = new Map();
  const matchText = value => value?.replace(/\s+/g, ' ').trim();
  const textQueries = new Set();
  const authorQueries = new Set();
  for (const message of messages) {
    const reply = message.reply;
    if (!reply || reply.nativeId || reply.messageId || !reply.text) continue;
    const quote = matchText(reply.text);
    if (reply.author) authorQueries.add(JSON.stringify([quote, reply.author.toLowerCase()]));
    else textQueries.add(quote);
  }
  const hasQueries = textQueries.size || authorQueries.size;
  for (const message of messages) {
    if (message.reply) {
      const {targetIndex, ...reply} = message.reply;
      const quote = matchText(reply.text);
      const author = reply.author?.toLowerCase();
      const target = reply.nativeId ? byNative.get(reply.nativeId)
        : reply.messageId ? (byId.has(reply.messageId) && !duplicates.has(reply.messageId) ? reply.messageId : null)
        : quote && (author ? byAuthor.get(JSON.stringify([quote, author])) : byText.get(quote));
      message.reply = Object.values(reply).some(Boolean) || targetIndex ? {
        ...reply, messageId: target && target !== message.id ? target : null,
      } : null;
    }
    if (!hasQueries) continue;
    const body = matchText(message.text);
    if (!body) continue;
    if (textQueries.has(body)) byText.set(body, byText.has(body) ? null : message.id);
    if (authorQueries.size) {
      const key = JSON.stringify([body, message.author?.toLowerCase()]);
      if (authorQueries.has(key)) byAuthor.set(key, byAuthor.has(key) ? null : message.id);
    }
  }
}

function scanMetadata(value, messages) {
  const status = statuses.has(value?.status) ? value.status : 'partial';
  const coverage = record(value?.coverage) ? Object.fromEntries(
    Object.entries(value.coverage).filter(([key, state]) => ['older', 'newer'].includes(key) && typeof state === 'string'),
  ) : {};
  const earliest = messages.find(message => message.timestamp)?.timestamp ?? null;
  const latest = messages.findLast(message => message.timestamp)?.timestamp ?? null;
  return {
    status: status === 'completed' && !messages.length ? 'partial' : status,
    reason: optional(value?.reason),
    coverage,
    startedAt: timestamp(value?.startedAt),
    endedAt: timestamp(value?.endedAt),
    earliest,
    latest,
    elapsedMs: Number.isFinite(value?.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : null,
    resumed: value?.resumed === true,
  };
}

export function createArchive({conversation = {}, scan = {}, messages = [], exportedAt = new Date().toISOString(), sourceUrl} = {},
  {keepMediaSources = true} = {}) {
  if (!record(conversation) || !Array.isArray(messages) || messages.some(item => !record(item))) {
    throw new TypeError('Supply conversation metadata and an array of message objects.');
  }
  const route = conversationRoute(sourceUrl ?? conversation.sourceUrl);
  const id = identifier(conversation.id) || route?.id;
  if (!id) throw new TypeError('Conversation ID is missing. Supply an archive conversation or a Messenger thread URL.');
  if (route && route.id !== id) throw new TypeError('Conversation ID differs from the source thread URL.');
  const observed = [];
  const nativeIds = new Set();
  for (const item of messages) {
    const message = messageFrom(item, keepMediaSources);
    if (message.nativeId && nativeIds.has(message.nativeId)) {
      // Conflicting native IDs in an input must be rejected visibly, never collapsed.
      throw new TypeError('Duplicate native message ID at messages[' + observed.length + '].');
    }
    if (message.nativeId) nativeIds.add(message.nativeId);
    observed.push(message);
  }
  const duplicates = assignIds(observed);
  for (const message of observed) {
    if (message.reply?.targetIndex && !message.reply.messageId && observed[message.reply.targetIndex - 1]) {
      message.reply.messageId = observed[message.reply.targetIndex - 1].id;
    }
  }
  const ordered = chronological(observed);
  resolveReplies(ordered, duplicates);
  const name = optional(conversation.name) || 'Messenger conversation';
  const conversationAvatar = avatar(conversation.avatar);
  return {
    schemaVersion: SCHEMA_VERSION,
    conversation: {
      id, name, participants: participantsFor(conversation.participants, ordered, conversationAvatar, name),
      avatar: conversationAvatar,
    },
    scan: scanMetadata(scan, ordered),
    exportedAt: timestamp(exportedAt),
    sourceUrl: route?.url ?? null,
    messages: ordered,
  };
}

export function archiveFromCapture(payload) {
  const route = conversationRoute(payload?.source_url);
  if (!route || route.id !== payload.conversation?.id || !Array.isArray(payload.items) || payload.count !== payload.items.length) {
    throw new TypeError('The captured messages do not match a verified Messenger conversation.');
  }
  return createArchive({
    conversation: payload.conversation,
    scan: {...payload.scan, coverage: payload.scan?.coverage ?? payload.coverage},
    messages: payload.items,
    exportedAt: payload.exported_at,
    sourceUrl: route.url,
  });
}

function checkArchive(value) {
  const errors = [];
  const warnings = [];
  const issue = message => {
    if (errors.length < 30) errors.push(message);
    else if (errors.length === 30) errors.push('Additional validation errors omitted.');
  };
  const isText = value => typeof value === 'string' && value.trim().length > 0;
  const nullableString = value => value === null || typeof value === 'string';
  const nullableTimestamp = value => value === null || (typeof value === 'string' && timestamp(value) === value);
  const nullablePath = value => value === null || safeLocalPath(value) === value;
  if (!record(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return {valid: false, errors: ['Expected a schemaVersion ' + SCHEMA_VERSION + ' archive object.'], warnings};
  }
  if (!record(value.conversation) || !isText(value.conversation.id) || !isText(value.conversation.name)) {
    issue('conversation.id and conversation.name must be non-empty strings.');
  }
  if (!Array.isArray(value.conversation?.participants)) issue('conversation.participants must be an array.');
  for (const [index, person] of list(value.conversation?.participants).entries()) {
    if (!record(person) || !isText(person.name) || !nullablePath(person.avatar ?? null)
      || !nullableString(person.id ?? null)) issue('conversation.participants[' + index + '] has invalid metadata.');
  }
  if (!nullablePath(value.conversation?.avatar ?? null)) issue('conversation.avatar must be a safe relative path.');
  if (!record(value.scan) || !statuses.has(value.scan.status)) issue('scan.status must be a recognized scan state.');
  if (record(value.scan)) {
    for (const key of ['startedAt', 'endedAt', 'earliest', 'latest']) {
      if (!nullableTimestamp(value.scan[key] ?? null)) issue('scan.' + key + ' must be a UTC timestamp or null.');
    }
    if (!nullableString(value.scan.reason ?? null)) issue('scan.reason must be a string or null.');
    if (value.scan.coverage != null && (!record(value.scan.coverage) || Object.entries(value.scan.coverage)
      .some(([key, state]) => !['older', 'newer'].includes(key) || !isText(state)))) {
      issue('scan.coverage must be a map of older and newer coverage states.');
    }
    if (value.scan.elapsedMs != null && (!Number.isFinite(value.scan.elapsedMs) || value.scan.elapsedMs < 0)) {
      issue('scan.elapsedMs must be a non-negative number or null.');
    }
    if (value.scan.resumed != null && typeof value.scan.resumed !== 'boolean') issue('scan.resumed must be a boolean.');
  }
  if (!nullableTimestamp(value.exportedAt ?? null)) issue('exportedAt must be a UTC timestamp or null.');
  if (value.sourceUrl != null && conversationRoute(value.sourceUrl)?.id !== value.conversation?.id) {
    issue('sourceUrl must name the same Messenger conversation as conversation.id.');
  }
  if (!Array.isArray(value.messages)) issue('messages must be an array.');
  const ids = new Set();
  const nativeIds = new Set();
  let previous = '';
  let earliest = null;
  let missingDates = 0;
  for (const [index, item] of list(value.messages).entries()) {
    const context = 'messages[' + index + ']';
    if (!record(item)) {
      issue(context + ' must be an object.');
      continue;
    }
    if (!isText(item.id)) issue(context + '.id must be a non-empty string.');
    if (ids.has(item.id)) issue(context + '.id repeats an earlier message ID.');
    ids.add(item.id);
    if (!nullableString(item.nativeId ?? null)) issue(context + '.nativeId must be a string or null.');
    if (item.nativeId && nativeIds.has(item.nativeId)) issue(context + '.nativeId repeats an earlier native ID.');
    if (item.nativeId) nativeIds.add(item.nativeId);
    if (!isText(item.type) || typeof item.text !== 'string' || !directions.has(item.direction)) {
      issue(context + ' requires a type, text and a recognized direction.');
    }
    for (const key of ['author', 'date', 'time', 'datetimeRaw']) {
      if (!nullableString(item[key] ?? null)) issue(context + '.' + key + ' must be a string or null.');
    }
    for (const key of ['edited', 'forwarded']) {
      if (item[key] != null && typeof item[key] !== 'boolean') issue(context + '.' + key + ' must be a boolean.');
    }
    if (!nullablePath(item.avatar ?? null)) issue(context + '.avatar must be a safe relative path.');
    if (item.reply != null && (!record(item.reply) || ['messageId', 'nativeId', 'author', 'text', 'label']
      .some(key => !nullableString(item.reply[key] ?? null)))) issue(context + '.reply has invalid metadata.');
    if (!nullableTimestamp(item.timestamp)) issue(context + '.timestamp must be a UTC timestamp or null.');
    if (item.timestamp) {
      if (item.timestamp < previous) issue(context + '.timestamp is earlier than a previous message.');
      earliest ??= item.timestamp;
      previous = item.timestamp;
    } else missingDates++;
    for (const key of ['attachments', 'links', 'reactions']) {
      if (!Array.isArray(item[key])) issue(context + '.' + key + ' must be an array.');
    }
    if (item.receipts != null && (!Array.isArray(item.receipts) || item.receipts.some(receipt => !isText(receipt)))) {
      issue(context + '.receipts must be an array of strings.');
    }
    for (const [assetIndex, entry] of list(item.attachments).entries()) {
      const asset = context + '.attachments[' + assetIndex + ']';
      if (!record(entry) || !isText(entry.kind) || !mediaStatuses.has(entry.status)) {
        issue(asset + ' requires a kind and a recognized attachment status.');
        continue;
      }
      if (!nullablePath(entry.path ?? null)) issue(asset + '.path must be a safe relative path.');
      if (Boolean(entry.path) !== (entry.status === 'archived')) issue(asset + '.status and .path disagree.');
      if (entry.size != null && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
        issue(asset + '.size must be a non-negative integer or null.');
      }
      if (entry.durationSeconds != null && (!Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 0)) {
        issue(asset + '.durationSeconds must be a non-negative number or null.');
      }
      for (const key of ['filename', 'label', 'mimeType', 'errorCode']) {
        if (!nullableString(entry[key] ?? null)) issue(asset + '.' + key + ' must be a string or null.');
      }
      if (entry.mimeType != null && !/^[\w.+-]+\/[\w.+-]+$/u.test(entry.mimeType)) issue(asset + '.mimeType is invalid.');
      if (entry.sha256 != null && (typeof entry.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(entry.sha256) || !entry.path)) {
        issue(asset + '.sha256 must be a lowercase SHA-256 digest for an archived attachment.');
      }
    }
    for (const [linkIndex, link] of list(item.links).entries()) {
      if (!record(link) || !safeLink(link.url) || !nullableString(link.label ?? null)) {
        issue(context + '.links[' + linkIndex + '] requires an HTTP(S) URL and an optional label.');
      }
    }
    for (const [reactionIndex, reaction] of list(item.reactions).entries()) {
      if (!record(reaction) || ['label', 'emoji', 'author'].some(key => !nullableString(reaction[key] ?? null))
        || (reaction.emojis != null && (!Array.isArray(reaction.emojis) || reaction.emojis.some(emoji => !isText(emoji))))
        || (reaction.count != null && (!Number.isSafeInteger(reaction.count) || reaction.count < 1))) {
        issue(context + '.reactions[' + reactionIndex + '] has invalid metadata.');
      }
    }
  }
  for (const [index, item] of list(value.messages).entries()) {
    if (item?.reply?.messageId && (item.reply.messageId === item.id || !ids.has(item.reply.messageId))) {
      issue('messages[' + index + '].reply.messageId must reference another message in the archive.');
    }
  }
  if (value.scan?.status === 'completed' && !value.messages?.length) issue('An empty scan cannot be completed.');
  if ((value.scan?.earliest && value.scan.earliest !== earliest)
    || (value.scan?.latest && value.scan.latest !== previous)) issue('scan dates disagree with the captured timestamps.');
  if (missingDates) warnings.push(missingDates + ' message(s) have no exact timestamp.');
  if (value.scan?.status !== 'completed') warnings.push('Coverage is partial or unconfirmed.');
  return {valid: !errors.length, errors, warnings};
}

function stableId(value) {
  // Names and export paths are identity hints only. Keep the original components
  // instead of relying on a small hash to distinguish independent conversations.
  return encodeURIComponent(JSON.stringify(value));
}

function importOfficial(data) {
  if (!Array.isArray(data.messages) || !Array.isArray(data.participants)
    || (!optional(data.title) && !optional(data.thread_path))) {
    throw new TypeError('Unrecognized archive. Expected MessScrap JSON or an official Messenger message JSON file.');
  }
  if (data.participants.some(person => !record(person) || !optional(person.name))) {
    throw new TypeError('Official export participants must have non-empty names.');
  }
  for (const [index, item] of data.messages.entries()) {
    if (!record(item) || typeof item.sender_name !== 'string' || typeof item.timestamp_ms !== 'number' || !timestamp(item.timestamp_ms)) {
      throw new TypeError('Official export messages[' + index + '] requires sender_name and timestamp_ms.');
    }
  }
  const participants = data.participants.map(person => person.name);
  const path = optional(data.thread_path);
  const ownerGroup = path ? path.split('/').slice(-1)[0] : null;
  if (path && !safeLocalPath(path)) throw new TypeError('Official export thread_path must be a safe relative path.');
  const id = 'official:' + stableId(ownerGroup ? [ownerGroup] : [optional(data.title), [...participants].sort()]);
  const sections = {
    photos: 'image', videos: 'video', audio_files: 'audio', gifs: 'gif', stickers: 'sticker', files: 'file',
  };
  const messages = [...data.messages].reverse().map(item => {
    const attachments = Object.entries(sections).flatMap(([key, kind]) => {
      const entries = record(item[key]) ? [item[key]] : list(item[key]);
      return entries.filter(record).map(entry => {
        const filepath = safeLocalPath(entry.uri);
        return {
          kind, path: filepath,
          filename: filepath?.split('/').at(-1) ?? null,
        };
      });
    });
    if (record(item.sticker)) {
      const filepath = safeLocalPath(item.sticker.uri);
      attachments.push({kind: 'sticker', path: filepath, filename: filepath?.split('/').at(-1) ?? null});
    }
    return {
      author: item.sender_name,
      timestamp: item.timestamp_ms,
      text: item.content,
      type: item.is_unsent ? 'system' : optional(item.type)?.toLowerCase() === 'call' ? 'call'
        : attachments[0]?.kind || (item.content ? 'text' : 'unknown'),
      links: item.share?.link ? [{url: item.share.link, label: item.share.share_text}] : [],
      attachments,
      reactions: item.reactions,
    };
  });
  return createArchive({
    conversation: {id, name: data.title, participants},
    scan: {status: 'partial', reason: 'Coverage of this official export could not be verified.'},
    exportedAt: null,
    messages,
  });
}

function importLegacy(data) {
  const messages = Array.isArray(data) ? data : data.items ?? data.messages;
  if (!Array.isArray(messages)) {
    throw new TypeError('Legacy archive must contain an items or messages array.');
  }
  if (record(data) && data.count != null && (!Number.isSafeInteger(data.count) || data.count !== messages.length)) {
    throw new TypeError('Legacy archive count does not match the number of messages.');
  }
  for (const [index, item] of messages.entries()) {
    if (!record(item) || (typeof item.text !== 'string' && typeof item.content !== 'string'
      && !optional(item.message_type) && !optional(item.type) && !list(item.attachments).length)) {
      throw new TypeError('Legacy message at index ' + index + ' has no readable text, type or attachments.');
    }
    for (const key of ['text', 'author', 'date', 'time', 'timestamp']) {
      if (item[key] != null && typeof item[key] !== 'string' && (key !== 'timestamp' || typeof item[key] !== 'number')) {
        throw new TypeError('Legacy messages[' + index + '].' + key + ' has an invalid type.');
      }
    }
    for (const key of ['attachments', 'links', 'reactions', 'receipts']) {
      if (item[key] != null && !Array.isArray(item[key])) {
        throw new TypeError('Legacy messages[' + index + '].' + key + ' must be an array.');
      }
    }
  }
  const sourceUrl = data.source_url ?? data.sourceUrl;
  const route = conversationRoute(sourceUrl);
  if (sourceUrl && !route) throw new TypeError('Legacy archive source URL is not a supported Messenger thread.');
  const participants = new Set(messages.map(item => optional(item.author)).filter(Boolean));
  const migrationId = 'legacy:' + stableId([optional(data.title), [...participants].sort()]);
  return createArchive({
    conversation: {
      id: route?.id ?? identifier(data.conversation?.id) ?? migrationId,
      name: optional(data.conversation?.name ?? data.title) ?? (participants.size === 1 ? [...participants][0] : null),
      participants: data.conversation?.participants,
    },
    scan: {
      status: data.interrupted ? 'cancelled' : 'partial',
      reason: 'Migrated legacy archive. Original coverage is unverified.',
      coverage: data.coverage,
    },
    sourceUrl,
    exportedAt: data.exported_at ?? data.exportedAt ?? null,
    messages,
  }, {keepMediaSources: false});
}

export function importArchive(data) {
  if (typeof data === 'string') {
    try { data = JSON.parse(data.replace(/^\uFEFF/u, '')); }
    catch { throw new TypeError('Invalid JSON. Choose a MessScrap or official Messenger JSON archive.'); }
  }
  if (!Array.isArray(data) && !record(data)) throw new TypeError('Expected a JSON archive object.');
  const version = data.schemaVersion ?? data.schema_version;
  if (version === SCHEMA_VERSION && data.schemaVersion === SCHEMA_VERSION) {
    const result = checkArchive(data);
    if (!result.valid) throw new TypeError(result.errors.join('\n'));
    return createArchive(data, {keepMediaSources: false});
  }
  if (version != null && version !== 1) throw new TypeError('Unsupported archive schema version ' + String(version) + '.');
  return Array.isArray(data) || data.items != null || version === 1 ? importLegacy(data) : importOfficial(data);
}

export function validateArchive(data) {
  if (record(data) && data.schemaVersion === SCHEMA_VERSION) return checkArchive(data);
  try {
    return checkArchive(importArchive(data));
  } catch (error) {
    return {valid: false, errors: error.message.split('\n'), warnings: []};
  }
}

const fallbackKey = item => item.timestamp && authorOf(item) !== 'Unknown sender'
  && (item.text || item.attachments.length) ? JSON.stringify([
    item.timestamp, item.author, item.direction, item.type, item.text,
    item.attachments.map(entry => [entry.kind, entry.filename, entry.label]),
  ]) : null;
const authorOf = item => item.author || (item.direction === 'outgoing' ? 'You' : 'Unknown sender');

function addIndex(map, key, index) {
  if (key) map.set(key, map.has(key) ? null : index);
}

function attachmentIdentity(item) {
  return JSON.stringify([item.kind, item.filename || item.label, item.durationSeconds]);
}

function mergeAttachments(existing, observed) {
  const indices = new Map();
  existing.forEach((item, index) => addIndex(indices, attachmentIdentity(item), index));
  const observedIndices = new Map();
  observed.forEach((item, index) => addIndex(observedIndices, attachmentIdentity(item), index));
  const attachments = [...existing];
  for (const [index, item] of observed.entries()) {
    const key = attachmentIdentity(item);
    const target = indices.get(key);
    if (target == null || observedIndices.get(key) !== index) {
      const alreadyArchived = item.path && attachments.some(entry => entry.path === item.path);
      if (!alreadyArchived) attachments.push(item);
      continue;
    }
    const prior = attachments[target];
    const fields = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
    attachments[target] = prior.path ? {...fields, ...prior} : {...prior, ...fields};
  }
  return attachments;
}

function mergeObservation(existing, observed) {
  const edited = existing.edited || observed.edited;
  const conflict = Boolean(existing.author && observed.author && existing.author !== observed.author)
    || Boolean(existing.timestamp && observed.timestamp && existing.timestamp !== observed.timestamp)
    || Boolean(existing.text && observed.text && existing.text !== observed.text && !observed.edited);
  if (conflict) return {conflict, item: existing};
  const linkMap = new Map(existing.links.map(link => [link.url, link]));
  for (const link of observed.links) if (!linkMap.has(link.url) || link.label) linkMap.set(link.url, link);
  return {
    conflict,
    item: {
      ...existing,
      nativeId: existing.nativeId ?? observed.nativeId,
      author: existing.author ?? observed.author,
      timestamp: existing.timestamp ?? observed.timestamp,
      date: existing.date ?? observed.date,
      time: existing.time ?? observed.time,
      datetimeRaw: existing.datetimeRaw ?? observed.datetimeRaw,
      reply: existing.reply || observed.reply,
      direction: existing.direction === 'unknown' ? observed.direction : existing.direction,
      type: existing.type === 'unknown' ? observed.type : existing.type,
      text: (observed.edited ? observed.text : existing.text) || observed.text,
      attachments: mergeAttachments(existing.attachments, observed.attachments),
      links: [...linkMap.values()],
      reactions: observed.reactions.length ? observed.reactions : existing.reactions,
      receipts: observed.receipts.length ? observed.receipts : existing.receipts,
      avatar: existing.avatar ?? observed.avatar,
      edited,
      forwarded: existing.forwarded || observed.forwarded,
    },
  };
}

export function mergeArchives(base, next) {
  if (base.conversation.id !== next.conversation.id) throw new TypeError('Cannot merge different conversations.');
  if (base.conversation.id.startsWith('legacy:') || base.conversation.id.startsWith('official:')) {
    throw new TypeError('This import has no verified conversation identity. Merge requires a Messenger thread ID.');
  }
  const needsFallback = [base, next].some(archive => archive.messages.some(item => !item.nativeId));
  const baseKeys = needsFallback ? base.messages.map(fallbackKey) : [];
  const nextKeys = needsFallback ? next.messages.map(fallbackKey) : [];
  const baseIndex = new Map();
  const nextIndex = new Map();
  const nativeIndex = new Map();
  base.messages.forEach((item, index) => {
    if (item.nativeId) nativeIndex.set(item.nativeId, index);
    addIndex(baseIndex, baseKeys[index], index);
  });
  nextKeys.forEach((key, index) => addIndex(nextIndex, key, index));
  const isNeighbor = (left, right, timestamp) => {
    const previous = base.messages[left];
    const incoming = next.messages[right];
    if (!previous || !incoming) return false;
    return previous.nativeId && incoming.nativeId ? previous.nativeId === incoming.nativeId
      : Boolean(previous.timestamp && previous.timestamp !== timestamp && baseKeys[left] && baseKeys[left] === nextKeys[right]
        && baseIndex.get(baseKeys[left]) === left && nextIndex.get(nextKeys[right]) === right);
  };

  const matching = new Set();
  const mapping = new Map();
  const occupied = new Set(base.messages.map(item => item.id));
  const results = [...base.messages];
  const incomingMap = new Map();
  const report = {added: 0, updated: 0, unchanged: 0, conflicting: 0, conflictIds: [], uncertain: true};
  const pending = [];
  const placement = new Map();
  const lastBase = base.messages.length;
  let lastMatch = -1;
  let additions = [];
  let reordered = false;
  let overlapping = false;
  for (const [index, item] of next.messages.entries()) {
    const key = nextKeys[index];
    let match = item.nativeId ? nativeIndex.get(item.nativeId) : undefined;
    if (match == null && key && nextIndex.get(key) === index) {
      const candidate = baseIndex.get(key);
      if (candidate != null && !(base.messages[candidate].nativeId && item.nativeId)
        && (isNeighbor(candidate - 1, index - 1, item.timestamp)
          || isNeighbor(candidate + 1, index + 1, item.timestamp))) match = candidate;
    }
    if (match != null && !matching.has(match)) {
      if (match < lastMatch) reordered = true;
      if (additions.length) {
        placement.set(match, additions);
        additions = [];
      }
      lastMatch = match;
      matching.add(match);
      overlapping = true;
      mapping.set(item.id, results[match].id);
      pending.push([match, item]);
    } else {
      let id = item.id;
      if (occupied.has(id)) id = 'merged-' + (results.length + 1);
      while (occupied.has(id)) id += '-';
      mapping.set(item.id, id);
      occupied.add(id);
      incomingMap.set(item.id, results.length);
      additions.push(results.length);
      results.push({...item, id});
      report.added++;
    }
  }
  const remapReply = item => item.reply ? {
    ...item.reply, messageId: mapping.get(item.reply.messageId) ?? null,
  } : null;
  for (const item of next.messages) {
    const index = incomingMap.get(item.id);
    if (index != null) results[index] = {...results[index], reply: remapReply(item)};
  }
  for (const [match, item] of pending) {
    const previous = results[match];
    const result = mergeObservation(previous, {...item, reply: remapReply(item)});
    results[match] = result.item;
    if (result.conflict) {
      report.conflicting++;
      if (report.conflictIds.length < 100) report.conflictIds.push(previous.id);
    } else if (JSON.stringify(previous) === JSON.stringify(result.item)) report.unchanged++;
    else report.updated++;
  }
  // Position additions relative to observed overlap. This preserves their order
  // even when timestamps are missing or two events share one clock reading.
  if (additions.length) placement.set(lastMatch >= 0 ? lastMatch + 1 : lastBase, additions);
  const ordered = !reordered && overlapping && report.added ? [] : results;
  if (ordered !== results) {
    for (let index = 0; index <= lastBase; index++) {
      for (const added of placement.get(index) || []) ordered.push(results[added]);
      if (index < lastBase) ordered.push(results[index]);
    }
  }
  const verified = overlapping && !reordered && base.scan.status === 'completed' && next.scan.status === 'completed' && !report.conflicting;
  report.uncertain = !verified;
  const result = createArchive({
    conversation: {
      ...base.conversation,
      participants: [...base.conversation.participants, ...next.conversation.participants],
    },
    sourceUrl: base.sourceUrl ?? next.sourceUrl,
    exportedAt: next.exportedAt,
    scan: {
      ...next.scan,
      status: verified ? 'completed' : 'partial',
      reason: verified ? 'Merged overlapping scans with verified coverage.' : 'Merged observed messages. Continuous history could not be verified.',
    },
    messages: ordered,
  });
  return {archive: result, report};
}

const hasSessionMedia = ({sourceUrl, previewSourceUrl, inlineKey, previewInlineKey}) =>
  sourceUrl !== undefined || previewSourceUrl !== undefined || inlineKey !== undefined || previewInlineKey !== undefined;

function publicMessage(item) {
  if (!item.attachments.some(hasSessionMedia)) return item;
  return {
    ...item,
    attachments: item.attachments.map(({sourceUrl, previewSourceUrl, inlineKey, previewInlineKey, ...entry}) => entry),
  };
}

export function publicArchive(archive) {
  return archive.messages.some(item => item.attachments.some(hasSessionMedia))
    ? {...archive, messages: archive.messages.map(publicMessage)} : archive;
}

function* jsonChunks(archive) {
  yield '{';
  let first = true;
  for (const [key, value] of Object.entries(archive)) {
    if (value === undefined) continue;
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(key) + ':';
    if (key === 'messages') {
      yield '[';
      for (const [index, item] of value.entries()) {
        yield (index ? ',' : '') + JSON.stringify(publicMessage(item));
      }
      yield ']';
    } else yield JSON.stringify(value);
  }
  yield '}\n';
}

function* csvChunks(archive) {
  yield csvRow(['id', 'native_id', 'timestamp_utc', 'date', 'time', 'author', 'direction', 'type', 'text', 'attachment_count', 'links']);
  for (const item of archive.messages) {
    yield csvRow([
      item.id, item.nativeId, item.timestamp, item.date, item.time, item.author, item.direction, item.type,
      item.text, item.attachments.length, item.links.map(link => link.url).join('\n'),
    ]);
  }
}

const serializers = new Map([['json', jsonChunks], ['txt', txtChunks], ['csv', csvChunks]]);

export function* archiveChunks(archive, format) {
  const serialize = serializers.get(format);
  if (!serialize) throw new TypeError('Unsupported export format ' + String(format) + '.');
  let buffer = '';
  for (const chunk of serialize(archive)) {
    buffer += chunk;
    if (buffer.length >= 65536) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

export function formatArchive(archive, format) {
  return format === 'json' ? JSON.stringify(publicArchive(archive)) + '\n' : [...archiveChunks(archive, format)].join('');
}

export function searchMessages(archive, query) {
  const terms = string(query).trim().normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return archive.messages;
  return archive.messages.filter(item => {
    const text = [item.text, item.author, ...item.attachments.map(entry => entry.filename || entry.label), ...item.links.map(link => link.url)]
      .join(' ').normalize('NFKC').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}
