import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {createArchive} from '../shared/archive.mjs';
import {browserAttachmentLoaderExpression, buildArchiveBatch, buildArchiveZip, isMessengerMediaUrl, zipEntries} from '../shared/zip.mjs';

function unzipStored(bytes) {
  const decoder = new TextDecoder();
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const content = offset + 30 + nameLength;
    const name = decoder.decode(bytes.subarray(offset + 30, content));
    entries.set(name, bytes.subarray(content, content + length));
    offset = content + length;
  }
  return entries;
}

const url = 'https://scontent.fbcdn.net/photo.png?fixture=temporary';
const conversation = {id: 'synthetic', name: 'Test <conversation>'};
const archive = createArchive({
  conversation,
  exportedAt: '2026-01-01T00:00:00Z',
  messages: [{
    id: 'fixture-1', text: 'A summer walk 🌿',
    timestamp: '2026-01-01T07:00:00Z',
    attachments: [
      {kind: 'image', filename: 'sunrise.png', sourceUrl: url},
      {kind: 'image', filename: 'same-photo.png', sourceUrl: url},
      {kind: 'file', filename: 'missing.pdf', sourceUrl: 'https://www.facebook.com/missing'},
      {kind: 'audio', filename: 'broken.mp3', sourceUrl: 'https://www.facebook.com/broken'},
    ],
  }],
});

test('ZIP manifests and viewer use local media, reporting every attachment outcome', async () => {
  const calls = new Map();
  const loader = async attachment => {
    calls.set(attachment.sourceUrl, (calls.get(attachment.sourceUrl) || 0) + 1);
    if (attachment.filename === 'missing.pdf') return null;
    if (attachment.filename === 'broken.mp3') throw new Error('test network failure');
    return {bytes: Uint8Array.of(1, 2, 3), mimeType: 'image/png'};
  };
  const progress = [];
  const bytes = await buildArchiveZip(archive, {includeMedia: true, loadMedia: loader, onProgress: event => progress.push(event)});
  assert.equal(calls.get(url), 1);
  assert.equal(calls.get('https://www.facebook.com/broken'), 2);
  const files = unzipStored(bytes);
  const text = name => new TextDecoder().decode(files.get(name));
  assert.equal(files.size, 9);
  const manifest = JSON.parse(text('manifest.json'));
  assert.deepEqual(manifest.media, {finished: 4, total: 4, archived: 2, failed: 1, unavailable: 1, skipped: 0});
  assert.deepEqual(progress.at(-1), manifest.media);
  assert.match(manifest.attachments[0].path, /^media\/images\/[a-f\d]{64}\.png$/u);
  assert.deepEqual(files.get(manifest.attachments[0].path), Uint8Array.of(1, 2, 3));
  assert.equal(manifest.attachments[0].path, manifest.attachments[1].path);
  assert.equal(manifest.attachments[1].filename, 'same-photo.png');
  assert.match(text('messages.txt'), /summer walk 🌿/u);
  assert(!text('messages.json').includes('fixture=temporary'));
  assert(!text('index.html').includes('fixture=temporary'));
  assert(!text('manifest.json').includes('fixture=temporary'));
  const repeated = await buildArchiveZip(archive, {includeMedia: true, loadMedia: loader});
  assert.deepEqual(bytes, repeated);
});

test('ZIP includes a separate folder and offline index for each batch conversation', async () => {
  const other = createArchive({conversation: {id: 'another', name: 'Second'}, messages: []});
  const files = unzipStored(await buildArchiveBatch([archive, other]));
  const index = new TextDecoder().decode(files.get('index.html'));
  assert(index.includes('Test &lt;conversation&gt;') && index.includes('conversation-2/index.html'));
  for (const folder of ['conversation-1', 'conversation-2']) assert(files.has(folder + '/manifest.json'));
});

test('ZIP names reject traversal, reserved names, and ambiguous extraction targets', () => {
  for (const name of ['../secret', '/secret', 'media//x', 'media/./x', 'x\\y', 'C:x', 'aux.txt']) {
    assert.throws(() => zipEntries([[name, 'x']]), /unsafe/iu, name);
  }
  assert.throws(() => zipEntries([['name', 'x'], ['Name', 'y']]), /duplicate/iu);
  assert.throws(() => zipEntries([['name', 'x'], ['Name/file', 'y']]), /directory/iu);
});

test('ZIP cancellation exits a stuck download and timeout becomes a failure', async () => {
  const controller = new AbortController();
  const never = () => new Promise(() => {});
  const run = buildArchiveZip(archive, {includeMedia: true, loadMedia: never, signal: controller.signal});
  controller.abort();
  await assert.rejects(run, {name: 'AbortError'});
  const files = unzipStored(await buildArchiveZip(archive, {
    includeMedia: true, loadMedia: never, timeout: 5, retries: 0,
  }));
  assert.equal(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).media.failed, 4);
});

test('browser downloader is allowlisted, serializable, and does not follow redirects', async () => {
  const origin = 'https://www.facebook.com';
  assert(!isMessengerMediaUrl('https://facebook.com.bad.example/'));
  assert(!isMessengerMediaUrl('https://x@y.facebook.com/'));
  assert(!isMessengerMediaUrl('https://www.facebook.com:555/'));
  assert(isMessengerMediaUrl('blob:https://www.facebook.com/blob-test', origin));
  assert(!isMessengerMediaUrl('blob:https://www.facebook.com/blob-test', 'https://messenger.com'));
  let fetchedUrl;
  const loader = runInNewContext(browserAttachmentLoaderExpression(), {
    URL, Uint8Array, location: {origin},
    fetch: async (source, options) => {
      fetchedUrl = source;
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.referrerPolicy, 'no-referrer');
      return new Response(Uint8Array.of(5), {headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': "attachment; filename*=UTF-8''photo-%E2%98%80.png",
      }});
    },
  });
  assert.equal(await loader({sourceUrl: 'https://example.org/'}, new AbortController().signal), null);
  assert.equal(fetchedUrl, undefined);
  const file = await loader({sourceUrl: url}, new AbortController().signal);
  assert.equal(fetchedUrl, url);
  assert.deepEqual(file.bytes, Uint8Array.of(5));
  assert.equal(file.filename, 'photo-☀.png');
});
