import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = read('../extension/thread.js') + '\n' + read('../extension/collect.js');
const sourceUrl = 'https://www.facebook.com/messages/e2ee/t/fixture';
const nextUrl = 'https://www.facebook.com/messages/e2ee/t/next';
const records = Array.from({length: 11}, (_, index) => ({
  source_message_id: 'id-' + index,
  text: 'Message ' + index,
  author: 'Ada',
  timestamp: new Date(Date.UTC(2025, 0, 1) + index * 60000).toISOString(),
}));

function fixtureRow(record) {
  return {
    parentElement: {closest: () => null},
    closest: () => null,
    getClientRects: () => [1],
    getAttribute: key => ({
      'data-message-id': record.source_message_id,
      'data-thread-id': record.thread,
      'aria-label': record.author,
    })[key],
    querySelector: () => null,
    textContent: record.text,
  };
}

function harness({confirmed = false, documentUrl = sourceUrl, capture = false} = {}) {
  let position = 8;
  let paneId = 'fixture';
  let title = 'Ada';
  let visible = records;
  let emptyAfter = Infinity;
  let reads = 0;
  const directions = [];
  const navigation = new EventTarget();
  const location = {href: sourceUrl};
  const root = {
    isConnected: true,
    getClientRects: () => [1],
    closest: selector => selector.includes('data-thread-id') ? root : null,
    matches: selector => selector.includes('role="log"') || (confirmed && selector.includes('data-history-')),
    getAttribute(key) {
      return {'data-thread-id': paneId, 'data-conversation-name': title}[key];
    },
    querySelector(selector) {
      return selector.includes('data-message-id') && visible.length ? fixtureRow(visible[0]) : null;
    },
    querySelectorAll(selector) {
      return selector.includes('data-message-id') ? visible.slice(position, position + 3).map(fixtureRow) : [];
    },
  };
  const context = {
    URL, AbortController, setTimeout, clearTimeout, location, navigation,
    document: {querySelectorAll: () => []},
    performance: {getEntriesByType: () => [{name: documentUrl}]},
    findContainer: () => root,
    readMessages: () => ({records: ++reads > emptyAfter ? [] : visible.slice(position, position + 3)}),
    scrollMessages: (_root, direction, move) => {
      directions.push(direction);
      const before = position;
      if (move) position = Math.max(0, Math.min(visible.length - 3, position + direction));
      return {
        atEdge: direction < 0 ? before === 0 : before >= visible.length - 3,
        loading: false, before: before * 100, height: visible.length * 100, viewport: 300,
      };
    },
  };
  runInNewContext(source + (capture ? '\n' + read('../src/dom/capture.js') : '') + `
    this.History = History;
    this.collectChat = collectChat;
    this.guard = new ConversationGuard();
  `, context);
  return {context, ...context, directions, route(url, commit = true) {
    const event = new Event('navigate');
    Object.defineProperty(event, 'destination', {value: {url}});
    navigation.dispatchEvent(event);
    if (commit) location.href = url;
  }, pane(id, data, name = 'Ada') {
    paneId = id;
    title = name;
    visible = data;
    position = Math.min(position, Math.max(0, data.length - 3));
  }, emptyAfter(count) { emptyAfter = count; }};
}

const quick = {pause: () => 0, stableRounds: 1, limit: 30, initializeTimeout: 400};
const ids = result => Array.from(result.payload.items, item => item.source_message_id);

{
  const {collectChat, guard, directions} = harness();
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal,
    {...quick, guard, directions: [-1]});
  assert.equal(result.error, null);
  assert.deepEqual(ids(result), records.map(item => item.source_message_id));
  assert(directions.every(direction => direction === -1));
  assert.equal(result.payload.coverage.newer, 'not_requested');
  assert.equal(result.payload.coverage.older, 'edge_stable');
  assert.equal(result.payload.scan.status, 'partial');
}

for (const confirmed of [false, true]) {
  const {collectChat, guard, directions} = harness({confirmed});
  const result = await collectChat(sourceUrl, () => {}, new AbortController().signal, {...quick, guard});
  assert.deepEqual(ids(result), records.map(item => item.source_message_id));
  assert.equal(result.payload.scan.status, confirmed ? 'completed' : 'partial');
  assert.equal(result.payload.scan.earliest, records[0].timestamp);
  assert.equal(result.payload.scan.latest, records.at(-1).timestamp);
  assert.equal(directions[0], 1);
  assert(directions.includes(-1));
}

// Firefox delivers a navigation event for local Blob downloads without changing location.
{
  const {guard, route} = harness();
  const identity = guard.inspect();
  route('blob:https://www.facebook.com/synthetic-export', false);
  assert.equal(guard.matches(identity), true);
  route('blob:https://www.facebook.com/synthetic-page');
  assert.equal(guard.matches(identity), false);
}

// URL and pane metadata may update before React replaces the old rows.
{
  const {guard, route, pane, collectChat} = harness();
  const initial = guard.inspect();
  assert(initial.ready);
  route(nextUrl);
  pane('next', records.map(item => ({...item})), 'Lin');
  assert.equal(guard.matches(initial), false);
  assert.equal(guard.inspect().ready, false);
  const after = [{source_message_id: 'new-id', text: 'New conversation', author: 'Lin'}];
  const render = setTimeout(() => pane('next', after, 'Lin'), 30);
  const result = await collectChat(nextUrl, () => {}, new AbortController().signal,
    {...quick, guard, directions: [-1]});
  clearTimeout(render);
  assert.equal(result.error, null);
  assert.deepEqual(ids(result), ['new-id']);
  assert.equal(result.payload.conversation.name, 'Lin');
}

// Fresh injection after an unobserved SPA change requires row-level proof or a reload.
{
  const stale = harness({documentUrl: nextUrl});
  assert.equal(stale.guard.inspect().ready, false);
  stale.pane('fixture', records.map(item => ({...item, thread: 'fixture'})));
  assert.equal(stale.guard.inspect().ready, true);
}

{
  const run = harness();
  const controller = new AbortController();
  const result = await run.collectChat(sourceUrl, count => { if (count) controller.abort(); }, controller.signal,
    {...quick, guard: run.guard, directions: [-1]});
  assert.equal(result.payload.count, 3);
  assert.equal(result.payload.scan.status, 'cancelled');
  assert.equal(result.payload.coverage.older, 'interrupted');
}

{
  const run = harness();
  let changed = false;
  const result = await run.collectChat(sourceUrl, count => {
    if (!count || changed) return;
    changed = true;
    run.route(nextUrl);
    run.route(sourceUrl);
  }, new AbortController().signal, {...quick, guard: run.guard});
  assert.equal(result.payload.count, 0);
  assert.equal(result.payload.scan.status, 'cancelled');
  assert.match(result.error, /Conversation changed/);
}

{
  const run = harness({confirmed: true});
  run.emptyAfter(1);
  const result = await run.collectChat(sourceUrl, () => {}, new AbortController().signal,
    {...quick, guard: run.guard, emptyRounds: 2});
  assert.equal(result.payload.scan.status, 'partial');
  assert.equal(result.payload.coverage.newer, 'empty_read');
  assert.equal(result.payload.coverage.older, 'empty_read');
}

{
  const run = harness({confirmed: true});
  run.emptyAfter(0);
  const result = await run.collectChat(sourceUrl, () => {}, new AbortController().signal,
    {...quick, guard: run.guard, emptyRounds: 2});
  assert.equal(result.payload.scan.status, 'failed');
  assert.equal(result.payload.count, 0);
}

{
  const {History} = harness();
  const history = new History();
  const row = (text, id, node) => ({text, source_message_id: id, node_id: node, author: 'Ada'});
  history.addWindow([row('start', 'start', 1), row('repeat', null, 2), row('repeat', null, 3), row('anchor', 'anchor', 4)], 1, '0:400:300');
  history.addWindow([row('start', 'start', 5), row('repeat', null, 6), row('repeat', null, 7), row('anchor', 'anchor', 8)], 1, '0:400:300');
  assert.equal(history.size, 4);
  history.addWindow([row('repeat', null, 2), row('repeat', null, 3), row('anchor', 'anchor', 4), row('end', 'end', 5)], 1, '100:400:300');
  assert.equal(history.size, 7, 'ambiguous repeated rows without a second bound should be preserved');
  const anchored = new History();
  anchored.addWindow([row('start', 'start', 1), row('repeat', null, 2), row('repeat', null, 3), row('anchor', 'anchor', 4)], 1, '0:600:300');
  anchored.addWindow([row('start', 'start', 10), row('repeat', null, 11), row('repeat', null, 12), row('anchor', 'anchor', 13), row('end', 'end', 14)], 1, '30:600:300');
  assert.deepEqual(Array.from(anchored.toArray(), item => item.text), ['start', 'repeat', 'repeat', 'anchor', 'end']);
  anchored.addWindow([row('distinct text', null, 2), row('another message', null, 3)], 1, '60:600:300');
  assert.equal(anchored.gaps, 1);
  assert.equal(anchored.size, 7);
}

// Checkpoint resume restores previous messages without merging a cross-thread payload.
{
  const run = harness();
  const controller = new AbortController();
  const saved = [];
  await run.collectChat(sourceUrl, count => { if (count) controller.abort(); }, controller.signal,
    {...quick, guard: run.guard, checkpoint: payload => saved.push(payload)});
  assert.equal(saved.length, 1);
  assert.equal(saved[0].count, 3);
  const resumed = await run.collectChat(sourceUrl, () => {}, new AbortController().signal,
    {...quick, guard: run.guard, resume: saved[0]});
  assert.equal(resumed.payload.scan.resumed, true);
  assert.deepEqual(ids(resumed), records.map(item => item.source_message_id));
  const invalid = await run.collectChat(sourceUrl, () => {}, new AbortController().signal,
    {...quick, guard: run.guard, resume: {...saved[0], source_url: nextUrl}});
  assert.match(invalid.error, /different conversation/);
  assert.equal(invalid.payload.count, 0);
}

// The CLI bridge also prevents retrieval after a completed scan goes stale.
{
  const run = harness({capture: true});
  const capture = run.context.__messscrapCapture;
  capture.start({...quick, directions: [-1]});
  while (capture.state().running) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(capture.state({detail: true}).result.payload.count, 11);
  run.route(nextUrl);
  assert.equal(capture.state({detail: true}).result.payload, null);
  assert.equal(capture.state({detail: true}).progress.status, 'cancelled');
  capture.dispose();
}

console.log('Scanner regression: SPA races, virtualization, boundaries, cancellation, checkpoints and CLI isolation passed.');
