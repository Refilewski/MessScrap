import {publicArchive, statistics} from './archive.mjs';
import {icons} from './icons.mjs';
import {viewerRuntime} from './viewer-runtime.mjs';
import {viewerStyles} from './viewer.css.mjs';

function jsonForHTML(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function makeViewer(archive, initialStatistics) {
  const data = jsonForHTML({archive: publicArchive(archive), initialStatistics, icons});
  const runtime = '(' + viewerRuntime.toString() + ')(' + statistics.toString() + ');';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \x27none\x27; script-src \x27unsafe-inline\x27; style-src \x27unsafe-inline\x27; img-src file:; media-src file:; base-uri \x27none\x27; form-action \x27none\x27">',
    '<title>MessScrap Archive</title>',
    '<style>' + viewerStyles + '</style>',
    '</head>',
    '<body>',
    '<div class="app" id="app" aria-busy="true">',
    '  <header class="topbar">',
    '    <div class="brand"><button class="icon-button mobile-menu" id="mobile-menu" type="button" aria-label="Toggle navigation" aria-controls="rail" aria-expanded="false"></button><span class="brand-icon" id="brand-icon"></span><strong>MessScrap Archive</strong></div>',
    '    <div class="top-actions"><label class="theme-picker"><span id="theme-icon"></span><select id="theme" aria-label="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><span class="offline">Offline</span></div>',
    '  </header>',
    '  <aside id="rail" class="rail" aria-label="Archive navigation">',
    '    <label class="search"><span id="search-icon"></span><input id="search" type="search" placeholder="Search messages" aria-label="Search messages" maxlength="600" autocomplete="off"></label>',
    '    <div class="search-tools" id="search-tools" hidden><span id="search-count" role="status"></span><div class="inline-actions"><button type="button" class="icon-button" id="previous-result" title="Previous result" aria-label="Previous result"></button><button type="button" class="icon-button" id="next-result" title="Next result" aria-label="Next result"></button></div></div>',
    '    <div class="conv-card" id="conversation-card"><div><strong id="conversation-label"></strong><small id="conversation-count"></small></div></div>',
    '    <nav aria-label="Archive views"></nav>',
    '  </aside>',
    '  <button type="button" class="mobile-backdrop" id="mobile-backdrop" aria-label="Close navigation" tabindex="-1"></button>',
    '  <main class="main">',
    '    <header class="view-header"><div class="header-copy"><h1 id="conversation-title"></h1><p id="view-caption"></p></div><div class="view-actions">',
    '      <button type="button" class="icon-button" id="toggle-calendar" title="Jump to date" aria-label="Jump to date" aria-controls="calendar-panel" aria-expanded="false"></button>',
    '      <button type="button" class="icon-button" id="toggle-filter" title="Filters" aria-label="Filters" aria-controls="filter-panel" aria-expanded="false"></button>',
    '    </div></header>',
    '    <div class="control-panel" id="calendar-panel" hidden><label>Jump to date<input type="date" id="target-date"></label><button class="action" type="button" id="jump-date">Go to date</button><button class="action" type="button" id="jump-earliest">Earliest</button><button class="action" type="button" id="jump-latest">Latest</button></div>',
    '    <div class="control-panel" id="filter-panel" hidden><label>From date<input type="date" id="date-from"></label><label>To date<input type="date" id="date-until"></label><button class="action" type="button" id="reset-filters">Clear filters</button><p class="chart-note" id="filter-error" role="status" hidden>The start date is after the end date.</p></div>',
    '    <div id="view" class="view" tabindex="0"></div>',
    '  </main>',
    '  <footer class="statusbar"><span id="status-icon"></span><span id="status-messages"></span><span aria-hidden="true">·</span><span id="status-attachments"></span><span aria-hidden="true">·</span><span>Local archive</span></footer>',
    '</div>',
    '<dialog class="preview-dialog" id="preview" aria-labelledby="preview-title"><div class="preview-head"><strong id="preview-title"></strong><button class="icon-button" id="close-preview" type="button" aria-label="Close preview"></button></div><div class="preview-content" id="preview-content"></div></dialog>',
    '<div class="toast" id="toast" role="status" hidden></div>',
    '<noscript>Enable JavaScript to browse this local archive.</noscript>',
    '<script type="application/json" id="archive-data">' + data + '</script>',
    '<script>' + runtime + '</script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
