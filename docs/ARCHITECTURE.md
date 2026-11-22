# Capture and archive internals

The browser extension and CLI use the same browser-side DOM capture and archive modules. Browser attachment access, checkpoint storage, and file writes are specific to each environment. The generated HTML contains its own renderer, styles, and archive data.

## Conversation identity and scan coverage

A Messenger route identifies the intended conversation. The scanner checks that the active message list belongs to that conversation before reading it and invalidates the scan when the conversation changes. Where the page lacks sufficient evidence after single-page navigation, capture waits or stops. A directly loaded conversation can help the browser establish a fresh baseline.

Capture uses Messenger's visible message list and follows scrolling as older or newer messages appear. A completed capture requires explicit boundary evidence. A round limit, stopped history load, missing message list, ambiguous transition, or cancelled scan can leave coverage incomplete. The manifest and archive metadata preserve the scan state and reason. The total history size is usually unknown, so message counts and elapsed time are more informative than a progress percentage.

Native Messenger IDs identify messages when available. Fallback matching uses the ordered overlap of neighboring message observations. The collector uses author, content, timestamps, direction, message type, and attachments when available. Separate identical messages in the same ordered window are preserved. Ambiguous observations may produce duplicate records, especially when Messenger omits IDs and neighboring messages.

## Archive schema v2

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Archive format version. |
| `conversation` | Conversation ID, name, participants, and available avatar information. |
| `scan` | Scan state, reason, timing, and available direction coverage. |
| `messages` | Ordered messages with local IDs and optional native message IDs. |
| `exportedAt` | Export timestamp. |
| `sourceUrl` | Messenger conversation URL when available. |

A message may include a UTC timestamp, display date or time, author, direction, message type, replies, reactions, links, and attachment metadata. Unknown values can be empty or null. Native message IDs and linked local IDs support navigation to a captured reply target.

A ZIP includes `index.html`, `messages.json`, `messages.txt`, `messages.csv`, `metadata.json`, `statistics.json`, `manifest.json`, `README.txt`, and the available media. Attachment records retain their original display labels and MIME types when known. View the manifest to distinguish archived, unavailable, failed, and skipped media.

Archived media file paths use content hashes so repeated transfers can share one file. The manifest and viewer retain the display filename where available. Live attachment source URLs are used during capture and media transfer. Exported archives reference the relative paths of saved media.

When importing legacy MessScrap JSON or compatible official Messenger JSON, the importer maps available fields to schema v2. The validator can report a malformed archive, unsupported schema, missing relative files, or a manifest mismatch.

## Checkpoints and updates

A checkpoint associates an observed message history with one conversation ID. Resume verifies overlap with new observations before restoring saved messages. When overlap cannot be established, the scanner keeps the prior checkpoint and reports the new capture separately.

An incremental update keeps historical messages and matches the overlapping capture by native ID or sufficiently supported sequence evidence. An update reports additions, updates, unchanged messages, conflicts, and coverage uncertainty. A visible overlap can support deduplication while gaps in what Messenger exposed can remain unknown.

## Statistics

Analytics summarize the captured messages, or the messages matching the dashboard's participant and date filters. Unknown dates and senders limit date- and participant-based calculations.

| Metric | Calculation |
| --- | --- |
| Messages, participants, links, reactions, attachments | Counts from the captured records and their available metadata. |
| Words and word frequency | Unicode word-like segments, normalized for frequency counting. |
| Characters and message length | Unicode code points in message text. Mean and median summarize the messages with text. |
| Emojis | Emoji-bearing Unicode grapheme clusters. Sequences such as a combined emoji count as a unit. |
| Activity by date, hour, week, month, and year | Buckets use dated messages in UTC. Weeks start on Monday. |
| Calendar heatmap and active dates | Observed message counts on each UTC date. |
| Conversation age | The difference between the earliest and latest observed UTC calendar dates. |
| Longest activity streak | The longest run of consecutive UTC dates with captured messages. |
| Longest inactivity period | The most intervening whole UTC dates between two observed active dates. |
| Estimated response time | Mean and median of positive gaps of up to 24 hours between adjacent dated messages from different known authors. System, event, call, and unsent rows are excluded. With a participant filter, samples count when that participant sent the later message. |

A response-time sample measures a change of speaker. A message with no known date or sender breaks the sequence. Samples can reflect group conversation activity or overlapping exchanges, so interpret them as estimates. Streak and inactivity values are bounded by captured dated messages. A metric with insufficient evidence is unavailable.

## Local data and rendering

The viewer operates from `file://`. It reads relative paths for archived media and opens external links only after a user action. Conversation text is rendered as text. Archive readers validate relative paths before accessing media, and CSV export protects cells that spreadsheet programs could interpret as formulas.

Capture and optional media retrieval use the user's authorized browser session. MessScrap requires no server account or synchronization service. Avoid sharing private source archives, checkpoints, or attachment URLs when reporting issues.
