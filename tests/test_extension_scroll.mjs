import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const collector = readFileSync(new URL('../extension/collect.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8');
const sourceUrl = 'https://www.facebook.com/messages/e2ee/t/fixture';
const records = Array.from({length: 11}, (_, index) => ({
  node_id: 'node-' + index, source_message_id: 'id-' + index,
  text: 'Message ' + index, author: 'Ada',
}));

function harness() {
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

assert(panel.includes('Scroll to top'));
assert(panel.includes("runCollection({directions: [-1]})"));
assert(panel.includes("downloadExport('txt')"));
assert(panel.includes("downloadExport('json')"));
console.log('Extension upward-only scan, stop, and full-history regression: passed.');
