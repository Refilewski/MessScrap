import base64
import binascii
import hashlib
from pathlib import Path

from selenium.common.exceptions import TimeoutException

MAX_FILE_BYTES = 25 * 1024 * 1024
EXTENSIONS = {
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".weba",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "video/ogg": ".ogv",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
}
DOWNLOAD_SCRIPT = (Path(__file__).with_name("dom") / "download.js").read_text(encoding="utf-8")


class MediaDownloader:
    def __init__(self, driver, destination: Path):
        self.driver = driver
        self.destination = destination
        self.results: dict[tuple, dict] = {}

    def enrich(self, records: list[dict]) -> None:
        try:
            self._enrich(records)
        finally:
            for record in records:
                for attachment in record["attachments"]:
                    attachment.pop("_url_inline_index", None)
                    attachment.pop("_preview_url_inline_index", None)

    def _enrich(self, records: list[dict]) -> None:
        for record in records:
            identifier = record["source_message_id"] or record["node_id"]
            for index, attachment in enumerate(record["attachments"]):
                for url_field, path_field, error_field in (
                    ("url", "local_path", "download_error"),
                    ("preview_url", "preview_local_path", "preview_download_error"),
                ):
                    url = attachment.get(url_field)
                    inline = attachment.get(f"_{url_field}_inline_index")
                    if inline is not None:
                        key = ("inline", identifier, index, url_field)
                        source = inline
                    elif url and url.startswith(("https://", "http://", "blob:")):
                        key = ("url", url)
                        source = url
                    else:
                        continue
                    if key not in self.results:
                        self.results[key] = self._download(source)
                    result = self.results[key]
                    if "path" in result:
                        attachment[path_field] = result["path"]
                    else:
                        attachment[error_field] = result["error"]

    def _download(self, source: str | int) -> dict:
        try:
            response = self.driver.execute_async_script(DOWNLOAD_SCRIPT, source, MAX_FILE_BYTES)
        except TimeoutException:
            return {"error": "timeout"}
        if not response or "error" in response:
            return {"error": response.get("error", "unavailable") if response else "unavailable"}

        try:
            content = base64.b64decode(response["data"], validate=True)
        except (binascii.Error, KeyError, ValueError):
            return {"error": "invalid response"}
        if not 0 < len(content) <= MAX_FILE_BYTES:
            return {"error": "invalid file size"}

        mime_type = response.get("type", "").partition(";")[0].strip().lower()
        if mime_type in {"text/html", "application/xhtml+xml"}:
            return {"error": "HTML response"}
        filename = hashlib.sha256(content).hexdigest() + EXTENSIONS.get(mime_type, ".bin")
        directory = self.destination / "media"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / filename
        if path.is_file():
            return {"path": f"media/{filename}"}
        temporary = path.with_suffix(".tmp")
        try:
            temporary.write_bytes(content)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return {"path": f"media/{filename}"}
