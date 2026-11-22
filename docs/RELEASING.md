# Release preparation

The extension and CLI use the same application version from `package.json`. MessScrap 2.0.1 uses archive schema version `2`. Legacy archive import provides a migration path from older versions.

## Build and verify

Run the same checks as the repository verification workflow with a clean checkout.

The build uses Node.js 22.11 or later, Python 3.10 or later, and Playwright Chromium and Firefox for browser smoke tests.

```sh
npm ci
node scripts/check.mjs
npm test
python3 extension/build.py --target all
npm run pack:cli
node scripts/verify-packages.mjs
npx playwright install --no-shell chromium firefox
node scripts/verify-browser.mjs
node tests/test_chromium_extension.mjs
MESSSCRAP_FIREFOX="$(node -p "require('playwright').firefox.executablePath()")" node tests/test_firefox_extension.mjs
```

Verify the package by installing the tarball in an empty directory and checking `messscrap --version`, `messscrap --help`, and an offline archive import and export. Confirm that the generated extension packages contain the versioned manifests and bundled scripts. Load the package in a compatible browser and verify capture with synthetic data. [Browser compatibility and installation](BROWSERS.md)

The workflow builds release assets from the current checkout and records SHA-256 checksums. Download the workflow artifacts for review. Release publication is a separate authorized action.

## Release assets

- Chromium extension ZIP.
- Firefox extension ZIP for temporary installation or submission to Mozilla signing.
- Versioned npm CLI tarball for local installation on Node.js.
- SHA-256 checksum list.

The original Windows and Python ZIPs remain attached to their historical releases. The 2.0 CLI artifact uses the shared JavaScript implementation and carries the current viewer, archive formats, and scan adapter.

## Publish after review

Confirm that the release tag, package version, extension manifest version, changelog, and assets match. Check the archive schema and CLI migration notes before publishing to GitHub Releases, and upload the checksum list alongside the artifacts. [Changelog](../CHANGELOG.md) · [CLI migration](CLI.md#migrate-from-02x)
