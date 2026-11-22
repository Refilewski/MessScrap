import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  archiveChunks, archiveFromCapture, conversationId, createArchive, formatArchive, importArchive, mergeArchives, publicArchive,
  safeFilename, safeLink, safeLocalPath, searchMessages, statistics, statisticsCsv, validateArchive,
} from '../shared/archive.mjs';

const original = 'https://www.facebook.com/messages/e2ee/t/301';
const conversation = {id: '301', name: 'Synthetic conversation', participants: ['Ada', 'Bao']};
const when = (day, hour = '12:00') => '2026-09-' + day + 'T' + hour + ':00.000Z';
const item = (nativeId, text, extra) => ({nativeId, author: 'Ada', direction: 'incoming', text, ...extra});
const archive = (messages, scan = {status: 'partial'}) => createArchive({
  conversation, sourceUrl: original, messages, scan, exportedAt: when('09'),
});

test('normalizes legacy threads, chronologies and references without losing duplicate text', () => {
  const migrated = importArchive({
    count: 5,
    source_url: original + '?ephemeral=ignored',
    items: [
      {source_message_id: 'id2', text: 'repeat', author: 'Ada', timestamp: when('02')},
      {source_message_id: 'id1', text: 'repeat', author: 'Ada', timestamp: when('01')},
      {source_message_id: 'id3', text: 'response', timestamp: when('03'), reply_to: {source_message_id: 'id2'}},
      {source_message_id: 'id4', text: 'fallback', timestamp: when('04'), reply_to: {text: 'repeat'}},
      {text: 'undated', timestamp: '2026-09-05T10:00', date: 'Saturday'},
    ],
  });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.conversation.id, '301');
  assert.equal(migrated.sourceUrl, original);
  assert.equal(migrated.scan.status, 'partial');
  assert.equal(migrated.scan.earliest, when('01'));
  assert.deepEqual(migrated.messages.map(message => message.nativeId), ['id1', 'id2', 'id3', 'id4', null]);
  assert.equal(migrated.messages[2].reply.messageId, migrated.messages[1].id);
  assert.equal(migrated.messages[3].reply.messageId, null);
  assert.equal(migrated.messages[4].timestamp, null);
  assert.equal(validateArchive(migrated).valid, true);
  assert.deepEqual(importArchive(formatArchive(migrated, 'json')), migrated);
  assert.equal(conversationId('https://www.messenger.com/t/301#foo'), '301');
  assert.equal(conversationId('https://evil.invalid/messages/t/301'), null);
  assert.throws(() => createArchive({conversation, sourceUrl: original.replace('301', '302')}), /Conversation ID differs/);
});

test('validates archives with indexed errors and keeps completion labels conservative', () => {
  assert.equal(archive([], {status: 'completed'}).scan.status, 'partial');
  const damaged = archive([item('id', 'message', {timestamp: when('01'), attachments: [{kind: 'file'}]})]);
  Object.assign(damaged.messages[0].attachments[0], {path: 'media/../file', size: -1, sha256: 'bogus'});
  damaged.messages[0].links = [{url: 'javascript:1'}];
  const result = validateArchive(damaged);
  assert.equal(result.valid, false);
  assert(result.errors.some(line => line.includes('messages[0].attachments[0].path')));
  assert(result.errors.some(line => line.includes('messages[0].attachments[0].size')));
  assert(result.errors.some(line => line.includes('messages[0].attachments[0].sha256')));
  assert(result.errors.some(line => line.includes('messages[0].links[0]')));
  assert.throws(() => importArchive(damaged), /safe relative path/);
  assert.throws(() => importArchive('{"schemaVersion":8}'), /Unsupported archive schema version 8/);
  assert.throws(() => importArchive('{broken)'), /Invalid JSON/);
  assert.throws(() => importArchive({items: [{author: 'Ada'}]}), /Legacy message at index 0/);
  assert.throws(() => archive([item('same', 'a'), item('same', 'b')]), /Duplicate native/);
});

test('migrates official Messenger JSON without inventing directions or media', () => {
  const data = importArchive({
    title: 'Synthetic official group',
    thread_path: 'messages/inbox/group_123',
    participants: [{name: 'Ala'}, {name: 'Ren'}],
    messages: [
      {sender_name: 'Ren', timestamp_ms: Date.parse(when('02')), photos: [{uri: 'messages/inbox/group_123/photo.jpg'}]},
      {sender_name: 'Ala', timestamp_ms: Date.parse(when('01')), content: 'Hej 🇵🇱',
        reactions: [{actor: 'Ren', reaction: '👍'}]},
    ],
  });
  assert.deepEqual(data.messages.map(message => message.author), ['Ala', 'Ren']);
  assert.equal(data.messages[0].direction, 'unknown');
  assert.equal(data.messages[0].reactions[0].emoji, '👍');
  assert.equal(data.messages[1].attachments[0].path, 'messages/inbox/group_123/photo.jpg');
  assert.equal(data.messages[1].attachments[0].status, 'archived');
  assert.throws(() => importArchive({participants: [], title: 'Invalid', messages: [{}]}), /sender_name and timestamp_ms/);
});

test('removes transient media references from exports and JSON imports', () => {
  const sourceUrl = 'https://scontent.fbcdn.net/media?secret=temporary';
  const previewSourceUrl = 'blob:https://www.messenger.com/session-id';
  const fixture = archive([item('native-xyz', 'Disk photo', {
    links: [{url: sourceUrl}],
    attachments: [{
      kind: 'photo', sourceUrl, previewSourceUrl, inlineKey: 'local-blob',
      previewInlineKey: 'local-preview', path: 'media/images/photo.jpg', sha256: 'a'.repeat(64),
    }],
  })]);
  assert.equal(fixture.messages[0].attachments[0].sourceUrl, sourceUrl);
  assert.deepEqual(fixture.messages[0].links, []);
  const json = formatArchive(fixture, 'json');
  assert(!/temporary|session-id|local-blob|local-preview/.test(json));
  assert.deepEqual(JSON.parse(json), publicArchive(fixture));
  const imported = importArchive(fixture);
  assert.equal(imported.messages[0].attachments[0].path, 'media/images/photo.jpg');
  assert.equal(imported.messages[0].attachments[0].sha256, 'a'.repeat(64));
  assert.equal(imported.messages[0].attachments[0].sourceUrl, undefined);
  assert.equal(importArchive({
    source_url: original, items: [{text: 'legacy', attachments: [{url: sourceUrl}]}],
  }).messages[0].attachments[0].sourceUrl, undefined);
});

test('exports readable text without internal IDs and neutralizes spreadsheet formulas', () => {
  const fixture = archive([
    item('native-xyz', 'Open https://example.org/private\r\nAnd a second line', {
      date: 'Tuesday', time: '4:00am',
      reactions: [{label: '1 reaction with ❤️; see who reacted'}],
    }),
    item('native-abc', '\t =HYPERLINK("bad")', {
      author: 'Bao', date: 'Tuesday', time: '4:01am',
      reply: {nativeId: 'native-xyz'},
    }),
  ]);
  const txt = formatArchive(fixture, 'txt');
  assert.match(txt, /── Tuesday ──\n\nAda · 4:00am/);
  assert.match(txt, /Open \[link\]\n    And a second line/);
  assert.match(txt, /↳ Ada: Open \[link\] And a second line/);
  assert.match(txt, /Reaction: 1 reaction with ❤️$/m);
  assert.doesNotMatch(txt, /native-xyz|local-1|https:|example\.org|see who reacted/);
  assert.match(formatArchive(fixture, 'csv'), /"'\t =HYPERLINK\(""bad""\)"/);
  for (const format of ['json', 'txt', 'csv']) {
    assert.equal([...archiveChunks(fixture, format)].join(''), formatArchive(fixture, format));
  }
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('https://username:secret@example.org/'), null);
  for (const path of ['media/%2e%2e/a', '../a', '/a', 'media\\..\\a', 'C:/a', 'media/NUL.txt']) {
    assert.equal(safeLocalPath(path), null, path);
  }
  assert.equal(safeLocalPath('media/notes/photo 2026.jpg'), 'media/notes/photo 2026.jpg');
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert(!safeFilename('../unsafe/<filename>.txt').includes('/'));
});

test('rejects scan payloads with a mismatched thread or message count', () => {
  const payload = {
    conversation, source_url: original, count: 1, items: [{text: 'capture'}], scan: {status: 'partial'},
    coverage: {older: 'round_limit'},
  };
  assert.deepEqual(archiveFromCapture(payload).scan.coverage, {older: 'round_limit'});
  assert.throws(() => archiveFromCapture({...payload, source_url: original.replace('301', '302')}), /verified Messenger/);
  assert.throws(() => archiveFromCapture({...payload, count: 0}), /verified Messenger/);
});

test('combines native identity and contextual overlap while preserving uncertainty and conflicts', () => {
  const before = archive([
    item('a', 'native overlap', {timestamp: when('01')}),
    item(null, 'distinct fallback', {timestamp: when('02')}),
    item('b', 'old text', {timestamp: when('03')}),
    item('c', 'before edit', {timestamp: when('04')}),
  ]);
  const newer = archive([
    item('a', 'native overlap', {timestamp: when('01')}),
    item(null, 'distinct fallback', {timestamp: when('02')}),
    item('b', 'conflicting change', {timestamp: when('03'), attachments: [{path: 'media/new.jpg'}]}),
    item('c', 'after edit', {timestamp: when('04'), edited: true, attachments: [{path: 'media/new.jpg'}]}),
    item('d', 'newer', {timestamp: when('05'), reply: {nativeId: 'c'}}),
  ]);
  const {archive: merged, report} = mergeArchives(before, newer);
  assert.deepEqual(report, {added: 1, updated: 1, unchanged: 2, conflicting: 1, conflictIds: ['local-3'], uncertain: true});
  assert.equal(merged.messages[2].text, 'old text');
  assert.equal(merged.messages[2].attachments.length, 0);
  assert.equal(merged.messages[3].text, 'after edit');
  assert.equal(merged.messages[4].reply.messageId, merged.messages[3].id);
  assert.equal(merged.scan.status, 'partial');
  assert.equal(before.messages[3].text, 'before edit');
  assert.equal(validateArchive(merged).valid, true);
  assert.throws(() => mergeArchives(before, createArchive({conversation: {id: 'different'}})), /different conversations/);

  const ambiguous = archive([
    item(null, 'same', {timestamp: when('01')}),
    item(null, 'same', {timestamp: when('01')}),
  ]);
  assert.equal(mergeArchives(ambiguous, ambiguous).archive.messages.length, 4);
  const undatedBefore = archive([item('1', 'first'), item('3', 'third')]);
  const undatedNext = archive([item('1', 'first'), item('2', 'second'), item('3', 'third')]);
  assert.deepEqual(mergeArchives(undatedBefore, undatedNext).archive.messages.map(message => message.text), [
    'first', 'second', 'third',
  ]);
});

test('computes actual distributions, Unicode metrics and response samples', () => {
  const fixture = archive([
    item('a', 'Hi 👋', {timestamp: when('01')}),
    item('b', 'Hi there', {author: 'Bao', timestamp: when('01', '12:01')}),
    item('event', '', {author: null, type: 'system', timestamp: when('02')}),
    item('c', 'Bonjour', {
      timestamp: when('05'), links: [{url: 'https://example.net/a'}],
      attachments: [{kind: 'file'}], reactions: [{emoji: '👍', count: 2}],
    }),
    item('d', '終わり', {timestamp: null}),
  ]);
  const stats = statistics(fixture);
  assert.equal(stats.totalMessages, 5);
  assert.equal(stats.totalCharacters, 22);
  assert.equal(stats.conversationAgeDays, 4);
  assert.equal(stats.longestStreakDays, 2);
  assert.equal(stats.longestInactivityDays, 2);
  assert.deepEqual(stats.responseTimes, {sampleCount: 1, averageSeconds: 60, medianSeconds: 60});
  assert.deepEqual(stats.participants[0], {name: 'Ada', count: 3, percentage: 60});
  assert.deepEqual(stats.emojis, [{label: '👋', count: 1}]);
  assert.deepEqual(stats.links.domains, [{label: 'example.net', count: 1}]);
  assert.deepEqual(stats.reactions.types, [{label: '👍', count: 2}]);
  assert.equal(stats.attachments.byKind.file, 1);
  assert.equal(stats.byHour[12], 4);
  assert.equal(statistics(fixture, {start: '2026-09-02', participant: 'Ada'}).totalMessages, 1);
  assert.equal(statistics(fixture, {participant: 'Bao'}).responseTimes.sampleCount, 1);
  assert.equal(statistics(archive([])).conversationAgeDays, null);
  assert.equal(statistics(archive([])).averageMessageLength, null);
  assert.match(statisticsCsv(stats), /"response_times","averageSeconds","60"/);
  assert.equal(searchMessages(fixture, 'ADA 👋').length, 1);
});
