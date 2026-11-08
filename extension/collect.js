class History {
  entries = new Map();
  first = null;
  last = null;

  addWindow(records, direction) {
    const keys = records.map(item => item.source_message_id
      ? 'source:' + item.source_message_id
      : 'node:' + item.node_id + ':' + item.text);
    const anchor = keys.map(key => this.entries.get(key)).find(Boolean);
    let previous = anchor ? anchor.previous : (direction > 0 ? this.last : null);
    let added = 0;
    for (let i = 0; i < records.length; i++) {
      const key = keys[i];
      const record = records[i];
      let entry = this.entries.get(key);
      if (entry) {
        mergeObservation(entry.record, record);
      } else {
        const next = previous ? previous.next : this.first;
        entry = {record, previous, next};
        this.entries.set(key, entry);
        if (previous) previous.next = entry;
        else this.first = entry;
        if (next) next.previous = entry;
        else this.last = entry;
        added++;
      }
      previous = entry;
    }
    return added;
  }

  toArray() {
    const records = [];
    for (let entry = this.first; entry; entry = entry.next) records.push(entry.record);
    return records;
  }
}

function mergeObservation(existing, record) {
  for (const [field, value] of Object.entries(record)) {
    if (field === 'node_id' || !value || (value === 'unknown' && ['direction', 'message_type'].includes(field))) continue;
    if (Array.isArray(value)) {
      const previous = existing[field] || [];
      const keys = new Set(previous.map(item => JSON.stringify(item)));
      for (const item of value) {
        const key = JSON.stringify(item);
        if (!keys.has(key)) {
          previous.push(item);
          keys.add(key);
        }
      }
      existing[field] = previous;
    } else if (field === 'avatar' || field === 'reply_to') {
      const available = Object.fromEntries(Object.entries(value).filter(([, data]) => data));
      existing[field] = {...existing[field], ...available};
    } else {
      existing[field] = value;
    }
  }
}

function makePayload(history, sourceUrl, coverage, interrupted) {
  const items = history.toArray().map((raw, offset) => {
    const {node_id, structured, avatar, reply_to, ...record} = raw;
    return {
      index: offset + 1,
      message_id: 'local-' + (offset + 1),
      ...record,
      avatar: {url: null, alt: null, ...avatar},
      reply_to: {
        source_message_id: null, label: null, author: null, text: null,
        date: null, time: null, target_index: null, target_message_id: null,
        ...reply_to,
      },
    };
  });
  const bySource = new Map(items.filter(item => item.source_message_id).map(item => [item.source_message_id, item]));
  const byText = new Map();
  const byAuthor = new Map();
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  for (const item of items) {
    const reply = item.reply_to;
    const quote = normalize(reply.text);
    const author = normalize(reply.author).toLowerCase();
    const target = reply.source_message_id
      ? bySource.get(reply.source_message_id)
      : author ? byAuthor.get(JSON.stringify([quote, author])) : byText.get(quote);
    if (target && target !== item) {
      reply.target_index = target.index;
      reply.target_message_id = target.message_id;
    }
    const text = normalize(item.text);
    if (!text) continue;
    const key = JSON.stringify([text, normalize(item.author).toLowerCase()]);
    byText.set(text, byText.has(text) ? null : item);
    byAuthor.set(key, byAuthor.has(key) ? null : item);
  }

  return {
    exported_at: new Date().toISOString(),
    source_url: sourceUrl,
    partial: interrupted || Object.values(coverage).some(state => state !== 'edge_stable'),
    interrupted,
    coverage,
    count: items.length,
    items,
  };
}

async function collectChat(sourceUrl, onProgress, signal, options = {}) {
  const limit = options.limit ?? 5000;
  const stableRounds = options.stableRounds ?? 10;
  const pause = options.pause ?? (direction => direction < 0 ? 450 : 250);
  const history = new History();
  const coverage = {newer: 'not_started', older: 'not_started'};
  let root = null;
  let error = null;

  try {
    for (const direction of [1, -1]) {
      if (signal.aborted) break;
      const phase = direction > 0 ? 'newer' : 'older';
      let previousEdge = null;
      let stable = 0;
      coverage[phase] = 'in_progress';
      for (let round = 1; round <= limit; round++) {
        if (signal.aborted) break;
        if (threadUrl(location.href) !== sourceUrl) throw new Error('Rozmowa została przełączona.');
        if (!root?.isConnected) root = findContainer();
        const result = root ? readMessages(root, false, false, false, 0) : null;
        if (!result?.records.length && history.entries.size === 0) {
          throw new Error('Nie wykryto wiadomości. Odblokuj rozmowę lub włącz widok komputerowy i spróbuj ponownie.');
        }

        const added = history.addWindow(result?.records || [], direction);
        const state = root ? scrollMessages(root, direction, round < limit) : null;
        const edge = state?.atEdge && !state.loading
          ? [state.before, state.height, state.viewport].join(':')
          : null;
        stable = !added && edge && edge === previousEdge ? stable + 1 : 0;
        previousEdge = edge;
        onProgress(history.entries.size, phase);
        if (stable >= stableRounds) {
          coverage[phase] = 'edge_stable';
          break;
        }
        if (round === limit) coverage[phase] = 'round_limit';
        else await new Promise(resolve => setTimeout(resolve, pause(direction)));
      }
      if (signal.aborted) coverage[phase] = 'interrupted';
    }
  } catch (failure) {
    error = failure.message || 'Błąd odczytu rozmowy.';
  }

  return {payload: makePayload(history, sourceUrl, coverage, signal.aborted), error};
}
