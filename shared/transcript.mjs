const urls = /(?:\b(?:https?:\/\/|ftp:\/\/|www\.)|\bblob:)[^\s<>\[\]"']+/gi;
const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(urls, '[link]').trim();
const author = item => item.author || (item.direction === 'outgoing' ? 'You' : 'Unknown');

function describeAttachment(attachment) {
  const kind = clean(attachment.kind || 'attachment');
  const label = clean(attachment.filename || attachment.label);
  return label && label.toLowerCase() !== kind.toLowerCase() ? kind + ': ' + label : kind;
}

export function* txtChunks(archive) {
  const items = archive.messages;
  const byId = items.some(item => item.reply?.messageId) ? new Map(items.map(item => [item.id, item])) : null;
  const title = clean(archive.conversation.name).replace(/\s+/gu, ' ') || 'Messenger conversation';
  yield title + ' · ' + items.length + ' messages\n';
  if (archive.exportedAt) yield 'Exported: ' + archive.exportedAt + '\n';
  if (archive.scan.status !== 'completed') yield 'Partial export — some history may be missing.\n';

  let previousDay = null;
  let previousAuthor = null;
  let previousTime = null;
  for (const item of items) {
    const day = clean(item.date || item.timestamp?.slice(0, 10));
    if (day !== previousDay) {
      if (day) yield '\n── ' + day + ' ──\n';
      previousDay = day;
      previousAuthor = null;
    }
    const sender = clean(author(item));
    const moment = clean(item.time || item.timestamp?.slice(11, 16));
    if (sender !== previousAuthor || moment !== previousTime || !moment) {
      yield '\n' + sender + (moment ? ' · ' + moment : '') + '\n';
    }
    previousAuthor = sender;
    previousTime = moment;

    const message = clean(item.text);
    const attachments = item.attachments.map(describeAttachment);
    if (message) {
      const [first, ...rest] = message.split('\n');
      yield '  • ' + first + '\n';
      for (const part of rest) yield part ? '    ' + part + '\n' : '\n';
    } else {
      const marker = attachments.length ? '[' + attachments.shift() + ']'
        : item.links.length ? '[link]' : '[' + clean(item.type || 'message') + ']';
      yield '  • ' + marker + '\n';
    }
    for (const entry of attachments) yield '    [' + entry + ']\n';

    const target = byId?.get(item.reply?.messageId);
    const replyAuthor = clean(item.reply?.author || (target ? author(target) : ''));
    let quote = clean(item.reply?.text || target?.text).replace(/\n/g, ' ');
    if (quote.length > 120) quote = quote.slice(0, 117).trimEnd() + '...';
    if (replyAuthor || quote) yield '    ↳ ' + (replyAuthor ? replyAuthor + ': ' : '') + quote + '\n';

    for (const reaction of item.reactions) {
      const label = clean(reaction.label || reaction.emoji || reaction.emojis?.join(' '))
        .replace(/;?\s*see who reacted.*$/i, '').trim();
      if (label) yield '    Reaction: ' + label + '\n';
    }
  }
}
