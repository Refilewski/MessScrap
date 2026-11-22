# MessScrap 2.0 implementation checklist

This file tracks the overhaul and the verification that remains. Update an item when its changes and evidence are available. Messenger screenshots and tests use synthetic conversations.

## Baseline

- [x] Inspect repository, history, tags, legacy builds, and tests.
- [x] Audit prior release paths. Extension releases build from current source. The Python workflow packages and replaces assets under the fixed `v0.2.0` tag.
- [x] Keep archive, session and credential data out of test fixtures and documentation.
- [x] Select coordinated `2.0.0` application versions and archive schema `2`. Record the CLI and archive migration paths.
- [x] Identify the license state. The baseline has no software license or GitHub license metadata.

## Implementation

- [x] Guard capture against route changes and stale message DOM. Revalidate before consuming scan results.
- [x] Match native message IDs and ordered observations. Test virtualized lists, repeated messages, missing IDs and uncertain overlap.
- [x] Expose capture states, cancellation, pause/resume, elapsed time, throughput, date range and attachment counts. Test empty windows and partial coverage.
- [x] Move normalization, validation, merging, analytics and export format handling into the browser-compatible shared core.
- [x] Implement offline viewer navigation, filters, full-text search, replies, media and file access, links, themes and responsive layout.
- [x] Implement offline statistics views, CLI JSON/CSV statistics and metric documentation.
- [x] Download authorized, available attachments with bounded concurrency, retry, timeout and cancellation.
- [x] Build complete ZIPs and report attachment outcomes in the manifest.
- [x] Persist scoped checkpoints in the browser and CLI, verify integrity and restore from synthetic interruptions.
- [x] Merge live overlapping captures and imported archives with clear uncertainty, preserved originals and updated export formats.
- [x] Discover and select visible conversations with isolated batch capture, cancellation, per-conversation status and optional combined index.
- [x] Migrate compatible earlier and official Messenger JSON. Verify validation errors for bad media paths and malformed archives.
- [x] Replace the legacy packaged CLI and retain or document earlier invocation modes.
- [x] Ship the compact extension panel with preferences, scan state, format actions and checkpoint controls.
- [x] Remove obsolete exporters and packaging paths.

## Verification and delivery

- [x] Run targeted regression tests, lint or syntax checks and production builds.
- [x] Install and smoke-test the generated CLI package from a clean directory. Verify exact version and sample exports.
- [x] Load the Chromium and Firefox extension builds and exercise the panel with synthetic Messenger fixtures.
- [x] Validate representative archives and test the offline HTML viewer with networking disabled.
- [x] Capture actual extension, archive viewer and analytics screenshots. Check desktop and mobile layouts.
- [x] Measure synthetic 1,000, 10,000 and 100,000 message archives and publish actual measurements.
- [x] Review HTML escaping, unsafe links and CSV cells, attachment sources, safe paths, and ZIP validation.
- [x] Prepare versioned extension and CLI artifacts with matching SHA-256 checksums and manual publication.
- [x] Draft the English README, command reference, architecture and statistics guide, changelog, and release instructions.
- [x] Cross-check the README screenshots, command options, paths, versions and documented limitations against the build.
- [x] Prepare the dedicated `feature/messscrap-2` branch for review against `main`.

## Remaining verification and decisions

- [ ] Validate against signed-in Messenger sessions on representative accounts and supported locales. Local browser tests use intercepted synthetic conversations.
- [ ] Verify Firefox on Android and install the CLI on Windows and macOS. These platforms were unavailable for local smoke testing.
- [ ] Confirm the maintainer's intended license. The repository has no existing software license.
