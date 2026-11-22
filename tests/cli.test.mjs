import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureTab, deleteCheckpoint, listCheckpoints, loadCheckpoint, saveCheckpoint } from '../cli/capture.mjs';
import { createArchive, formatArchive } from '../shared/archive.mjs';
import { buildArchiveZip, zipEntries } from '../shared/zip.mjs';

const cli = fileURLToPath(new URL('../cli/messscrap.mjs', import.meta.url));
const source = 'https://www.messenger.com/t/synthetic-demo';
const time = '2026-04-23T12:00:00.000Z';
const messages = [
  { source_message_id: 'demo-1', author: 'Avery', timestamp: time, text: 'Hello café ☕' },
  { source_message_id: 'demo-2', author: 'Morgan', timestamp: '2026-04-24T12:00:00.000Z',
    text: '=HeLLo world', attachments: [{ kind: 'file', filename: 'sample.txt', mimeType: 'text/plain' }] }
];
const archive = createArchive({ conversation: { id: 'synthetic-demo', name: 'Synthetic example' },
  sourceUrl: source, scan: { status: 'partial', reason: 'Synthetic checkpoint' }, messages });
const legacy = { conversation: { id: 'synthetic-demo', name: 'Synthetic example' }, source_url: source,
  exported_at: time, partial: true, count: messages.length, items: messages, scan: archive.scan };

async function workingDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'messscrap-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI imports and converts formats through its distributable entry point', async t => {
  const cwd = await workingDirectory(t);
  await writeFile(join(cwd, 'legacy.json'), JSON.stringify(legacy));
  for (const [args, expected] of [
    [['--version'], /^2\.0\.0/], [['--help'], /messscrap <command>/]
  ]) {
    const result = await run(args, cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, expected);
  }

  const imported = await run(['import', 'legacy.json', '--out', 'current.json', '--json'], cwd);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).messages, 2);
  const canonical = JSON.parse(await readFile(join(cwd, 'current.json'), 'utf8'));
  assert.equal(canonical.schemaVersion, 2);
  assert.equal(canonical.conversation.id, 'synthetic-demo');

  for (const [format, check] of [
    ['txt', /Hello café ☕/], ['csv', /"'=HeLLo world"/], ['html', /MessScrap Archive/], ['zip', /^PK/]
  ]) {
    const path = 'export.' + format;
    const result = await run(['export', 'current.json', '--format', format, '--out', path], cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.match(await readFile(join(cwd, path), 'utf8'), check);
  }
  const result = await run(['validate', 'export.zip', '--json'], cwd);
  assert.equal(result.code, 0, JSON.parse(result.stdout).errors?.join('\n') || result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
  const conflict = await run(['import', 'legacy.json', '--out', 'current.json'], cwd);
  assert.equal(conflict.code, 1);
  assert.match(conflict.stderr, /already exists/);
  assert.equal((await run(['scan', '--max-rounds', '0', '--no-prompt'], cwd)).code, 2);
});

test('CLI updates, searches, and reports filtered statistics', async t => {
  const cwd = await workingDirectory(t);
  const next = createArchive({ conversation: archive.conversation, sourceUrl: source, scan: { status: 'partial' },
    messages: [messages[1], { source_message_id: 'demo-3', author: 'Avery', text: 'Good morning', timestamp: '2026-04-24T12:02:00.000Z' }] });
  await writeFile(join(cwd, 'current.json'), formatArchive(archive, 'json'));
  await writeFile(join(cwd, 'next.json'), formatArchive(next, 'json'));
  const updated = await run(['update', 'current.json', '--from', 'next.json', '--out', 'updated.json', '--json'], cwd);
  assert.equal(updated.code, 0, updated.stderr);
  const outcome = JSON.parse(updated.stdout);
  assert.deepEqual([outcome.report.added, outcome.report.unchanged, outcome.report.uncertain], [1, 1, true]);
  assert.equal(JSON.parse(await readFile(join(cwd, 'current.json'), 'utf8')).messages.length, 2);
  const stats = await run(['stats', 'updated.json', '--participant', 'Avery', '--start', '2026-04-24'], cwd);
  assert.equal(stats.code, 0, stats.stderr);
  assert.equal(JSON.parse(stats.stdout).totalMessages, 1);
  const found = await run(['search', 'updated.json', 'hello', '--limit', '1', '--json'], cwd);
  assert.equal(found.code, 0, found.stderr);
  assert.equal(JSON.parse(found.stdout).count, 2);
  assert.equal(JSON.parse(found.stdout).messages.length, 1);
  const batch = await run(['batch', 'current.json', 'does-not-exist.json', 'next.json', '--combined', '--out', 'batch.zip', '--json'], cwd);
  assert.equal(batch.code, 3, batch.stderr);
  assert.equal(JSON.parse(batch.stdout).saved[0].conversations, 2);
  assert.equal(JSON.parse(batch.stdout).failures.length, 1);
});

test('CLI validates actual bundled media, traversal, and missing files', async t => {
  const cwd = await workingDirectory(t);
  const withMedia = await buildArchiveZip(archive, {
    includeMedia: true,
    loadMedia: () => ({ bytes: Buffer.from('Synthetic document'), mimeType: 'text/plain' })
  });
  const zipPath = join(cwd, 'with-media.zip');
  await writeFile(zipPath, withMedia);
  const result = await run(['validate', zipPath, '--json'], cwd);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const repacked = await run(['export', zipPath, '--format', 'zip', '--out', 'repacked.zip'], cwd);
  assert.equal(repacked.code, 0, repacked.stderr);
  assert.equal((await run(['validate', 'repacked.zip'], cwd)).code, 0);

  const malformed = Buffer.from(zipEntries([['messages.json', formatArchive(archive, 'json')], ['bad/file', 'unsafe']]));
  const needle = Buffer.from('bad/file');
  for (let index = malformed.indexOf(needle); index >= 0; index = malformed.indexOf(needle, index + 1)) {
    Buffer.from('../e.txt').copy(malformed, index);
  }
  await writeFile(join(cwd, 'unsafe.zip'), malformed);
  const unsafe = await run(['validate', 'unsafe.zip', '--json'], cwd);
  assert.equal(unsafe.code, 2);
  assert.match(JSON.parse(unsafe.stdout).errors.join(' '), /unsafe entry path/);

  await mkdir(join(cwd, 'missing'));
  const missing = createArchive({ conversation: archive.conversation, messages: [{
    author: 'Avery', text: '', attachments: [{ kind: 'file', path: 'media/example.txt' }]
  }] });
  await writeFile(join(cwd, 'missing', 'messages.json'), formatArchive(missing, 'json'));
  const absent = await run(['validate', 'missing', '--json'], cwd);
  assert.equal(absent.code, 2);
  assert.match(JSON.parse(absent.stdout).errors.join(' '), /missing or unreadable/);
});

test('local checkpoints isolate conversations and reject tampered payloads', async t => {
  const cwd = await workingDirectory(t);
  const path = await saveCheckpoint(cwd, legacy);
  assert.deepEqual(await loadCheckpoint(cwd, 'synthetic-demo'), legacy);
  await assert.rejects(loadCheckpoint(cwd, 'another-thread'), /No checkpoint for this conversation/);
  const checkpoint = (await listCheckpoints(cwd))[0];
  assert.equal(checkpoint.count, 2);
  const contents = (await readFile(path, 'utf8')).replace('café', 'tape');
  await writeFile(path, contents);
  await assert.rejects(loadCheckpoint(cwd, 'synthetic-demo'), /checksum/);
  await deleteCheckpoint(cwd, checkpoint.key);
  assert.deepEqual(await readdir(cwd), []);
});

test('live scan checks identity at publication after a user switches conversations', async () => {
  const active = { id: 'synthetic-demo', generation: 0, ready: true };
  let current = active;
  const calls = [];
  const connection = {
    async install() {},
    async capture(method, options) {
      calls.push(method);
      if (method === 'inspect') return current;
      if (method === 'state') return options?.detail ? { running: false, result: { payload: legacy } } : { running: false };
      return true;
    }
  };
  const options = { signal: new AbortController().signal, captureOptions: {} };
  await assert.rejects(captureTab(connection, { url: source }, options, async (_archive, _loader, confirm) => {
    current = { ...active, id: 'another-thread', generation: 1 };
    await confirm();
  }), /conversation changed before export/);
  assert.equal(calls.at(-1), 'dispose');
});
