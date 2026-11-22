# Large-archive benchmarks

Run the benchmark from the repository root after installing the development dependencies and Chromium.

```sh
npm ci
npx playwright install chromium
node --expose-gc scripts/benchmark.mjs --browser
```

Measured on Linux x64 with an AMD EPYC 9V74, Node.js 24.22.3, and headless Chrome for Testing 159.0.8154.6. Each row is one measured run on a deterministic synthetic group conversation. The fixture mixes short repeated passages with distinct notes, links, emoji, reactions, and attachment metadata. It excludes media download and live Messenger latency.

| Messages | Normalize | JSON export | JSON parse and import | Core search | Analytics | HTML generation |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 9.9 ms | 1.7 ms | 14.1 ms | 1.7 ms | 18.8 ms | 3.9 ms |
| 10,000 | 75.4 ms | 15.9 ms | 123.7 ms | 10.9 ms | 62.6 ms | 28.0 ms |
| 100,000 | 614.5 ms | 225.8 ms | 1,006.7 ms | 75.4 ms | 550.0 ms | 348.7 ms |
| 250,000 | 1,316.7 ms | 836.1 ms | 2,641.5 ms | 104.9 ms | 1,401.7 ms | 1,992.9 ms |

| Messages | Standalone HTML | Offline viewer open | First viewer search |
| ---: | ---: | ---: | ---: |
| 1,000 | 0.46 MB | 131.5 ms | 191.2 ms |
| 10,000 | 3.91 MB | 162.3 ms | 185.5 ms |
| 100,000 | 38.42 MB | 2,030.2 ms | 242.8 ms |
| 250,000 | 96.24 MB | 2,983.8 ms | 337.0 ms |

Viewer open measures navigation to the local file and appearance of the Messages control. Search measures the first query on that loaded archive, including input, debounce, and display of the result count. The viewer renders up to 100 timeline rows per page, but still parses the complete embedded dataset on open. The ZIP builder holds its output in memory and applies media limits. Device memory, message sizes, and attachment volume affect practical limits.
