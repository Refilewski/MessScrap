import {archiveFromCapture, formatArchive, importArchive, mergeArchives, safeFilename} from '../shared/archive.mjs';
import {icons} from '../shared/icons.mjs';
import {makeViewer} from '../shared/viewer.mjs';
import {archiveEntries, browserAttachmentLoader, buildArchiveBatch, buildArchiveZip, isMessengerMediaUrl} from '../shared/zip.mjs';
import panelStyle from './panel.css';

const panelId = 'messscrap-export-panel';
const CHUNK_SIZE = 500;
const defaults = {theme: 'system', format: 'zip', media: false, checkpoints: false, limit: 5000, concurrency: 3};
const mimeTypes = {
  txt: 'text/plain;charset=utf-8', json: 'application/json', csv: 'text/csv;charset=utf-8',
  html: 'text/html;charset=utf-8', zip: 'application/zip',
};
const formatNumber = new Intl.NumberFormat();
const formatTime = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

function icon(name, classes = '') {
  return `<svg aria-hidden="true" class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}

function renderTime(value) {
  const time = value && new Date(value);
  return time && Number.isFinite(time.getTime()) ? formatTime.format(time) : 'Unknown';
}

function inlineSources(result) {
  return new Map(Array.from(result.inlineMedia ?? [], ([source, key]) => [key, source]));
}

function downloadLocal(root, content, type, filename) {
  const link = document.createElement('a');
  const href = URL.createObjectURL(new Blob([content], {type}));
  link.href = href;
  link.download = filename;
  link.hidden = true;
  root.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

function pauseFor(delay, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, {once: true});
  });
}

async function waitForConversation(entry, guard, signal) {
  if (guard.inspect().id !== entry.id) {
    const link = [...document.querySelectorAll('a[href]')].find(node => threadUrl(node.href) === entry.sourceUrl
      && node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'));
    if (!link) throw new Error('The conversation is no longer in the visible list.');
    signal.throwIfAborted();
    link.click();
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const snapshot = guard.inspect();
    if (snapshot.id === entry.id && snapshot.ready) return snapshot;
    await pauseFor(250, signal);
  }
  throw new Error('Could not verify the selected message list.');
}

function installPanel() {
  if (!threadUrl(location.href)) return;
  const existing = document.getElementById(panelId);
  if (existing) {
    existing.hidden = false;
    existing.shadowRoot?.querySelector('button:not(:disabled)')?.focus();
    return;
  }

  const api = globalThis.browser ?? globalThis.chrome;
  const host = document.createElement('div');
  host.id = panelId;
  const root = host.attachShadow({mode: 'open'});
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(panelStyle);
  root.adoptedStyleSheets = [sheet];
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'MessScrap conversation export');
  section.dataset.theme = 'system';
  section.innerHTML = `
    <header>
      <div class="line">${icon('archive', 'brand')}<strong>MessScrap</strong></div>
      <div class="line">
        <button type="button" class="icon" id="toggle-settings" aria-label="Scan settings" title="Scan settings" aria-expanded="false">${icon('filter')}</button>
        <button type="button" class="icon" id="minimize" aria-label="Minimize panel" title="Minimize panel">${icon('minimize')}</button>
        <button type="button" class="icon" id="close" aria-label="Close panel" title="Close panel">${icon('close')}</button>
      </div>
    </header>
    <main>
      <div class="line">
        <div class="avatar" id="avatar" aria-hidden="true">${icon('users')}</div>
        <div class="person"><h2 id="conversation">Messenger conversation</h2><p class="muted" id="participants">Verifying message list…</p></div>
        <span class="status" id="status" data-state="idle">Ready</span>
      </div>
      <dl class="metrics">
        <div><dt>Messages</dt><dd id="count">0</dd></div>
        <div><dt>Attachments</dt><dd id="attachments">0</dd></div>
        <div><dt>Elapsed</dt><dd id="elapsed">0s</dd></div>
        <div><dt>Messages/s</dt><dd id="speed">0</dd></div>
        <div class="range"><dt>Captured range</dt><dd id="range">—</dd></div>
      </dl>
      <p id="resumed" class="muted" hidden>Resumed from local checkpoint</p>
      <p id="notice" class="muted" role="status" hidden></p>
      <p id="error" class="muted" role="alert" hidden></p>
      <progress id="download-progress" class="progress" aria-label="Attachment download progress" hidden></progress>
      <div class="actions">
        <button type="button" class="primary" id="start">${icon('play')}<span>Start scan</span></button>
        <button type="button" id="pause" hidden>${icon('pause')}<span>Pause</span></button>
        <button type="button" id="stop" hidden>${icon('stop')}<span>Cancel</span></button>
        <button type="button" id="resume" hidden>Resume checkpoint</button>
      </div>
      <div class="export">
        <div class="line">
          <label class="line" for="format">Format
            <select id="format">
              <option value="zip">ZIP archive</option><option value="html">HTML viewer</option>
              <option value="json">JSON</option><option value="csv">CSV</option><option value="txt">TXT</option>
            </select>
          </label>
          <button type="button" class="primary" id="save" disabled>${icon('download')}Export</button>
        </div>
        <label class="line"><input type="checkbox" id="media"> Include attachments in ZIP</label>
      </div>
      <div id="settings" class="settings" hidden>
        <label class="line" for="theme">Theme <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label class="line" for="limit">Scan round limit <input type="number" id="limit" min="1" max="50000" step="1"></label>
        <label class="line" for="concurrency">Concurrent downloads <input type="number" id="concurrency" min="1" max="8" step="1"></label>
        <label class="line"><span>Save local scan checkpoints</span><input type="checkbox" id="checkpoints"></label>
        <div id="checkpoint" class="actions" hidden><p class="muted" id="checkpoint-info"></p><button type="button" id="delete-checkpoint">Delete checkpoint</button></div>
        <div class="actions"><button type="button" id="scroll-top">Scan older messages</button></div>
        <details>
          <summary>Update an archive</summary>
          <div class="settings">
            <label>Existing JSON archive<input type="file" id="import" accept=".json,application/json"></label>
            <label id="media-folder-label" hidden>Existing archive media folder<input type="file" id="media-folder" webkitdirectory multiple></label>
            <p class="muted" id="import-info">Select an archive for this conversation before scanning.</p>
            <button type="button" id="clear-import" hidden>Clear imported archive</button>
          </div>
        </details>
      </div>
      <details id="batch">
        <summary>Batch export</summary>
        <div class="settings">
          <p class="muted" id="queue-info"></p>
          <ul class="queue-items" id="queue"></ul>
          <div class="actions">
            <button type="button" id="discover">Refresh conversations</button>
            <button type="button" id="queue-start" disabled>Start batch</button>
          </div>
          <label class="line"><input type="checkbox" id="combined" checked> Combine archives with an offline index</label>
        </div>
      </details>
    </main>
    <footer><span>Local export</span></footer>`;
  root.append(section);
  document.documentElement.append(host);

  const ui = Object.fromEntries([...root.querySelectorAll('[id]')].map(node => [node.id, node]));
  const onClick = (node, action) => node.addEventListener('click', event => {
    if (event.isTrusted && host.isConnected) action();
  });
  const guard = new ConversationGuard();
  let prefs = {...defaults};
  const preferenceEdits = {};
  let current = guard.inspect();
  let task;
  let saved;
  let imported;
  let importedFiles = new Map();
  let importedGeneration = 0;
  let checkpoint;
  let queue = [];
  let progress;
  let avatarSource;

  const request = async (operation, id, payload) => {
    const reply = await api.runtime.sendMessage({scope: 'messscrap', operation, id, payload});
    if (!reply || reply.error) throw new Error(reply?.error || 'The extension could not access local storage.');
    return reply.value;
  };
  const message = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
    node.hidden = !value;
  };
  const notice = value => message(ui.notice, value);
  const error = value => message(ui.error, value);
  const same = (a, b) => a?.id === b?.id && a?.generation === b?.generation;
  const render = () => {
    const phase = progress?.status?.toLowerCase() || (current.ready ? 'ready' : 'initializing');
    ui.status.textContent = phase[0].toUpperCase() + phase.slice(1);
    ui.status.dataset.state = phase;
    ui.conversation.textContent = current.name || 'Messenger conversation';
    const people = progress?.conversation?.id === current.id ? progress.conversation.participants : current.participants;
    const participants = (people ?? []).map(person => typeof person === 'string' ? person : person.name).filter(Boolean);
    ui.participants.textContent = participants.join(', ') || (current.ready ? 'Participants unavailable' : 'Verifying message list…');
    if (avatarSource !== current.avatar) {
      avatarSource = current.avatar;
      ui.avatar.innerHTML = icon('users');
      if (isMessengerMediaUrl(avatarSource)) {
        const image = document.createElement('img');
        image.alt = '';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('load', () => {
          if (avatarSource === current.avatar && image.src === current.avatar) ui.avatar.replaceChildren(image);
        }, {once: true});
        image.src = avatarSource;
      }
    }
    ui.count.textContent = formatNumber.format(progress?.count ?? 0);
    ui.attachments.textContent = formatNumber.format(progress?.attachments ?? 0);
    const seconds = Math.floor((progress?.elapsedMs ?? 0) / 1000);
    ui.elapsed.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    ui.speed.textContent = formatNumber.format(Math.round(progress?.messagesPerSecond ?? 0));
    ui.range.textContent = progress?.earliest || progress?.latest
      ? `${renderTime(progress.earliest)} – ${renderTime(progress.latest)}` : '—';
    ui.resumed.hidden = !progress?.resumed;
    ui.start.disabled = Boolean(task || !current.id);
    ui.start.querySelector('span').textContent = imported ? 'Scan update' : 'Start scan';
    ui['scroll-top'].disabled = Boolean(task || !current.id || imported);
    ui.pause.hidden = !task || task.kind !== 'scan';
    if (!ui.pause.hidden) {
      ui.pause.querySelector('span').textContent = task.paused ? 'Resume' : 'Pause';
      ui.pause.disabled = task.controller.signal.aborted;
    }
    ui.stop.hidden = !task;
    ui.stop.disabled = Boolean(task?.controller.signal.aborted);
    ui.resume.hidden = !checkpoint;
    ui.resume.disabled = Boolean(task || imported);
    ui.checkpoint.hidden = !checkpoint;
    ui['checkpoint-info'].textContent = checkpoint ? `${formatNumber.format(checkpoint.count)} messages saved locally` : '';
    ui['delete-checkpoint'].disabled = Boolean(task);
    ui.save.disabled = Boolean(task || !saved || !current.ready || !same(saved.snapshot, current));
    ui.format.disabled = Boolean(task);
    ui.media.disabled = Boolean(task || prefs.format !== 'zip');
    ui['queue-start'].disabled = Boolean(task || !queue.some(entry => entry.selected));
    ui.discover.disabled = Boolean(task);
    ui.combined.disabled = Boolean(task);
    for (const input of ui.queue.querySelectorAll('input')) input.disabled = Boolean(task);
    ui.import.disabled = Boolean(task);
    ui['media-folder'].disabled = Boolean(task);
    ui['clear-import'].disabled = Boolean(task);
  };

  const applyPreferences = () => {
    section.dataset.theme = prefs.theme;
    for (const key of ['theme', 'format', 'limit', 'concurrency']) ui[key].value = prefs[key];
    for (const key of ['media', 'checkpoints']) ui[key].checked = prefs[key];
    render();
  };
  request('preferences').then(value => {
    prefs = {...defaults, ...value, ...preferenceEdits};
    applyPreferences();
  }).catch(err => error(err.message));
  for (const key of Object.keys(defaults)) {
    ui[key].addEventListener('change', event => {
      if (!event.isTrusted) return;
      const input = ui[key];
      if (!input.checkValidity()) {
        input.value = prefs[key];
        return;
      }
      prefs[key] = input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? (input.valueAsNumber || defaults[key]) : input.value;
      preferenceEdits[key] = prefs[key];
      applyPreferences();
      request('save-preferences', undefined, {[key]: prefs[key]}).catch(err => error(err.message));
    });
  }

  async function writeCheckpoint(snapshot, payload) {
    const {items, ...header} = payload;
    const revision = crypto.randomUUID();
    await request('begin-checkpoint', snapshot.id, {revision, header});
    try {
      for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
        if (guard.refresh() !== snapshot.generation) return null;
        await request('put-chunk', snapshot.id, {revision, index: offset / CHUNK_SIZE, items: items.slice(offset, offset + CHUNK_SIZE)});
      }
      if (!guard.matches(snapshot)) return null;
      return await request('commit-checkpoint', snapshot.id, {revision});
    } finally {
      // Once committed, a revision has no staging record and cannot be rolled back.
      await request('abort-checkpoint', snapshot.id, {revision}).catch(() => {});
    }
  }

  async function readCheckpoint(snapshot, signal) {
    const metadata = await request('info', snapshot.id);
    if (!metadata) return null;
    const {header, revision, chunks} = metadata;
    const items = [];
    for (let index = 0; index < chunks; index++) {
      signal.throwIfAborted();
      const chunk = await request('read-chunk', snapshot.id, {revision, index});
      items.push(...chunk);
    }
    return {...header, items};
  }

  const refreshCheckpoint = async snapshot => {
    if (!snapshot.id) return;
    try {
      const value = await request('info', snapshot.id);
      if (same(current, snapshot) && host.isConnected) {
        checkpoint = value;
        render();
      }
    } catch (err) {
      if (prefs.checkpoints && same(current, snapshot)) error(err.message);
    }
  };
  refreshCheckpoint(current);

  function clearImported() {
    importedGeneration++;
    imported = null;
    importedFiles.clear();
    ui.import.value = ui['media-folder'].value = '';
    ui['clear-import'].hidden = ui['media-folder-label'].hidden = true;
    ui['import-info'].textContent = 'Select an archive for this conversation before scanning.';
  }

  onClick(ui['clear-import'], () => {
    clearImported();
    saved = null;
    render();
  });
  ui.import.addEventListener('change', async event => {
    if (!event.isTrusted) return;
    const [file] = ui.import.files;
    if (!file) return;
    const generation = ++importedGeneration;
    const snapshot = guard.inspect();
    try {
      const archive = importArchive(await file.text());
      if (!same(snapshot, guard.inspect()) || importedGeneration !== generation) return;
      if (archive.conversation.id !== snapshot.id) {
        throw new Error('The selected archive belongs to a different conversation.');
      }
      imported = archive;
      importedFiles.clear();
      saved = null;
      error('');
      ui['clear-import'].hidden = ui['media-folder-label'].hidden = false;
      ui['import-info'].textContent = `${formatNumber.format(archive.messages.length)} archived messages loaded.`;
      render();
    } catch (err) {
      if (importedGeneration === generation) error(err.message);
    }
  });
  ui['media-folder'].addEventListener('change', event => {
    if (!event.isTrusted) return;
    importedFiles = new Map();
    for (const file of ui['media-folder'].files) {
      const path = file.webkitRelativePath.split('/');
      const index = path.indexOf('media');
      if (index >= 0) importedFiles.set(path.slice(index).join('/'), file);
    }
  });
  onClick(ui['toggle-settings'], () => {
    ui.settings.hidden = !ui.settings.hidden;
    ui['toggle-settings'].setAttribute('aria-expanded', String(!ui.settings.hidden));
  });

  function synchronize() {
    const next = guard.inspect();
    if (!same(current, next)) {
      saved = progress = checkpoint = null;
      if (task && task.kind !== 'batch') {
        task.controller.abort(new DOMException('Conversation changed.', 'AbortError'));
      }
      if (imported && imported.conversation.id !== next.id) clearImported();
      if (task?.kind !== 'batch') notice('Conversation changed. Start a scan in the active conversation.');
      error('');
      refreshCheckpoint(next);
    }
    current = next;
    render();
    return current;
  }
  const timer = setInterval(synchronize, 450);
  const observer = new MutationObserver(() => {
    if (!host.isConnected) cleanup();
  });
  observer.observe(document.documentElement, {childList: true});
  let disposed = false;
  function cleanup() {
    if (disposed) return;
    disposed = true;
    task?.controller.abort();
    clearInterval(timer);
    observer.disconnect();
    guard.dispose();
    globalThis.removeEventListener('pagehide', cleanup);
    host.remove();
  }
  globalThis.addEventListener('pagehide', cleanup, {once: true});
  onClick(ui.close, cleanup);
  onClick(ui.minimize, () => { host.hidden = true; });
  onClick(ui.stop, () => {
    task?.controller.abort();
    render();
  });
  onClick(ui.pause, () => {
    if (task?.kind !== 'scan') return;
    task.paused = !task.paused;
    render();
  });
  onClick(ui['delete-checkpoint'], async () => {
    const snapshot = guard.inspect();
    try {
      await request('delete', snapshot.id);
      if (same(current, snapshot)) {
        checkpoint = null;
        notice('Local checkpoint deleted.');
        render();
      }
    } catch (err) {
      error(err.message);
    }
  });

  async function capture(snapshot, signal, {resume, directions, overlapIds, overlapBefore} = {}) {
    const result = await collectChat(snapshot.sourceUrl, (count, phase, metrics) => {
      if (!host.isConnected || guard.refresh() !== snapshot.generation) return;
      progress = {...metrics, count};
      if (metrics?.reason) notice(metrics.reason);
      render();
    }, signal, {
      guard, limit: prefs.limit, directions, resume, overlapIds, overlapBefore, captureInlineMedia: prefs.media,
      isPaused: () => Boolean(task?.paused),
      checkpoint: prefs.checkpoints
        ? async payload => {
          if (!guard.matches(snapshot)) return;
          try {
            const value = await writeCheckpoint(snapshot, payload);
            if (value && same(guard.inspect(), snapshot)) {
              checkpoint = value;
              render();
            }
          } catch (err) {
            error(err.message);
          }
        }
        : undefined,
    });
    if (!guard.matches(snapshot)) throw new Error('Conversation changed or its message list could no longer be verified.');
    return result;
  }

  async function run(options = {}) {
    if (task) return;
    const snapshot = synchronize();
    if (!snapshot.id) return;
    task = {kind: 'scan', controller: new AbortController(), paused: false};
    const signal = task.controller.signal;
    const base = imported;
    const previous = saved;
    saved = null;
    progress = {status: 'initializing'};
    notice(options.resume ? 'Restoring local checkpoint…' : '');
    error('');
    render();
    try {
      const resume = options.resume ? await readCheckpoint(snapshot, signal) : undefined;
      if (options.resume && !resume) throw new Error('The checkpoint could not be found.');
      if (resume) notice('Resumed from local checkpoint.');
      const overlapIds = base?.messages.filter(item => item.nativeId).slice(-8).map(item => item.nativeId);
      const overlapBefore = base && !overlapIds.length ? base.messages.findLast(item => item.timestamp)?.timestamp : undefined;
      const result = await capture(snapshot, signal, {resume, directions: options.directions, overlapIds, overlapBefore});
      if (result.error) error(typeof result.error === 'string' ? result.error : result.error.message);
      if (result.payload?.count) {
        let archive = archiveFromCapture(result.payload);
        if (base) {
          const merged = mergeArchives(base, archive);
          archive = merged.archive;
          const {added, updated, unchanged, conflicting, uncertain} = merged.report;
          notice(`Update saved in memory. ${added} added · ${updated} updated · ${unchanged} unchanged · ${conflicting} conflicts.${uncertain ? ' History coverage is uncertain.' : ''}`);
        }
        saved = {archive, snapshot, inline: inlineSources(result), files: base ? importedFiles : undefined};
      }
    } catch (err) {
      if (same(guard.inspect(), snapshot)) {
        progress = {...progress, status: signal.aborted ? 'cancelled' : 'failed'};
        error(err.message || 'The scan stopped.');
      }
    } finally {
      if (!saved && previous && guard.matches(previous.snapshot)) {
        saved = previous;
        notice(`Previous verified capture still available · ${formatNumber.format(saved.archive.messages.length)} messages.`);
      }
      task = null;
      synchronize();
    }
  }
  onClick(ui.start, () => run());
  onClick(ui['scroll-top'], () => run({directions: [-1]}));
  onClick(ui.resume, () => run({resume: true}));

  function zipOptions(signal, {inline, files} = {}) {
    return {
      includeMedia: prefs.media,
      concurrency: prefs.concurrency,
      signal,
      async loadMedia(attachment, downloadSignal) {
        const file = files?.get(attachment.path);
        if (file) {
          if (file.size > 64 * 1024 * 1024) return null;
          return {bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, mimeType: file.type || attachment.mimeType};
        }
        return browserAttachmentLoader(attachment, downloadSignal, key => inline?.get(key));
      },
      onProgress({finished, total, failed, unavailable, skipped}) {
        ui['download-progress'].hidden = !total;
        ui['download-progress'].max = total || 1;
        ui['download-progress'].value = finished;
        notice(`Attachments ${finished} of ${total} · ${failed} failed · ${unavailable} unavailable · ${skipped} skipped.`);
      },
    };
  }

  async function exportSaved() {
    synchronize();
    if (task || !saved || !guard.matches(saved.snapshot)) return;
    const output = saved;
    const format = prefs.format;
    task = {kind: 'export', controller: new AbortController()};
    const signal = task.controller.signal;
    notice('Preparing archive…');
    error('');
    render();
    try {
      const content = format === 'zip' ? await buildArchiveZip(output.archive, zipOptions(signal, output))
        : format === 'html' ? makeViewer(output.archive) : formatArchive(output.archive, format);
      signal.throwIfAborted();
      if (!guard.matches(output.snapshot)) throw new Error('The conversation changed before export.');
      const name = safeFilename(output.archive.conversation.name) || 'conversation';
      const time = output.archive.exportedAt.replace(/[:.]/g, '-');
      downloadLocal(root, content, mimeTypes[format], `messscrap-${name}-${time}.${format}`);
      notice('Archive download started.');
    } catch (err) {
      if (same(guard.inspect(), output.snapshot)) {
        if (signal.aborted) notice('Export cancelled.');
        else error(err.message || 'The archive could not be exported.');
      }
    } finally {
      task = null;
      ui['download-progress'].hidden = true;
      synchronize();
    }
  }
  onClick(ui.save, exportSaved);

  function renderQueue() {
    ui.queue.replaceChildren();
    for (const entry of queue) {
      const row = document.createElement('li');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `batch-entry-${ui.queue.childElementCount}`;
      checkbox.checked = entry.selected;
      checkbox.disabled = Boolean(task);
      checkbox.addEventListener('change', event => {
        if (!event.isTrusted) return;
        entry.selected = checkbox.checked;
        render();
      });
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.title = entry.name;
      label.textContent = entry.name;
      const badge = document.createElement('span');
      badge.className = 'muted';
      badge.textContent = entry.status;
      badge.title = entry.reason || entry.status;
      row.append(checkbox, label, badge);
      ui.queue.append(row);
    }
  }

  function discover() {
    const existing = new Map(queue.map(entry => [entry.id, entry]));
    queue = discoverConversations().map(entry => {
      const previous = existing.get(entry.id);
      return {...entry, name: entry.name || 'Messenger conversation', selected: previous?.selected ?? entry.selected,
        status: previous?.status || 'Queued'};
    });
    ui['queue-info'].textContent = queue.length
      ? 'Select visible conversations to scan one at a time.'
      : 'No conversations are visible. Open the Messenger conversation list and refresh.';
    renderQueue();
    render();
  }

  async function runBatch() {
    if (task) return;
    const entries = queue.filter(entry => entry.selected);
    if (!entries.length) return;
    const combined = ui.combined.checked;
    task = {kind: 'batch', controller: new AbortController()};
    const signal = task.controller.signal;
    const archives = [];
    const packaged = new Map();
    let finished = 0;
    saved = null;
    error('');
    render();
    try {
      for (const entry of entries) {
        signal.throwIfAborted();
        entry.status = 'Opening';
        entry.reason = '';
        renderQueue();
        try {
          const snapshot = await waitForConversation(entry, guard, signal);
          synchronize();
          entry.status = 'Scanning';
          renderQueue();
          const result = await capture(snapshot, signal);
          signal.throwIfAborted();
          if (!result.payload?.count) throw new Error('No messages were captured.');
          const archive = archiveFromCapture(result.payload);
          const options = zipOptions(signal, {inline: inlineSources(result)});
          if (combined) {
            const files = await archiveEntries(archive, options);
            signal.throwIfAborted();
            if (!guard.matches(snapshot)) throw new Error('Conversation changed before export.');
            packaged.set(archive, files);
            archives.push(archive);
          } else {
            const bytes = await buildArchiveZip(archive, options);
            signal.throwIfAborted();
            if (!guard.matches(snapshot)) throw new Error('Conversation changed before export.');
            const name = safeFilename(archive.conversation.name) || 'conversation';
            downloadLocal(root, bytes, mimeTypes.zip, `messscrap-${name}-${archive.exportedAt.replace(/[:.]/g, '-')}.zip`);
          }
          entry.status = archive.scan.status === 'completed' ? 'Collected' : 'Partial';
          finished++;
        } catch (err) {
          entry.status = signal.aborted ? 'Cancelled' : 'Failed';
          entry.reason = err?.message;
        }
        renderQueue();
      }
      signal.throwIfAborted();
      if (combined && archives.length) {
        const bytes = await buildArchiveBatch(archives, {signal, entriesForArchive: archive => packaged.get(archive)});
        signal.throwIfAborted();
        downloadLocal(root, bytes, mimeTypes.zip, 'messscrap-conversations.zip');
      }
      notice(`Batch finished. ${finished} of ${entries.length} conversations archived.`);
    } catch (err) {
      if (signal.aborted) notice(`Batch cancelled after ${finished} of ${entries.length} conversations.`);
      else error(err.message || 'Batch export failed.');
    } finally {
      task = null;
      ui['download-progress'].hidden = true;
      render();
    }
  }
  onClick(ui.discover, discover);
  ui.batch.addEventListener('toggle', () => {
    if (ui.batch.open && !queue.length && !task) discover();
  });
  onClick(ui['queue-start'], runBatch);
  applyPreferences();
}
