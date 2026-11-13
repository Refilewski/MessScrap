// Human-readable TXT export. Keep IDs and URLs in JSON, not in the transcript.
const txtUrlPattern = /(?:\b(?:https?:\/\/|ftp:\/\/|www\.)|\bblob:)[^\s<>\[\]"']+/gi;

function txtClean(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(txtUrlPattern, '[link]').trim();
}

function txtDay(item) {
  if (item.date) return item.date;
  return (item.timestamp || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] || '';
}

function txtTime(item) {
  if (item.time) return item.time;
  return (item.timestamp || '').match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/)?.[1] || '';
}

function txtAttachment(attachment) {
  const kind = txtClean(attachment.kind || 'attachment');
  const label = txtClean(attachment.filename || attachment.label);
  return label && label.toLowerCase() !== kind.toLowerCase() ? kind + ': ' + label : kind;
}

function formatTxt(payload) {
  const items = payload.items || [];
  const byIndex = new Map(items.map(item => [item.index, item]));
  const lines = [
    'Messenger conversation · ' + (payload.count ?? items.length) + ' messages',
    'Exported: ' + payload.exported_at,
  ];
  if (payload.partial) lines.push('Partial export — some history may be missing.');

  let previousDay = null;
  let previousGroup = null;
  for (const item of items) {
    const day = txtClean(txtDay(item));
    if (day !== previousDay) {
      if (day) lines.push('', '── ' + day + ' ──');
      previousDay = day;
      previousGroup = null;
    }

    const author = txtClean(item.author || (item.direction === 'me' ? 'You' : 'Unknown'));
    const moment = txtClean(txtTime(item));
    const group = JSON.stringify([day, author, moment]);
    if (group !== previousGroup || !moment) lines.push('', author + (moment ? ' · ' + moment : ''));
    previousGroup = group;

    const message = txtClean(item.text);
    const attachments = (item.attachments || []).map(txtAttachment);
    if (message) {
      const [first, ...rest] = message.split('\n');
      lines.push('  • ' + first);
      for (const part of rest) lines.push(part ? '    ' + part : '');
    } else {
      const marker = attachments.length ? '[' + attachments.shift() + ']'
        : item.links?.length ? '[link]' : '[' + txtClean(item.message_type || 'message') + ']';
      lines.push('  • ' + marker);
    }
    for (const attachment of attachments) lines.push('    [' + attachment + ']');

    const reply = item.reply_to || {};
    const target = byIndex.get(reply.target_index);
    const replyAuthor = txtClean(reply.author || target?.author ||
      (target ? (target.direction === 'me' ? 'You' : 'Unknown') : ''));
    let quote = txtClean(reply.text || target?.text).replace(/\n/g, ' ');
    if (quote.length > 120) quote = quote.slice(0, 117).trimEnd() + '...';
    if (replyAuthor || quote) lines.push('    ↳ ' + (replyAuthor ? replyAuthor + ': ' : '') + quote);

    for (const reaction of item.reactions || []) {
      const label = txtClean(reaction.label).replace(/;?\s*see who reacted.*$/i, '').trim();
      if (label) lines.push('    Reaction: ' + label);
    }
  }
  return lines.join('\n') + '\n';
}
