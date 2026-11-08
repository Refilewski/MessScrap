<p align="center">
  <img src="docs/banner.svg" alt="MessScrap — local Messenger conversation exports" width="100%">
</p>

<p align="center">
  <strong>Export an open Messenger conversation on your computer or Android phone.</strong>
</p>

<p align="center">
  <a href="#windows-quick-start">Windows</a> ·
  <a href="#firefox-on-android-and-desktop">Firefox</a> ·
  <a href="#what-gets-exported">Export formats</a> ·
  <a href="docs/quickstart.pl.md">Instrukcja po polsku</a>
</p>

## Features

- **Scroll in both directions.** MessScrap saves older messages as Messenger loads them and keeps the conversation in order.
- **Keep repeated messages.** Messenger's message IDs distinguish separate messages with identical text.
- **Capture more than text.** Exports include multiline messages, timestamps, quotes, reactions, read indicators, links and attachment metadata when the page exposes them.
- **Keep partial results.** Stop an export and save the messages collected so far.

| Version | Where it runs | What it saves |
| --- | --- | --- |
| **Python CLI** | Windows with Brave or Chrome | JSON, TXT and offline HTML. Optional copies of available attachments. |
| **Firefox extension** | Desktop Firefox and Firefox for Android | JSON with message and attachment metadata. Runs in the open conversation. |

## Windows quick start

Install Python 3.10 or newer and Brave or Chrome. Clone the repository, then run these commands in PowerShell.

```powershell
git clone https://github.com/Refilewski/messscrap.git
cd messscrap
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

MessScrap opens a separate browser profile or connects to one already listening on `127.0.0.1:9222`. Sign in there, open a specific conversation and unlock the encrypted history if prompted. Press Enter when the terminal asks. Results go to `exports/conversations/<conversation>/<run>/`.

| Option | Use it to |
| --- | --- |
| `--download-media` | Save accessible attachments and previews under `media/`, up to 25 MiB each. |
| `--from-current --prompt` | Export toward newer messages from your current scroll position. |
| `--max-rounds 40` | Limit the export to 40 rounds toward newer messages. |
| `--scroll-up-sleep 0.8 --no-new-stop 15` | Give Messenger more time to load older messages. |
| `--output .\backup` | Write exports to a different directory. |
| `--help` | See all CLI options. |

To keep results while an export is running, press **Ctrl+C** once and wait for the files to finish writing.

<details>
<summary>Start Brave manually</summary>

```powershell
& "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\MessengerExportBrave" `
  "https://www.facebook.com/messages/"
```

For Chrome, use its executable and a separate profile directory.

</details>

## Firefox on Android and desktop

Build the extension from the repository root. The build only needs Python and uses the same message parser as the CLI.

```powershell
python extension/build.py
```

The build creates `bin/firefox-extension/` and an unsigned `bin/messscrap-firefox-0.1.0.zip`. The extension targets Firefox **140+ on desktop** and **142+ on Android**.

### Android over USB

1. Enable USB debugging in Android and **Remote debugging via USB** in Firefox.
2. Connect the unlocked phone and accept the debugging prompt.
3. Run `adb devices` and use the device ID in the command below. Install Android Platform Tools and Node.js on your computer if needed.
4. In Firefox, open and unlock a specific Messenger conversation. Use **Desktop site** if the mobile page does not display the conversation history.
5. Choose **Extensions → MessScrap → Open panel → Collect history → Save JSON**. The current panel labels are in Polish. See the [Polish quick start](docs/quickstart.pl.md) for the exact labels.

```powershell
npx web-ext run --target=firefox-android --android-device=YOUR_DEVICE_ID --firefox-apk=org.mozilla.firefox --source-dir=bin/firefox-extension
```

This installs the extension temporarily. For an installation that survives a browser restart, submit the ZIP to Mozilla for **unlisted signing**, then install the signed `.xpi` from file. [USB development](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/) · [Install a signed file](https://extensionworkshop.com/documentation/publish/install-self-distributed/)

### Desktop Firefox

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, then select `bin/firefox-extension/manifest.json`. Open a conversation and start MessScrap from the extensions menu.

## What gets exported

| Output | Contents |
| --- | --- |
| **JSON** | Ordered messages with local IDs, source IDs where available, available metadata and a coverage report. |
| **TXT** | Searchable transcript with timestamps and message details. |
| **HTML** | Offline conversation view with links to replies and locally saved attachments. |

The JSON header includes `partial`, `interrupted` and per-direction `coverage`. An `edge_stable` result means Messenger stopped revealing new records at that end during the scan. The conversation may still have older history that the browser did not load. Attachment URLs may expire or work only in the original browser session.

## Privacy and diagnostics

MessScrap runs locally and uses the browser session you open. The optional attachment downloader retrieves files through that session. Exports, attachment URLs and debug samples can contain private conversation data, so review them before sharing. The Git repository excludes local archives, exports and browser snapshots.

When reporting a problem, include your browser and OS versions, whether you used the CLI or extension, and the step that failed. For parser issues, a synthetic example or redacted sample is enough.

## Project layout and tests

```text
main.py       Windows CLI entry point
src/          Browser connection, history collection, export formats
src/dom/      Shared JavaScript parser and scroll logic
extension/    Firefox interface, manifest and build script
tests/        Regression tests and browser smoke tests
docs/         Polish quick start and README artwork
```

```powershell
python -m unittest discover -s tests
```

Browser tests use synthetic chats and opt-in local fixtures. To run the Firefox smoke test, build the extension, set `MESSSCRAP_FIREFOX` to your Firefox executable and run `node tests/test_firefox_extension.mjs`. The test opens a separate profile and checks full and interrupted JSON exports.
