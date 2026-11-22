import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const executable = process.env.MESSSCRAP_FIREFOX;
assert(executable, 'Set MESSSCRAP_FIREFOX to the Firefox executable.');
const {version} = JSON.parse(await readFile('package.json', 'utf8'));
const extension = resolve(process.argv[2] || `bin/messscrap-firefox-${version}.zip`);
const temporaryRoot = await realpath(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, 'messscrap-firefox-'));
const fixtureUrl = 'https://www.facebook.com/messages/e2ee/t/messscrap-test';
const fixture = `<!doctype html><meta charset="utf-8">
<style>
#chat { width: min(600px, 100%); height: 240px; overflow: auto; }
#list { height: 1920px; position: relative; }
article { position: absolute; height: 70px; width: min(500px, 100%); }
</style>
<main role="main"><header><h1>Firefox fixture</h1></header><div id="chat"><div role="log" id="list" data-thread-id="messscrap-test" data-has-more-before="false" data-has-more-after="false"></div></div></main>
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
  ['browser.download.alwaysOpenPanel', false],
  ['browser.download.always_ask_before_handling_new_types', false],
  ['browser.helperApps.neverAsk.saveToDisk', 'text/plain,application/json'],
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
], {windowsHide: true, env: {...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1'}});
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
    pending.set(id, {resolve, reject, timer, method});
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
    if (message.type === 'error') request.reject(new Error(request.method + ': ' + message.error + ': ' + message.message));
    else request.resolve(message.result);
  });

  const session = await send('session.new', {capabilities: {alwaysMatch: {browserName: 'firefox'}}});
  const installed = await send('webExtension.install', {extensionData: {type: 'path', path: extension}});
  assert.equal(installed.extension, 'messscrap@refil.cc');
  const {contexts} = await send('browsingContext.getTree');
  const context = contexts[0].context;
  await send('session.subscribe', {events: ['network.beforeRequestSent']});
  await send('network.addIntercept', {
    phases: ['beforeRequestSent'],
    urlPatterns: [{type: 'string', pattern: fixtureUrl}],
  });
  await send('browsingContext.navigate', {context, url: fixtureUrl, wait: 'complete'});
  // Firefox may start on a privileged about: page where viewport overrides are unavailable.
  await send('browsingContext.setViewport', {context, viewport: {width: 390, height: 760}});

  async function evaluate(expression, target = {context}) {
    const result = await send('script.evaluate', {expression, target, awaitPromise: true});
    assert.equal(result.type, 'success', JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  const panel = "document.querySelector('#messscrap-export-panel').shadowRoot";
  async function click(selector) {
    const center = await evaluate(`(() => {
      const node = ${panel}.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block: 'nearest'});
      const rect = node.getBoundingClientRect();
      return JSON.stringify([Math.floor(rect.left + rect.width / 2), Math.floor(rect.top + rect.height / 2)]);
    })()`);
    const [x, y] = JSON.parse(center);
    await send('input.performActions', {context, actions: [{
      type: 'pointer', id: 'mouse', parameters: {pointerType: 'mouse'},
      actions: [{type: 'pointerMove', x, y}, {type: 'pointerDown', button: 0}, {type: 'pointerUp', button: 0}],
    }]});
  }

  async function selectFormat(format) {
    const keys = format === 'txt' ? ['\uE010'] : ['\uE011', '\uE015', '\uE015'];
    await evaluate(`${panel}.querySelector('#format').focus(); true`);
    await send('input.performActions', {context, actions: [{
      type: 'key', id: 'keyboard', actions: keys.flatMap(value =>
        [{type: 'keyDown', value}, {type: 'keyUp', value}]),
    }]});
    assert.equal(await evaluate(`${panel}.querySelector('#format').value`), format);
    await evaluate(`${panel}.querySelector('#format').blur(); true`);
  }

  async function waitFor(expression, attempts = 200) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error('Firefox did not reach the expected extension state: ' + expression);
  }

  async function savedFile(extension, previous = null) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const filename = (await readdir(profile)).find(name => name.startsWith('messscrap-')
        && name.endsWith('.' + extension) && name !== previous);
      if (filename && (await stat(join(profile, filename))).size > 0) return filename;
      await delay(100);
    }
    throw new Error('No ' + extension.toUpperCase() + ' downloaded.');
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
  assert.equal(await evaluate(`${panel}.querySelector('#conversation').textContent`), 'Firefox fixture');
  await click('#start');
  await waitFor(`!${panel}.querySelector('#save').disabled`);
  assert.equal(await evaluate(`${panel}.querySelector('#status').dataset.state`), 'completed');

  await selectFormat('txt');
  await click('#save');
  const savedTxt = await savedFile('txt');
  const transcript = await readFile(join(profile, savedTxt), 'utf8');
  assert.match(transcript, /Firefox fixture · 24 messages/);
  assert.match(transcript, /  • repeat/);
  assert(!transcript.includes('id-2'));
  assert(!transcript.includes('facebook.com/messages'));

  await selectFormat('json');
  assert.equal(await evaluate(`${panel}.querySelector('#save').disabled`), false, 'A TXT download preserves the verified scan for another format.');
  await click('#save');
  const saved = await savedFile('json');
  const data = JSON.parse(await readFile(join(profile, saved), 'utf8'));
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.conversation.id, 'messscrap-test');
  assert.deepEqual(data.messages.map(item => item.nativeId), Array.from({length: 24}, (_, i) => 'id-' + i));
  assert.equal(data.messages[4].reply.messageId, data.messages[2].id);
  assert.equal(data.messages[5].attachments[0].kind, 'image');
  assert.equal(data.scan.status, 'completed');

  await click('#start');
  await waitFor(`Number(${panel}.querySelector('#count').textContent) > 0`, 40);
  await click('#stop');
  await waitFor(`!${panel}.querySelector('#save').disabled`, 40);
  await click('#save');
  const partial = await savedFile('json', saved);
  const partialData = JSON.parse(await readFile(join(profile, partial), 'utf8'));
  assert.equal(partialData.scan.status, 'cancelled');
  assert(partialData.messages.length > 0 && partialData.messages.length < 24);
  console.log('Firefox ' + session.capabilities.browserVersion + ': installed extension, exported 24 messages and checked TXT and partial JSON.');
} finally {
  socket?.close();
  firefox.kill();
  await delay(800);
  const resolvedProfile = await realpath(profile);
  assert.equal(dirname(resolvedProfile), temporaryRoot);
  await rm(resolvedProfile, {recursive: true, force: true, maxRetries: 6, retryDelay: 200});
}
