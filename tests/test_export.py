import json
import tempfile
import unittest
from pathlib import Path

from src.browser import conversation_url
from src.exporter import create_export_run, export_items
from src.filters import clean_record
from src.history import MessageHistory
from src.scraper import FIND_CONTAINER, MessengerScraper, SCAN_AND_SCROLL


def message(identifier, text="repeat", **extra):
    return clean_record({"source_message_id": identifier, "text": text, "structured": True, **extra})


class HistoryTests(unittest.TestCase):
    def test_stitches_overlapping_windows_in_both_directions(self):
        history = MessageHistory()
        history.add_window([message("3"), message("5")], 1)
        history.add_window([message("5"), message("6")], 1)
        history.add_window([message("1"), message("2"), message("3"), message("4"), message("5")], -1)
        history.add_window([message("0"), message("1")], -1)
        self.assertEqual([r["source_message_id"] for r in history.records()], list("0123456"))

    def test_preserves_identical_text_on_distinct_nodes_without_ids(self):
        history = MessageHistory()
        history.add_window([message(None, node_id=1), message(None, node_id=2)], 1)
        history.add_window([message(None, node_id=2, author="Ada")], 1)
        self.assertEqual(len(history), 2)
        self.assertEqual(history.records()[1]["author"], "Ada")

    def test_fills_metadata_without_removing_previous_observations(self):
        history = MessageHistory()
        history.add_window([message("a", attachments=[{"kind": "audio"}])], 1)
        history.add_window([message("a", author="Ada", reactions=[{"label": "Reaction"}])], -1)
        record = history.records()[0]
        self.assertEqual(len(history), 1)
        self.assertEqual(record["author"], "Ada")
        self.assertEqual(record["attachments"], [{"kind": "audio"}])
        self.assertEqual(record["reactions"], [{"label": "Reaction"}])

    def test_keeps_full_multiline_text_and_messages_without_text(self):
        text = "Seen\n" + "a" * 4500 + "\nnowy wiersz"
        self.assertEqual(message("a", text)["text"], text)
        self.assertEqual(message("b", "", message_type="video")["message_type"], "video")


class ExportTests(unittest.TestCase):
    def test_round_trip_preserves_native_ids_and_resolves_only_unambiguous_replies(self):
        items = [
            message("a", "<script>test</script>"),
            message("b", "repeat"),
            message("c", "repeat"),
            message("d", "text", reply_to={"source_message_id": "c", "text": "repeat"}),
            message("e", "text", reply_to={"text": "repeat"}),
            message("f", "", message_type="video", attachments=[{"kind": "video", "url": "blob:source"}]),
        ]
        url = "https://www.facebook.com/messages/t/example"
        with tempfile.TemporaryDirectory() as temp:
            run = create_export_run(url, export_dir=Path(temp))
            txt, data, html = export_items(items, url, run, partial=True, directions={"older": "round_limit"})
            payload = json.loads(data.read_text(encoding="utf-8"))
            self.assertEqual(payload["count"], 6)
            self.assertTrue(payload["partial"])
            self.assertEqual(payload["coverage"], {"older": "round_limit"})
            self.assertEqual(payload["items"][3]["reply_to"]["target_message_id"], "local-3")
            self.assertIsNone(payload["items"][4]["reply_to"]["target_index"])
            self.assertEqual(payload["items"][5]["attachments"][0]["url"], "blob:source")
            self.assertIn("blob:source", txt.read_text(encoding="utf-8"))
            rendered = html.read_text(encoding="utf-8")
            self.assertIn("&lt;script&gt;", rendered)
            self.assertNotIn("<script>", rendered)
            self.assertIn('href="#m3"', rendered)

    def test_selects_only_specific_threads_on_messenger_hosts(self):
        self.assertEqual(
            conversation_url("https://www.facebook.com/messages/e2ee/t/123/?ignored=1"),
            "https://www.facebook.com/messages/e2ee/t/123",
        )
        self.assertIsNone(conversation_url("https://www.facebook.com/messages/"))
        self.assertIsNone(conversation_url("https://example.com/?facebook.com/messages/t/123"))


class FixtureDriver:
    def __init__(self, windows):
        self.windows = iter(windows)

    def execute_script(self, script, *args):
        if script == FIND_CONTAINER:
            return "chat-panel"
        assert script == SCAN_AND_SCROLL
        ids, state = next(self.windows)
        return {
            "records": [{"source_message_id": id_, "structured": True, "text": id_} for id_ in ids],
            "state": {"before": 0, "viewport": 100, "height": 200, "atEdge": True, "loading": False, **state},
            "samples": [], "skipped": [],
        }


class ScraperTests(unittest.TestCase):
    def test_waits_at_loading_edge_then_saves_new_older_messages(self):
        driver = FixtureDriver([
            (["c", "d"], {}),
            (["c", "d"], {"loading": True}),
            (["a", "b", "c"], {"height": 300}),
            (["a", "b", "c"], {"height": 300}),
            (["a", "b", "c"], {"height": 300}),
        ])
        scraper = MessengerScraper(driver, "https://www.messenger.com/t/123")
        scraper.scan_direction(-1, limit=10, pause=0, stable_rounds=2)
        self.assertEqual(scraper.directions["older"], "edge_stable")
        self.assertEqual([r["text"] for r in scraper.history.records()], list("abcd"))

    def test_round_limit_keeps_partial_history(self):
        driver = FixtureDriver([(["c", "d"], {"atEdge": False})])
        scraper = MessengerScraper(driver, "https://www.messenger.com/t/123")
        scraper.scan_direction(1, limit=1, pause=0, stable_rounds=2)
        self.assertEqual(scraper.directions["newer"], "round_limit")
        self.assertEqual(len(scraper.history), 2)
