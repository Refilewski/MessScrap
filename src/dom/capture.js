(() => {
  globalThis.__messscrapCapture?.dispose();
  const guard = new ConversationGuard();
  let controller = null;
  let paused = false;
  let progress = null;
  let result = null;
  let inline = null;
  let checkpoint = null;
  let checkpointRevision = 0;
  let identity = null;

  function clear() {
    if (controller) return false;
    result = null;
    progress = null;
    paused = false;
    inline = null;
    checkpoint = null;
    identity = null;
    return true;
  }

  function invalidate() {
    if (!identity || (!result?.payload?.count && !checkpoint)) return;
    if (guard.matches(identity)) return;
    checkpoint = null;
    inline = null;
    if (result?.payload?.count) {
      const reason = 'Conversation changed. Start a new scan in the active conversation.';
      progress = {...progress, status: 'cancelled', count: 0, attachments: 0, earliest: null, latest: null, reason};
      result = {payload: null, error: reason};
    }
  }

  function start(options = {}) {
    if (controller) throw new Error('A scan is already running.');
    const current = guard.inspect();
    if (!current.sourceUrl) throw new Error('Open a specific Messenger conversation.');
    const expected = options.expectedIdentity;
    if (expected && (current.id !== expected.id || current.generation !== expected.generation)) {
      throw new Error('The conversation changed before capture.');
    }
    clear();
    identity = current;
    controller = new AbortController();
    const signal = controller.signal;
    const save = options.checkpoint;
    collectChat(current.sourceUrl, (_count, _phase, next) => { progress = next; }, signal, {
      ...options,
      guard,
      isPaused: () => paused,
      checkpoint: save ? payload => { checkpoint = payload; checkpointRevision++; } : null,
    }).then(value => {
      result = {payload: value.payload, error: value.error};
      inline = value.inlineMedia ? new Map([...value.inlineMedia].map(([source, key]) => [key, source])) : null;
    }).catch(error => {
      const reason = error.message || 'Could not read the conversation.';
      progress = {...progress, status: 'failed', reason};
      result = {payload: null, error: reason};
    }).finally(() => { controller = null; });
    return true;
  }

  globalThis.__messscrapCapture = {
    inspect: () => guard.inspect(),
    discover: discoverConversations,
    start,
    state({detail = false} = {}) {
      // Checkpoint identity comes from the guarded scan at each save.
      // A temporarily empty pane can occur while loading older history.
      if (!controller) invalidate();
      else if (identity && guard.refresh() !== identity.generation) checkpoint = null;
      const verifiedCheckpoint = detail && checkpoint && guard.matches(identity) ? checkpoint : null;
      return {running: Boolean(controller), resultReady: Boolean(result), progress, checkpointRevision,
        result: detail ? result : null, checkpoint: verifiedCheckpoint};
    },
    pause() { paused = true; },
    resume() { paused = false; },
    cancel() { controller?.abort(); },
    resolveInlineMedia(key) {
      invalidate();
      return inline?.get(key) || null;
    },
    clear,
    dispose() {
      controller?.abort();
      guard.dispose();
      inline?.clear();
      delete globalThis.__messscrapCapture;
    },
  };
})();
