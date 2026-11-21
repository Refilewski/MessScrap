import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {runInNewContext} from 'node:vm';

const collector = readFileSync(new URL('../extension/collect.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
const sourceUrl = 'https://www.facebook.com/messages/e2ee/t/fixture';
const records = Array.from({length: 11}, (_, index) => ({
  node_id: 'node-' + index, source_message_id: 'id-' + index,
  text: 'Message ' + index, author: 'Ada',
}));

function harness(overrides = {}) {
  let position = 8;
  const directions = [];
  const root = {isConnected: true};
  const context = {
    location: {href: sourceUrl},
    threadUrl: value => value,
    findContainer: () => root,
    readMessages: () => ({records: records.slice(position, position + 3)}),
    scrollMessages: (_root, direction, move) => {
      directions.push(direction);
      const before = position;
      if (move) position = Math.max(0, Math.min(records.length - 3, position + direction));
      return {
        atEdge: direction < 0 ? before === 0 : before >= records.length - 3,
        loading: false, before: before * 100, height: 1100, viewport: 300,
      };
    },
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  runInNewContext(collector + '\nthis.collectChat = collectChat;', context);
  return {collectChat: context.collectChat, directions};
}

// The new button must never trigger the newer/downward phase.
{
  const {collectChat, directions} = harness();
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {
    directions: [-1], pause: () => 0, stableRounds: 1, limit: 30,
  });
  assert.equal(result.error, null);
  assert.equal(result.payload.count, 11);
  assert(directions.length > 0 && directions.every(direction => direction === -1));
  assert.equal(result.payload.coverage.newer, 'not_requested');
  assert.equal(result.payload.coverage.older, 'edge_stable');
  assert.equal(result.payload.partial, true);
  assert.equal(result.payload.items[0].text, 'Message 0');
}

// Stop must keep already seen messages and mark the export interrupted.
{
  const {collectChat, directions} = harness();
  const controller = new AbortController();
  const result = await collectChat(sourceUrl, () => controller.abort(), controller.signal, {
    directions: [-1], pause: () => 0, stableRounds: 1, limit: 30,
  });
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.interrupted, true);
  assert.equal(result.payload.coverage.newer, 'not_requested');
  assert.equal(result.payload.coverage.older, 'interrupted');
  assert(directions.every(direction => direction === -1));
}

// The existing full-history button still scans both directions.
{
  const {collectChat, directions} = harness();
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {
    pause: () => 0, stableRounds: 1, limit: 30,
  });
  assert.equal(result.payload.count, 11);
  assert.equal(result.payload.partial, false);
  assert.equal(directions[0], 1);
  assert(directions.includes(-1));
}

// Stop cancels a pending scan delay and keeps the first batch.
{
  const timer = 1;
  const cleared = [];
  let delay;
  const {collectChat, directions} = harness({
    setTimeout(_callback, milliseconds) {
      delay = milliseconds;
      return timer;
    },
    clearTimeout(id) { cleared.push(id); },
  });
  const controller = new AbortController();
  const pending = collectChat(sourceUrl, () => {}, controller.signal, {pause: () => 450});
  assert.equal(delay, 450);
  controller.abort();
  const result = await Promise.race([pending, nextTurn()]);
  assert(result, 'Collection should finish without waiting for the timer.');
  assert.deepEqual(cleared, [timer]);
  assert.deepEqual(directions, [1]);
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.coverage.newer, 'interrupted');
  assert.equal(result.payload.coverage.older, 'not_requested');
}

// A failed scan keeps completed coverage and previously collected messages.
{
  const location = {href: sourceUrl};
  const {collectChat} = harness({location});
  const result = await collectChat(sourceUrl, (_count, phase) => {
    if (phase === 'older') location.href += '-next';
  }, new AbortController().signal, {pause: () => 0, stableRounds: 1, limit: 30});
  assert.equal(result.error, 'The tab switched to a different conversation.');
  assert.equal(result.payload.source_url, sourceUrl);
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.partial, true);
  assert.equal(result.payload.interrupted, false);
  assert.equal(result.payload.coverage.newer, 'edge_stable');
  assert.equal(result.payload.coverage.older, 'error');
}

// A conversation can replace its initial empty message container as it loads.
{
  const empty = {isConnected: true};
  const loaded = {isConnected: true};
  let lookups = 0;
  const {collectChat, directions} = harness({
    findContainer: () => lookups++ ? loaded : empty,
    readMessages: root => ({records: root === loaded ? records.slice(8) : []}),
    setTimeout(callback, delay) {
      assert(lookups > 1 || directions.length === 0, 'Scroll must wait until messages exist.');
      return setTimeout(callback, delay);
    },
  });
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {
    directions: [1], pause: () => 0, stableRounds: 1, limit: 5,
  });
  assert.equal(result.error, null);
  assert.equal(lookups, 2);
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.coverage.newer, 'edge_stable');
}

// The loading wait honors the scan limit and remains stoppable with no messages.
{
  for (const [limit, expectedReads] of [[2, 2], [30, 4]]) {
    let reads = 0;
    const {collectChat, directions} = harness({
      readMessages() {
        reads++;
        return {records: []};
      },
    });
    const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {limit, pause: () => 0});
    assert.match(result.error, /No messages detected/);
    assert.equal(result.payload.coverage.newer, 'error');
    assert.equal(reads, expectedReads);
    assert.deepEqual(directions, []);
  }

  const {collectChat, directions} = harness({readMessages: () => ({records: []})});
  const controller = new AbortController();
  const pending = collectChat(sourceUrl, () => {}, controller.signal);
  controller.abort();
  const result = await pending;
  assert.equal(result.error, null);
  assert.equal(result.payload.count, 0);
  assert.equal(result.payload.coverage.newer, 'interrupted');
  assert.deepEqual(directions, []);
}

// An empty viewport may be re-rendering and cannot establish a stable edge.
{
  let reads = 0;
  const {collectChat} = harness({
    readMessages: () => ({records: reads++ === 0 ? records.slice(8) : []}),
  });
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {
    directions: [1], pause: () => 0, stableRounds: 1, limit: 3,
  });
  assert.equal(result.error, null);
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.coverage.newer, 'round_limit');
}

// A panel that stays open when Messenger switches chats uses the new thread.
{
  const location = {href: sourceUrl};
  const buttons = new Map();
  const shadow = {
    adoptedStyleSheets: [],
    append() {},
    querySelector(selector) {
      if (!buttons.has(selector)) {
        buttons.set(selector, {
          addEventListener(_event, listener) { this.click = listener; },
          focus() {},
          dataset: {},
        });
      }
      return buttons.get(selector);
    },
  };
  const calls = [];
  runInNewContext(`(() => {${panel}\n})()`, {
    AbortController,
    CSSStyleSheet: class { replaceSync() {} },
    location,
    threadUrl: value => value,
    document: {
      getElementById: () => null,
      createElement: () => ({attachShadow: () => shadow}),
      documentElement: {append() {}},
    },
    async collectChat(url, _onProgress, _signal, options) {
      calls.push({url, directions: Array.from(options.directions)});
      return {payload: {count: 1, partial: true}};
    },
  });

  const nextUrl = sourceUrl + '-next';
  location.href = nextUrl;
  await buttons.get('#scrollTop').click();
  assert.deepEqual(calls, [{url: nextUrl, directions: [-1]}]);
  assert.equal(buttons.get('#save').hidden, false);
  assert.equal(buttons.get('#saveTxt').hidden, false);
}

assert(panel.includes("downloadExport('txt')"));
assert(panel.includes("downloadExport('json')"));
console.log('Extension upward-only scan, stop, and full-history regression: passed.');
