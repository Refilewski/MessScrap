# Browser compatibility

| Platform | Browser | MessScrap 2.0.1 |
| --- | --- | --- |
| Windows, macOS, Linux | Chrome, Brave, Chromium | Supported desktop target. The Manifest V3 package is tested in desktop Chromium with synthetic conversations. |
| Windows, macOS, Linux | Firefox 140+ | Supported desktop target. The Firefox package is tested in a temporary desktop profile with synthetic conversations. |
| Android | Firefox 142+ | Experimental. Development installation is documented below. Live capture still needs device testing. |
| Android | Standard Google Chrome | Unsupported for extension installation. Chrome's **Add to Desktop** sends the extension to a computer. [Google Chrome Web Store Help](https://support.google.com/chrome_webstore/answer/2664769) |
| Android | Vivaldi 8.2+ | Vivaldi documents loading unpacked extensions. The MessScrap package and live capture are unverified on this browser. [Vivaldi Android extensions guide](https://help.vivaldi.com/android/android-tools/extensions-on-android/) |
| Android | Microsoft Edge | Edge offers a mobile extension catalog. Local installation depends on the browser channel and its developer options. MessScrap's ZIP installation and runtime are unverified. [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/microsoft-edge-extensions?hl=en-US) · [Kiwi's migration notes on Edge Canary](https://github.com/kiwibrowser/src.next) |
| Android | Kiwi | Archived by its maintainers in January 2025. MessScrap has no supported Kiwi installation path. [Kiwi project status](https://github.com/kiwibrowser/src.next) |
| iOS, iPadOS | Orion | Experimental. Orion implements a subset of WebExtensions on WebKit. Local installation and live capture need device testing for this patch. [Orion extension support](https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html) |

The offline viewer opens exported HTML or an extracted ZIP on desktop and mobile browsers. The CLI runs on desktop systems with Node.js.

## Desktop installation

Build from the checkout if the release package is unavailable. The command below produces separate browser folders and ZIPs under `bin/`.

```sh
npm ci
python3 extension/build.py --target all
```

- In desktop Chrome, Brave, or Chromium, extract the Chromium ZIP and select the folder containing `manifest.json` using **Extensions → Developer mode → Load unpacked**. The ZIP is a distribution archive. Chrome's local development workflow loads the extracted folder. [Chrome developer installation guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
- In desktop Firefox, extract the Firefox ZIP, open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose the extracted `manifest.json`. Persistent installation in standard release builds requires Mozilla signing. [Firefox temporary installation guide](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)

## Firefox for Android

1. Build the Firefox variant and use the generated `bin/firefox-extension` directory, or extract the Firefox ZIP.
2. On the development computer, install Android Platform Tools (`adb`) and Mozilla's `web-ext`. On the phone, enable Android USB debugging and Firefox's **Remote debugging via USB** option, then connect the phone and accept the prompt.
3. From the extracted extension directory or `bin/firefox-extension`, run the command below. Select the connected device and the installed Firefox edition when prompted.

```sh
web-ext run -t firefox-android
```

This loads a temporary development add-on. A supported persistent installation requires an appropriately signed add-on. The build ZIP is unsigned. [Mozilla Android development guide](https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/) · [Mozilla add-on distribution guide](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

## Orion on iOS and iPadOS

1. In Orion, open **… → Settings → Extensions** and enable Chrome extensions.
2. Save the official or locally built Chromium ZIP to Files. In Orion, open **… → Extensions**, tap **+**, choose the file installation option, and select the ZIP. Kagi also documents selecting `manifest.json` from an extracted folder as a file installation option.
3. With a Messenger conversation open, select MessScrap from **Extensions**, allow access to Messenger if Orion prompts you, and choose **Open panel**.

Orion's extension feature is in beta. Its file picker and installed extension list can confirm whether installation succeeded. Capture, checkpoint storage, and export downloads still require separate checks on the device. [Orion iOS extension guide](https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html) · [Kagi staff guidance on accepted formats](https://orionfeedback.org/d/936-install-from-file-for-extensions/20)

## Mobile Chromium installation report

The published 2.0.0 Chromium and Firefox ZIPs match the release checksums and contain a root-level Manifest V3 and the referenced files. Desktop Chromium loaded the extracted Chromium ZIP with its original permissions. Its service worker and popup started. [MessScrap v2.0.0 release](https://github.com/Refilewski/MessScrap/releases/tag/v2.0.0)

The reported failure did not identify the mobile browser, its version or channel, the installation steps, or the error shown. Local installation on mobile depends on the browser's extension distribution format and APIs. Vivaldi documents loading the extracted folder from **Manage Extensions → Developer Mode → Load unpacked**. Edge may expose catalog and channel-specific developer routes. [Vivaldi Android extensions guide](https://help.vivaldi.com/android/android-tools/extensions-on-android/) · [Kiwi's migration notes on Edge Canary](https://github.com/kiwibrowser/src.next)

If installation fails, include the browser name and version, OS version, exact package filename, installation steps, and the displayed error in your report.

## Mobile capture and verification

Open a specific Messenger conversation and unlock its history. Try **Desktop Site** if Messenger shows an app prompt or does not render the conversation. This setting requests a desktop page. Messenger can still render a narrow or otherwise different layout based on the browser and viewport.

Opening the panel confirms that injection reached the Messenger tab. Capture starts after MessScrap can associate the visible message list with the active conversation. A thread URL, open panel, and visible rows can coexist while Messenger is still switching conversations. If verification fails, keep the target thread open and allow its history to settle, then retry in the panel. Expand **Diagnostics** for the last verification condition and use **Copy diagnostics** to obtain a report. [Troubleshooting](../README.md#troubleshooting)

In 2.0.0, both discovery and verification depended on rows having `data-message-id` or `aria-roledescription="message"`. A pane could also lack the expected log or grid role or the evidence tying it to the active thread. Any of these conditions could leave verification waiting until its deadline. No signed-in mobile DOM sample was available for either report. Missing row markers, a different pane structure, and delayed or incomplete identity evidence remain possible explanations on the reported devices.

The popup uses tab selection and script injection under the browser's active-tab permission. Capture runs in the Messenger page. Preferences and checkpoints use extension storage through the browser's background execution, and exports use a local Blob download. Keep the Messenger tab in the foreground during a scan. Mobile browsers can suspend a background tab or the extension when their app is switched away. [WebExtensions activeTab behavior](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions#activetab_permission) · [Orion API documentation](https://help.kagi.com/orion/misc/technical.html)

Device verification still needs Firefox Android and Orion iOS scenarios covering direct navigation, conversation switching, delayed or locked history, touch scrolling, scan controls, foreground and background transitions, checkpoint recovery, and successful downloads. Narrow-viewport tests exercise synthetic DOM fixtures. They establish behavior for those fixtures and do not identify the markup served to the reported devices.
