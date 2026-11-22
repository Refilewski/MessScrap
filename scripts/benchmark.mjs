import {performance} from 'node:perf_hooks';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {arch, cpus, platform, tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {formatArchive, importArchive, searchMessages, statistics} from '../shared/archive.mjs';
import {makeViewer} from '../shared/viewer.mjs';
import {demoArchive} from './demo-archive.mjs';

const time = run => {
  const started = performance.now();
  const result = run();
  return [result, Math.round((performance.now() - started) * 10) / 10];
};
const rows = [];
const args = process.argv.slice(2);
const counts = args.filter(value => value !== '--browser').map(Number);
const useBrowser = args.includes('--browser');
const temp = useBrowser ? await mkdtemp(join(tmpdir(), 'messscrap-benchmark-')) : null;
const chromium = useBrowser ? (await import('playwright')).chromium : null;
const systemChromium = '/usr/bin/chromium';
const browserPath = process.env.MESSSCRAP_CHROMIUM
  || (chromium && existsSync(chromium.executablePath()) ? chromium.executablePath()
    : existsSync(systemChromium) ? systemChromium : undefined);
const browser = await chromium?.launch({executablePath: browserPath, headless: true});
const context = await browser?.newContext({offline: true, viewport: {width: 1280, height: 800}});

async function measureBrowser(text) {
  const path = join(temp, 'index.html');
  await writeFile(path, text);
  const page = await context.newPage();
  try {
    let started = performance.now();
    await page.goto(pathToFileURL(path).href);
    await page.getByRole('button', {name: 'Messages', exact: true}).waitFor();
    const openMs = Math.round((performance.now() - started) * 10) / 10;
    started = performance.now();
    await page.locator('#search').fill('weather');
    await page.locator('#search-count').filter({hasText: /result/}).waitFor();
    const firstSearchMs = Math.round((performance.now() - started) * 10) / 10;
    return {openMs, firstSearchMs};
  } finally {
    await page.close();
  }
}

try {
  for (const count of counts.length ? counts : [1000, 10000, 100000, 250000]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Provide positive integer message counts');
    globalThis.gc?.();
    const [archive, createMs] = time(() => demoArchive(count));
    const [archiveJson, jsonMs] = time(() => formatArchive(archive, 'json'));
    const [, importMs] = time(() => importArchive(JSON.parse(archiveJson)));
    const [, searchMs] = time(() => searchMessages(archive, 'weather'));
    const [stats, analyticsMs] = time(() => statistics(archive));
    const [html, htmlMs] = time(() => makeViewer(archive, stats));
    rows.push({
      count, createMs, jsonMs, importMs, searchMs, analyticsMs, htmlMs,
      jsonBytes: Buffer.byteLength(archiveJson), htmlBytes: Buffer.byteLength(html),
      ...(context ? await measureBrowser(html) : {}),
    });
  }
  console.log(JSON.stringify({
    node: process.version, browser: browser?.version(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model, rows,
  }, null, 2));
} finally {
  await browser?.close();
  if (temp) await rm(temp, {recursive: true, force: true});
}
