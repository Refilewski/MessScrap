import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait

from extension.build import build
from src import browser
from src.media import MediaDownloader
from src.scraper import MessengerScraper


@unittest.skipUnless(os.environ.get("MESSSCRAP_CHROMIUM") and os.environ.get("MESSSCRAP_CHROMEDRIVER"), "requires local Chromium and ChromeDriver")
class ChromiumExtensionTests(unittest.TestCase):
    def test_install_package_and_open_popup(self):
        options = webdriver.ChromeOptions()
        if not hasattr(options, "enable_webextensions"):
            self.skipTest("requires Selenium WebExtension support")
        options.binary_location = os.environ["MESSSCRAP_CHROMIUM"]
        options.enable_webextensions = True
        options.web_socket_url = True
        for flag in ("--headless=new", "--disable-background-networking", "--disable-gpu", "--no-first-run"):
            options.add_argument(flag)
        with tempfile.TemporaryDirectory() as temp:
            directory, _ = build(Path(temp), "chromium")
            with webdriver.Chrome(options=options, service=Service(os.environ["MESSSCRAP_CHROMEDRIVER"])) as driver:
                installed = driver.webextension.install(path=str(directory))
                driver.get(f"chrome-extension://{installed['extension']}/popup.html")
                self.assertEqual(driver.title, "MessScrap")
                driver.find_element(By.ID, "open").click()
                WebDriverWait(driver, 5).until(
                    lambda page: "Open a specific conversation" in page.find_element(By.ID, "status").text
                )


@unittest.skipUnless(os.environ.get("MESSSCRAP_CHROMIUM") and os.environ.get("MESSSCRAP_CHROMEDRIVER"), "requires local Chromium and ChromeDriver")
class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        options = webdriver.ChromeOptions()
        options.binary_location = os.environ["MESSSCRAP_CHROMIUM"]
        for flag in ("--headless=new", "--disable-background-networking", "--disable-gpu", "--no-first-run"):
            options.add_argument(flag)
        cls.driver = webdriver.Chrome(options=options, service=Service(os.environ["MESSSCRAP_CHROMEDRIVER"]))
        cls.addClassCleanup(cls.driver.quit)
        cls.driver.execute_cdp_cmd("Network.enable", {})
        cls.driver.execute_cdp_cmd("Network.setBlockedURLs", {"urls": ["http://*", "https://*"]})

    def current_origin_path(self):
        return self.driver.execute_script("return location.origin + location.pathname;")

    def test_attach_to_running_browser(self):
        address = self.driver.capabilities["goog:chromeOptions"]["debuggerAddress"]
        self.driver.get("about:blank")
        with patch.object(browser, "DEBUGGER_ADDRESS", address):
            attached = browser.attach_to_browser()
            try:
                self.assertEqual(attached.current_url, "about:blank")
            finally:
                attached.quit()
        self.assertEqual(self.driver.current_url, "about:blank")

    def test_scrolls_virtualized_chat_and_saves_media_before_moving(self):
        fixture = """<!doctype html><meta charset="utf-8">
<style>
#chat { width: 600px; height: 240px; overflow: auto; }
#list { height: 1920px; position: relative; }
.row { position: absolute; height: 90px; width: 550px; }
</style>
<main role="main"><div id="chat"><div role="log" id="list"></div></div></main>
<script>
const chat = document.querySelector('#chat');
const list = document.querySelector('#list');
const blobUrl = URL.createObjectURL(new Blob(['media test'], {type: 'video/mp4'}));
function render() {
  const start = Math.max(0, Math.floor(chat.scrollTop / 80) - 1);
  const end = Math.min(24, start + 7);
  list.replaceChildren();
  for (let i = start; i < end; i++) {
    const row = document.createElement('article');
    row.className = 'row';
    row.dataset.messageId = 'id-' + i;
    row.style.top = (i * 80) + 'px';
    row.setAttribute('aria-label', 'At November 8, 2026 at 9:30 PM, You: repeat');
    row.innerHTML = '<div dir="auto">repeat</div>';
    if (i === 2) row.innerHTML = '<div dir="auto">Seen<br>' + 'x'.repeat(4500) + '</div>';
    if (i === 4) {
      row.innerHTML = '<div role="button" aria-label="Go to Ada’s message" data-reply-to-message-id="id-2"><div dir="auto">quote</div></div>'
        + '<div dir="auto">answer</div><button aria-label="1 reaction"><img alt="👍">1</button><img alt="Seen by Ada">';
    }
    if (i === 5) {
      row.setAttribute('aria-label', 'At 9:30 PM, You');
      row.innerHTML = '<video preload="none" src="' + blobUrl + '"></video>';
    }
    list.append(row);
  }
}
chat.scrollTop = 800;
chat.addEventListener('scroll', render);
render();
</script>"""
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            page = folder / "fixture.html"
            page.write_text(fixture, encoding="utf-8")
            self.driver.get(page.as_uri())
            downloader = MediaDownloader(self.driver, folder)
            scraper = MessengerScraper(self.driver, self.current_origin_path(), media=downloader)
            for direction in (1, -1):
                scraper.scan_direction(direction, limit=30, pause=0.07, stable_rounds=2)
            items = scraper.history.records()
            self.assertEqual([item["source_message_id"] for item in items], [f"id-{i}" for i in range(24)])
            self.assertEqual(items[2]["text"], "Seen\n" + "x" * 4500)
            self.assertEqual(items[4]["text"], "answer")
            self.assertEqual(items[4]["reply_to"]["source_message_id"], "id-2")
            self.assertEqual(items[4]["reactions"][0]["count"], 1)
            self.assertEqual(items[4]["receipts"], ["Seen by Ada"])
            self.assertEqual(items[1]["date"], "November 8, 2026")
            self.assertEqual(items[5]["message_type"], "video")
            self.assertEqual((folder / items[5]["attachments"][0]["local_path"]).read_bytes(), b"media test")
            self.assertEqual(scraper.directions, {"newer": "edge_stable", "older": "edge_stable"})

    def test_private_saved_pages_if_supplied(self):
        sample_dir = os.environ.get("MESSSCRAP_SNAPSHOT_DIR")
        if not sample_dir:
            self.skipTest("no local snapshots supplied")
        from lxml import html

        for original in sorted(Path(sample_dir).glob("*.html")):
            with self.subTest(snapshot=original.name), tempfile.TemporaryDirectory() as temp:
                document = html.parse(str(original))
                root = document.getroot()
                for el in root.xpath("//script|//iframe|//object|//embed|//base|//meta[@http-equiv]|//link"):
                    if el.getparent() is not None:
                        el.drop_tree()
                for el in root.iter():
                    for key in tuple(el.attrib):
                        if key.startswith("on"):
                            del el.attrib[key]
                source_rows = root.xpath('//*[@role="main"]//*[@role="log"]//*[@data-message-id]')
                expected = [row.get("data-message-id") for row in source_rows]
                self.assertGreater(len(expected), 0)
                page = Path(temp) / "snapshot.html"
                page.write_bytes(html.tostring(root, encoding="UTF-8", method="html"))
                self.driver.get(page.as_uri())
                downloader = MediaDownloader(self.driver, page.parent)
                scraper = MessengerScraper(self.driver, self.current_origin_path(), media=downloader)
                scraper.scan_direction(1, limit=1, pause=0, stable_rounds=1)
                items = scraper.history.records()
                self.assertEqual([item["source_message_id"] for item in items], expected)
                self.assertTrue(all(item["datetime_raw"] and item["time"] for item in items))
                embedded = [
                    attachment for item in items for attachment in item["attachments"]
                    if attachment.get("url_scheme") == "data"
                ]
                expected_embedded = sum(len(row.xpath('.//img[starts-with(@src, "data:image/")]')) for row in source_rows)
                self.assertEqual(len(embedded), expected_embedded)
                for attachment in embedded:
                    self.assertTrue((page.parent / attachment["local_path"]).is_file())
                    self.assertNotIn("_url_inline_index", attachment)
                if root.xpath('//*[@data-message-id]//*[@role="img"][contains(@aria-label, "sticker") and contains(@style, "blob:")]'):
                    self.assertTrue(any(
                        asset["kind"] == "sticker" and (asset["url"] or "").startswith("blob:")
                        for item in items for asset in item["attachments"]
                    ))
                kinds = sorted({item["message_type"] for item in items})
                print(f"{original.name}: {len(items)} / {len(expected)} IDs, types={', '.join(kinds)}, embedded files={len(embedded)}")
