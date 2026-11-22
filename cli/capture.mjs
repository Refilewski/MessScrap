import { open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { archiveFromCapture, conversationId } from '../shared/archive.mjs';
import { digest, writeAtomic } from './archive-io.mjs';
import { browserMediaLoader } from './browser.mjs';

function checkpointName(id) {
  return digest(id).slice(0, 32) + '.checkpoint';
}

export async function saveCheckpoint(directory, payload) {
  const id = payload?.conversation?.id;
  if (typeof id !== 'string' || conversationId(payload.source_url) !== id ||
      !Array.isArray(payload.items) || payload.items.length !== payload.count) {
    throw new Error('The scanner returned a checkpoint for an invalid conversation or message count.');
  }
  const data = JSON.stringify(payload);
  const metadata = {
    version: 1, id, name: payload.conversation.name, capturedAt: payload.exported_at,
    count: payload.count, checksum: digest(data)
  };
  return writeAtomic(join(directory, checkpointName(id)), JSON.stringify(metadata) + '\n' + data, { replace: true });
}

function parseCheckpointHeader(bytes) {
  const end = bytes.indexOf(10);
  if (end < 0 || end > 16384) throw new Error('Checkpoint header is invalid.');
  const metadata = JSON.parse(bytes.subarray(0, end).toString('utf8'));
  if (metadata?.version !== 1 || typeof metadata.id !== 'string' || typeof metadata.name !== 'string' ||
      !Number.isSafeInteger(metadata.count) || !/^[a-f0-9]{64}$/.test(metadata.checksum)) {
    throw new Error('Checkpoint metadata is invalid.');
  }
  return { metadata, data: bytes.subarray(end + 1) };
}

export async function loadCheckpoint(directory, id) {
  const path = join(directory, checkpointName(id));
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error('Checkpoint is too large or invalid.');
    const { metadata, data } = parseCheckpointHeader(await readFile(path));
    const payload = JSON.parse(data.toString('utf8'));
    if (metadata.id !== id || digest(data) !== metadata.checksum || payload.conversation?.id !== id ||
        conversationId(payload.source_url) !== id || payload.count !== metadata.count ||
        payload.items?.length !== metadata.count) {
      throw new Error('Checkpoint checksum, message count, or conversation ID does not match.');
    }
    archiveFromCapture(payload);
    return payload;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No checkpoint for this conversation. Start with scan --checkpoint.');
    throw new Error('Cannot resume from this checkpoint. Inspect --checkpoints or remove it with --forget. ' + error.message);
  }
}

export async function listCheckpoints(directory) {
  const names = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const next = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{32}\.checkpoint$/.test(name)) continue;
    const key = name.slice(0, 32);
    try {
      const handle = await open(join(directory, name), 'r');
      try {
        const bytes = Buffer.alloc(16386);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const { metadata } = parseCheckpointHeader(bytes.subarray(0, bytesRead));
        if (checkpointName(metadata.id) !== name) throw new Error('Checkpoint ID does not match its filename.');
        next.push({ key, id: metadata.id, name: metadata.name, count: metadata.count, capturedAt: metadata.capturedAt });
      } finally {
        await handle.close();
      }
    } catch {
      next.push({ key, error: 'Unreadable or invalid checkpoint' });
    }
  }
  return next;
}

export async function deleteCheckpoint(directory, id) {
  const name = /^[a-f0-9]{32}$/.test(id) ? id + '.checkpoint' : checkpointName(id);
  try {
    await unlink(join(directory, name));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No checkpoint found with that key or conversation ID.');
    throw error;
  }
  return id;
}

export async function promptForConversation(browser, options) {
  const ask = async question => {
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    try {
      await reader.question(question, { signal: options.signal });
    } finally {
      reader.close();
    }
  };

  if (options.prompt && !process.stdin.isTTY) throw new Error('--prompt requires a terminal.');
  if (options.prompt) await ask('Open and unlock one conversation, then press Enter. ');
  const matchingTabs = async () => (await browser.tabs()).filter(tab => {
    const id = conversationId(tab.url);
    return id && (!options.expectedId || id === options.expectedId);
  });
  let tabs = await matchingTabs();
  if (!tabs.length && !options.noninteractive && !options.prompt && process.stdin.isTTY) {
    await ask('Open and unlock one conversation in the browser, then press Enter. ');
    tabs = await matchingTabs();
  }
  if (!tabs.length) throw new Error('Open and unlock one Messenger conversation in the MessScrap browser profile.');
  if (tabs.length === 1) return tabs[0];

  const visible = [];
  for (const tab of tabs) {
    let connection;
    try {
      connection = await browser.open(tab);
      if (await connection.evaluate("document.visibilityState === 'visible'")) visible.push(tab);
    } finally {
      connection?.close();
    }
  }
  if (visible.length === 1) return visible[0];
  throw new Error('Multiple conversations are open. Leave one visible or run batch --discover.');
}

function keyboard(connection, enabled, report) {
  const input = process.stdin;
  if (!enabled || !input.isTTY || typeof input.setRawMode !== 'function') return () => {};
  const raw = input.isRaw;
  const wasPaused = input.isPaused();
  let toggle = false;
  let pending = Promise.resolve();
  const onData = bytes => {
    for (const key of bytes.toString()) {
      if (key === 'q' || key === '\u0003') {
        pending = pending.then(() => connection.capture('cancel')).catch(() => {});
      } else if (key === ' ') {
        toggle = !toggle;
        const action = toggle ? 'pause' : 'resume';
        pending = pending.then(() => connection.capture(action)).catch(() => {});
      }
    }
  };
  input.setRawMode(true);
  input.on('data', onData);
  input.resume();
  report('Space pauses or resumes the scan. Q stops and saves captured messages.');
  return () => {
    input.off('data', onData);
    input.setRawMode(raw);
    if (wasPaused || !input.listenerCount('data')) input.pause();
  };
}

export async function captureTab(connection, tab, options, consume) {
  const { signal, captureOptions, onProgress = () => {}, onNotice = () => {} } = options;
  signal.throwIfAborted();
  if (options.navigate &&
      conversationId(await connection.evaluate('location.href')) !== conversationId(options.navigate)) {
    await connection.navigate(options.navigate);
  }
  await connection.install();
  let cleanupKeyboard = () => {};
  let cancelTask;
  const cancel = () => {
    cancelTask = connection.capture('cancel').catch(() => {});
  };
  try {
    const current = await connection.capture('inspect');
    if (!current?.id || current.id !== conversationId(options.navigate || tab.url)) {
      throw new Error('The active browser tab changed before capture.');
    }
    if (options.expectedId && current.id !== options.expectedId) {
      throw new Error('Open the conversation whose ID matches the original archive.');
    }
    const resume = options.resume ? await loadCheckpoint(options.checkpointDirectory, current.id) : undefined;
    if (resume) onNotice('Resuming with ' + resume.count.toLocaleString('en') + ' checkpoint messages.');
    const checkpoint = Boolean(options.checkpoint || resume);
    signal.throwIfAborted();
    await connection.capture('start', { ...captureOptions, checkpoint, resume });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    cleanupKeyboard = keyboard(connection, options.keyboard, onNotice);

    let state;
    let revision = 0;
    // Continue polling during cancellation so the scanner can return safely from
    // an in-flight DOM read and finalize the partial capture.
    const elapsedLimit = 15_000;
    let stoppedAt;
    while (true) {
      state = await connection.capture('state');
      if (!state) throw new Error('The page reloaded while scanning. Open the conversation and resume its checkpoint.');
      onProgress(state.progress, !state.running);
      if (checkpoint && state.checkpointRevision !== revision && state.running) {
        const detail = await connection.capture('state', { detail: true });
        if (detail?.checkpoint) await saveCheckpoint(options.checkpointDirectory, detail.checkpoint);
        revision = detail?.checkpointRevision ?? state.checkpointRevision;
      }
      if (!state.running) break;
      if (signal.aborted) {
        stoppedAt ??= Date.now();
        if (Date.now() - stoppedAt > elapsedLimit) throw signal.reason;
      }
      await delay(300);
    }

    const detail = await connection.capture('state', { detail: true });
    if (checkpoint && detail?.checkpoint && detail.checkpointRevision !== revision) {
      await saveCheckpoint(options.checkpointDirectory, detail.checkpoint);
    }
    const payload = detail?.result?.payload;
    const end = await connection.capture('inspect');
    if (!payload?.count) throw new Error(detail?.result?.error || detail?.progress?.reason || 'No messages were captured.');
    if (!end?.ready || end.id !== current.id || payload.conversation.id !== current.id ||
        end.generation !== current.generation) {
      throw new Error('The conversation changed before export. Start a new scan in the active conversation.');
    }
    const archive = archiveFromCapture(payload);
    cleanupKeyboard();
    cleanupKeyboard = () => {};
    const confirm = async () => {
      const inspected = await connection.capture('inspect');
      if (!inspected?.ready || inspected.id !== end.id || inspected.generation !== end.generation) {
        throw new Error('The conversation changed before export. Start a new scan in the active conversation.');
      }
    };
    return await consume(archive, browserMediaLoader(connection, end), confirm);
  } finally {
    signal.removeEventListener('abort', cancel);
    cleanupKeyboard();
    await cancelTask;
    await connection.capture('dispose').catch(() => {});
  }
}
