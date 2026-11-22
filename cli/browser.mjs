import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationId } from '../shared/archive.mjs';
import { browserAttachmentLoaderExpression } from '../shared/zip.mjs';

const startUrl = 'https://www.facebook.com/messages/';
const files = [
  ['extension/thread.js'],
  ['src/dom/container.js', 'findContainer()'],
  ['src/dom/messages.js', 'readMessages()'],
  ['src/dom/scroll.js', 'scrollMessages(root, direction, move)'],
  ['extension/collect.js'],
  ['src/dom/capture.js']
];

let captureBundle;
async function browserScript() {
  captureBundle ??= Promise.all(files.map(async ([path, signature]) => {
    const code = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    return signature ? 'function ' + signature + ' {\n' + code + '\n}' : code;
  })).then(parts => '(() => {\n"use strict";\n' + parts.join('\n') + '\n})();');
  return captureBundle;
}

export function dataDirectory() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || homedir(), 'MessScrap');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'MessScrap');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'messscrap');
}

async function browserExecutable(explicit) {
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'brave.exe', 'chromium.exe', 'msedge.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'brave', 'microsoft-edge'];
  const paths = explicit ? [resolve(explicit)] : [];
  if (!explicit && process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      paths.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
  } else if (!explicit && process.platform === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of ['Google Chrome', 'Brave Browser', 'Chromium', 'Microsoft Edge']) {
        paths.push(join(base, name + '.app', 'Contents', 'MacOS', name));
      }
    }
  }
  if (!explicit) {
    for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
      paths.push(...names.map(name => join(directory, name)));
    }
  }
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Continue to the next installed browser.
    }
  }
  throw new Error(explicit
    ? 'The browser executable is unavailable. Check --browser.'
    : 'No Chromium browser found. Install Chrome, Brave, Edge, or Chromium, or set --browser PATH.');
}

async function targets(port, signal) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1200)]),
      redirect: 'error'
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload)) return null;
    return payload.filter(item => item?.type === 'page' && typeof item.id === 'string');
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function messengerPage(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^(?:www|web|m)\./, '');
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
      (host === 'messenger.com' || (host === 'facebook.com' && /^\/messages(?:\/|$)/.test(parsed.pathname)));
  } catch {
    return false;
  }
}

export async function connectBrowser(options) {
  const { port, signal, onNotice = () => {} } = options;
  let available = await targets(port, signal);
  if (!available) {
    const binary = await browserExecutable(options.browser);
    const profile = resolve(options.profile || join(dataDirectory(), 'browser'));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const child = spawn(binary, [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      startUrl
    ], { detached: true, stdio: 'ignore' });
    let launchError;
    child.once('error', error => { launchError = error; });
    child.unref();
    onNotice('Opened ' + basename(binary) + ' in the separate MessScrap browser profile.');
    for (let index = 0; index < 30 && !available; index++) {
      await delay(400, undefined, { signal });
      if (launchError) throw new Error('Could not launch the browser. Check --browser and --profile.');
      available = await targets(port, signal);
    }
  }
  if (!available) {
    throw new Error('Could not connect to the local Chromium debugging port. Close the MessScrap browser profile and try again.');
  }
  return {
    async tabs() {
      return (await targets(port, signal) || []).filter(item => messengerPage(item.url));
    },
    open(tab) {
      return connectTab(tab, port, signal);
    }
  };
}

async function connectTab(tab, port, signal) {
  signal.throwIfAborted();
  const url = 'ws://127.0.0.1:' + port + '/devtools/page/' + encodeURIComponent(tab.id);
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  let disposed = false;
  const ready = Promise.withResolvers();
  const openTimer = setTimeout(() => ready.reject(new Error('The browser tab did not respond.')), 4000);
  socket.addEventListener('open', () => ready.resolve(), { once: true });
  socket.addEventListener('error', () => ready.reject(new Error('Could not attach to the local browser tab.')), { once: true });
  const close = () => {
    disposed = true;
    ready.reject(new Error('The local browser connection closed.'));
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('The local browser connection closed.'));
    }
    pending.clear();
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  };
  socket.addEventListener('close', close, { once: true });
  try {
    await ready.promise;
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(openTimer);
  }

  socket.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error('The browser could not carry out the requested operation.'));
    else request.resolve(message.result);
  });

  function send(method, params = {}, timeout = 30000) {
    if (disposed) return Promise.reject(new Error('The local browser connection closed.'));
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The browser operation timed out.'));
      }, timeout);
      pending.set(id, { resolve: resolveRequest, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error('The local browser connection closed.'));
      }
    });
  }

  async function evaluate(expression, awaitPromise = true) {
    const response = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (response.exceptionDetails) throw new Error('The browser capture could not run. Reload the conversation tab and try again.');
    return response.result?.value;
  }

  return {
    close,
    evaluate,
    async install() {
      await evaluate(await browserScript());
    },
    capture(method, argument) {
      return evaluate('globalThis.__messscrapCapture?.' + method + '(' +
        (argument === undefined ? '' : JSON.stringify(argument)) + ')');
    },
    async navigate(url) {
      if (!conversationId(url)) throw new Error('The selected conversation URL is invalid.');
      const response = await send('Page.navigate', { url });
      if (response.errorText) throw new Error('The selected conversation could not open.');
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          if (conversationId(await evaluate('location.href')) === conversationId(url) &&
              await evaluate('document.readyState !== "loading"')) return;
        } catch {
          // Chromium briefly invalidates the execution context during navigation.
        }
        await delay(250, undefined, { signal });
      }
      throw new Error('Timed out opening the selected conversation.');
    }
  };
}

async function browserReadMedia(attachment, capture, load, conversationId, generation) {
  const current = capture?.inspect();
  if (!current?.ready || current.id !== conversationId || current.generation !== generation) return null;
  const file = await load(attachment, AbortSignal.timeout(12000), key => capture.resolveInlineMedia(key));
  const verified = capture.inspect();
  if (!file || !verified.ready || verified.id !== conversationId || verified.generation !== generation) return null;
  const data = await new Promise((resolveData, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolveData(reader.result.split(',', 2)[1]);
    reader.onerror = reject;
    reader.readAsDataURL(new Blob([file.bytes]));
  });
  const end = capture.inspect();
  return end.ready && end.id === conversationId && end.generation === generation
    ? { data, mimeType: file.mimeType, filename: file.filename }
    : null;
}

export function browserMediaLoader(connection, identity) {
  const loader = browserAttachmentLoaderExpression();
  return async (attachment, signal) => {
    signal?.throwIfAborted();
    const result = await connection.evaluate('(' + browserReadMedia.toString() + ')(' +
      JSON.stringify({
        kind: attachment.kind, sourceUrl: attachment.sourceUrl, inlineKey: attachment.inlineKey,
        previewSourceUrl: attachment.previewSourceUrl, previewInlineKey: attachment.previewInlineKey
      }) + ',globalThis.__messscrapCapture,' + loader + ',' + JSON.stringify(identity.id) +
      ',' + JSON.stringify(identity.generation) + ')');
    signal?.throwIfAborted();
    return result?.data
      ? { bytes: Buffer.from(result.data, 'base64'), mimeType: result.mimeType, filename: result.filename }
      : null;
  };
}
