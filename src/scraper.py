from pathlib import Path
from time import sleep

from selenium.common.exceptions import StaleElementReferenceException

from .filters import clean_record
from .history import MessageHistory


def read_script(name: str) -> str:
    return (Path(__file__).with_name("dom") / name).read_text(encoding="utf-8")


FIND_CONTAINER = read_script("container.js")
SCAN_AND_SCROLL = (
    """
if (location.origin + location.pathname.replace(/\\/$/, '') !== arguments[7]) {
  return {navigationChanged: true};
}
const collect = () => {
""" + read_script("messages.js") + """
};
const fallback = () => {
""" + read_script("legacy.js") + """
};
const scroll = (direction, move) => {
""" + read_script("scroll.js") + """
};
const result = collect() || fallback();
result.state = scroll(arguments[5], arguments[6]);
return result;
"""
)
MOVE_SCROLL = """
const el = arguments[0];
el.scrollTop += arguments[1] * Math.max(1, Math.floor(el.clientHeight * 0.72));
"""


class NoChatContainerFound(RuntimeError):
    pass


class ConversationChanged(RuntimeError):
    pass


class MessengerScraper:
    def __init__(self, driver, source_url: str, *, debug=False, debug_lite=False, dump_samples=False, media=None):
        self.driver = driver
        self.source_url = source_url
        self.debug = debug
        self.debug_lite = debug_lite
        self.dump_samples = dump_samples
        self.media = media
        self.history = MessageHistory()
        self.samples: list[dict] = []
        self.skipped: list[dict] = []
        self._sample_keys: set = set()
        self._debug_keys: set = set()
        self._round = 0
        self.container = None
        self.directions: dict[str, str] = {}

    def _find_container(self):
        self.container = self.driver.execute_script(FIND_CONTAINER)
        if self.container is None:
            raise NoChatContainerFound("No message panel found. Open and unlock the conversation.")

    def _scan(self, direction: int, move: bool):
        if self.container is None:
            self._find_container()
        for attempt in range(2):
            try:
                result = self.driver.execute_script(
                    SCAN_AND_SCROLL,
                    self.container, self.debug, self.dump_samples and len(self.samples) < 30,
                    self.debug_lite, 30 - len(self.samples), direction, move, self.source_url,
                    self.media is not None,
                )
            except StaleElementReferenceException:
                if attempt:
                    raise
                self._find_container()
            else:
                if result.get("navigationChanged"):
                    raise ConversationChanged("The tab switched to a different conversation.")
                return result

    def _capture_debug(self, result: dict):
        for sample in result["samples"]:
            key = sample.get("source_message_id") or sample.get("outer_html") or sample.get("text")
            if len(self.samples) < 30 and key not in self._sample_keys:
                self._sample_keys.add(key)
                self.samples.append({"round": self._round, **sample})
        for item in result["skipped"]:
            if len(self.skipped) >= 2000:
                break
            key = (item.get("reason"), item.get("text"), item.get("ariaLabel"))
            if key not in self._debug_keys:
                self._debug_keys.add(key)
                self.skipped.append({"round": self._round, **item})

    def scan_direction(self, direction: int, *, limit: int, pause: float, stable_rounds: int) -> None:
        label = "older" if direction < 0 else "newer"
        self.directions[label] = "in_progress"
        stable = 0
        previous_edge = None
        for round_number in range(1, limit + 1):
            self._round += 1
            result = self._scan(direction, move=self.media is None and round_number < limit)
            records = [cleaned for raw in result["records"] if (cleaned := clean_record(raw)) is not None]
            self._capture_debug(result)
            try:
                if self.media:
                    self.media.enrich(records)
            finally:
                added, updated = self.history.add_window(records, direction)

            state = result["state"]
            edge = (state["height"], state["before"], state["viewport"])
            if state["atEdge"] and not state["loading"] and not added and not updated and edge == previous_edge:
                stable += 1
            else:
                stable = 0
            previous_edge = edge if state["atEdge"] else None
            if round_number == 1 or round_number % 25 == 0 or stable == stable_rounds:
                print(f"Round {round_number} ({label}) | +{added}, {len(self.history)} total")
            if stable >= stable_rounds:
                self.directions[label] = "edge_stable"
                return
            if round_number < limit:
                if self.media:
                    try:
                        self.driver.execute_script(MOVE_SCROLL, self.container, direction)
                    except StaleElementReferenceException:
                        self._find_container()
                sleep(pause)
        self.directions[label] = "round_limit"
