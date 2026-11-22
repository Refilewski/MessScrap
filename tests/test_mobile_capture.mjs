import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
const files = [
  ['extension/thread.js'],
  ['src/dom/container.js', 'findContainer()'],
  ['src/dom/messages.js', 'readMessages()'],
  ['src/dom/scroll.js', 'scrollMessages(root, direction, move)'],
  ['extension/collect.js'],
];
const source = await Promise.all(files.map(async ([path, signature]) => {
  const code = await read(path);
  return signature ? 'function ' + signature + ' {\n' + code + '\n}' : code;
}));
const scanner = `(() => {
${source.join('\n')}
let guard = new ConversationGuard();
window.fixtureScanner = {
  restart() { guard.dispose(); guard = new ConversationGuard(); },
  inspect() {
    const info = guard.inspect();
    return {...info, root: info.root?.id, pane: info.pane?.id};
  },
  async collect() {
    return collectChat(location.href, () => {}, new AbortController().signal, {
      guard, initializeTimeout: 400, pause: () => 20, stableRounds: 2, limit: 30,
    });
  },
};
})();`;
const builtPanel = await read('bin/chromium-extension/content.js');
const candidates = [process.env.MESSSCRAP_CHROMIUM, process.env.CHROMIUM_PATH, chromium.executablePath(), '/usr/bin/chromium'].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  if (await access(candidate).then(() => true, () => false)) {
    executablePath = candidate;
    break;
  }
}
assert(executablePath, 'Set MESSSCRAP_CHROMIUM or install the Playwright Chromium browser.');
const browser = await chromium.launch({headless: true, executablePath});
const origin = 'https://m.facebook.com';
const firstId = 'synthetic-mobile-thread';
const nextId = 'synthetic-next-thread';
const topic = 'Synthetic fixture participant';
const secondTopic = 'Another fixture participant';
const privateLine = 'Synthetic secret message';
const route = id => '/messages/e2ee/t/' + id;

// These fixtures model structural combinations with synthetic data. They do not
// represent a recorded Messenger page from an Android or iOS device.
function markup({metaViewport = true, semantic = false} = {}) {
  return `<!doctype html><meta charset="utf-8">
${metaViewport ? '<meta name="viewport" content="width=device-width,initial-scale=1">' : ''}
<title>Synthetic conversation page</title>
<style>
body { margin: 0; font: 15px system-ui; }
main { box-sizing: border-box; width: ${metaViewport ? '100%' : '980px'}; max-width: 100%; }
#scroll { height: 200px; overflow-y: auto; overflow-anchor: none; }
#list.virtual { height: 896px; position: relative; }
#list.virtual article { position: absolute; }
article { min-height: 35px; padding: 4px; }
time { font-size: 11px; }
</style>
<aside aria-label="Notifications"><div role="log"><div data-message-id="notice">Notification</div></div></aside>
<main>
<nav aria-label="Conversations">
  <a href="${route(firstId)}" aria-current="page"><span dir="auto">${topic}</span></a>
  <a href="${route(nextId)}"><span dir="auto">${secondTopic}</span></a>
  <div role="grid"><article data-message-id="preview"><div dir="auto">Sidebar preview</div></article></div>
</nav>
<section id="conversation-pane">
  <header><h1>${topic}</h1></header>
  <div id="scroll">
    <div id="list"${semantic ? ' role="log"' : ''}></div>
  </div>
</section>
</main>`;
}

function renderRows({id, title, line, style, virtual, bindPane = true, bindRows = false}) {
  const list = document.querySelector('#list');
  const scroller = document.querySelector('#scroll');
  if (bindPane) list.dataset.threadId = id;
  else delete list.dataset.threadId;
  document.querySelector('h1').textContent = title;
  for (const link of document.querySelectorAll('nav a')) {
    link.setAttribute('aria-current', link.pathname.endsWith('/' + id) ? 'page' : 'false');
  }
  list.classList.toggle('virtual', virtual);

  function render() {
    const first = virtual ? Math.min(8, Math.max(0, Math.floor(scroller.scrollTop / 56) - 2)) : 0;
    list.replaceChildren();
    for (let i = first; i < first + (virtual ? 8 : 3); i++) {
      const row = document.createElement('article');
      const body = document.createElement('div');
      const time = document.createElement('time');
      time.dateTime = new Date(Date.UTC(2025, 0, 1, 12, i === 5 ? 4 : i)).toISOString();
      body.dir = 'auto';
      body.textContent = i === 4 || i === 5 ? 'Repeated fixture text' : line + ' ' + i;
      if (style === 'native' || (virtual && i !== 4 && i !== 5)) row.dataset.messageId = id + '-row-' + i;
      if (style === 'structured') row.dataset.senderName = title;
      else row.setAttribute('aria-label', 'At January 1, 2025 12:00 PM, ' + title + ': ' + body.textContent);
      if (bindRows) row.dataset.threadId = id;
      if (virtual) row.style.top = (i * 56) + 'px';
      row.append(body, time);
      list.append(row);
    }
  }

  scroller.onscroll = virtual ? render : null;
  scroller.scrollTop = virtual ? 360 : 0;
  render();
}

function rows(options = {}) {
  return {id: firstId, title: topic, line: privateLine, style: 'structured', virtual: false, ...options};
}

async function fixture(options) {
  const context = await browser.newContext(options.context);
  if (options.withoutNavigationApi) await context.addInitScript(() => {
    Object.defineProperty(window, 'navigation', {value: undefined});
  });
  await context.route('https://**/*', request => {
    if (new URL(request.request().url()).origin === origin) {
      return request.fulfill({body: markup(options), contentType: 'text/html; charset=utf-8'});
    }
    return request.abort();
  });
  const page = await context.newPage();
  await page.goto(origin + route(firstId));
  if (options.scanner !== false) await page.addScriptTag({content: scanner});
  const inspect = () => page.evaluate(() => fixtureScanner.inspect());
  const collect = () => page.evaluate(() => fixtureScanner.collect());
  const render = options => page.evaluate(renderRows, rows(options));
  return {context, page, inspect, collect, render};
}

async function openPanel(page, brokenCheckpoint = false) {
  // This fixture exercises the packaged content UI with a minimal local
  // preferences adapter. The extension installation tests cover actual APIs.
  await page.evaluate(brokenCheckpoint => {
    window.browser = {runtime: {sendMessage: async ({operation, id}) => {
      if (operation === 'preferences' && brokenCheckpoint) return {value: {format: 'json'}};
      if (operation === 'info' && brokenCheckpoint) return {value: {
        count: 1, chunks: 1, revision: 'invalid-checkpoint',
        header: {source_url: location.href, conversation: {id}, checkpoint_version: 99},
      }};
      return {value: operation === 'read-chunk' ? [] : null};
    }}};
  }, brokenCheckpoint);
  await page.addScriptTag({content: builtPanel});
  return page.locator('#messscrap-export-panel');
}

async function checkPanelLayout(panel) {
  const layout = await panel.locator('section').evaluate(section => {
    const {left, right, top, bottom, width} = section.getBoundingClientRect();
    const viewport = visualViewport;
    return {
      within: left >= viewport.offsetLeft - 1 && right <= viewport.offsetLeft + viewport.width + 1
        && top >= viewport.offsetTop - 1 && bottom <= viewport.offsetTop + viewport.height + 1,
      effectiveWidth: width * viewport.scale,
      overflow: section.scrollWidth - section.clientWidth,
    };
  });
  assert(layout.within, 'The panel fits the visual viewport.');
  assert(layout.effectiveWidth >= 240, 'The panel remains readable on a desktop-sized page fitted to mobile.');
  assert.equal(layout.overflow, 0, 'Expanded panel content fits without horizontal scrolling.');
}

try {
  const desktop = await fixture({semantic: true, context: {viewport: {width: 1080, height: 720}}});
  const {page, inspect, collect, render} = desktop;
  assert.equal((await inspect()).diagnostics.status, 'rows_missing');
  await page.locator('#list').evaluate(list => list.removeAttribute('role'));
  assert.equal((await inspect()).diagnostics.status, 'container_missing');
  await page.locator('#list').evaluate(list => list.setAttribute('role', 'log'));
  await page.locator('#list').evaluate(list => list.setAttribute('aria-busy', 'true'));
  assert.equal((await inspect()).diagnostics.status, 'loading');
  await page.locator('#list').evaluate(list => list.removeAttribute('aria-busy'));
  await render({style: 'native', bindPane: false});
  assert.equal((await inspect()).diagnostics.status, 'identity_unproven',
    'A selected sidebar conversation, heading and URL alone are insufficient.');
  await page.locator('#list').evaluate(list => list.setAttribute('aria-label', 'Messages with ' + list.closest('section').querySelector('h1').textContent));
  const desktopIdentity = await inspect();
  assert.equal(desktopIdentity.ready, true);
  assert.equal(desktopIdentity.pane, 'list');
  const desktopResult = await collect();
  assert.equal(desktopResult.error, null);
  assert.equal(desktopResult.payload.count, 3);

  // An independent second visible pane makes the message list ambiguous.
  await page.locator('#list').evaluate(list => {
    const duplicate = list.cloneNode(true);
    duplicate.id = 'second-message-list';
    list.parentElement.after(duplicate);
  });
  assert.equal((await inspect()).diagnostics.status, 'identity_conflict');
  assert.equal((await collect()).payload.count, 0);
  await page.locator('#second-message-list').evaluate(list => { list.style.visibility = 'hidden'; });
  await render({style: 'native', bindRows: true});
  assert.equal((await inspect()).ready, true, 'A visibility-hidden pane does not make the rendered pane ambiguous.');

  // The previous messages remain mounted while both the URL and the heading
  // update. Even an attempt starting after the pushState must reject them.
  await page.evaluate(({path, id, title}) => {
    history.pushState({}, '', path);
    document.querySelector('#list').dataset.threadId = id;
    document.querySelector('h1').textContent = title;
    const links = [...document.querySelectorAll('nav a')];
    links[0].removeAttribute('aria-current');
    links[1].setAttribute('aria-current', 'page');
  }, {path: route(nextId), id: nextId, title: secondTopic});
  assert.equal((await inspect()).ready, false);
  await render({id: nextId, title: secondTopic, line: 'Previously unseen window', style: 'native'});
  assert.equal((await inspect()).ready, false, 'Unseen row IDs on a reused pane cannot establish ownership.');
  await page.evaluate(() => fixtureScanner.restart());
  assert.equal((await inspect()).ready, false, 'An unobserved SPA change still needs row-level proof.');
  await render({id: nextId, title: secondTopic, line: 'New fixture row', bindRows: true});
  assert.equal((await inspect()).ready, true);
  await page.locator('#list article').first().evaluate(row => { row.dataset.conversationId = 'conflicting'; });
  assert.equal((await inspect()).diagnostics.status, 'identity_conflict',
    'Conflicting identifier attributes on a row reject capture.');
  assert.equal((await collect()).payload.count, 0);
  await page.reload();
  await page.addScriptTag({content: scanner});
  await render({id: nextId, title: secondTopic, line: 'New fixture row'});
  const reloaded = await inspect();
  assert.equal(reloaded.ready, true, 'Reload should re-establish the document route: ' + JSON.stringify(reloaded.diagnostics));
  await page.evaluate(() => history.pushState({}, '', '/messages/'));
  assert.equal((await inspect()).diagnostics.status, 'unsupported_url');

  await page.goto(origin + route(firstId));
  await page.evaluate(path => history.pushState({}, '', path), route(nextId));
  await render({id: nextId, title: secondTopic, line: 'Still mounted after Back', style: 'native'});
  await page.goBack();
  await page.evaluate(({firstId, topic}) => {
    document.querySelector('#list').dataset.threadId = firstId;
    document.querySelector('h1').textContent = topic;
    const [first, second] = document.querySelectorAll('nav a');
    first.setAttribute('aria-current', 'page');
    second.removeAttribute('aria-current');
  }, {firstId, topic});
  await page.addScriptTag({content: scanner});
  assert.equal((await inspect()).ready, false, 'Late injection after SPA Back must not accept a stale rendered window.');
  await desktop.context.close();

  const android = await fixture({
    metaViewport: false,
    withoutNavigationApi: true,
    context: {viewport: {width: 360, height: 640}, isMobile: true, hasTouch: true, deviceScaleFactor: 2},
  });
  const androidPanel = await openPanel(android.page);
  const androidControl = id => androidPanel.locator('#' + id);
  await androidControl('start').tap();
  await androidControl('status').filter({hasText: /initializing|verifying/i}).waitFor();
  await android.render({virtual: true});
  const androidIdentity = await android.inspect();
  assert.equal(androidIdentity.ready, true);
  assert.equal(androidIdentity.root, 'scroll');
  await androidControl('pause').tap();
  await androidControl('status').filter({hasText: /^Paused$/}).waitFor();
  await androidControl('pause').tap();
  await androidControl('status').filter({hasText: /^Scanning$/}).waitFor();
  await androidControl('stop').tap();
  await androidControl('status').filter({hasText: /^Cancelled$/}).waitFor();
  assert.equal(await androidControl('save').isEnabled(), true);
  const androidResult = await android.collect();
  assert.equal(androidResult.error, null);
  const virtual = androidResult.payload;
  assert.equal(virtual.count, 16);
  assert.deepEqual(virtual.items.map(item => item.text), Array.from({length: 16}, (_, i) =>
    i === 4 || i === 5 ? 'Repeated fixture text' : privateLine + ' ' + i));
  assert.deepEqual(virtual.items.slice(4, 6).map(item => item.source_message_id), [null, null]);
  assert.equal(virtual.items[4].author, topic);
  assert.equal(virtual.items[4].timestamp, '2025-01-01T12:04:00.000Z');
  assert.equal(virtual.scan.status, 'partial');
  assert.equal(virtual.coverage.older, 'edge_stable');
  assert.equal(virtual.coverage.newer, 'edge_stable');

  await androidControl('toggle-settings').tap();
  await androidControl('batch').locator('summary').tap();
  await androidControl('diagnostics').locator('summary').tap();
  await checkPanelLayout(androidPanel);
  const scrollBefore = await android.page.locator('#scroll').evaluate(node => node.scrollTop);
  const paneScroll = await androidPanel.locator('section').evaluate(section => {
    section.scrollTop = section.scrollHeight;
    return section.scrollTop;
  });
  assert(paneScroll > 0, 'Expanded controls can be reached by scrolling the panel.');
  assert.equal(await android.page.locator('#scroll').evaluate(node => node.scrollTop), scrollBefore);
  await android.context.close();

  const iphone = await fixture({
    context: {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 3},
    scanner: false,
  });
  await iphone.render({style: 'label', bindPane: false});
  const iphonePanel = await openPanel(iphone.page, true);
  const iphoneControl = id => iphonePanel.locator('#' + id);
  await iphoneControl('start').tap();
  await iphoneControl('status').filter({hasText: /^Failed$/}).waitFor({timeout: 15_000});
  assert.equal(await iphoneControl('save').isDisabled(), true);
  if (await iphoneControl('diagnostics').getAttribute('open') === null) {
    await iphoneControl('diagnostics').locator('summary').tap();
  }
  await iphone.page.waitForFunction(() => document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#diagnostic-report').value);
  const report = await iphoneControl('diagnostic-report').inputValue();
  assert.match(report, /identity.*(?:unverified|not proven)/i);
  assert.match(report, /timeout|timed out/i);
  assert.match(report, /(?:visible )?message rows[^\d]+3/i);
  for (const value of [firstId, topic, privateLine, origin]) assert(!report.includes(value), 'Diagnostic report must omit conversation data.');
  await iphone.page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {async writeText(text) { window.copiedReport = text; }}});
  });
  await iphoneControl('copy-diagnostics').tap();
  assert.equal(await iphone.page.evaluate(() => window.copiedReport), report);
  await checkPanelLayout(iphonePanel);
  await iphone.render({style: 'label'});
  await iphoneControl('start').getByText(/retry/i).waitFor();
  await iphoneControl('start').tap();
  await iphoneControl('save').waitFor();
  await iphone.page.waitForFunction(() => !document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').disabled);
  const saved = iphone.page.waitForEvent('download');
  await iphoneControl('save').tap();
  const download = await saved;
  const archive = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(archive.conversation.id, firstId);
  assert.deepEqual(archive.messages.map(item => item.text), [0, 1, 2].map(i => privateLine + ' ' + i));
  assert(archive.messages.every(item => item.author === topic && !item.nativeId));

  await iphoneControl('resume').tap();
  await iphoneControl('status').filter({hasText: /^Failed$/}).waitFor();
  assert.equal(await iphoneControl('save').isEnabled(), true, 'A failed retry retains a still-verified prior export.');
  await iphone.page.evaluate(path => history.pushState({}, '', path), route(nextId));
  await iphone.page.waitForFunction(() => document.querySelector('#messscrap-export-panel').shadowRoot.querySelector('#save').disabled);
  await iphone.context.close();

  console.log('Capture verification on synthetic desktop, Android-sized, and iPhone-sized Chromium fixtures passed.');
} finally {
  await browser.close();
}
