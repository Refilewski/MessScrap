if (!threadUrl(location.href)) return false;

const panelId = 'messscrap-export-panel';
const existing = document.getElementById(panelId);
if (existing) {
  existing.hidden = false;
  const controls = existing.shadowRoot;
  controls?.querySelector('#collapse[aria-expanded="false"]')?.click();
  controls?.querySelector('#stop:not([hidden]):not(:disabled), #start:not(:disabled)')?.focus();
  return true;
}

const host = document.createElement('div');
host.id = panelId;
const root = host.attachShadow({mode: 'open'});
const styles = `
  :host {
    all: initial;
    position: fixed;
    right: max(12px, env(safe-area-inset-right, 0px));
    bottom: max(12px, env(safe-area-inset-bottom, 0px));
    z-index: 2147483647;
    color-scheme: dark;
  }
  :host([hidden]), [hidden] { display: none !important; }
  *, *::before, *::after { box-sizing: border-box; }
  .panel {
    width: min(356px, calc(100vw - max(12px, env(safe-area-inset-right, 0px)) - max(12px, env(safe-area-inset-left, 0px))));
    max-height: calc(100vh - 24px);
    max-height: calc(100dvh - 24px);
    overflow: auto;
    border: 1px solid #333750;
    border-radius: 20px;
    background: #111323;
    color: #f5f4ff;
    box-shadow: 0 16px 56px #08091580, 0 2px 10px #08091560;
    font: 14px/1.45 system-ui, -apple-system, sans-serif;
  }
  .panel:has(.body[hidden]) { width: 240px; max-width: calc(100vw - 24px); }
  header { display: flex; align-items: center; gap: 10px; padding: 13px 14px; }
  .mark {
    display: grid;
    place-items: center;
    flex: 0 0 36px;
    height: 36px;
    border-radius: 11px;
    background: linear-gradient(145deg, #6954dd, #4433a8);
    color: #fff;
    font-size: 22px;
    line-height: 1;
  }
  .brand { flex: 1; min-width: 0; }
  .brand strong { display: block; font-size: 15px; letter-spacing: -.02em; }
  .brand small, .sub { color: #b3b6d0; font-size: 12px; }
  button {
    appearance: none;
    margin: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
    border: 1px solid #383c58;
    background: #1b1e34;
    border-radius: 11px;
    min-height: 44px;
    text-align: left;
  }
  button:hover:not(:disabled) { background-color: #252945; border-color: #7474ac; }
  button:focus-visible { outline: 2px solid #c4bbff; outline-offset: 3px; }
  button:disabled { opacity: .6; cursor: default; }
  .icon {
    width: 44px;
    text-align: center;
    padding: 0;
    font-size: 19px;
    line-height: 1;
    background: transparent;
    border-color: transparent;
    color: #d4d4ec;
  }
  .body { padding: 0 14px 14px; }
  .summary {
    padding: 13px;
    border: 1px solid #39365e;
    border-radius: 14px;
    background: radial-gradient(ellipse at top right, #27204a, #191b30 80%);
  }
  .summary-top { display: flex; align-items: baseline; gap: 10px; justify-content: space-between; }
  .stage { color: #c7bdff; font-weight: 650; }
  .stage[data-tone="success"] { color: #abebd0; }
  .stage[data-tone="partial"] { color: #ffe0a1; }
  .stage[data-tone="error"] { color: #ffc1d1; }
  .tally { color: #c4c6df; font-size: 12px; white-space: nowrap; }
  .tally strong { color: #fff; font-size: 22px; line-height: 1; font-variant-numeric: tabular-nums; }
  .status { margin: 6px 0 0; color: #c4c6df; font-size: 13px; overflow-wrap: anywhere; }
  .meter {
    margin-top: 11px;
    height: 4px;
    overflow: hidden;
    border-radius: 5px;
    background: #3a3760;
  }
  .meter::before {
    display: block;
    width: 44%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #806cff, #c2afff);
    content: '';
    animation: scanning 1.6s ease-in-out infinite alternate;
  }
  @keyframes scanning { from { transform: translateX(0); } to { transform: translateX(128%); } }
  @media (prefers-reduced-motion: reduce) { .meter::before { animation: none; } }
  .actions, .downloads { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 10px; }
  .action { padding: 9px 11px; }
  .action strong, .action .sub { display: block; }
  .action strong { font-size: 13px; }
  .primary {
    color: #fff;
    background: linear-gradient(145deg, #5c49cb, #4937b0);
    border-color: #8876f7;
  }
  .primary:hover:not(:disabled) { background: linear-gradient(145deg, #6b57dd, #5340c1); border-color: #b2a5ff; }
  .primary .sub { color: #e4dfff; }
  .stop { display: block; width: 100%; margin-top: 10px; text-align: center; color: #ffd0dc; border-color: #704359; }
  .downloads { padding-bottom: 10px; border-bottom: 1px solid #333750; }
  .downloads:not([hidden]) ~ .actions #start { background: #1b1e34; border-color: #383c58; }
  .downloads:not([hidden]) ~ .actions #start:hover { background: #252945; border-color: #7474ac; }
  .downloads:not([hidden]) ~ .actions #start .sub { color: #b3b6d0; }
  .download-status { margin: 7px 0 0; color: #c4c6df; font-size: 12px; }
  .download-status:empty { display: none; }
  @media (forced-colors: active) {
    button, .summary, .panel { border: 1px solid ButtonText; }
    .meter { border: 1px solid Highlight; }
    .meter::before { background: Highlight; }
  }
`;
if (typeof CSSStyleSheet === 'function' && CSSStyleSheet.prototype.replaceSync && 'adoptedStyleSheets' in root) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(styles);
  root.adoptedStyleSheets = [sheet];
} else {
  const style = document.createElement('style');
  style.textContent = styles;
  root.append(style);
}

const layout = document.createElement('template');
layout.innerHTML = `
  <section class="panel" aria-label="MessScrap conversation export">
    <header>
      <span class="mark" aria-hidden="true">↓</span>
      <div class="brand"><strong>MessScrap</strong><small>Chat export</small></div>
      <button type="button" class="icon" id="collapse" aria-controls="body" aria-expanded="true" aria-label="Minimize panel">−</button>
      <button type="button" class="icon" id="close" aria-label="Close panel">×</button>
    </header>
    <div class="body" id="body">
      <div class="summary">
        <div class="summary-top">
          <strong class="stage" id="stage">Ready to collect</strong>
          <span class="tally"><strong id="count">0</strong> <span id="countLabel">messages</span></span>
        </div>
        <p class="status" id="status" role="status">Choose how to scan this conversation.</p>
        <div class="meter" id="meter" aria-hidden="true" hidden></div>
      </div>
      <div class="downloads" id="downloads" hidden>
        <button type="button" class="action primary" id="saveTxt" hidden><strong>Save TXT <span aria-hidden="true">↓</span></strong><span class="sub">Readable transcript</span></button>
        <button type="button" class="action" id="save" hidden><strong>Save JSON <span aria-hidden="true">↓</span></strong><span class="sub">Full message data</span></button>
      </div>
      <p class="download-status" id="downloadStatus" role="status"></p>
      <div class="actions" id="actions">
        <button type="button" class="action primary" id="start"><strong>Collect history</strong><span class="sub">Newer, then older</span></button>
        <button type="button" class="action" id="scrollTop"><strong>Scroll to top</strong><span class="sub">Older from here</span></button>
      </div>
      <button type="button" class="stop" id="stop" hidden>Stop and keep messages</button>
    </div>
  </section>
`;
root.append(layout.content);

const body = root.querySelector('#body');
const collapse = root.querySelector('#collapse');
const status = root.querySelector('#status');
const stage = root.querySelector('#stage');
const count = root.querySelector('#count');
const countLabel = root.querySelector('#countLabel');
const meter = root.querySelector('#meter');
const actions = root.querySelector('#actions');
const start = root.querySelector('#start');
const scrollToTop = root.querySelector('#scrollTop');
const stop = root.querySelector('#stop');
const downloads = root.querySelector('#downloads');
const downloadStatus = root.querySelector('#downloadStatus');
const save = root.querySelector('#save');
const saveTxt = root.querySelector('#saveTxt');
const close = root.querySelector('#close');
let controller = null;
let payload = null;

close.addEventListener('click', () => { host.hidden = true; });
collapse.addEventListener('click', () => {
  body.hidden = !body.hidden;
  collapse.textContent = body.hidden ? '+' : '−';
  collapse.setAttribute('aria-expanded', String(!body.hidden));
  collapse.setAttribute('aria-label', body.hidden ? 'Expand panel' : 'Minimize panel');
});
stop.addEventListener('click', () => {
  if (!controller || controller.signal.aborted) return;
  stop.disabled = true;
  updateStage('Stopping');
  status.textContent = 'Preparing the messages collected so far.';
  controller.abort();
});

function updateStage(label, tone = '') {
  stage.textContent = label;
  stage.dataset.tone = tone;
}

function updateCount(value) {
  count.textContent = value.toLocaleString();
  countLabel.textContent = value === 1 ? 'message' : 'messages';
}

function showDownloads(visible) {
  downloads.hidden = save.hidden = saveTxt.hidden = !visible;
}

async function runCollection(options = {}) {
  if (controller) return;
  const sourceUrl = threadUrl(location.href);
  if (!sourceUrl) {
    status.textContent = 'Open a specific conversation before collecting messages.';
    return;
  }

  const previous = payload?.source_url === sourceUrl ? payload : null;
  payload = null;
  controller = new AbortController();
  const signal = controller.signal;
  close.disabled = start.disabled = scrollToTop.disabled = true;
  actions.hidden = true;
  stop.disabled = stop.hidden = false;
  meter.hidden = false;
  showDownloads(false);
  downloadStatus.textContent = '';
  updateCount(0);
  updateStage('Starting');
  status.textContent = 'Looking for messages in this conversation.';
  if (!body.hidden) stop.focus();
  try {
    let previousPhase;
    const result = await collectChat(sourceUrl, (total, phase) => {
      if (signal.aborted) return;
      updateCount(total);
      if (phase === previousPhase) return;
      previousPhase = phase;
      updateStage(phase === 'older' ? 'Scanning older history' : 'Scanning newer history');
      status.textContent = 'Messages are kept if you stop this scan.';
    }, signal, options);
    payload = result.payload?.count ? result.payload : previous;
    updateCount(payload?.count ?? 0);
    if (result.error || !result.payload?.count) {
      updateStage(payload ? 'Export available' : 'No messages collected', payload ? 'partial' : 'error');
      status.textContent = [
        result.error || 'The scan ended before it found any messages.',
        result.payload?.count ? 'You can save the partial results.' : payload ? 'Your previous export is still available.' : '',
      ].filter(Boolean).join(' ');
    } else {
      if (payload.partial) updateStage('Partial export ready', 'partial');
      else updateStage('Export ready', 'success');
      status.textContent = payload.interrupted
        ? 'Scan stopped. Save the messages collected so far.'
        : payload.partial ? 'Save the messages from the portion scanned.' : 'Save the collected conversation as TXT or JSON.';
    }
  } catch (error) {
    payload = previous;
    updateCount(payload?.count ?? 0);
    updateStage('Could not finish', 'error');
    status.textContent = [error?.message || 'Could not collect messages.', payload ? 'Your previous export is still available.' : ''].filter(Boolean).join(' ');
  } finally {
    const restoreFocus = root.activeElement === stop && !body.hidden;
    controller = null;
    close.disabled = start.disabled = scrollToTop.disabled = false;
    stop.hidden = meter.hidden = true;
    actions.hidden = false;
    showDownloads(Boolean(payload?.count));
    if (restoreFocus) (payload?.count ? saveTxt : start).focus();
  }
}

start.addEventListener('click', () => runCollection());
scrollToTop.addEventListener('click', () => runCollection({directions: [-1]}));

function downloadExport(format) {
  if (!payload?.count) return;
  let url;
  let link;
  try {
    const content = format === 'txt' ? formatTxt(payload) : JSON.stringify(payload, null, 2) + '\n';
    const mime = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json';
    url = URL.createObjectURL(new Blob([content], {type: mime}));
    link = document.createElement('a');
    link.href = url;
    link.download = 'messscrap-' + payload.exported_at.replace(/[:.]/g, '-') + '.' + format;
    link.hidden = true;
    root.append(link);
    link.click();
    downloadStatus.textContent = format.toUpperCase() + ' download requested.';
  } catch {
    downloadStatus.textContent = 'Could not start the download. Try saving again.';
  } finally {
    link?.remove();
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

save.addEventListener('click', () => downloadExport('json'));
saveTxt.addEventListener('click', () => downloadExport('txt'));

document.documentElement.append(host);
return true;
