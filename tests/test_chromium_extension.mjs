import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {chromium} from 'playwright';

const fixture = `<!doctype html><meta charset="utf-8"><title>Synthetic Messenger conversation</title>
<style>
  body { margin:0; font: 14px system-ui,sans-serif; color:#20232a; background:#f5f6f8; }
  main { margin:40px auto; width:min(680px,95vw); box-sizing:border-box; background:#fff; border:1px solid #e5e7eb; border-radius:12px; }
  header { padding:16px 20px; border-bottom:1px solid #e5e7eb; }
  header h1 { margin:0; font-size:17px; }
  header span { margin-right:8px; font-size:12px; color:#595f6a; }
  nav { display:flex; gap:12px; padding:12px 20px; }
  #chat { height:255px; overflow:auto; }
  #list { height:1728px; position:relative; }
  article { position:absolute; min-height:38px; max-width:75%; margin:10px 16px; border-radius:12px; background:#f2f3f5; padding:7px 10px; }
  article.mine { right:0; color:#fff; background:#175ee5; }
  time { display:block; margin-top:3px; opacity:.7; font-size:10px; }
</style>
<nav aria-label="Conversations">
  <a href="/messages/e2ee/t/studio-weekend">Studio Weekend</a>
  <a href="/messages/e2ee/t/reading-room">Reading Room</a>
</nav>
<main role="main">
<header><h1></h1><span data-participant-name="Avery Chen">Avery Chen</span><span data-participant-name="Sam Rivera">Sam Rivera</span><span data-participant-name="You">You</span></header>
<div id="chat"><div role="log" id="list" data-has-more-before="false" data-has-more-after="false"></div></div>
</main>
<script>
const chat = document.querySelector('#chat');
const list = document.querySelector('#list');
const start = 'studio-weekend';
const thread = () => location.pathname.split('/').at(-1);
const label = id => id === start ? 'Studio Weekend' : 'Reading Room';
const notes = [
  'I reserved the room for Saturday.',
  'What time can we get in?',
  '10 am works for me.',
  'See you there!',
  'See you there!',
  'I added a reference photo.',
  'I’ll bring the reflector and spare batteries.',
  'Let’s make a short shot list in the morning.',
  'Thanks, that sounds good.',
];
let rendered = thread();
function render() {
  const first = Math.max(0, Math.floor(chat.scrollTop / 72) - 2);
  list.replaceChildren();
  for (let i = first; i < Math.min(24, first + 8); i++) {
    const row = document.createElement('article');
    const who = ['Avery Chen', 'Sam Rivera', 'You'][i % 3];
    const line = rendered === start ? notes[i % notes.length] : 'Reading Room message ' + i;
    row.dataset.messageId = rendered + '-' + i;
    row.classList.toggle('mine', who === 'You');
    row.style.top = (i * 72) + 'px';
    row.setAttribute('aria-label', 'At November 21, 2026 10:00 AM, ' + who + ': ' + line);
    const body = document.createElement('div');
    body.dir = 'auto';
    body.textContent = line;
    const stamp = document.createElement('time');
    stamp.dateTime = new Date(Date.UTC(2026, 10, 21, 10, i)).toISOString();
    stamp.textContent = stamp.dateTime.slice(11, 16);
    row.append(body, stamp);
    if (i === 5) {
      const img = document.createElement('img');
      img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAABlBMVEX//wAAAAAAm7n3FAAAAApJREFUeNpjYAAAAAIAAUivpHEAAAAASUVORK5CYII=';
      img.alt = 'Photo';
      row.append(img);
    }
    list.append(row);
  }
}
function bind(id) {
  rendered = id;
  list.dataset.threadId = id;
  document.querySelector('h1').textContent = label(id);
  document.querySelectorAll('nav a').forEach(a => a.setAttribute('aria-current', a.href.endsWith('/' + id) ? 'page' : 'false'));
  chat.scrollTop = 800;
  render();
}
document.querySelector('nav').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  history.pushState(null, '', link.href);
  // Route changes immediately while the previous conversation is still mounted.
  setTimeout(() => bind(thread()), 1200);
});
chat.addEventListener('scroll', render);
bind(thread());
</script>`;

const root = await mkdtemp(join(tmpdir(), 'messscrap-chromium-'));
const unpacked = join(root, 'extension');
const profile = join(root, 'profile');
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const archiveFile = resolve(process.argv[2] || `bin/messscrap-chromium-${packageInfo.version}.zip`);
const origin = 'https://www.facebook.com';
const firstUrl = origin + '/messages/e2ee/t/studio-weekend';
const screenshot = process.env.MESSSCRAP_SCREENSHOT;
const candidates = [process.env.MESSSCRAP_CHROMIUM, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  if (await access(candidate).then(() => true, () => false)) {
    executablePath = candidate;
    break;
  }
}

const debugPort = await new Promise((resolvePort, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const {port} = socket.address();
    socket.close(error => error ? reject(error) : resolvePort(port));
  });
});

let context;
try {
  await mkdir(unpacked);
  execFileSync('python3', ['-m', 'zipfile', '-e', archiveFile, unpacked]);
  const manifestPath = join(unpacked, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'storage']);
  assert(!manifest.host_permissions, 'The distributed extension must use only the active-tab grant.');
  assert.equal(manifest.version, packageInfo.version);
  // Headless Chromium cannot click its own toolbar. Grant the unpacked test
  // copy access to the fixture origin, which is intercepted and never queried.
  await writeFile(manifestPath, JSON.stringify({...manifest, host_permissions: [origin + '/*']}));
  context = await chromium.launchPersistentContext(profile, {
    executablePath, channel: 'chromium', headless: true,
    viewport: {width: 1100, height: 720}, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${unpacked}`, `--load-extension=${unpacked}`, '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort],
  });
  await context.route('https://**/*', route => {
    if (route.request().url().startsWith(origin + '/messages/e2ee/t/')) {
      return route.fulfill({contentType: 'text/html; charset=utf-8', body: fixture});
    }
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), packageInfo.version);
  const popupUrl = await worker.evaluate(() => chrome.runtime.getURL('popup.html'));
  const page = context.pages()[0];
  await page.goto(firstUrl);

  async function openPanel() {
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    await page.bringToFront();
    await popup.evaluate(() => document.querySelector('#open').click());
    const panel = page.locator('#messscrap-export-panel');
    await panel.waitFor();
    const stillOpen = !popup.isClosed();
    if (stillOpen) await popup.close();
    return panel;
  }

  const panel = await openPanel();
  const control = id => panel.locator('#' + id);
  assert.match(await control('conversation').textContent(), /Studio Weekend/);
  await control('toggle-settings').click();
  await control('checkpoints').check();
  await control('toggle-settings').click();
  await control('media').check();
  await control('start').click();
  await control('pause').click();
  await control('status').filter({hasText: /^Paused$/}).waitFor();
  await control('minimize').click();
  await panel.waitFor({state: 'hidden'});
  await openPanel();
  assert.equal(await control('status').textContent(), 'Paused');
  await control('pause').click();
  await control('save').waitFor({state: 'visible'});
  await page.waitForFunction(() => !document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').disabled, undefined, {timeout: 20_000});
  assert.equal(await control('count').textContent(), '24');
  assert.equal(await control('attachments').textContent(), '1');
  assert.equal(await control('status').textContent(), 'Completed');
  assert.match(await control('participants').textContent(), /Avery Chen, Sam Rivera, You/);
  if (screenshot) {
    await mkdir('docs/screenshots', {recursive: true});
    await panel.screenshot({path: 'docs/screenshots/browser-extension.png', animations: 'disabled'});
  }

  const downloadEvent = page.waitForEvent('download');
  await control('save').click();
  const download = await downloadEvent;
  const zip = join(root, 'archive.zip');
  await download.saveAs(zip);
  const data = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([json.loads(z.read(k)) for k in ("messages.json", "manifest.json")]))', zip]));
  const [conversation, exported] = data;
  assert.equal(conversation.schemaVersion, 2);
  assert.equal(conversation.conversation.id, 'studio-weekend');
  assert.equal(conversation.messages.length, 24);
  assert.equal(exported.media.archived, 1, JSON.stringify(exported.media) + ' ' + JSON.stringify(exported.attachments));
  assert.equal(conversation.messages[5].attachments[0].status, 'archived');

  // An asynchronous SPA transition must invalidate the just-exported scan before
  // the new conversation's rows render.
  await page.getByRole('link', {name: 'Reading Room'}).click();
  await page.waitForFunction(() => document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').disabled);
  assert(await control('save').isDisabled());
  await control('conversation').filter({hasText: /^Reading Room$/}).waitFor();

  await page.goto(firstUrl);
  await openPanel();
  await control('resume').waitFor();
  await control('resume').click();
  await control('status').filter({hasText: /^Scanning$/}).waitFor();
  await control('stop').click();
  await control('status').filter({hasText: /^Cancelled$/}).waitFor();
  assert.equal(await control('count').textContent(), '24');
  await page.setViewportSize({width: 360, height: 640});
  const box = await panel.boundingBox();
  assert(box.x >= 0 && box.x + box.width <= 360, 'The panel fits the mobile viewport.');

  await control('toggle-settings').click();
  await control('limit').fill('1');
  await control('limit').press('Tab');
  await control('toggle-settings').click();
  await panel.locator('#batch summary').click();
  await panel.getByRole('checkbox', {name: 'Reading Room'}).check();
  const batchEvent = page.waitForEvent('download');
  await control('queue-start').click();
  const batch = await batchEvent;
  const batchZip = join(root, 'batch.zip');
  await batch.saveAs(batchZip);
  const ids = JSON.parse(execFileSync('python3', ['-c', 'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([json.loads(z.read(k))["conversation"]["id"] for k in z.namelist() if k.endswith("messages.json")]))', batchZip]));
  assert.deepEqual(ids, ['studio-weekend', 'reading-room']);
  console.log('Chromium extension: popup and panel, minimized and reopened a paused scan, media ZIP, SPA invalidation, persistent checkpoint, mobile layout, combined batch.');
  // Attach the installed CLI to the same Chromium fixture through its public
  // scan command. Playwright continues intercepting the origin throughout.
  const installer = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await writeFile(join(root, 'package.json'), '{"private":true}');
  const tarball = resolve('bin', 'messscrap-' + packageInfo.version + '.tgz');
  const runCommand = promisify(execFile);
  await runCommand(installer, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tarball], {
    cwd: root, shell: process.platform === 'win32',
  });
  const entry = join(root, 'node_modules', 'messscrap', 'cli', 'messscrap.mjs');
  const runCli = (...args) => runCommand(process.execPath, [entry, ...args], {cwd: root, timeout: 30_000});
  await page.setViewportSize({width: 1100, height: 720});
  await page.goto(firstUrl);
  const connection = ['--port', String(debugPort), '--no-prompt', '--json', '--checkpoint-dir', 'checkpoints'];
  const captured = await runCli('scan', ...connection, '--checkpoint', '--no-new-stop', '2',
    '--sleep', '.05', '--scroll-up-sleep', '.05', '--media', '--out', 'cli.zip');
  assert.deepEqual(
    [JSON.parse(captured.stdout).status, JSON.parse(captured.stdout).messages],
    ['completed', 24],
  );
  const verified = await runCli('validate', 'cli.zip', '--json');
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const cliManifest = JSON.parse(execFileSync('python3', ['-c',
    'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("manifest.json").decode())', join(root, 'cli.zip')]));
  assert.equal(cliManifest.media.archived, 1);
  await page.reload();
  const resumed = await runCli('scan', ...connection, '--resume', '--max-rounds', '1', '--out', 'cli-resumed.json')
    .catch(error => error);
  assert.equal(resumed.code, 3, resumed.stderr);
  const resumedArchive = JSON.parse(await readFile(join(root, 'cli-resumed.json'), 'utf8'));
  assert.equal(resumedArchive.messages.length, 24);
  assert.equal(resumedArchive.scan.resumed, true);
  console.log('Packaged CLI: live Chromium scan through CDP, attachment ZIP, validation, and resume after reload.');

} finally {
  await context?.close();
  await rm(root, {recursive: true, force: true, maxRetries: 6, retryDelay: 200});
}
