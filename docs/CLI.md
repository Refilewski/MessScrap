# Command-line reference

MessScrap 2.0 runs on Node.js 22.11 or later. Commands that read existing archives work offline. Live capture opens an isolated Chrome, Brave, Chromium, or Edge profile so you can sign in to Messenger yourself.

Install the versioned tarball with `npm install -g ./messscrap-2.0.0.tgz`. Use `messscrap --version` to verify your installation and `messscrap <command> --help` for command-specific options.

## Capture

```sh
messscrap scan --checkpoint --format zip --media --output ./archives
messscrap scan --resume --format json --output ./archives
messscrap scan --checkpoints
messscrap scan --forget CHECKPOINT_ID
```

Open and unlock the conversation in the isolated browser. The interactive terminal reports scan state, elapsed time, captured messages, and date range. Press **Space** to pause or resume and **Q** or **Ctrl+C** to stop. In a non-interactive terminal pass `--no-prompt` and open the conversation before invoking the command.

| Option | Purpose |
| --- | --- |
| `--format json\|txt\|csv\|html\|zip` | Choose the output format. |
| `--media` | Include retrievable attachment files when packaging a ZIP. |
| `--concurrency N` | Set concurrent downloads. Defaults to three and allows up to 12. |
| `--checkpoint` | Save resumable local scan state. |
| `--resume` | Restore a checkpoint for the browser's active conversation. |
| `--checkpoint-dir DIR` | Use a different checkpoint directory. |
| `--max-rounds N` | Limit consecutive scroll rounds per scan direction. |
| `--from-current` | Collect toward newer messages from the current scroll position. |
| `--scroll-up-until-top` | Collect toward older messages before scanning toward newer messages. |
| `--browser PATH` | Select a different Chromium executable. |
| `--profile DIR` | Use a different isolated capture browser profile. |
| `--port N` | Select the browser debugging port. The default is `9222`. |
| `--output DIR` | Set the output directory. The default is `./exports`. |

A scan can write an archive with **Partial** coverage and exit with status `3`. Inspect the scan reason in the resulting JSON or ZIP manifest.

The CLI looks for a browser on your local debugging port first. When it needs to open a browser, it uses its own profile directory by default. The browser keeps this profile for future scans so you can use the same signed-in session.

| Platform | Default profile directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\MessScrap\browser` |
| macOS | `~/Library/Application Support/MessScrap/browser` |
| Linux | `$XDG_DATA_HOME/messscrap/browser` or `~/.local/share/messscrap/browser` |

## Export and import

```sh
messscrap export archive.json --format html --out archive.html
messscrap export archive.json --format zip --media --output ./archives
messscrap import messenger-export.json --out imported.json
messscrap validate archive.zip --json
```

`export`, `import`, and `validate` accept compatible JSON archives. A supplied ZIP must contain a MessScrap archive with an identifiable message document. Pass `--out FILE` to set an exact output path. The CLI refuses to overwrite an existing output file. Keep the archive's relative media layout when moving an extracted archive. For a local conversion with `--media`, the CLI uses the media files available to the source archive.

`validate` reports schema violations and missing archived files. Validation of a local ZIP or extracted archive can also inspect its manifest. A valid archive can still contain unavailable attachments and partial scan coverage.

## Update and batch export

```sh
messscrap update archive.json --format zip --media
messscrap update archive.json --from newer.json --out merged.json
messscrap batch --discover
messscrap batch --select CONVERSATION_ID --select OTHER_CONVERSATION_ID
messscrap batch archive-a.json archive-b.json --combined --output ./archives
```

Live updates capture toward an overlap with existing history. Use `--overlap-days DAYS` to adjust the date cutoff, which defaults to seven days before the latest known message. Review the merge counts and coverage uncertainty in the output before treating an update as continuous with earlier captures. Merge uses conversation IDs to guard against mixing different threads.

Batch discovery uses conversations exposed by the capture browser. Select the visible conversation IDs or pass existing archive files. Batch archives keep each conversation's transcript and attachments under its own path.

Open the combined archive's extracted `index.html` to browse the batch. To validate, search, or convert a single conversation from a combined ZIP, extract the ZIP and pass the appropriate conversation folder's `messages.json` to the CLI.

## Search and statistics

```sh
messscrap search archive.json "weekend" --limit 20
messscrap search archive.json "weekend" --json
messscrap stats archive.json --format csv --participant "Maya Chen" --start 2026-10-01 --end 2026-10-31
```

Date filters accept inclusive UTC dates. Statistics use only captured messages and observable metadata. See [the calculations](ARCHITECTURE.md#statistics) for details.

## Terminal use

Set the environment variable `NO_COLOR` for plain output. Use `--no-prompt` for scripts and the `--json` option for structured results on commands that support it. Diagnostic messages go to standard error for machine-readable commands.

| Exit code | Meaning |
| --- | --- |
| `0` | Command succeeded. |
| `1` | An operation failed. |
| `2` | Usage error or failed archive validation. |
| `3` | A scan or batch finished with partial coverage. |
| `130` | Cancelled. |

## Migrate from 0.2.x

- Install the versioned Node.js CLI package in place of the old Windows portable executable. An invocation without a subcommand still starts a scan. In a source checkout, `python main.py` forwards arguments to the current Node.js CLI.
- `--download-media` remains an alias for `--media`. Existing scan-direction and scroll timing options remain available. Check `messscrap scan --help` for the current option names and defaults.
- The DOM dump and debug export options are retired. Use a synthetic Messenger DOM fixture when reporting parsing regressions.
- The output now uses archive schema v2. Legacy `items` documents are accepted by the shared importer. Convert old data with `messscrap import` and regenerate HTML or ZIP from the converted JSON.
- ZIP files from the old Windows and Python releases remain tied to those versions. Install the 2.0.0 tarball to use the shared archive viewer and exporter.
