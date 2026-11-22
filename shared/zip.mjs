import {SCHEMA_VERSION, formatArchive, safeFilename, safeLocalPath, statistics} from './archive.mjs';
import {makeViewer} from './viewer.mjs';

const encoder = new TextEncoder();
const zipLimit = 0xffffffff;
const maxMediaBytes = 64 * 1024 * 1024;
const maxArchiveMediaBytes = 512 * 1024 * 1024;
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipEntries(entries) {
  const files = [];
  const names = new Set();
  let dataSize = 0;
  let directorySize = 0;
  for (const [name, content] of entries) {
    if (!safeLocalPath(name)) throw new TypeError('Unsafe ZIP entry name');
    const normalizedName = name.normalize('NFC').toLowerCase();
    if (names.has(normalizedName)) throw new Error('Duplicate ZIP entry name');
    names.add(normalizedName);
    const fileName = encoder.encode(name);
    const bytes = typeof content === 'string' ? encoder.encode(content) : content;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('ZIP entries require text or bytes');
    if (fileName.length > 0xffff) throw new RangeError('ZIP entry name is too long');
    files.push({fileName, bytes, offset: dataSize, crc: crc32(bytes)});
    dataSize += 30 + fileName.length + bytes.length;
    directorySize += 46 + fileName.length;
    if (files.length >= 0xffff || dataSize + directorySize + 22 >= zipLimit) {
      throw new RangeError('Archive exceeds the standard ZIP size or file-count limit');
    }
  }
  for (const name of names) {
    let index = name.indexOf('/');
    while (index !== -1) {
      if (names.has(name.slice(0, index))) throw new Error('A ZIP path is both a file and a directory');
      index = name.indexOf('/', index + 1);
    }
  }

  const result = new Uint8Array(dataSize + directorySize + 22);
  const view = new DataView(result.buffer);
  const short = (offset, value) => view.setUint16(offset, value, true);
  const long = (offset, value) => view.setUint32(offset, value, true);
  let directory = dataSize;
  for (const {fileName, bytes, offset, crc} of files) {
    long(offset, 0x04034b50);
    short(offset + 4, 20);
    short(offset + 6, 0x0800);
    short(offset + 12, 33); // 1980-01-01, deterministic DOS date.
    long(offset + 14, crc);
    long(offset + 18, bytes.length);
    long(offset + 22, bytes.length);
    short(offset + 26, fileName.length);
    result.set(fileName, offset + 30);
    result.set(bytes, offset + 30 + fileName.length);

    long(directory, 0x02014b50);
    short(directory + 4, 20);
    short(directory + 6, 20);
    short(directory + 8, 0x0800);
    short(directory + 14, 33);
    long(directory + 16, crc);
    long(directory + 20, bytes.length);
    long(directory + 24, bytes.length);
    short(directory + 28, fileName.length);
    long(directory + 42, offset);
    result.set(fileName, directory + 46);
    directory += 46 + fileName.length;
  }
  long(directory, 0x06054b50);
  short(directory + 8, files.length);
  short(directory + 10, files.length);
  long(directory + 12, directorySize);
  long(directory + 16, dataSize);
  return result;
}

const extensions = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/webp', '.webp'],
  ['image/gif', '.gif'], ['image/avif', '.avif'], ['image/bmp', '.bmp'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
  ['audio/webm', '.weba'], ['audio/ogg', '.ogg'], ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'], ['audio/aac', '.aac'], ['audio/wav', '.wav'],
  ['application/pdf', '.pdf'], ['application/zip', '.zip'], ['text/plain', '.txt'],
]);

function mediaDirectory(mime, kind) {
  if (mime.startsWith('image/') || ['image', 'gif', 'sticker'].includes(kind)) return 'images';
  if (mime.startsWith('video/') || kind === 'video') return 'videos';
  if (mime.startsWith('audio/') || ['audio', 'voice'].includes(kind)) return 'audio';
  return 'files';
}

function expirationStatus(code) {
  return [401, 403, 404, 410].includes(code);
}

export function isMessengerMediaUrl(value, origin = globalThis.location?.origin) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:') return Boolean(origin && url.origin === origin);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /(?:^|\.)(?:facebook\.com|messenger\.com|fbcdn\.net|fbsbx\.com|cdninstagram\.com)$/iu.test(url.hostname);
  } catch {
    return false;
  }
}

function responseFilename(header) {
  const encoded = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to the plain filename parameter.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]+)"|([^;]+))/iu.exec(header);
  return plain?.[1] || plain?.[2]?.trim() || undefined;
}

async function fetchAttachmentSource(rawUrl, signal) {
  const inline = /^data:((?:image|audio|video)\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/iu.exec(rawUrl);
  if (inline) {
    if (inline[2].length > Math.ceil(maxMediaBytes * 4 / 3)) return null;
    const content = atob(inline[2]);
    const bytes = new Uint8Array(content.length);
    for (let index = 0; index < bytes.length; index++) bytes[index] = content.charCodeAt(index);
    return {bytes, mimeType: inline[1].toLowerCase()};
  }
  if (!isMessengerMediaUrl(rawUrl)) return null;
  const response = await fetch(rawUrl, {
    signal, redirect: 'error', credentials: 'same-origin', referrerPolicy: 'no-referrer',
  });
  if (expirationStatus(response.status)) return null;
  if (!response.ok) throw new Error('Attachment request failed');
  if (!response.body || Number(response.headers.get('Content-Length')) > maxMediaBytes) return null;
  const mimeType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() || '';
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxMediaBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!length) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return {bytes, mimeType, filename: responseFilename(response.headers.get('Content-Disposition') || '')};
}

export async function browserAttachmentLoader(attachment, signal, resolveInline) {
  const hasImagePreview = ['image', 'gif', 'sticker'].includes(attachment.kind);
  const sources = [attachment.inlineKey && resolveInline?.(attachment.inlineKey), attachment.sourceUrl || attachment.url];
  if (hasImagePreview) {
    sources.push(attachment.previewInlineKey && resolveInline?.(attachment.previewInlineKey), attachment.previewSourceUrl);
  }
  let failure;
  for (const url of new Set(sources.filter(Boolean))) {
    signal?.throwIfAborted();
    try {
      const media = await fetchAttachmentSource(url, signal);
      if (media) return media;
    } catch (error) {
      signal?.throwIfAborted();
      failure = error;
    }
  }
  if (failure) throw failure;
  return null;
}

export function browserAttachmentLoaderExpression() {
  return `(() => {
    const maxMediaBytes = ${maxMediaBytes};
    ${isMessengerMediaUrl.toString()}
    ${expirationStatus.toString()}
    ${responseFilename.toString()}
    ${fetchAttachmentSource.toString()}
    return ${browserAttachmentLoader.toString()};
  })()`;
}

async function loadAttempt(loader, attachment, signal, timeout) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('Attachment request timed out')), timeout);
  let rejectOnAbort;
  try {
    const aborted = new Promise((_, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectOnAbort, {once: true});
    });
    return await Promise.race([aborted, loader(attachment, controller.signal)]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', rejectOnAbort);
    signal?.removeEventListener('abort', abort);
  }
}

function publicAttachment(attachment, result) {
  const {sourceUrl, previewSourceUrl, inlineKey, previewInlineKey, url, preview_url,
    path, local_path, preview_local_path, sha256,
    _url_inline_index, _preview_url_inline_index, ...exportable} = attachment;
  return {...exportable, ...result};
}

async function archiveMedia(archive, {
  includeMedia = false, loadMedia, signal, onProgress,
  concurrency = 3, timeout = 12000, retries = 1,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12
      || !Number.isFinite(timeout) || timeout <= 0
      || !Number.isInteger(retries) || retries < 0 || retries > 4) {
    throw new RangeError('Invalid media transfer options');
  }
  signal?.throwIfAborted();
  const files = new Map();
  const bySource = new Map();
  const byDigest = new Map();
  const tasks = [];
  let bytesArchived = 0;
  const messages = archive.messages.map(message => {
    const attachments = message.attachments.map((attachment, index) => {
      const output = publicAttachment(attachment, {status: 'skipped', path: null});
      tasks.push({messageId: message.id, index, attachment, output});
      return output;
    });
    return {...message, attachments};
  });
  const totals = {finished: 0, total: tasks.length, archived: 0, failed: 0, unavailable: 0, skipped: 0};
  const manifestEntries = new Array(tasks.length);
  onProgress?.({...totals});
  let nextTask = 0;

  async function download(attachment) {
    for (let retry = 0; retry <= retries; retry++) {
      try {
        const result = await loadAttempt(loadMedia, attachment, signal, timeout);
        signal?.throwIfAborted();
        if (!result || !(result.bytes instanceof Uint8Array) || !result.bytes.length) {
          return {status: 'unavailable', reason: 'Source could not be read'};
        }
        if (result.bytes.length > maxMediaBytes) return {status: 'skipped', reason: 'Attachment exceeds 64 MiB'};
        const receivedType = (result.mimeType || attachment.mimeType || '').split(';')[0].trim().toLowerCase();
        const mimeType = /^[\w.+-]+\/[\w.+-]+$/u.test(receivedType) ? receivedType : 'application/octet-stream';
        if (['text/html', 'application/xhtml+xml'].includes(mimeType)) {
          return {status: 'unavailable', reason: 'Source returned a web page'};
        }
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', result.bytes)),
          byte => byte.toString(16).padStart(2, '0')).join('');
        const directory = mediaDirectory(mimeType, attachment.kind);
        const extension = extensions.get(mimeType) || '.bin';
        const fileKey = `${directory}/${digest}${extension}`;
        let path = byDigest.get(fileKey);
        if (!path) {
          if (bytesArchived + result.bytes.length > maxArchiveMediaBytes) {
            return {status: 'skipped', reason: 'Archive exceeds its 512 MiB media budget'};
          }
          path = 'media/' + fileKey;
          files.set(path, result.bytes);
          byDigest.set(fileKey, path);
          bytesArchived += result.bytes.length;
        }
        const filename = safeFilename(result.filename || attachment.filename || path.split('/').at(-1));
        return {status: 'archived', path, filename, mimeType, size: result.bytes.length, sha256: digest};
      } catch {
        signal?.throwIfAborted();
      }
    }
    return {status: 'failed', reason: 'Download failed after retrying the available source'};
  }

  async function worker() {
    while (nextTask < tasks.length) {
      signal?.throwIfAborted();
      const position = nextTask++;
      const {messageId, index, attachment, output} = tasks[position];
      let result;
      if (!includeMedia) result = {status: 'skipped', reason: 'Media was excluded'};
      else if (!loadMedia) result = {status: 'unavailable', reason: 'No local or browser media source'};
      else {
        const source = attachment.path || attachment.sourceUrl || attachment.url ||
          (attachment.inlineKey && 'inline:' + attachment.inlineKey);
        if (source && !bySource.has(source)) bySource.set(source, download(attachment));
        result = source ? await bySource.get(source) : await download(attachment);
      }
      Object.assign(output, result, {filename: attachment.filename
        ? safeFilename(attachment.filename) : result.filename || undefined});
      manifestEntries[position] = {messageId, index, kind: attachment.kind, ...result,
        path: output.path, filename: output.filename};
      totals[result.status]++;
      totals.finished++;
      if (totals.finished % 25 === 0 || result.status === 'archived' || totals.finished === totals.total) {
        onProgress?.({...totals});
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, tasks.length)}, worker));
  signal?.throwIfAborted();
  return {archive: {...archive, messages}, files, manifestEntries, totals};
}

export async function archiveEntries(archive, options = {}) {
  const result = await archiveMedia(archive, options);
  const {messages, ...metadata} = result.archive;
  let earliest = null;
  let latest = null;
  for (const {timestamp} of messages) {
    if (timestamp == null) continue;
    if (earliest == null || timestamp < earliest) earliest = timestamp;
    if (latest == null || timestamp > latest) latest = timestamp;
  }
  const stats = statistics(result.archive);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    conversationId: archive.conversation.id,
    scan: archive.scan,
    dateRange: {earliest, latest},
    media: result.totals,
    attachments: result.manifestEntries,
  };
  return [
    ['index.html', makeViewer(result.archive, stats)],
    ['messages.json', formatArchive(result.archive, 'json')],
    ['messages.txt', formatArchive(result.archive, 'txt')],
    ['messages.csv', formatArchive(result.archive, 'csv')],
    ['metadata.json', JSON.stringify({...metadata, messageCount: messages.length}, null, 2)],
    ['statistics.json', JSON.stringify(stats, null, 2)],
    ['manifest.json', JSON.stringify(manifest, null, 2)],
    ['README.txt', 'MessScrap Archive\n\nExtract all files into the same directory and open index.html in a browser.\n'
      + 'The viewer reads the archive locally. Keep media/ alongside index.html.\n'
      + 'See manifest.json for scan coverage and attachment availability.\n'],
    ...Array.from(result.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ];
}

export async function buildArchiveZip(archive, options = {}) {
  return zipEntries(await archiveEntries(archive, options));
}

function htmlText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export async function buildArchiveBatch(archives, options = {}) {
  const entries = [];
  const links = [];
  for (const [index, archive] of archives.entries()) {
    options.signal?.throwIfAborted();
    const folder = `conversation-${index + 1}`;
    const loadMedia = options.loadMedia && ((attachment, signal) => options.loadMedia(attachment, signal, archive));
    const files = options.entriesForArchive
      ? await options.entriesForArchive(archive) : await archiveEntries(archive, {...options, loadMedia});
    entries.push(...files.map(([path, bytes]) => [`${folder}/${path}`, bytes]));
    links.push(`<li><a href="${folder}/index.html">${htmlText(archive.conversation.name)}</a> · ${archive.messages.length} messages</li>`);
  }
  entries.unshift(['index.html', '<!doctype html><html lang="en"><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>MessScrap Archives</title>'
    + '<style>body{font:16px system-ui;max-width:48rem;margin:3rem auto;padding:0 1rem;color-scheme:light dark}'
    + 'li{padding:.6rem 0;border-bottom:1px solid #8884}</style>'
    + `<h1>MessScrap Archives</h1><p>Local archives</p><ul>${links.join('')}</ul></html>`]);
  return zipEntries(entries);
}
