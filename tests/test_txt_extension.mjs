import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the exact standalone formatter bundled into Chromium and Firefox.
const formatter = readFileSync(new URL('../extension/txt.js', import.meta.url), 'utf8');
const render = payload => runInNewContext(formatter + '\nformatTxt(payload)', {payload});
const items = [
  {
    index: 1, source_message_id: 'secret-1', message_id: 'local-1',
    author: 'Ada', date: 'Monday', time: '10:00am',
    text: 'First https://example.com/private',
  },
  {
    index: 2, source_message_id: 'secret-2', message_id: 'local-2',
    author: 'Ada', date: 'Monday', time: '10:00am',
    text: 'Second\nline\nmore',
  },
  {
    index: 3, source_message_id: 'secret-3',
    author: 'Bob', date: 'Monday', time: '10:01am',
    text: 'Thanks',
    reply_to: {target_index: 1},
    reactions: [{label: '1 reaction with ❤️; see who reacted to this'}],
  },
  {
    index: 4, source_message_id: 'secret-4',
    direction: 'me', date: 'Tuesday', time: '10:00am',
    message_type: 'sticker', text: '',
    attachments: [{kind: 'sticker', url: 'blob:https://facebook.com/private'}],
  },
  {
    index: 5, author: 'Ada', date: 'Tuesday', time: '10:01am',
    text: 'Go to www.example.org now',
  },
  {
    index: 6, direction: 'me', timestamp: '2026-11-13T14:02:00+01:00',
    text: 'line 1\r\nline 2', message_type: 'text',
    reply_to: {text: 'Look at ftp://example.com/file'},
  },
];

const transcript = render({
  items, count: items.length, exported_at: '2026-11-13T17:36:51+01:00',
  partial: true, source_url: 'https://facebook.com/messages/e2ee/t/999',
});
assert.match(transcript, /Messenger conversation · 6 messages/);
assert.match(transcript, /Partial export — some history may be missing/);
assert.match(transcript, /── Monday ──/);
assert.match(transcript, /── Tuesday ──/);
assert.match(transcript, /── 2026-11-13 ──/);
assert.equal((transcript.match(/Ada · 10:00am/g) || []).length, 1);
assert.match(transcript, /  • First \[link\]/);
assert.match(transcript, /  • Second\n    line\n    more/);
assert.match(transcript, /    ↳ Ada: First \[link\]/);
assert.match(transcript, /Reaction: 1 reaction with ❤️/);
assert.match(transcript, /  • \[sticker\]/);
assert.match(transcript, /  • Go to \[link\] now/);
assert.match(transcript, /You · 14:02/);
assert.match(transcript, /  • line 1\n    line 2/);
assert.match(transcript, /↳ Look at \[link\]/);
assert(!/secret-|local-|www\.example|ftp:\/\/|https:\/\/|blob:|facebook\.com|999|Coverage:|see who reacted/.test(transcript));
assert(!transcript.includes('source_message_id'));

// Empty and fully captured exports also produce readable output.
const empty = render({items: [], count: 0, exported_at: 'now', partial: false});
assert.match(empty, /^Messenger conversation · 0 messages\nExported: now\n$/);
assert(!empty.includes('Partial export'));
assert(readFileSync(new URL('../extension/build.py', import.meta.url), 'utf8').includes('"txt.js"'));
assert(readFileSync(new URL('../extension/panel.js', import.meta.url), 'utf8').includes('Save TXT'));
console.log('TXT browser extension formatter: passed.');
