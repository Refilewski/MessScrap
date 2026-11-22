import {csvRow} from './csv.mjs';

export function statistics(archive, {participant, start, end} = {}) {
  const dayMs = 86_400_000;
  const authorOf = item => item.author || (item.direction === 'outgoing' ? 'You' : null);
  const add = (map, key, value = 1) => map.set(key, (map.get(key) || 0) + value);
  const entries = (map, rank = false) => [...map].map(([label, count]) => ({label, count})).sort((a, b) =>
    (rank ? b.count - a.count : 0) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const mean = (sum, count) => count ? sum / count : null;
  const median = array => {
    if (!array.length) return null;
    const ordered = array.sort((a, b) => a - b);
    const mid = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
  };
  const domainOf = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname : null;
    } catch { return null; }
  };

  const lengths = [];
  const responseSamples = [];
  const authors = new Map();
  const days = new Map();
  const weeks = new Map();
  const months = new Map();
  const years = new Map();
  const words = new Map();
  const emojis = new Map();
  const attachmentsByKind = new Map();
  const attachmentsByStatus = new Map();
  const linkDomains = new Map();
  const reactionTypes = new Map();
  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0);

  let totalMessages = 0;
  let totalWords = 0;
  let totalCharacters = 0;
  let responseSum = 0;
  let attachmentCount = 0;
  let linkCount = 0;
  let reactionCount = 0;
  let previous = null;
  const systemTypes = new Set(['system', 'event', 'call', 'unsent']);
  const wordSegmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', {granularity: 'word'}) : null;
  const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', {granularity: 'grapheme'}) : null;
  const emojiPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
  const bodyCache = new Map();
  const weekCache = new Map();

  for (const item of archive.messages) {
    const date = item.timestamp?.slice(0, 10);
    if ((start && (!date || date < start.slice(0, 10))) || (end && (!date || date > end.slice(0, 10)))) continue;
    const author = authorOf(item);
    const selected = !participant || author === participant || (!author && participant === 'Unknown sender');
    if (!systemTypes.has(item.type)) {
      if (date && previous && author && previous.author && author !== previous.author && selected) {
        const elapsed = (Date.parse(item.timestamp) - Date.parse(previous.timestamp)) / 1000;
        if (elapsed > 0 && elapsed <= 86_400) {
          responseSum += elapsed;
          responseSamples.push(elapsed);
        }
      }
      previous = date && author ? {timestamp: item.timestamp, author} : null;
    }
    if (!selected) continue;
    totalMessages++;
    add(authors, author || 'Unknown sender');
    if (date) {
      let weekInfo = weekCache.get(date);
      if (!weekInfo) {
        const midnight = new Date(date + 'T00:00:00.000Z');
        const weekday = midnight.getUTCDay();
        const monday = new Date(midnight.getTime() - ((weekday + 6) % 7) * dayMs).toISOString().slice(0, 10);
        weekInfo = {weekday, monday};
        weekCache.set(date, weekInfo);
      }
      add(days, date);
      add(weeks, weekInfo.monday);
      add(months, date.slice(0, 7));
      add(years, date.slice(0, 4));
      byHour[Number(item.timestamp.slice(11, 13))]++;
      byWeekday[weekInfo.weekday]++;
    }

    if (item.text) {
      let body = bodyCache.get(item.text);
      if (!body) {
        let size = item.text.length;
        // Count code points without allocating one string per character.
        for (const _pair of item.text.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) size--;
        const terms = item.text.normalize('NFKC').toLowerCase();
        const tokens = wordSegmenter ? [] : terms.match(/[\p{L}\p{N}]+/gu) || [];
        if (wordSegmenter) {
          for (const part of wordSegmenter.segment(terms)) {
            if (part.isWordLike) tokens.push(part.segment);
          }
        }
        let symbols = [];
        if (emojiPattern.test(item.text)) {
          symbols = graphemes ? Array.from(graphemes.segment(item.text), part => part.segment).filter(value => emojiPattern.test(value))
            : Array.from(item.text).filter(value => emojiPattern.test(value));
        }
        body = {size, tokens, symbols};
        if (bodyCache.size < 512 && item.text.length <= 2048) bodyCache.set(item.text, body);
      }
      totalCharacters += body.size;
      lengths.push(body.size);
      totalWords += body.tokens.length;
      for (const token of body.tokens) add(words, token);
      for (const symbol of body.symbols) add(emojis, symbol);
    }
    for (const attachment of item.attachments) {
      attachmentCount++;
      add(attachmentsByKind, attachment.kind);
      add(attachmentsByStatus, attachment.status);
    }
    for (const link of item.links) {
      const domain = domainOf(link.url);
      if (!domain) continue;
      linkCount++;
      add(linkDomains, domain);
    }
    for (const reaction of item.reactions) {
      const symbols = reaction.emoji ? [reaction.emoji] : (reaction.emojis || []);
      const key = symbols.length ? symbols.join(' ') : reaction.label;
      const count = reaction.count || (symbols.length === 1 || reaction.author ? 1 : 0);
      if (!count || !key) continue;
      reactionCount += count;
      add(reactionTypes, key, count);
    }
  }

  const daily = entries(days);
  const activityDays = daily.map(item => Date.parse(item.label + 'T00:00:00.000Z') / dayMs);
  let streak = 0;
  let longestStreakDays = activityDays.length ? 0 : null;
  let longestInactivityDays = activityDays.length > 1 ? 0 : null;
  for (let index = 0; index < activityDays.length; index++) {
    const gap = activityDays[index] - activityDays[index - 1];
    streak = gap === 1 ? streak + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, streak);
    if (gap > 1) longestInactivityDays = Math.max(longestInactivityDays, gap - 1);
  }
  return {
    totalMessages,
    totalWords,
    totalCharacters,
    averageMessageLength: mean(totalCharacters, lengths.length),
    medianMessageLength: median(lengths),
    conversationAgeDays: activityDays.length ? activityDays.at(-1) - activityDays[0] : null,
    longestStreakDays,
    longestInactivityDays,
    participants: entries(authors, true).map(({label, count}) => ({
      name: label, count, percentage: 100 * count / totalMessages,
    })),
    periods: {day: daily, week: entries(weeks), month: entries(months), year: entries(years)},
    byHour,
    byWeekday,
    mostActiveDates: entries(days, true).slice(0, 14),
    responseTimes: {
      sampleCount: responseSamples.length,
      averageSeconds: mean(responseSum, responseSamples.length),
      medianSeconds: median(responseSamples),
    },
    words: entries(words, true).slice(0, 30),
    emojis: entries(emojis, true).slice(0, 30),
    attachments: {
      total: attachmentCount,
      byKind: Object.fromEntries(attachmentsByKind),
      byStatus: Object.fromEntries(attachmentsByStatus),
    },
    links: {total: linkCount, domains: entries(linkDomains, true)},
    reactions: {total: reactionCount, types: entries(reactionTypes, true)},
  };
}

export function statisticsCsv(data) {
  const output = [['metric', 'label', 'value']];
  for (const [metric, value] of Object.entries(data)) {
    if (typeof value === 'number' || value === null) output.push([metric, '', value]);
  }
  for (const item of data.participants) {
    output.push(['messages_by_participant', item.name, item.count], ['participant_percentage', item.name, item.percentage]);
  }
  for (const [period, values] of Object.entries(data.periods)) {
    for (const {label, count} of values) output.push(['messages_per_' + period, label, count]);
  }
  for (const [metric, counts] of [['messages_by_hour', data.byHour], ['messages_by_weekday', data.byWeekday]]) {
    counts.forEach((count, index) => output.push([metric, index, count]));
  }
  for (const [metric, values] of [
    ['most_active_date', data.mostActiveDates], ['word', data.words], ['emoji', data.emojis],
    ['link_domain', data.links.domains], ['reaction_type', data.reactions.types],
  ]) {
    for (const {label, count} of values) output.push([metric, label, count]);
  }
  for (const [key, value] of Object.entries(data.responseTimes)) output.push(['response_times', key, value]);
  for (const [metric, value] of [
    ['attachment_total', data.attachments.total], ['link_total', data.links.total], ['reaction_total', data.reactions.total],
  ]) output.push([metric, '', value]);
  for (const [metric, map] of [['attachment_kind', data.attachments.byKind], ['attachment_status', data.attachments.byStatus]]) {
    for (const [key, count] of Object.entries(map)) output.push([metric, key, count]);
  }
  return output.map(csvRow).join('');
}
