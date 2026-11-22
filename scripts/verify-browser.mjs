import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {createArchive} from '../shared/archive.mjs';
import {archiveEntries} from '../shared/zip.mjs';
import {demoArchive} from './demo-archive.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const captureScreenshots = process.argv.includes('--screenshots');
const screenshotDir = join(root, 'docs', 'screenshots');
const archiveDir = await mkdtemp(join(tmpdir(), 'messscrap-offline-'));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.MESSSCRAP_CHROMIUM || process.env.CHROMIUM_PATH,
});
const errors = [];
const requests = [];

async function archivePhoto(context) {
  const page = await context.newPage();
  try {
    return Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 550;
      canvas.height = 264;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#e5eadc';
      ctx.fillRect(0, 0, 550, 264);
      function trace(points, fill, outline, width = 1) {
        ctx.beginPath();
        for (const [index, [x, y]] of points.entries()) {
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (fill) { ctx.fillStyle = fill; ctx.fill(); }
        if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = width; ctx.stroke(); }
      }
      trace([[0, 14], [90, 38], [137, 8], [225, 26], [260, 96], [185, 124], [122, 117], [53, 156], [0, 136]], '#c4d6be');
      trace([[550, 129], [477, 149], [450, 184], [378, 176], [362, 252], [441, 264], [550, 264]], '#c4d6be');
      trace([[0, 212], [67, 185], [134, 187], [220, 158], [261, 176], [338, 141], [393, 98], [474, 83], [550, 44]], null, '#9dbdc6', 10);
      trace([[14, 236], [103, 216], [179, 213], [228, 192], [271, 196], [341, 170], [392, 129], [442, 115], [487, 116], [535, 83]], null, '#f5f6ed', 7);
      trace([[83, 222], [125, 211], [153, 210], [200, 191], [229, 184], [261, 197], [318, 181], [345, 172], [393, 131], [431, 119]], null, '#437362', 3.5);
      for (const [x, y] of [[83, 222], [431, 119]]) {
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, 2 * Math.PI);
        ctx.fillStyle = '#437362';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.fillStyle = '#40554d';
      ctx.font = '600 13px system-ui';
      ctx.fillText('Station', 30, 218);
      ctx.fillText('Footbridge', 447, 127);
      ctx.fillText('Riverside walking route', 22, 27);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
  } finally {
    await page.close();
  }
}

function archiveFixture() {
  const sample = demoArchive();
  const date = '2025-12-07T';
  const notes = [
    ['17:21', 'Maya Torres', 'The river path is open again. Still good for Saturday?'],
    ['17:22', 'Avery Chen', 'Yes. I checked the train times and can meet at the station at nine.'],
    ['17:24', 'Theo Park', 'I’m in. Sending the route so everyone has it saved.'],
    ['17:25', 'Theo Park', '', {attachments: [{kind: 'image', filename: 'riverside-route.png', mimeType: 'image/png', sourceUrl: 'https://scontent.fbcdn.net/synthetic-route.png'}]}],
    ['17:31', 'Maya Torres', 'That footbridge is the one! See you both there. ☀️', {reactions: [{emoji: '👍', author: 'Avery Chen'}]}],
    ['17:34', 'Avery Chen', 'I’ll bring coffee for the ride.', {reply: {messageId: 'final-0', text: 'The river path is open again. Still good for Saturday?', author: 'Maya Torres'}}],
    ['17:36', 'Theo Park', 'I saved the weekend notes here.', {attachments: [{kind: 'file', filename: 'weekend-notes.txt', mimeType: 'text/plain', sourceUrl: 'https://scontent.fbcdn.net/synthetic-notes.txt'}]}],
  ];
  const hiddenTests = [
    {id: 'viewer-safety', text: '</script><img src="https://invalid.example/network" onerror="window.injected = true">', author: 'Maya Torres', timestamp: '2025-12-06T11:12:00Z'},
    {id: 'fixture-sticker', attachments: [{kind: 'sticker', filename: 'Wave.webp', status: 'unavailable'}], author: 'Maya Torres', timestamp: '2025-12-06T11:12:01Z'},
  ];
  return createArchive({
    ...sample,
    messages: [
      ...sample.messages,
      ...hiddenTests,
      ...notes.map(([time, author, text, fields], index) => ({
        id: 'final-' + index,
        timestamp: date + time + ':00Z',
        author,
        direction: author === 'Avery Chen' ? 'outgoing' : 'incoming',
        text,
        ...fields,
      })),
    ],
  }, {keepMediaSources: true});
}

function track(page) {
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('http:') || request.url().startsWith('https:')) requests.push(request.url());
  });
}

async function assertVisible(locator) {
  await locator.waitFor({state: 'visible'});
  assert(await locator.isVisible());
}

try {
  const desktop = await browser.newContext({offline: true, viewport: {width: 1360, height: 820}, colorScheme: 'light', reducedMotion: 'reduce'});
  const photo = await archivePhoto(desktop);
  const fixture = archiveFixture();
  const files = await archiveEntries(fixture, {
    includeMedia: true,
    loadMedia: async attachment => {
      if (attachment.filename === 'riverside-route.png') return {mimeType: 'image/png', bytes: photo};
      if (attachment.filename === 'weekend-notes.txt') return {mimeType: 'text/plain', bytes: new TextEncoder().encode('Saturday\n09:00 Station entrance\n')};
      return null;
    },
  });
  for (const [name, contents] of files) {
    const file = join(archiveDir, name);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, contents);
  }
  const url = pathToFileURL(join(archiveDir, 'index.html')).href;
  const page = await desktop.newPage();
  track(page);
  await page.goto(url);
  await assertVisible(page.getByRole('heading', {name: 'Weekend Plans'}));
  assert.equal((await page.locator('.message').count()), 100);
  assert.equal(await page.locator('#status-messages').textContent(), fixture.messages.length.toLocaleString('en-US') + ' messages');

  if (captureScreenshots) {
    await mkdir(screenshotDir, {recursive: true});
    await page.locator('.bubble img').last().evaluate(image => image.decode());
    await page.screenshot({path: join(screenshotDir, 'archive-viewer.png'), animations: 'disabled'});
  }

  const search = page.getByRole('searchbox', {name: 'Search messages'});
  await search.fill('train');
  await assertVisible(page.locator('#search-count').filter({hasText: /results/}));
  await assertVisible(page.locator('.bubble mark').last());
  await page.getByRole('button', {name: 'Previous result'}).click();
  assert.equal(await page.locator('.message.highlight').count(), 1);
  await search.fill('window.injected');
  await assertVisible(page.locator('.message-text').filter({hasText: /<\/script><img src=/u}));
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await search.fill('');

  const calendar = page.getByRole('button', {name: 'Jump to date'});
  await calendar.click();
  await page.getByRole('button', {name: 'Earliest'}).click();
  await assertVisible(page.locator('#message-0.highlight'));
  await calendar.click();

  await page.getByRole('button', {name: 'Media', exact: true}).click();
  await page.getByRole('combobox', {name: 'Media type'}).selectOption('image');
  const thumbnail = page.getByRole('button', {name: 'riverside-route.png'});
  await assertVisible(thumbnail);
  assert(await thumbnail.locator('img').evaluate(async image => { await image.decode(); return image.naturalWidth > 500; }));
  await thumbnail.click();
  await assertVisible(page.getByRole('dialog'));
  await page.getByRole('button', {name: 'Close preview'}).click();
  await page.getByRole('combobox', {name: 'Media type'}).selectOption('sticker');
  await assertVisible(page.getByText('Unavailable', {exact: true}));

  await page.getByRole('button', {name: 'Links', exact: true}).click();
  await page.getByRole('searchbox', {name: 'Search links'}).fill('example.org');
  await assertVisible(page.getByRole('link', {name: 'Open link'}).first());
  assert.equal(await page.getByRole('link', {name: 'Open link'}).first().getAttribute('target'), '_blank');
  await page.getByRole('button', {name: 'View message'}).first().click();
  await assertVisible(page.locator('.message.highlight'));

  await page.getByRole('button', {name: 'Files', exact: true}).click();
  await assertVisible(page.getByText('weekend-notes.txt', {exact: true}));
  assert.match(await page.getByRole('link', {name: 'Save file'}).getAttribute('href'), /^\.\/media\/files\//u);

  await page.getByRole('button', {name: 'Statistics', exact: true}).click();
  await assertVisible(page.getByRole('heading', {name: 'Conversation statistics'}));
  assert.equal(await page.locator('.heat-cell.active').count() > 100, true);
  assert.equal(await page.locator('.stat-card').first().locator('strong').textContent(), fixture.messages.length.toLocaleString('en-US'));
  if (captureScreenshots) {
    await page.screenshot({path: join(screenshotDir, 'conversation-statistics.png'), animations: 'disabled'});
  }
  await page.getByRole('button', {name: 'Filters', exact: true}).click();
  await page.getByRole('combobox', {name: 'Participant'}).selectOption('Maya Torres');
  assert.equal(await page.locator('.stat-card').first().locator('strong').textContent(), fixture.messages.filter(message => message.author === 'Maya Torres').length.toLocaleString('en-US'));
  await page.getByRole('combobox', {name: 'Theme'}).selectOption('dark');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');

  const mobile = await browser.newContext({offline: true, viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce'});
  const handset = await mobile.newPage();
  track(handset);
  await handset.goto(url);
  await assertVisible(handset.getByRole('heading', {name: 'Weekend Plans'}));
  for (const width of [390, 320]) {
    await handset.setViewportSize({width, height: 844});
    const layoutWidth = await handset.evaluate(() => document.documentElement.scrollWidth);
    assert.equal(layoutWidth, width, 'The archive must fit the mobile viewport without horizontal scrolling.');
  }
  await handset.setViewportSize({width: 390, height: 844});
  const toggle = handset.getByRole('button', {name: 'Toggle navigation'});
  await toggle.click();
  await assertVisible(handset.getByRole('searchbox', {name: 'Search messages'}));
  await handset.getByRole('button', {name: 'Overview', exact: true}).click();
  await assertVisible(handset.getByRole('heading', {name: 'Overview'}));
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log('Verified offline viewer from local archive files on desktop and mobile Chromium.');
} finally {
  await browser.close();
  await rm(archiveDir, {recursive: true, force: true});
}
