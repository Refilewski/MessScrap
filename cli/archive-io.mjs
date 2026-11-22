import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';
import { importArchive, safeFilename, safeLocalPath, validateArchive } from '../shared/archive.mjs';

const maxJson = 256 * 1024 * 1024;
const maxMedia = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const archiveStatuses = ['archived', 'failed', 'unavailable', 'skipped'];
const missing = error => error?.code === 'ENOENT';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function writeAtomic(path, contents, { replace = false, confirm } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), '.messscrap-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await confirm?.();
    if (replace) await rename(temporary, path);
    else {
      try {
        await link(temporary, path);
      } catch (error) {
        if (!['ENOSYS', 'ENOTSUP', 'EXDEV', 'EPERM', 'EOPNOTSUPP'].includes(error.code)) throw error;
        await copyFile(temporary, path, constants.COPYFILE_EXCL);
      }
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output already exists: ' + path);
    throw error;
  } finally {
    await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
  }
  return path;
}

export function outputFile(directory, name, format) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = Array.from(safeFilename(name)).slice(0, 64).join('') || 'archive';
  return join(resolve(directory), slug + '-' + stamp + '-' + randomUUID().slice(0, 8) + '.' + format);
}

async function checkedFile(path, limit) {
  const file = await stat(path);
  if (!file.isFile()) throw new Error('Expected a regular archive file.');
  if (file.size > limit) throw new Error('File exceeds the supported input size.');
  return readFile(path);
}

function parse(bytes, name) {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(name + ' is not well-formed UTF-8 JSON.');
  }
}

async function readSegment(file, start, length) {
  const target = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(target, offset, length - offset, start + offset);
    if (!bytesRead) throw new Error('The ZIP file is truncated.');
    offset += bytesRead;
  }
  return target;
}

function zipName(raw, directory) {
  const path = decoder.decode(raw);
  const name = directory ? path.slice(0, -1) : path;
  if (!name || name.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f\\:*?"<>|]/u.test(part) ||
    /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('The ZIP contains an unsafe entry path.');
  }
  return path;
}

async function openZip(path) {
  const file = await open(path, 'r');
  const entries = new Map();
  const canonical = new Map();
  let directoryOffset;
  try {
    const { size } = await file.stat();
    const tailLength = Math.min(size, 22 + 65535);
    const tail = await readSegment(file, size - tailLength, tailLength);
    let end = tailLength - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50 ||
        tail.readUInt16LE(end + 20) !== tailLength - end - 22)) end--;
    if (end < 0) throw new Error('No ZIP directory found.');
    const totalEntries = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) ||
        tail.readUInt16LE(end + 8) !== totalEntries || totalEntries === 65535 ||
        directorySize > 32 * 1024 * 1024 || directoryOffset + directorySize !== size - tailLength + end) {
      throw new Error('Unsupported or malformed ZIP directory.');
    }
    const directory = await readSegment(file, directoryOffset, directorySize);
    let position = 0;
    for (let count = 0; count < totalEntries; count++) {
      if (position + 46 > directorySize || directory.readUInt32LE(position) !== 0x02014b50) {
        throw new Error('Malformed ZIP directory entry.');
      }
      const flags = directory.readUInt16LE(position + 8);
      const method = directory.readUInt16LE(position + 10);
      const crc = directory.readUInt32LE(position + 16);
      const compressed = directory.readUInt32LE(position + 20);
      const size = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const disk = directory.readUInt16LE(position + 34);
      const unixType = directory.readUInt32LE(position + 38) >>> 28;
      const offset = directory.readUInt32LE(position + 42);
      const endName = position + 46 + nameLength;
      if (endName > directorySize || disk || (flags & ~0x080e) || ![0, 8].includes(method) ||
          (method === 0 && size !== compressed) || unixType === 10 || offset + 30 > directoryOffset) {
        throw new Error('Unsupported or unsafe ZIP entry.');
      }
      const nameBytes = directory.subarray(position + 46, endName);
      const folder = nameBytes.at(-1) === 47;
      const name = zipName(nameBytes, folder);
      const key = (folder ? name.slice(0, -1) : name).normalize('NFC').toLowerCase();
      if (canonical.has(key)) throw new Error('The ZIP contains a duplicate entry path.');
      canonical.set(key, folder);
      if (!folder) entries.set(name, { flags, method, crc, compressed, size, offset, nameBytes });
      position = endName + directory.readUInt16LE(position + 30) + directory.readUInt16LE(position + 32);
    }
    if (position !== directorySize) throw new Error('Malformed ZIP directory length.');
    for (const name of canonical.keys()) {
      let parent = name.lastIndexOf('/');
      while (parent !== -1) {
        if (canonical.get(name.slice(0, parent)) === false) {
          throw new Error('The ZIP contains a path used as a file and a directory.');
        }
        parent = name.lastIndexOf('/', parent - 1);
      }
    }
  } finally {
    await file.close();
  }

  return async (name, limit) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.size > limit || entry.compressed > limit + 1024 * 1024) {
      throw new Error('ZIP entry exceeds the supported input size.');
    }
    const file = await open(path, 'r');
    try {
      const { offset, flags, method, size, compressed, nameBytes, crc } = entry;
      const header = await readSegment(file, offset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 ||
          header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method ||
          header.readUInt16LE(26) !== nameBytes.length) throw new Error('Malformed ZIP local header.');
      const start = offset + 30 + nameBytes.length + header.readUInt16LE(28);
      if (start + compressed > directoryOffset ||
          !(await readSegment(file, offset + 30, nameBytes.length)).equals(nameBytes)) {
        throw new Error('ZIP entry does not match its directory record.');
      }
      const data = await readSegment(file, start, compressed);
      let content;
      try {
        content = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.max(1, size) });
      } catch {
        throw new Error('Compressed ZIP entry is damaged.');
      }
      if (content.length !== size || crc32(content) !== crc) throw new Error('ZIP entry checksum failed.');
      return content;
    } finally {
      await file.close();
    }
  };
}

async function readLocalFile(base, path, limit) {
  const safe = safeLocalPath(path);
  if (!safe) throw new Error('Unsafe relative media path.');
  const candidate = await realpath(join(base, ...safe.split('/')));
  const distance = relative(base, candidate);
  if (!distance || distance === '..' || distance.startsWith('..' + sep) || isAbsolute(distance)) {
    throw new Error('Media path resolves outside the archive directory.');
  }
  return checkedFile(candidate, limit);
}

export async function openArchive(path) {
  path = resolve(path);
  const info = await stat(path);
  const zip = !info.isDirectory() && extname(path).toLowerCase() === '.zip';
  const base = zip ? null : await realpath(info.isDirectory() ? path : dirname(path));
  const jsonPath = info.isDirectory() ? join(path, 'messages.json') : path;
  const readEntry = zip ? await openZip(path) : null;
  const primary = zip ? await readEntry('messages.json', maxJson) : info.isDirectory()
    ? await readLocalFile(base, 'messages.json', maxJson) : await checkedFile(jsonPath, maxJson);
  if (!primary) throw new Error('Select a single conversation ZIP with a top-level messages.json.');
  const original = parse(primary, 'messages.json');
  const readManifest = async () => {
    if (!zip && basename(jsonPath).toLowerCase() !== 'messages.json') return undefined;
    const bytes = await (zip ? readEntry('manifest.json', maxJson) : readLocalFile(base, 'manifest.json', maxJson))
      .catch(error => {
        if (missing(error)) return null;
        throw error;
      });
    return bytes ? parse(bytes, 'manifest.json') : undefined;
  };
  const readMedia = mediaPath => zip ? readEntry(mediaPath, maxMedia) : readLocalFile(base, mediaPath, maxMedia);
  const loadMedia = async (attachment, signal) => {
    signal?.throwIfAborted();
    if (!attachment.path) return null;
    try {
      const bytes = await readMedia(attachment.path);
      if (!bytes) return null;
      if (attachment.sha256 && digest(bytes) !== attachment.sha256) throw new Error('Media checksum failed.');
      signal?.throwIfAborted();
      return { bytes, mimeType: attachment.mimeType, filename: attachment.filename };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  };
  return { original, zip, readManifest, readMedia, loadMedia };
}

export async function validateSource(source, signal) {
  const result = validateArchive(source.original);
  if (!result.valid) return result;
  const archive = importArchive(source.original);
  const errors = [...result.errors];
  const issue = message => {
    if (errors.length < 40) errors.push(message);
    else if (errors.length === 40) errors.push('Additional validation errors omitted.');
  };
  const warnings = [...result.warnings];
  const attachments = new Map();
  for (const message of archive.messages) {
    message.attachments.forEach((attachment, index) => attachments.set(JSON.stringify([message.id, index]), attachment));
  }
  try {
    const manifest = await source.readManifest();
    if (manifest === undefined && source.zip) issue('ZIP is missing manifest.json.');
    if (manifest !== undefined && (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))) {
      issue('Manifest must be a JSON object.');
    } else if (manifest) {
      if (manifest.schemaVersion !== archive.schemaVersion || manifest.conversationId !== archive.conversation.id) {
        issue('Manifest schema version or conversation ID does not match messages.json.');
      }
      if (manifest.scan?.status !== archive.scan?.status) issue('Manifest scan status does not match messages.json.');
      let first = null;
      let last = null;
      for (const { timestamp } of archive.messages) {
        if (!timestamp) continue;
        if (!first || timestamp < first) first = timestamp;
        if (!last || timestamp > last) last = timestamp;
      }
      if (manifest.dateRange?.earliest !== first || manifest.dateRange?.latest !== last) {
        issue('Manifest date range does not match messages.json.');
      }
      if (!Array.isArray(manifest.attachments)) issue('Manifest attachments must be an array.');
      else {
        const seen = new Set();
        const counts = { archived: 0, skipped: 0, failed: 0, unavailable: 0 };
        for (const item of manifest.attachments) {
          const key = JSON.stringify([item?.messageId, item?.index]);
          const attachment = attachments.get(key);
          if (!attachment || seen.has(key) || !archiveStatuses.includes(item?.status)) {
            issue('Manifest contains an unknown, duplicate, or invalid attachment entry.');
            continue;
          }
          seen.add(key);
          counts[item.status]++;
          if (item.kind !== attachment.kind || item.status !== attachment.status || (item.path ?? null) !== attachment.path ||
              (item.status === 'archived' && (
                !safeLocalPath(item.path) || item.sha256 !== attachment.sha256 || item.size !== attachment.size))) {
            issue('Manifest attachment entry disagrees with messages.json: ' + item.messageId + ' #' + item.index);
          }
        }
        if (seen.size !== attachments.size) issue('Manifest does not cover every archive attachment.');
        if (manifest.media?.finished !== attachments.size || manifest.media?.total !== attachments.size ||
            archiveStatuses.some(status => manifest.media?.[status] !== counts[status])) {
          issue('Manifest attachment totals do not match its entries.');
        }
      }
    }
  } catch (error) {
    issue('Manifest: ' + error.message);
  }

  const checked = new Map();
  for (const attachment of attachments.values()) {
    signal?.throwIfAborted();
    if (!attachment.path) {
      if (attachment.status === 'archived') issue('An archived attachment has no local media path.');
      continue;
    }
    if (!checked.has(attachment.path)) {
      try {
        const bytes = await source.readMedia(attachment.path);
        if (!bytes) throw new Error('missing');
        checked.set(attachment.path, { hash: digest(bytes), size: bytes.length });
      } catch (error) {
        checked.set(attachment.path, null);
        issue('Media ' + attachment.path + ' is missing or unreadable' +
          (missing(error) ? '.' : ': ' + error.message));
      }
    }
    const found = checked.get(attachment.path);
    if (found && ((attachment.size != null && found.size !== attachment.size) ||
        (attachment.sha256 && found.hash !== attachment.sha256))) {
      issue('Media ' + attachment.path + ' does not match its recorded size or checksum.');
    }
  }
  return { valid: errors.length === 0, errors, warnings, conversation: archive.conversation.name, messages: archive.messages.length };
}

export async function newestArchive(directory) {
  const files = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (missing(error)) return [];
    throw error;
  });
  const candidates = await Promise.all(files
    .filter(entry => entry.isFile() && ['.json', '.zip'].includes(extname(entry.name)) &&
      !['metadata.json', 'manifest.json', 'statistics.json'].includes(entry.name))
    .map(async entry => {
      const path = join(directory, entry.name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
  candidates.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
  if (!candidates.length) throw new Error('Supply an archive path or scan a conversation into the output directory first.');
  return candidates[0].path;
}
