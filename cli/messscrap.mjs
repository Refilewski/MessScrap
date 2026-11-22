#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import {
  archiveChunks, conversationId, formatArchive, importArchive, mergeArchives, searchMessages, statistics, statisticsCsv
} from '../shared/archive.mjs';
import { makeViewer } from '../shared/viewer.mjs';
import { archiveEntries, buildArchiveBatch, buildArchiveZip } from '../shared/zip.mjs';
import { newestArchive, openArchive, outputFile, validateSource, writeAtomic } from './archive-io.mjs';
import { connectBrowser, dataDirectory } from './browser.mjs';
import { captureTab, deleteCheckpoint, listCheckpoints, promptForConversation } from './capture.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const outputDirectory = 'exports';
const formats = ['json', 'txt', 'csv', 'html', 'zip'];
const help = `MessScrap ${version}

Usage: messscrap <command> [options]

  scan [--resume] [--checkpoint]       Capture the current Messenger conversation
  export [ARCHIVE] --format FORMAT     Export JSON, TXT, CSV, HTML, or ZIP
  update ARCHIVE [--from NEW_ARCHIVE]   Merge an overlapping capture into a new archive
  stats ARCHIVE [--format json|csv]     Calculate conversation statistics
  search ARCHIVE "query"               Find messages by text, author, link, or attachment
  validate ARCHIVE [--json]             Check schema, manifest, and local media
  import ARCHIVE                        Convert legacy or official Messenger JSON to schema 2
  batch [ARCHIVE...] [--combined]       Export local archives or selected live conversations
  --help                               Show help
  --version                            Report the installed version

Options:
  --output DIR         Output directory (default ./exports)
  --out FILE           Output file. An existing file is protected.
  --media              Include available media in ZIP (implies --format zip)
  --concurrency N      Concurrent attachment downloads (default 3, max 12)
  --json               Machine-readable results where supported
  --no-prompt          Disable browser prompts and keyboard controls

Scan and update:
  --max-rounds N       Maximum scan rounds per requested direction
  --resume             Use the active conversation's local checkpoint
  --checkpoint         Save capture progress for later use
  --checkpoint-dir DIR Override the application checkpoint directory
  --checkpoints        List checkpoints (scan only)
  --forget KEY         Delete one checkpoint (scan only)
  --prompt             Wait for the conversation to be opened
  --port N             Local Chromium debugging port (default 9222)
  --browser PATH       Chromium browser executable override
  --profile DIR        Browser profile directory override
  --overlap-days N     Scan before the latest known date on live update (default 7)

Batch:
  --discover           List discoverable conversations
  --select ID          Select a discovered conversation. Repeat per conversation.
  --combined           Write one ZIP with an offline index and per-conversation archives

Statistics and search:
  --participant NAME   Filter by participant
  --start YYYY-MM-DD   Include dates on or after this UTC date
  --end YYYY-MM-DD     Include dates on or before this UTC date
  --limit N            Limit search results printed (default 50)

Exit codes: 0 success, 1 operation failed, 2 invalid command or archive,
            3 partial scan or batch, 130 cancelled.
`;

class UsageError extends Error {}
const commands = new Set(['scan', 'export', 'update', 'stats', 'search', 'validate', 'import', 'batch']);
const strings = [
  'format', 'output', 'out', 'concurrency', 'port', 'browser', 'profile', 'checkpoint-dir', 'forget', 'from',
  'overlap-days', 'max-rounds', 'safety-max-rounds', 'no-new-stop', 'scroll-up-rounds', 'sleep',
  'scroll-up-sleep', 'participant', 'start', 'end', 'limit'
];
const booleans = [
  'help', 'version', 'json', 'media', 'download-media', 'resume', 'checkpoint', 'checkpoints', 'no-prompt',
  'non-interactive', 'prompt', 'from-current', 'scroll-up-first', 'scroll-up-until-top', 'until-bottom',
  'combined', 'discover'
];
const sharedOutput = ['output', 'out', 'format', 'media', 'download-media', 'concurrency'];
const browserOptions = [
  'port', 'browser', 'profile', 'checkpoint-dir', 'no-prompt', 'non-interactive', 'prompt', 'resume',
  'checkpoint', 'max-rounds', 'safety-max-rounds', 'no-new-stop', 'scroll-up-rounds', 'sleep',
  'scroll-up-sleep', 'from-current', 'scroll-up-first', 'scroll-up-until-top', 'until-bottom'
];
const allowed = {
  scan: [...sharedOutput, ...browserOptions, 'checkpoints', 'forget'],
  export: sharedOutput,
  update: [...sharedOutput, ...browserOptions, 'from', 'overlap-days'],
  stats: ['format', 'participant', 'start', 'end', 'out', 'output'],
  search: ['limit', 'participant', 'start', 'end'],
  validate: [],
  import: ['out', 'output'],
  batch: [...sharedOutput, ...browserOptions, 'select', 'combined', 'discover']
};

function argsFor(argv) {
  let command = 'scan';
  if (argv.length && !argv[0].startsWith('-')) command = argv.shift();
  if (!commands.has(command)) throw new UsageError('Unknown command ' + command + '. See messscrap --help.');
  const options = Object.fromEntries([
    ...strings.map(name => [name, { type: 'string' }]),
    ...booleans.map(name => [name, { type: 'boolean' }]),
    ['select', { type: 'string', multiple: true }]
  ]);
  options.help.short = 'h';
  options.version.short = 'V';
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  for (const option of Object.keys(values)) {
    if (!['help', 'version', 'json'].includes(option) && !allowed[command].includes(option)) {
      throw new UsageError('--' + option + ' is unavailable for ' + command + '.');
    }
  }
  const min = ['stats', 'search', 'validate', 'import', 'update'].includes(command) ? (command === 'search' ? 2 : 1) : 0;
  const max = command === 'scan' ? 0 : command === 'search' ? 2 : command === 'batch' ? Infinity : 1;
  if (!values.help && !values.version && (positionals.length < min || positionals.length > max)) {
    throw new UsageError('Incorrect number of arguments for ' + command + '. See messscrap --help.');
  }
  return { command, values, positionals };
}

function integer(value, name, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return defaultValue;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new UsageError('--' + name + ' must be an integer from ' + min + ' to ' + max + '.');
  }
  return number;
}

function scanDelay(value, name, fallback) {
  if (value === undefined) return fallback;
  const seconds = Number(value);
  if (!/^\d*\.?\d+$/.test(value) || !Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
    throw new UsageError('--' + name + ' must be between 0 and 60 seconds.');
  }
  return seconds * 1000;
}

function archiveFormat(values, fallback = 'json') {
  const media = values.media || values['download-media'];
  const format = values.format || (media ? 'zip' : fallback);
  if (!formats.includes(format)) throw new UsageError('Choose an archive format from ' + formats.join(', ') + '.');
  if (media && format !== 'zip') throw new UsageError('--media requires ZIP. Use --format zip.');
  return format;
}

function captureOptions(values) {
  if ((values['no-prompt'] || values['non-interactive']) && values.prompt) {
    throw new UsageError('--prompt and --no-prompt are mutually exclusive.');
  }
  if (values['from-current'] && (values['scroll-up-first'] || values['scroll-up-until-top'])) {
    throw new UsageError('--from-current cannot be combined with upward scroll options.');
  }
  if (values['scroll-up-first'] && values['scroll-up-until-top']) {
    throw new UsageError('Choose one upward scroll option.');
  }
  const safety = integer(values['safety-max-rounds'], 'safety-max-rounds', 5000, 1, 100000);
  const limit = integer(values['max-rounds'], 'max-rounds', safety, 1, 100000);
  const olderFirst = values['scroll-up-first'] || values['scroll-up-until-top'];
  return {
    directions: olderFirst ? [-1, 1] : values['from-current'] ? [1] : [1, -1],
    limit,
    olderLimit: values['scroll-up-first']
      ? integer(values['scroll-up-rounds'], 'scroll-up-rounds', 30, 1, 100000) : limit,
    newerLimit: values['until-bottom'] ? safety : limit,
    stableRounds: integer(values['no-new-stop'], 'no-new-stop', 10, 1, 1000),
    olderDelay: scanDelay(values['scroll-up-sleep'], 'scroll-up-sleep', 450),
    newerDelay: scanDelay(values.sleep, 'sleep', 250),
    captureInlineMedia: Boolean(values.media || values['download-media'])
  };
}

function dateFilters(values) {
  const { participant, start, end } = values;
  for (const [name, value] of Object.entries({ start, end })) {
    if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      throw new UsageError('--' + name + ' must be a valid YYYY-MM-DD date.');
    }
  }
  if (start && end && start > end) throw new UsageError('--start must be on or before --end.');
  return { participant, start, end };
}

const colorTerminal = process.stderr.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
function style(text, color) {
  return colorTerminal ? styleText(color, text, { validateStream: false }) : text;
}

function reportFactory(machineReadable) {
  const tty = process.stderr.isTTY && process.env.TERM !== 'dumb';
  let inline = false;
  let lastLine = '';
  let lastTime = 0;
  const quiet = Boolean(machineReadable);
  const notice = message => {
    if (quiet) return;
    if (inline) process.stderr.write('\n');
    inline = false;
    process.stderr.write(message + '\n');
  };
  const progress = (state, done) => {
    if (quiet || !state) return;
    const { count, status, attachments, earliest, latest, elapsedMs, messagesPerSecond, conversation, reason } = state;
    const next = [
      String(status || 'initializing').toUpperCase(),
      conversation?.name || '',
      Number(count || 0).toLocaleString('en') + ' messages',
      Number(attachments || 0).toLocaleString('en') + ' attachments',
      ((elapsedMs || 0) / 1000).toFixed(1) + 's',
      Number(messagesPerSecond || 0).toFixed(1) + '/s',
      earliest && latest ? earliest.slice(0, 10) + ' – ' + latest.slice(0, 10) : '',
      reason || ''
    ].filter(Boolean).join(' | ');
    if (!done && (next === lastLine || (!tty && Date.now() - lastTime < 2000))) return;
    lastLine = next;
    lastTime = Date.now();
    if (tty && !done) {
      process.stderr.write('\r\u001b[2K' + next);
      inline = true;
    } else {
      if (inline) process.stderr.write('\r\u001b[2K');
      inline = false;
      notice(next);
    }
  };
  const media = state => {
    if (!state.total) return;
    const width = Math.min(24, Math.floor(state.finished * 24 / state.total));
    if (tty || !state.finished || state.finished === state.total) {
      notice('Media [' + '='.repeat(width) + ' '.repeat(24 - width) + '] ' +
        state.finished + '/' + state.total + ' processed, ' + state.archived + ' saved');
    }
  };
  return { notice, progress, media };
}

async function readArchive(path) {
  const source = await openArchive(path);
  return { source, archive: importArchive(source.original) };
}

function browserSettings(values, signal, report) {
  return {
    port: integer(values.port, 'port', 9222, 1, 65535),
    browser: values.browser,
    profile: values.profile,
    signal,
    onNotice: report.notice
  };
}

function captureSettings(values, signal, report) {
  const noninteractive = Boolean(values['no-prompt'] || values['non-interactive'] || values.json);
  return {
    signal,
    noninteractive,
    prompt: Boolean(values.prompt),
    keyboard: !noninteractive,
    resume: Boolean(values.resume),
    checkpoint: Boolean(values.checkpoint),
    checkpointDirectory: resolve(values['checkpoint-dir'] || join(dataDirectory(), 'checkpoints')),
    captureOptions: captureOptions(values),
    onProgress: report.progress,
    onNotice: report.notice
  };
}

async function withCapture(values, signal, report, consume, additions = {}) {
  const options = { ...captureSettings(values, signal, report), ...additions };
  const browser = await connectBrowser(browserSettings(values, signal, report));
  const tab = await promptForConversation(browser, options);
  const connection = await browser.open(tab);
  try {
    return await captureTab(connection, tab, options, consume);
  } finally {
    connection.close();
  }
}

function zipSettings(values, signal, report, loadMedia, preserve = false) {
  const includeMedia = Boolean(values.media || values['download-media'] || preserve);
  return {
    includeMedia,
    loadMedia,
    concurrency: integer(values.concurrency, 'concurrency', 3, 1, 12),
    signal,
    onProgress: includeMedia ? report.media : undefined
  };
}

function destination(values, archive, format, defaultName) {
  if (values.out) {
    if (extname(values.out).toLowerCase() !== '.' + format) {
      throw new UsageError('--out must end in .' + format + ' for the selected format.');
    }
    return resolve(values.out);
  }
  return outputFile(values.output || outputDirectory, defaultName || archive?.conversation.name || 'archive', format);
}

async function saveArchive(archive, format, values, signal, report, loadMedia, preserve, confirm) {
  const path = destination(values, archive, format);
  // If interrupted during scanning, keep the captured messages and omit new
  // downloads. Interruptions during the export still stop the write.
  const cancelledCapture = signal.aborted && archive.scan.status === 'cancelled';
  let content;
  if (format === 'zip') {
    const zipOptions = zipSettings(values, cancelledCapture ? undefined : signal, report, loadMedia, preserve);
    if (cancelledCapture) zipOptions.includeMedia = false;
    content = await buildArchiveZip(archive, zipOptions);
  } else content = format === 'html' ? makeViewer(archive) : archiveChunks(archive, format);
  if (!cancelledCapture) signal.throwIfAborted();
  await writeAtomic(path, content, { confirm });
  return { path, conversation: archive.conversation.name, messages: archive.messages.length,
    status: archive.scan.status, reason: archive.scan.reason };
}

function showResult(result, values) {
  if (values.json) console.log(JSON.stringify(result));
  else {
    if (result.path) console.log(result.path);
    if (result.report) {
      const { added, updated, unchanged, conflicting, uncertain } = result.report;
      console.log('Added ' + added + ', updated ' + updated + ', unchanged ' + unchanged + ', conflicts ' + conflicting + '.');
      if (uncertain) console.log('Coverage is uncertain. The archive may have gaps between captures.');
    }
  }
}

function scanExit(status) {
  switch (status) {
    case 'cancelled': return 130;
    case 'partial': return 3;
    case 'failed': return 1;
    default: return 0;
  }
}

function firstMedia(...loaders) {
  return async (attachment, signal) => {
    let failure;
    for (const load of loaders.filter(Boolean)) {
      try {
        const result = await load(attachment, signal);
        if (result) return result;
      } catch (error) {
        signal?.throwIfAborted();
        failure = error;
      }
    }
    if (failure) throw failure;
    return null;
  };
}

async function runBatch(positionals, values, signal, report) {
  const explicit = values.select || [];
  if (positionals.length && (values.discover || explicit.length)) throw new UsageError('Use archive paths or live selection.');
  if (values.discover && explicit.length) throw new UsageError('Run batch --discover before selecting conversation IDs.');
  if (!positionals.length && !values.discover && !explicit.length) {
    throw new UsageError('Provide archive paths, --discover, or one or more --select IDs.');
  }
  if (values.out && !values.combined && (positionals.length > 1 || explicit.length > 1)) {
    throw new UsageError('Use --output DIR to write separate archives.');
  }
  const format = archiveFormat(values, 'zip');
  if (values.combined && format !== 'zip') throw new UsageError('--combined requires ZIP.');

  let browser;
  let tabs;
  let discovered;
  if (!positionals.length) {
    browser = await connectBrowser(browserSettings(values, signal, report));
    tabs = await browser.tabs();
    if (!tabs.length) throw new Error('Open Messenger in the MessScrap browser profile first.');
    discovered = new Map();
    for (const tab of tabs) {
      signal.throwIfAborted();
      const id = conversationId(tab.url);
      if (id) discovered.set(id, { id, sourceUrl: tab.url, name: tab.title, tab });
      let connection;
      try {
        connection = await browser.open(tab);
        await connection.install();
        for (const item of await connection.capture('discover') || []) {
          if (item.id === conversationId(item.sourceUrl) && !discovered.get(item.id)?.tab) discovered.set(item.id, item);
        }
        await connection.capture('dispose');
      } catch (error) {
        report.notice('Could not discover all conversations in one browser tab. ' + error.message);
      } finally {
        connection?.close();
      }
    }
    if (values.discover) {
      const result = [...discovered.values()].map(({ id, name }) => ({ id, name }));
      if (values.json) console.log(JSON.stringify(result));
      else if (!result.length) report.notice('No accessible conversation links were found.');
      else for (const { id, name } of result) console.log(id + '\t' + (name || 'Messenger conversation'));
      return 0;
    }
  }

  const queue = positionals.length ? positionals : [...new Set(explicit)];
  const prepared = [];
  const failures = [];
  const saved = [];
  let coverageExit = 0;
  for (const [index, target] of queue.entries()) {
    signal.throwIfAborted();
    report.notice('Conversation ' + (index + 1) + ' of ' + queue.length);
    const store = async (archive, loadMedia, preserve, confirm) => {
      coverageExit = Math.max(coverageExit, scanExit(archive.scan.status));
      if (values.combined) {
        const entries = await archiveEntries(archive, zipSettings(values, signal, report, loadMedia, preserve));
        await confirm?.();
        prepared.push({ archive: { conversation: archive.conversation, messages: { length: archive.messages.length } }, entries });
      } else {
        saved.push(await saveArchive(archive, format, values, signal, report, loadMedia, preserve, confirm));
      }
    };
    try {
      if (positionals.length) {
        const { source, archive } = await readArchive(target);
        await store(archive, source.loadMedia, source.zip);
      } else {
        const selected = discovered.get(target);
        if (!selected) throw new Error('Conversation was not discovered. Run batch --discover.');
        const tab = selected.tab || tabs[0];
        const connection = await browser.open(tab);
        try {
          await captureTab(connection, tab, {
            ...captureSettings(values, signal, report), keyboard: false,
            navigate: selected.sourceUrl, expectedId: selected.id
          }, (archive, loader, confirm) => store(archive, loader, false, confirm));
        } finally {
          connection.close();
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      failures.push({ target: positionals.length ? basename(target) : target, error: error.message });
      report.notice(style('Failed: ', 'red') + error.message);
    }
  }
  if (prepared.length) {
    const entries = new Map(prepared.map(({ archive, entries }) => [archive, entries]));
    const bytes = await buildArchiveBatch([...entries.keys()], { signal, entriesForArchive: archive => entries.get(archive) });
    const path = destination(values, null, 'zip', 'conversations');
    await writeAtomic(path, bytes);
    saved.push({ path, conversations: prepared.length });
  }
  if (values.json) console.log(JSON.stringify({ saved, failures }));
  else {
    for (const output of saved) console.log(output.path);
    report.notice(saved.length + ' export file(s) saved, ' + failures.length + ' failed.');
  }
  if (failures.length) return saved.length ? 3 : 1;
  return coverageExit;
}

async function run(command, values, positionals, signal) {
  const report = reportFactory(values.json);
  const [input, query] = positionals;
  switch (command) {
    case 'scan': {
      if (values.checkpoints || values.forget) {
        if (values.checkpoints && values.forget) throw new UsageError('Choose --checkpoints or --forget.');
        const directory = resolve(values['checkpoint-dir'] || join(dataDirectory(), 'checkpoints'));
        if (values.forget) {
          const removed = await deleteCheckpoint(directory, values.forget);
          console.log(values.json ? JSON.stringify({ removed }) : 'Removed checkpoint ' + removed + '.');
        } else {
          const checkpoints = await listCheckpoints(directory);
          if (values.json) console.log(JSON.stringify(checkpoints));
          else if (!checkpoints.length) console.log('No local checkpoints.');
          else for (const row of checkpoints) console.log(row.error
            ? row.key + '\t' + row.error : [row.key, row.id, row.name, row.count, row.capturedAt].join('\t'));
        }
        return 0;
      }
      const format = archiveFormat(values);
      const result = await withCapture(values, signal, report,
        (archive, loader, confirm) => saveArchive(archive, format, values, signal, report, loader, false, confirm));
      showResult(result, values);
      return scanExit(result.status);
    }
    case 'export': {
      const format = archiveFormat(values);
      const { source, archive } = await readArchive(input || await newestArchive(values.output || outputDirectory));
      const result = await saveArchive(archive, format, values, signal, report, source.loadMedia, source.zip);
      showResult(result, values);
      return 0;
    }
    case 'import': {
      const { archive } = await readArchive(input);
      const result = await saveArchive(archive, 'json', values, signal, report);
      showResult(result, values);
      return 0;
    }
    case 'update': {
      const base = await readArchive(input);
      const format = archiveFormat(values, base.source.zip ? 'zip' : 'json');
      const mergeAndSave = async (next, loadMedia, sourceZip, confirm) => {
        const { archive, report: mergeReport } = mergeArchives(base.archive, next);
        const loader = firstMedia(base.source.loadMedia, loadMedia);
        const result = await saveArchive(archive, format, values, signal, report, loader, base.source.zip || sourceZip, confirm);
        showResult({ ...result, report: mergeReport }, values);
        return scanExit(next.scan.status);
      };
      if (values.from) {
        const next = await readArchive(values.from);
        await mergeAndSave(next.archive, next.source.loadMedia, next.source.zip);
        return 0;
      }
      if (!base.archive.sourceUrl) throw new Error('This archive has no Messenger source conversation. Use update --from NEW_ARCHIVE.');
      const overlapDays = integer(values['overlap-days'], 'overlap-days', 7, 0, 3650);
      let latest = null;
      const overlapIds = [];
      for (let index = base.archive.messages.length - 1; index >= 0; index--) {
        const message = base.archive.messages[index];
        if (!latest && message.timestamp) latest = message.timestamp;
        if (message.nativeId) overlapIds.push(message.nativeId);
        if (latest && overlapIds.length >= 5) break;
      }
      const overlapBefore = latest ? new Date(Date.parse(latest) - overlapDays * 86400000).toISOString() : undefined;
      const options = captureOptions(values);
      return withCapture(values, signal, report,
        (archive, loader, confirm) => mergeAndSave(archive, loader, false, confirm), {
        expectedId: base.archive.conversation.id,
        captureOptions: { ...options, overlapBefore, overlapIds, captureInlineMedia: values.media || base.source.zip }
      });
    }
    case 'stats': {
      const format = values.format || 'json';
      if (!['json', 'csv'].includes(format)) throw new UsageError('Statistics format must be json or csv.');
      const filters = dateFilters(values);
      const { archive } = await readArchive(input);
      const data = statistics(archive, filters);
      const output = format === 'csv' ? statisticsCsv(data) : JSON.stringify(data, null, 2) + '\n';
      if (values.out || values.output) {
        const path = destination(values, archive, format, archive.conversation.name + '-statistics');
        await writeAtomic(path, output);
        showResult({ path }, values);
      } else process.stdout.write(output);
      return 0;
    }
    case 'search': {
      const { archive } = await readArchive(input);
      if (!query.trim()) throw new UsageError('Enter a nonempty query.');
      const limit = integer(values.limit, 'limit', 50, 1, 100000);
      const { participant, start, end } = dateFilters(values);
      const results = searchMessages(archive, query).filter(message => {
        const day = message.timestamp?.slice(0, 10);
        return (!participant || message.author === participant) &&
          (!start || (day && day >= start)) && (!end || (day && day <= end));
      });
      const messages = results.slice(0, limit);
      if (values.json) {
        // Reuse the JSON serializer so runtime fields from imported legacy
        // archives never leak into machine-readable search results.
        const sanitized = JSON.parse(formatArchive({ ...archive, messages }, 'json')).messages;
        console.log(JSON.stringify({ count: results.length, messages: sanitized }));
      } else {
        for (const message of messages) {
          console.log([message.timestamp || 'Unknown time', message.author || 'Unknown sender', message.text]
            .map(value => value.replace(/[\u0000-\u001f\u007f]/g, ' ')).join(' | '));
        }
        report.notice(messages.length + ' shown of ' + results.length + ' matching messages.');
      }
      return 0;
    }
    case 'validate': {
      let result;
      try {
        result = await validateSource(await openArchive(input), signal);
      } catch (error) {
        signal.throwIfAborted();
        result = { valid: false, errors: [error.message], warnings: [] };
      }
      if (values.json) console.log(JSON.stringify(result));
      else {
        for (const warning of result.warnings) report.notice(style('Warning: ', 'yellow') + warning);
        for (const error of result.errors) report.notice(style('Invalid: ', 'red') + error);
        if (result.valid) console.log('Valid archive. ' + result.messages + ' messages.');
      }
      return result.valid ? 0 : 2;
    }
    case 'batch':
      return runBatch(positionals, values, signal, report);
  }
}

const controller = new AbortController();
const onInterrupt = () => controller.abort(new Error('Operation cancelled.'));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try {
  const { command, values, positionals } = argsFor(process.argv.slice(2));
  if (values.version) console.log(version);
  else if (values.help) process.stdout.write(help);
  else process.exitCode = await run(command, values, positionals, controller.signal);
} catch (error) {
  console.error(style('MessScrap: ', 'red') + error.message);
  if (error instanceof UsageError) console.error('See messscrap --help.');
  process.exitCode = controller.signal.aborted ? 130 : error instanceof UsageError ? 2 : 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
}
