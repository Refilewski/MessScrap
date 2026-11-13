import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const executable = process.env.MESSSCRAP_FIREFOX;
assert(executable, 'Set MESSSCRAP_FIREFOX to the Firefox executable.');
const extension = resolve(process.argv[2] || 'bin/firefox-extension');
const temporaryRoot = await realpath(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, 'messscrap-firefox-'));
const fixtureUrl = 'https://www.facebook.com/messages/e2ee/t/messscrap-test';
const fixture = `<!doctype html><meta charset="utf-8">
<style>
#chat { width: min(600px, 100%); height: 240px; overflow: auto; }
#list { height: 1920px; position: relative; }
article { position: absolute; height: 70px; width: min(500px, 100%); }
</style>
<main role="main"><div id="chat"><div role="log" id="list"></div></div></main>
<script>
const chat = document.querySelector('#chat');
const list = document.querySelector('#list');
function render() {
  const start = Math.max(0, Math.floor(chat.scrollTop / 80) - 1);
  list.replaceChildren();
  for (let i = start; i < Math.min(24, start + 7); i++) {
    const row = document.createElement('article');
    row.dataset.messageId = 'id-' + i;
    row.style.top = (i * 80) + 'px';
    row.setAttribute('aria-label', 'At Saturday 9:30 PM, You: repeat');
    row.innerHTML = '<div dir="auto">repeat</div>';
    if (i === 4) row.innerHTML = '<div role="button" aria-label="Go to Ada’s message" data-reply-to-message-id="id-2"><div dir="auto">quote</div></div><div dir="auto">answer</div>';
    if (i === 5) row.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Photo">';
    list.append(row);
  }
}
chat.scrollTop = 800;
chat.addEventListener('scroll', render);
render();
</script>`;

await writeFile(join(profile, 'user.js'), [
  ['browser.download.folderList', 2],
  ['browser.download.dir', profile],
  ['browser.download.useDownloadDir', true],
  ['browser.shell.checkDefaultBrowser', false],
  ['network.proxy.type', 1],
  ['network.proxy.http', '127.0.0.1'],
  ['network.proxy.http_port', 1],
  ['network.proxy.ssl', '127.0.0.1'],
  ['network.proxy.ssl_port', 1],
  ['network.trr.mode', 5],
].map(([key, value]) => 'user_pref(' + JSON.stringify(key) + ',' + JSON.stringify(value) + ');').join('\n'));

const firefox = spawn(executable, [
  '-headless', '-no-remote', '-profile', profile,
  '--remote-debugging-port', '0', '--remote-allow-system-access', 'about:blank',
], {windowsHide: true});
let socket;
const pending = new Map();
let nextId = 0;

function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('No Firefox response for ' + method));
    }, 12000);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params}));
  });
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi: ' + logs)), 12000);
    firefox.stderr.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/WebDriver BiDi listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    firefox.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket = new WebSocket(endpoint + '/session');
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'network.beforeRequestSent' && message.params.isBlocked) {
      send('network.provideResponse', {
        request: message.params.request.request,
        statusCode: 200,
        headers: [{name: 'Content-Type', value: {type: 'string', value: 'text/html; charset=utf-8'}}],
        body: {type: 'string', value: fixture},
      }).catch(error => console.error(error));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.type === 'error') request.reject(new Error(message.error + ': ' + message.message));
    else request.resolve(message.result);
  });

  const session = await send('session.new', {capabilities: {alwaysMatch: {browserName: 'firefox'}}});
  const installed = await send('webExtension.install', {extensionData: {type: 'path', path: extension}});
  assert.equal(installed.extension, 'messscrap@refil.cc');
  const {contexts} = await send('browsingContext.getTree');
  const context = contexts[0].context;
  await send('browsingContext.setViewport', {context, viewport: {width: 390, height: 760}});
  await send('session.subscribe', {events: ['network.beforeRequestSent']});
  await send('network.addIntercept', {
    phases: ['beforeRequestSent'],
    urlPatterns: [{type: 'string', pattern: fixtureUrl}],
  });
  await send('browsingContext.navigate', {context, url: fixtureUrl, wait: 'complete'});

  async function evaluate(expression, target = {context}) {
    const result = await send('script.evaluate', {expression, target, awaitPromise: true});
    assert.equal(result.type, 'success', JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  const {contexts: chromeContexts} = await send('browsingContext.getTree', {'moz:scope': 'chrome'});
  assert(chromeContexts.length, 'Firefox chrome context is required to invoke the add-on popup.');
  const chrome = {context: chromeContexts[0].context};
  // Emulate the active-tab grant that Firefox normally gives on opening the
  // toolbar popup. Load the actual installed popup in a background tab.
  const popupUrl = await evaluate(`(async () => {
    const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
    const extension = ExtensionParent.GlobalManager.getExtension('messscrap@refil.cc');
    await extension.tabManager.addActiveTabPermission(gBrowser.selectedTab);
    return WebExtensionPolicy.getByID(extension.id).getURL('popup.html');
  })()`, chrome);
  const popup = await send('browsingContext.create', {type: 'tab', background: true});
  await send('browsingContext.navigate', {context: popup.context, url: popupUrl, wait: 'complete'});
  await evaluate("document.querySelector('#open').click(); true", popup);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate("Boolean(document.querySelector('#messscrap-export-panel'))")) break;
    await delay(100);
  }
  assert(await evaluate("(() => { const box = document.querySelector('#messscrap-export-panel').getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth; })()"));
  await evaluate("document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#start').click(); true");
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    ready = await evaluate("!document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').hidden");
    if (ready) break;
    await delay(100);
  }
  assert(ready, 'JSON export did not become available.');
  assert(await evaluate("!document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#saveTxt').hidden"));
  await evaluate("document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#saveTxt').click(); true");
  let savedTxt;
  for (let attempt = 0; attempt < 40; attempt++) {
    savedTxt = (await readdir(profile)).find(name => /^messscrap-.*\.txt$/.test(name));
    if (savedTxt) break;
    await delay(100);
  }
  assert(savedTxt, 'No TXT downloaded.');
  const transcript = await readFile(join(profile, savedTxt), 'utf8');
  assert.match(transcript, /Messenger conversation · 24 messages/);
  assert.match(transcript, /  • repeat/);
  assert(!transcript.includes('id-2'));
  assert(!transcript.includes('facebook.com/messages'));

  await evaluate("document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').click(); true");
  let saved;
  for (let attempt = 0; attempt < 40; attempt++) {
    saved = (await readdir(profile)).find(name => /^messscrap-.*\.json$/.test(name));
    if (saved) break;
    await delay(100);
  }
  assert(saved, 'No JSON downloaded.');
  const data = JSON.parse(await readFile(join(profile, saved), 'utf8'));
  assert.deepEqual(data.items.map(item => item.source_message_id), Array.from({length: 24}, (_, i) => 'id-' + i));
  assert.equal(data.items[4].reply_to.target_message_id, 'local-3');
  assert.equal(data.items[5].attachments[0].url_scheme, 'data');
  assert.equal(data.partial, false);

  await evaluate("(() => { const panel = document.querySelector('#messscrap-export-panel').shadowRoot; panel.querySelector('#start').click(); panel.querySelector('#stop').click(); return true; })()");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await evaluate("!document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').hidden")) break;
    await delay(100);
  }
  await evaluate("document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').click(); true");
  let partial;
  for (let attempt = 0; attempt < 40; attempt++) {
    partial = (await readdir(profile)).find(name => /^messscrap-.*\.json$/.test(name) && name !== saved);
    if (partial) break;
    await delay(100);
  }
  assert(partial, 'No partial JSON downloaded.');
  const partialData = JSON.parse(await readFile(join(profile, partial), 'utf8'));
  assert.equal(partialData.interrupted, true);
  assert(partialData.count > 0 && partialData.count < 24);
  console.log('Firefox ' + session.capabilities.browserVersion + ': installed extension, exported 24 messages and checked TXT and partial JSON.');
} finally {
  socket?.close();
  firefox.kill();
  await delay(800);
  const resolvedProfile = await realpath(profile);
  assert.equal(dirname(resolvedProfile), temporaryRoot);
  await rm(resolvedProfile, {recursive: true, force: true, maxRetries: 6, retryDelay: 200});
}
