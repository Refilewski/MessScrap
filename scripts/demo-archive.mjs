import {createArchive} from '../shared/archive.mjs';

const people = ['Avery Chen', 'Maya Torres', 'Theo Park'];
const snippets = [
  'I saved the route. We can take the footbridge if the trail is busy.',
  'That sounds good. I’ll bring the camera and a spare battery.',
  'I can be there by nine ☀️',
  'Meet at the station entrance?',
  'Perfect. I’ll bring coffee for the train.',
  'Here’s the trail map https://example.org/weekend/route',
  'Let’s check the weather the night before.',
  'The forecast looks clear until the afternoon.',
  'I found a little bakery near the finish.',
  'Count me in 🥐',
  'Wonderful. See you Saturday!',
  'I added the coordinates to the notes.',
];

export function demoArchive(count = 4821) {
  const start = Date.UTC(2025, 0, 4, 15);
  const dailyMessages = Math.max(17, Math.ceil(count / 1500));
  return createArchive({
    conversation: {
      id: 'synthetic-weekend-plans',
      name: 'Weekend Plans',
      participants: people.map(name => ({name})),
    },
    scan: {status: 'partial', reason: 'Synthetic demonstration data'},
    exportedAt: '2026-11-21T21:42:00.000Z',
    messages: Array.from({length: count}, (_, index) => {
      const speaker = Math.floor((index * 7 + index % 5) / 7) % people.length;
      const snippet = Math.floor(index * 5 + index / 13) % snippets.length;
      const batch = Math.floor(index / dailyMessages);
      const day = batch + Math.floor(batch / 8) + Math.floor(batch / 17);
      const clock = (batch % 8) * 3600000 + (index % dailyMessages) * Math.floor(3_600_000 / dailyMessages);
      const timestamp = new Date(start + day * 86400000 + clock).toISOString();
      const note = index % 3 === 0 ? ' I put a note about this in plan ' + (index + 1) + '.' : '';
      return {
        id: 'demo-' + index,
        nativeId: 'synthetic-' + index,
        author: people[speaker],
        direction: speaker === 0 ? 'outgoing' : 'incoming',
        text: snippets[snippet] + note,
        timestamp,
        type: index % 61 === 0 ? 'image' : 'text',
        reactions: index % 19 === 0 ? [{emoji: '👍', author: people[(speaker + 1) % people.length]}] : [],
        attachments: index % 61 === 0 ? [{
          kind: 'image', filename: 'trail-photo.png', mimeType: 'image/png',
        }] : [],
      };
    }),
  });
}
