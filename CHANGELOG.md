# Changelog

## 2.0.0 (unreleased)

### Added

- Minimize the extension panel during a scan and reopen it with the scan intact. Recover the previous verified result after a retry captures no messages.
- A standalone offline archive viewer with searchable conversations, media, link and file views, date navigation, and conversation analytics.
- Shared archive schema v2 with older MessScrap import, compatible official Messenger JSON import, and archive merging.
- CSV and ZIP exports, including shared statistics and an attachment status manifest.
- Browser-local and CLI checkpoints for resumable capture.
- A compact browser scan panel with local preferences, scan controls, and theme selection.
- Individual and combined batch archives for selected conversations.
- Cross-platform CLI packaging with commands for export, import, validation, search, stats, updates, and batch processing.

### Fixed

- Conversation switching now interrupts capture and invalidates stale export results. The scanner waits for evidence that the message list belongs to the target conversation.
- Native message IDs and ordered overlap matching improve handling of virtualized message lists and repeated messages.
- Missing message windows and uncertain scroll boundaries now report incomplete capture.
- Extension and CLI builds use the same export implementation and viewer.

### Changed

- The standalone CLI is distributed as an installable Node.js tarball. The flags-only capture form remains available. See the [migration instructions](docs/CLI.md#migrate-from-02x).
- Version and packaging checks apply to generated artifacts built from the current checkout. CI prepares artifacts for release review.
- HTML rendering, CSV cell escaping, and relative media paths are shared across archive producers.
- The viewer renders bounded pages of messages and lazy-loads images. ZIP export stores identical archived media once per conversation.

### Known limitations

- Live capture depends on the current Messenger layout and the history visible in the authorized session.
- A stable scroll edge can leave coverage partial. Missing IDs and timestamps can make some overlaps ambiguous.
- Attachment access varies by media type, browser, and whether Messenger still exposes the attachment to the session.

## 0.2.1

- Added extension TXT export alongside JSON.
- Published Chromium and Firefox extension ZIPs.

## 0.2.0

- Distributed the original Python CLI and Windows portable executable.
