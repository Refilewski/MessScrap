function observationKey(record) {
  const clean = value => typeof value === 'string' ? value.normalize('NFC').trim() : '';
  const path = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'blob:' ? '' : url.hostname + url.pathname;
    } catch {
      return '';
    }
  };
  return JSON.stringify([
    clean(record.author), clean(record.direction), clean(record.timestamp || record.datetime_raw),
    clean(record.date), clean(record.time), clean(record.text), clean(record.message_type),
    (record.attachments || []).map(item => [item.kind, item.filename, item.label, path(item.url)]),
    clean(record.reply_to?.text), clean(record.reply_to?.author), Boolean(record.forwarded),
  ]);
}

function mergeObservation(existing, record) {
  for (const [field, value] of Object.entries(record)) {
    if (['node_id', 'id', 'height', 'position'].includes(field) || value == null || value === ''
      || (value === 'unknown' && ['direction', 'message_type'].includes(field))) continue;
    if (Array.isArray(value)) {
      const previous = existing[field] || [];
      const keyFor = field === 'attachments' ? item => JSON.stringify([
        item.kind, item.filename, item.label, item.local_path,
      ]) : item => JSON.stringify(item);
      const keys = new Map(previous.map((item, index) => [keyFor(item), index]));
      const occurrences = new Map();
      existing[field] = previous.slice();
      for (const item of value) {
        const key = keyFor(item);
        const occurrence = (occurrences.get(key) || 0) + 1;
        occurrences.set(key, occurrence);
        const index = keys.get(key);
        if (index !== undefined && occurrence === 1) {
          if (field === 'attachments') {
            const old = previous[index];
            // Compare URLs without their expiring query strings. Do not join
            // different attachments that happen to have the same label.
            const pathname = url => url?.split(/[?#]/)[0];
            if (!old.url || !item.url || pathname(old.url) === pathname(item.url)) {
              existing[field][index] = {...old, ...Object.fromEntries(
                Object.entries(item).filter(([, data]) => data != null && data !== ''))};
              continue;
            }
          } else continue;
        }
        existing[field].push(item);
      }
    } else if (field === 'avatar' || field === 'reply_to') {
      const available = Object.fromEntries(Object.entries(value).filter(([, data]) => data));
      existing[field] = {...existing[field], ...available};
    } else {
      existing[field] = value;
    }
  }
}

class History {
  bySource = new Map();
  byFingerprint = new Map();
  first = null;
  last = null;
  window = [];
  view = null;
  size = 0;
  nextId = 0;
  attachments = 0;
  earliest = null;
  latest = null;
  participants = new Set();
  gaps = 0;
  uncertain = 0;
  resumed = false;

  constructor(seed = []) {
    for (const record of seed) {
      const ordinal = /^local-(\d+)$/.exec(record.id || record.message_id);
      if (ordinal) this.nextId = Math.max(this.nextId, Number(ordinal[1]));
    }
    for (const record of seed) {
      this.insert(record, record.observation_key || observationKey(record), this.last, record.id || record.message_id);
    }
    this.resumed = seed.length > 0;
  }

  insert(record, key, previous, id = null) {
    const next = previous ? previous.next : this.first;
    const entry = {record: {...record, id: id || 'local-' + ++this.nextId}, key, previous, next};
    if (previous) previous.next = entry;
    else this.first = entry;
    if (next) next.previous = entry;
    else this.last = entry;
    if (record.source_message_id) this.bySource.set(record.source_message_id, entry);
    this.byFingerprint.set(key, this.byFingerprint.has(key) ? null : entry);
    this.size++;
    this.attachments += record.attachments?.length || 0;
    this.observe(record);
    return entry;
  }

  observe(record) {
    if (record.author) this.participants.add(record.author);
    if (record.direction === 'me') this.participants.add(record.sender || 'You');
    const timestamp = observationTimestamp(record);
    if (timestamp == null) return;
    if (this.earliest === null || timestamp < this.earliest) this.earliest = timestamp;
    if (this.latest === null || timestamp > this.latest) this.latest = timestamp;
  }

  addWindow(records, direction, view = null) {
    if (!records.length) return 0;
    const observations = records.map(record => {
      const key = observationKey(record);
      return {record, key, seen: this.byFingerprint.has(key), match: this.bySource.get(record.source_message_id)};
    });
    const claimed = new Set(observations.map(item => item.match).filter(Boolean));
    const canMatch = (item, entry) => entry && !claimed.has(entry) && item.key === entry.key
      && !(item.record.source_message_id && entry.record.source_message_id
        && item.record.source_message_id !== entry.record.source_message_id);
    const setMatch = (item, entry) => {
      item.match = entry;
      claimed.add(entry);
    };
    const sameView = view != null && view === this.view
      && observations.length === this.window.length;
    if (sameView && observations.every((item, index) => item.match
      ? item.match === this.window[index] : canMatch(item, this.window[index]))) {
      // Scroll geometry and the ordered window both agree, regardless of
      // whether React recreated the DOM nodes.
      observations.forEach((item, index) => {
        if (!item.match) setMatch(item, this.window[index]);
      });
    }

    // A uniquely occurring fingerprint can anchor a missing-ID row only
    // when a distinct adjoining row supports the same alignment.
    for (let index = 0; index < observations.length; index++) {
      const item = observations[index];
      if (item.match) continue;
      const candidate = this.byFingerprint.get(item.key);
      if (!canMatch(item, candidate)) continue;
      const adjacent = [[observations[index - 1], candidate.previous],
        [observations[index + 1], candidate.next]];
      if (adjacent.some(([neighbor, entry]) => neighbor && entry && (neighbor.match === entry
        || (!neighbor.match && neighbor.key !== item.key && this.byFingerprint.get(neighbor.key) === entry
          && canMatch(neighbor, entry))))) setMatch(item, candidate);
    }

    // Fill repeated rows in a run only when matches bound both ends and the
    // gap contains exactly the same number and sequence of observations.
    let left = -1;
    for (let right = 0; right < observations.length; right++) {
      if (!observations[right].match) continue;
      if (left >= 0 && right > left + 1) {
        const between = [];
        let entry = observations[left].match.next;
        for (let offset = left + 1; offset < right && canMatch(observations[offset], entry); offset++) {
          between.push(entry);
          entry = entry.next;
        }
        if (between.length === right - left - 1 && entry === observations[right].match) {
          between.forEach((match, offset) => setMatch(observations[left + offset + 1], match));
        }
      }
      left = right;
    }

    // Expand an anchor over matching adjacent rows at the window edges.
    // A repeated fingerprint without a positional neighbor is ambiguous.
    const firstAnchor = observations.findIndex(item => item.match);
    const lastAnchor = observations.findLastIndex(item => item.match);
    for (const [anchor, step, edge] of [[firstAnchor, -1, 'previous'], [lastAnchor, 1, 'next']]) {
      if (anchor < 0) continue;
      let entry = observations[anchor].match[edge];
      for (let index = anchor + step; index >= 0 && index < observations.length; index += step) {
        const item = observations[index];
        if (!canMatch(item, entry) || this.byFingerprint.get(item.key) !== entry
          || !item.record.author || observationTimestamp(item.record) === null) break;
        setMatch(item, entry);
        entry = entry[edge];
      }
    }

    const anchor = observations.find(item => item.match)?.match;
    if (!anchor && this.size) this.gaps++;
    let previous = anchor ? anchor.previous : (direction > 0 ? this.last : null);
    let added = 0;
    for (const item of observations) {
      let entry = item.match || this.bySource.get(item.record.source_message_id);
      if (entry) {
        const count = entry.record.attachments?.length || 0;
        mergeObservation(entry.record, item.record);
        this.attachments += (entry.record.attachments?.length || 0) - count;
        this.observe(entry.record);
        if (item.record.source_message_id) this.bySource.set(item.record.source_message_id, entry);
      } else {
        if (item.seen && !item.record.source_message_id) this.uncertain++;
        entry = this.insert(item.record, item.key, previous);
        added++;
      }
      item.match = entry;
      previous = entry;
    }
    this.window = observations.map(item => item.match);
    this.view = view;
    return added;
  }

  toArray() {
    const records = [];
    for (let entry = this.first; entry; entry = entry.next) records.push(entry.record);
    return records;
  }
}

function observationTimestamp(record) {
  const timestamp = record.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const ms = Math.abs(timestamp) < 1e11 ? timestamp * 1000 : timestamp;
    return Math.abs(ms) <= 8.64e15 ? ms : null;
  }
  if (typeof timestamp !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) return null;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

function makePayload(history, conversation, coverage, scan, {checkpoint = false} = {}) {
  const items = history.toArray().map((raw, offset) => {
    const {node_id, structured, observation_key, avatar, reply_to, ...record} = raw;
    if (checkpoint) {
      record.accessibility_label = null;
      record.observation_key = observation_key || observationKey(record);
      record.attachments = (record.attachments || []).map(({url: _url, preview_url: _preview,
        inline_key: _inline, preview_inline_key: _previewInline, ...attachment}) => attachment);
    }
    return {
      index: offset + 1,
      message_id: record.id,
      ...record,
      avatar: checkpoint ? null : avatar,
      reply_to: reply_to ? {...reply_to, target_index: null, target_message_id: null} : null,
    };
  });
  const bySource = new Map(items.filter(item => item.source_message_id).map(item => [item.source_message_id, item]));
  const byText = new Map();
  const byAuthor = new Map();
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  for (const item of items) {
    const text = normalize(item.text);
    if (!text) continue;
    const key = JSON.stringify([text, normalize(item.author).toLowerCase()]);
    byText.set(text, byText.has(text) ? null : item);
    byAuthor.set(key, byAuthor.has(key) ? null : item);
  }
  for (const item of items) {
    const reply = item.reply_to;
    if (!reply) continue;
    const quote = normalize(reply.text);
    const author = normalize(reply.author).toLowerCase();
    const target = reply.source_message_id ? bySource.get(reply.source_message_id)
      : author ? byAuthor.get(JSON.stringify([quote, author])) : byText.get(quote);
    if (target?.index < item.index) {
      reply.target_index = target.index;
      reply.target_message_id = target.message_id;
    }
  }

  const {diagnostics, ...archivedScan} = scan;
  return {
    ...(checkpoint ? {checkpoint_version: 1} : {}),
    exported_at: new Date().toISOString(),
    source_url: conversation.sourceUrl,
    conversation: {id: conversation.id, sourceUrl: conversation.sourceUrl, name: conversation.name,
      participants: scan.conversation.participants, avatar: checkpoint ? null : conversation.avatar},
    partial: scan.status !== 'completed',
    interrupted: scan.status === 'cancelled',
    coverage: {...coverage},
    scan: {...archivedScan, conversation: undefined},
    count: items.length,
    items,
  };
}

function checkpointSeed(checkpoint, conversation) {
  if (!checkpoint) return [];
  if (checkpoint.conversation?.id !== conversation.id || threadId(checkpoint.source_url) !== conversation.id) {
    throw new Error('Checkpoint belongs to a different conversation.');
  }
  if (checkpoint.checkpoint_version !== 1 || !Array.isArray(checkpoint.items) || checkpoint.count !== checkpoint.items.length) {
    throw new Error('Checkpoint message count is invalid.');
  }
  const ids = new Set();
  const nativeIds = new Set();
  for (const record of checkpoint.items) {
    const id = record?.id || record?.message_id;
    const native = record?.source_message_id;
    if (typeof id !== 'string' || ids.has(id) || typeof record.text !== 'string'
      || (native != null && (typeof native !== 'string' || nativeIds.has(native)))
      || (record.observation_key != null && typeof record.observation_key !== 'string')
      || (record.attachments != null && (!Array.isArray(record.attachments)
        || record.attachments.some(item => !item || typeof item !== 'object')))) {
      throw new Error('Checkpoint contains invalid message records or identifiers.');
    }
    if (native) nativeIds.add(native);
    ids.add(id);
  }
  return checkpoint.items;
}


function checkpointVerifier(records) {
  const native = new Map();
  const fingerprints = new Map();
  const available = record => observationTimestamp(record) !== null && (record.author || record.sender);
  for (const [index, record] of records.entries()) {
    const key = record.observation_key || observationKey(record);
    if (record.source_message_id) native.set(record.source_message_id, key);
    if (available(record)) fingerprints.set(key, fingerprints.has(key) ? null : index);
  }
  const matchingNative = new Set();
  return observed => {
    let previous = null;
    let run = 0;
    for (const record of observed) {
      const key = observationKey(record);
      if (native.has(record.source_message_id)) {
        matchingNative.add(record.source_message_id);
        if (matchingNative.size >= 2 || (native.size === 1 && native.get(record.source_message_id) === key)) return true;
      }
      const match = available(record) ? fingerprints.get(key) : null;
      run = match == null ? 0 : previous != null && match === previous + 1 ? run + 1 : 1;
      if (run >= 3) return true;
      previous = match;
    }
    return false;
  };
}

function scanDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, {once: true});
  });
}

function confirmedBoundary(pane, root, direction) {
  const edge = direction < 0 ? 'start' : 'end';
  const attributes = direction < 0
    ? '[data-has-more-before="false"], [data-history-start="true"]'
    : '[data-has-more-after="false"], [data-history-end="true"]';
  const sentinel = [...pane.querySelectorAll('[data-history-boundary="' + edge + '"], ' + attributes)]
    .some(node => !node.closest(captureExcluded) && captureRendered(node));
  const dedicatedScrollport = root !== document.scrollingElement && !root.matches(captureSurface);
  return pane.matches(attributes) || (dedicatedScrollport && root.matches(attributes)) || sentinel;
}

function captureVerificationReason({status, reasonCode}) {
  switch (status) {
    case 'unsupported_url': return 'Open a supported Messenger conversation URL.';
    case 'unsupported_functionality': return 'The browser could not inspect the message list.';
    case 'loading': return 'Wait for Messenger to finish loading the conversation.';
    case 'navigating': return 'Wait for Messenger to open the selected conversation.';
    case 'container_missing': return 'No supported message list was found. Open the conversation with its messages visible.';
    case 'rows_missing': return 'No rendered message rows were found. Check that the conversation has messages and its history is unlocked.';
    case 'identity_conflict': return 'Conflicting conversation evidence was found. Wait for the active list to finish updating, then retry.';
    default: return reasonCode === 'reused_pane'
      ? 'Messenger reused a message list and did not identify which conversation owns its current rows. Reload the active conversation if retrying does not help.'
      : 'The visible message list could not be linked to the active conversation. Reopen the conversation and try again.';
  }
}

async function collectChat(sourceUrl, onProgress, signal, options = {}) {
  const limit = options.limit ?? 5000;
  const stableRounds = options.stableRounds ?? 10;
  const pause = options.pause ?? (direction => direction < 0 ? (options.olderDelay ?? 450) : (options.newerDelay ?? 250));
  const ownsGuard = !options.guard;
  const guard = options.guard || new ConversationGuard();
  const expectedId = threadId(sourceUrl);
  const startGeneration = guard.refresh();
  const now = () => Date.now();
  const started = now();
  let savedAt = started;
  let history = new History();
  let resumeRecords = [];
  let verifyCheckpoint = null;
  let conversation = {id: expectedId, sourceUrl, name: 'Messenger conversation', participants: [], avatar: null};
  const coverage = {newer: 'not_requested', older: 'not_requested'};
  const directions = options.directions ?? [1, -1];
  const inlineMedia = options.captureInlineMedia ? {sources: new Map(), size: 0} : null;
  let status = 'initializing';
  let reason = 'Waiting for the active conversation message list.';
  let error = null;
  let diagnostics = null;
  let phase = null;
  let round = 0;
  const overlapTargets = new Set(options.overlapIds || []);
  const overlapMatches = new Set();
  const overlapRequired = Math.min(2, overlapTargets.size);
  const cutoff = Date.parse(options.overlapBefore);

  function progress() {
    const elapsedMs = now() - started;
    return {
      status, reason, diagnostics, count: history.size, attachments: history.attachments,
      earliest: history.earliest === null ? null : new Date(history.earliest).toISOString(),
      latest: history.latest === null ? null : new Date(history.latest).toISOString(),
      elapsedMs, messagesPerSecond: elapsedMs ? Math.max(0, history.size - (history.resumed ? resumeRecords.length : 0)) * 1000 / elapsedMs : 0,
      resumed: history.resumed, gaps: history.gaps, uncertain: history.uncertain, round, phase,
      conversation: {id: conversation.id, sourceUrl: conversation.sourceUrl, name: conversation.name,
        participants: [...new Set([...conversation.participants, ...history.participants])], avatar: conversation.avatar},
    };
  }
  const publish = () => onProgress(history.size, phase, progress());
  const changed = message => {
    const failure = new Error(message || 'Conversation changed. Start a new scan in the active conversation.');
    failure.name = 'ConversationChanged';
    throw failure;
  };
  const ensureRoute = () => {
    if (guard.refresh() !== startGeneration || threadId(location.href) !== expectedId) changed();
  };
  const inspect = () => {
    const inspected = guard.inspect();
    diagnostics = inspected.diagnostics;
    ensureRoute();
    return inspected;
  };
  const ensureBinding = () => {
    const inspected = inspect();
    if (!inspected.verified || inspected.id !== conversation.id) {
      changed('Conversation verification was lost. ' + captureVerificationReason(diagnostics));
    }
  };
  async function saveCheckpoint(force = false) {
    if (verifyCheckpoint || !options.checkpoint || !history.size || (!force && now() - savedAt < (options.checkpointInterval ?? 30000))) return;
    ensureBinding();
    await options.checkpoint(makePayload(history, conversation, coverage, progress(), {checkpoint: true}));
    savedAt = now();
    ensureBinding();
  }
  async function waitWhilePaused() {
    while (!signal.aborted && options.isPaused?.()) {
      ensureRoute();
      status = 'paused';
      reason = 'Paused by user.';
      publish();
      await saveCheckpoint();
      await scanDelay(200, signal);
    }
    if (status === 'paused') {
      status = 'scanning';
      reason = 'Reading visible message windows.';
    }
  }

  try {
    publish();
    const deadline = now() + (options.initializeTimeout ?? 10000);
    while (!signal.aborted) {
      ensureRoute();
      const inspected = inspect();
      if (inspected.ready && inspected.id === expectedId) {
        conversation = inspected;
        break;
      }
      reason = captureVerificationReason(diagnostics);
      if (['unsupported_url', 'unsupported_functionality'].includes(diagnostics.status)) throw new Error(reason);
      if (now() >= deadline) {
        diagnostics = {...diagnostics, timedOut: true};
        throw new Error('Conversation verification timed out. ' + reason);
      }
      publish();
      await scanDelay(150, signal);
    }
    if (!signal.aborted) {
      resumeRecords = checkpointSeed(options.resume, conversation);
      if (resumeRecords.length) verifyCheckpoint = checkpointVerifier(resumeRecords);
      status = 'scanning';
      reason = verifyCheckpoint ? 'Checking for overlap with the local checkpoint.' : 'Reading visible message windows.';
    }

    for (const direction of directions) {
      if (signal.aborted) break;
      phase = direction > 0 ? 'newer' : 'older';
      let previousEdge = null;
      let stable = 0;
      let empty = 0;
      coverage[phase] = 'in_progress';
      const phaseLimit = direction < 0 ? (options.olderLimit ?? limit) : (options.newerLimit ?? limit);
      for (round = 1; round <= phaseLimit && !signal.aborted; round++) {
        await waitWhilePaused();
        if (signal.aborted) break;
        ensureRoute();
        const inspected = inspect();
        const waiting = ['loading', 'rows_missing', 'container_missing'].includes(diagnostics.status);
        if (!inspected.verified && !waiting) {
          changed('Conversation verification was lost. ' + captureVerificationReason(diagnostics));
        }
        const root = inspected.ready ? inspected.root : null;
        const state = root ? scrollMessages(root, direction, false, inspected.pane) : null;
        const result = root ? readMessages(root, inspected.pane, Boolean(inlineMedia), inspected.rows) : null;
        ensureRoute();
        const records = (result?.records || []).filter(record => record.text || record.source_message_id
          || record.attachments?.length || record.message_type === 'system' || record.message_type === 'event');
        if (inlineMedia && result?.inlineMedia?.length) preserveInlineMedia(records, inlineMedia, result.inlineMedia);
        if (!records.length) {
          stable = 0;
          previousEdge = null;
          if (++empty >= (options.emptyRounds ?? 20)) {
            coverage[phase] = 'empty_read';
            break;
          }
        } else {
          empty = 0;
          const view = [state.before, state.height, state.viewport].join(':');
          const added = history.addWindow(records, direction, view);
          if (verifyCheckpoint?.(records)) {
            const restored = new History(resumeRecords);
            restored.addWindow(history.toArray(), direction);
            restored.gaps += history.gaps;
            restored.uncertain += history.uncertain;
            history = restored;
            verifyCheckpoint = null;
            reason = 'Resumed from the verified local checkpoint.';
          }
          const edge = state.atEdge && !state.loading ? view : null;
          stable = !added && edge && edge === previousEdge ? stable + 1 : 0;
          for (const record of records) {
            if (overlapTargets.has(record.source_message_id)) overlapMatches.add(record.source_message_id);
          }
          previousEdge = edge;
          if (stable >= stableRounds) {
            coverage[phase] = confirmedBoundary(inspected.pane, root, direction)
              ? 'boundary_confirmed' : 'edge_stable';
            break;
          }
          if (direction < 0 && ((overlapRequired && overlapMatches.size >= overlapRequired)
            || (Number.isFinite(cutoff) && records.every(record => {
              const timestamp = observationTimestamp(record);
              return timestamp !== null && timestamp <= cutoff;
            })))) {
            coverage.older = 'incremental_overlap';
            break;
          }
          if (round < phaseLimit && !state.loading) scrollMessages(root, direction, true, inspected.pane);
        }
        publish();
        if (inspected.verified) await saveCheckpoint();
        if (round < phaseLimit) await scanDelay(pause(direction), signal);
      }
      if (coverage[phase] === 'in_progress') coverage[phase] = signal.aborted ? 'interrupted' : 'round_limit';
    }
    ensureRoute();
    if (history.size) ensureBinding();
    status = signal.aborted ? 'cancelled'
      : !history.size ? 'failed'
      : !history.gaps && !history.uncertain && coverage.older === 'boundary_confirmed' && coverage.newer === 'boundary_confirmed'
        ? 'completed' : 'partial';
    reason = ({
      cancelled: 'Cancelled by user.',
      failed: 'No readable messages were captured. Open and unlock the conversation.',
      completed: 'Messenger exposed both history boundaries.',
      partial: [
        Object.values(coverage).includes('round_limit') && 'Scan round limit reached.',
        Object.values(coverage).includes('empty_read') && 'The message list stopped yielding readable messages.',
        coverage.older === 'incremental_overlap' && 'Stopped after reaching the incremental overlap range.',
        history.gaps > 0 && 'Some message windows lacked a verifiable overlap.',
        history.uncertain > 0 && 'Potentially distinct repeated observations were kept.',
      ].filter(Boolean).join(' ') || 'Messenger did not expose both history boundaries.',
    })[status];
    if (verifyCheckpoint) reason += ' The local checkpoint could not be verified against this history and was left untouched.';
    if (status === 'failed') error = reason;
    await saveCheckpoint(true);
  } catch (failure) {
    const invalidated = failure.name === 'ConversationChanged';
    if (invalidated) {
      history = new History();
      inlineMedia?.sources.clear();
    }
    status = invalidated || signal.aborted ? 'cancelled' : history.size ? 'partial' : 'failed';
    if (phase && coverage[phase] === 'in_progress') coverage[phase] = invalidated ? 'conversation_changed' : 'read_failed';
    reason = failure.message || 'Could not read the conversation.';
    error = reason;
  } finally {
    if (ownsGuard) guard.dispose();
  }
  publish();
  return {payload: makePayload(history, conversation, coverage, progress()), error, inlineMedia: inlineMedia?.sources || null};
}

function preserveInlineMedia(records, media, sources) {
  for (const record of records) {
    for (const item of record.attachments || []) {
      for (const [field, key] of [['url', 'inline_key'], ['preview_url', 'preview_inline_key']]) {
        const index = item['_'+ field + '_inline_index'];
        delete item['_'+ field + '_inline_index'];
        const source = sources[index];
        if (!source) continue;
        if (!media.sources.has(source)) {
          const bytes = source.length * 2;
          if (bytes > 32 * 1024 * 1024 || media.size + bytes > 128 * 1024 * 1024) continue;
          media.size += bytes;
          media.sources.set(source, 'inline-' + (media.sources.size + 1));
        }
        item[key] = media.sources.get(source);
      }
    }
  }
}
