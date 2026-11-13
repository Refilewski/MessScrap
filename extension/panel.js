const sourceUrl = threadUrl(location.href);
if (!sourceUrl) return false;

const panelId = 'messscrap-export-panel';
const existing = document.getElementById(panelId);
if (existing) {
  existing.shadowRoot?.querySelector('button:not(:disabled)')?.focus();
  return true;
}

const host = document.createElement('div');
host.id = panelId;
const root = host.attachShadow({mode: 'open'});
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
    :host { position: fixed; inset: auto 12px 16px auto; z-index: 2147483647; }
    section {
      box-sizing: border-box; width: min(350px, calc(100vw - 24px));
      padding: 14px; border: 1px solid #b4bbc9; border-radius: 12px;
      background: #fff; color: #141a26; box-shadow: 0 4px 20px #0004;
      font: 15px/1.4 system-ui, sans-serif;
    }
    header, footer { display: flex; align-items: center; gap: 8px; }
    header { justify-content: space-between; }
    footer { flex-wrap: wrap; }
    button {
      appearance: none; background: #e8eef9; color: #142b54; border: 1px solid #a6b8d8;
      border-radius: 7px; min-height: 44px; padding: 0 12px; font: inherit;
    }
    button.primary { background: #174dbe; color: white; border-color: #174dbe; }
    button:disabled { opacity: .55; }
    button[hidden] { display: none; }
    p { margin: 8px 0 12px; }
`);
root.adoptedStyleSheets = [sheet];
root.innerHTML = `
  <section aria-label="Messenger conversation export">
    <header><strong>MessScrap</strong><button type="button" id="close" aria-label="Close panel">×</button></header>
    <p id="status" role="status">Collect messages from the open conversation and save as JSON or TXT.</p>
    <footer>
      <button type="button" class="primary" id="start">Collect history</button>
      <button type="button" id="stop" hidden>Stop</button>
      <button type="button" id="save" hidden>Save JSON</button>
      <button type="button" id="saveTxt" hidden>Save TXT</button>
    </footer>
  </section>
`;

const status = root.querySelector('#status');
const start = root.querySelector('#start');
const stop = root.querySelector('#stop');
const save = root.querySelector('#save');
const saveTxt = root.querySelector('#saveTxt');
const close = root.querySelector('#close');
let controller = null;
let payload = null;

close.addEventListener('click', () => host.remove());
stop.addEventListener('click', () => {
  controller?.abort();
  stop.disabled = true;
});

start.addEventListener('click', async () => {
  controller = new AbortController();
  close.disabled = start.disabled = true;
  stop.disabled = false;
  save.hidden = true;
  saveTxt.hidden = true;
  stop.hidden = false;
  const result = await collectChat(sourceUrl, (count, phase) => {
    const label = phase === 'older' ? 'Older history' : 'Newer history';
    const progress = label + ' · collected ' + count + ' messages';
    if (status.textContent !== progress) status.textContent = progress;
  }, controller.signal);
  payload = result.payload;
  status.textContent = [
    result.error,
    'Collected ' + payload.count + ' messages.' + (payload.partial ? ' Partial export.' : ''),
  ].filter(Boolean).join(' ');
  close.disabled = start.disabled = false;
  stop.hidden = true;
  save.hidden = !payload.count;
  saveTxt.hidden = !payload.count;
});

function downloadExport(format) {
  if (!payload?.count) return;
  const content = format === 'txt' ? formatTxt(payload) : JSON.stringify(payload, null, 2) + '\n';
  const mime = format === 'txt' ? 'text/plain;charset=utf-8' : 'application/json';
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'messscrap-' + payload.exported_at.replace(/[:.]/g, '-') + '.' + format;
  link.hidden = true;
  root.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

save.addEventListener('click', () => downloadExport('json'));
saveTxt.addEventListener('click', () => downloadExport('txt'));

document.documentElement.append(host);
return true;
