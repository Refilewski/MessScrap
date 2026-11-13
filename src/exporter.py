import json
import re
import unicodedata
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .config import EXPORT_DIR
from .filters import normalize_text

REPLY_FIELDS = ("target_index", "target_message_id", "author", "text", "date", "time", "source_message_id", "label")
ITEM_FIELDS = ("source_message_id", "author", "date", "time", "datetime_raw", "timestamp", "accessibility_label")
LIST_FIELDS = ("attachments", "links", "reactions", "receipts")


@dataclass(frozen=True)
class ExportRun:
    exported_at: str
    filename_time: str
    conversation_dir: Path
    debug_dir: Path


def create_export_run(source_url: str, page_title: str = "", export_dir: Path = EXPORT_DIR) -> ExportRun:
    now = datetime.now().astimezone()
    thread = unquote(urlsplit(source_url).path.rstrip("/").rsplit("/", 1)[-1])
    title = re.sub(r"\s*[|–-]\s*(?:Messenger|Facebook).*$", "", page_title, flags=re.I).strip()
    if title.casefold() in {"messenger", "facebook", ""}:
        title = ""
    ascii_title = unicodedata.normalize("NFKD", f"{title}-{thread}").encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-") or "conversation"
    if slug in {"con", "prn", "aux", "nul"} or re.fullmatch(r"(?:com|lpt)[1-9]", slug):
        slug = f"conversation-{slug}"
    timestamp = now.strftime("%Y-%m-%d_%H-%M-%S")
    subfolder = Path(slug[:80]) / now.strftime("%Y-%m-%d_%H-%M-%S_%f")
    return ExportRun(
        exported_at=now.isoformat(timespec="seconds"),
        filename_time=timestamp,
        conversation_dir=export_dir / "conversations" / subfolder,
        debug_dir=export_dir / "debug" / subfolder,
    )


def resolve_reply_targets(items: list[dict]) -> None:
    by_source = {item["source_message_id"]: item for item in items if item["source_message_id"]}
    by_text: dict[str, dict | None] = {}
    by_author: dict[tuple, dict | None] = {}
    for item in items:
        reply = item["reply_to"]
        target = None
        if reply["source_message_id"]:
            target = by_source.get(reply["source_message_id"])
        elif quote := normalize_text(reply["text"]):
            author = normalize_text(reply["author"]).casefold()
            target = by_author.get((quote, author)) if author else by_text.get(quote)
        if target is not None and target is not item:
            reply["target_index"] = target["index"]
            reply["target_message_id"] = target["message_id"]

        text = normalize_text(item["text"])
        if text:
            key = (text, normalize_text(item["author"]).casefold())
            by_author[key] = None if key in by_author else item
            by_text[text] = None if text in by_text else item


def build_payload(items: list[dict], source_url: str, run: ExportRun, *, partial=False, interrupted=False, directions=None) -> dict:
    messages = []
    for index, item in enumerate(items, 1):
        avatar = item.get("avatar") or {}
        reply = item.get("reply_to") or {}
        messages.append({
            "index": index,
            "message_id": f"local-{index}",
            **{field: item.get(field) for field in ITEM_FIELDS},
            "direction": item.get("direction") or "unknown",
            "text": item.get("text") or "",
            "message_type": item.get("message_type") or "unknown",
            "avatar": {field: avatar.get(field) for field in ("url", "alt")},
            "reply_to": {field: reply.get(field) for field in REPLY_FIELDS},
            **{field: item.get(field) or [] for field in LIST_FIELDS},
        })
    resolve_reply_targets(messages)
    return {
        "exported_at": run.exported_at,
        "source_url": source_url,
        "partial": partial,
        "interrupted": interrupted,
        "coverage": dict(directions or {}),
        "count": len(messages),
        "items": messages,
    }


@contextmanager
def atomic_output(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as file:
            yield file
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def write_json(path: Path, payload: object) -> None:
    with atomic_output(path) as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")


def details(item: dict) -> list[tuple[str, str]]:
    lines = []
    reply = item["reply_to"]
    if any(reply.values()):
        target = f"#{reply['target_index']}" if reply["target_index"] else reply["author"] or reply["label"]
        quote = reply["text"] or ""
        lines.append(("Reply", " · ".join(part for part in (target, quote) if part)))
    for entry in item["attachments"]:
        label = entry.get("label") or entry.get("filename") or entry["kind"]
        source = entry.get("local_path") or entry.get("url")
        parts = [label, source]
        if entry.get("download_error"):
            parts.append(entry["download_error"])
        lines.append(("Attachment", " · ".join(part for part in parts if part)))
    for entry in item["links"]:
        lines.append(("Link", entry["url"]))
    for entry in item["reactions"]:
        lines.append(("Reaction", entry["label"]))
    for entry in item["receipts"]:
        lines.append(("Status", entry))
    return lines


def message_heading(item: dict) -> str:
    author = item["author"] or ("You" if item["direction"] == "me" else "Unknown sender")
    moment = item["timestamp"] or item["datetime_raw"] or " ".join(
        value for value in (item["date"], item["time"]) if value
    )
    parts = [f"#{item['index']}", author, moment, item["message_type"], item["source_message_id"]]
    return " · ".join(value for value in parts if value)


TXT_URL_PATTERN = re.compile(r"(?i)(?:\b(?:https?://|ftp://|www\.)|\bblob:)[^\s<>\[\]\"']+")


def txt_text(value: object) -> str:
    """Keep conversation text, but hide URLs in this human-readable view."""
    return TXT_URL_PATTERN.sub("[link]", str(value or "").replace("\r\n", "\n").replace("\r", "\n")).strip()


def txt_day(item: dict) -> str:
    day = item.get("date") or ""
    if day:
        return day
    timestamp = item.get("timestamp") or ""
    match = re.match(r"^\d{4}-\d{2}-\d{2}", timestamp)
    return match.group(0) if match else ""


def txt_time(item: dict) -> str:
    if item.get("time"):
        return item["time"]
    match = re.match(r"^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})", item.get("timestamp") or "")
    return match.group(1) if match else ""


def txt_attachment(entry: dict) -> str:
    kind = txt_text(entry.get("kind") or "attachment")
    label = txt_text(entry.get("filename") or entry.get("label"))
    return f"{kind}: {label}" if label and label.casefold() != kind.casefold() else kind


def write_txt(path: Path, payload: dict) -> None:
    by_index = {item["index"]: item for item in payload["items"]}
    previous_day = None
    previous_group = None
    with atomic_output(path) as file:
        file.write(f"Messenger conversation · {payload['count']} messages\n")
        file.write(f"Exported: {payload['exported_at']}\n")
        if payload.get("partial"):
            file.write("Partial export — some history may be missing.\n")

        for item in payload["items"]:
            day = txt_text(txt_day(item))
            if day != previous_day:
                if day:
                    file.write(f"\n── {day} ──\n")
                previous_day = day
                previous_group = None
            author = txt_text(item.get("author") or ("You" if item.get("direction") == "me" else "Unknown"))
            moment = txt_text(txt_time(item))
            group = (day, author, moment)
            if group != previous_group or not moment:
                file.write(f"\n{author}{' · ' + moment if moment else ''}\n")
            previous_group = group

            message = txt_text(item.get("text"))
            attachments = [txt_attachment(entry) for entry in (item.get("attachments") or [])]
            links = item.get("links") or []
            if message:
                lines = message.split("\n")
                file.write(f"  • {lines[0]}\n")
                for continuation in lines[1:]:
                    file.write(f"    {continuation}\n" if continuation else "\n")
            else:
                marker = f"[{attachments.pop(0)}]" if attachments else (
                    "[link]" if links else f"[{txt_text(item.get('message_type') or 'message')}]"
                )
                file.write(f"  • {marker}\n")
            for attachment in attachments:
                file.write(f"    [{attachment}]\n")

            reply = item.get("reply_to") or {}
            target = by_index.get(reply.get("target_index"))
            reply_author = txt_text(reply.get("author") or (target or {}).get("author"))
            quote = txt_text(reply.get("text") or (target or {}).get("text"))
            if reply_author or quote:
                excerpt = quote.replace("\n", " ")
                if len(excerpt) > 120:
                    excerpt = excerpt[:117].rstrip() + "..."
                file.write(f"    ↳ {reply_author + ': ' if reply_author else ''}{excerpt}\n")

            for reaction in item.get("reactions") or []:
                label = txt_text(reaction.get("label"))
                label = re.sub(r";?\s*see who reacted.*$", "", label, flags=re.I).strip()
                if label:
                    file.write(f"    Reaction: {label}\n")

HTML_HEAD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Messenger Chat Export</title>
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: auto; max-width: 56rem; padding: 1rem; }
article { border: 1px solid GrayText; border-radius: .65rem; padding: .8rem; margin: .65rem 0; }
article.me { border-inline-start: .35rem solid #367dec; }
header, small, summary { color: GrayText; }
p, li { white-space: pre-wrap; overflow-wrap: anywhere; }
ul { margin-bottom: 0; }
</style></head><body>
"""


def write_html(path: Path, payload: dict) -> None:
    with atomic_output(path) as file:
        file.write(HTML_HEAD)
        file.write(f"<h1>Messenger · {payload['count']} messages</h1>\n")
        file.write(f"<p>{escape(payload['source_url'])}\n{escape(payload['exported_at'])}</p>\n")
        if payload["partial"]:
            file.write("<p><strong>Partial export.</strong></p>\n")
        for item in payload["items"]:
            direction = item["direction"] if item["direction"] in {"me", "other"} else "unknown"
            file.write(f'<article class="{direction}" id="m{item["index"]}">\n')
            file.write(f"<header>{escape(message_heading(item))}</header>\n")
            if item["text"]:
                file.write(f"<p>{escape(item['text'])}</p>\n")
            extra = details(item)
            if extra:
                file.write("<ul>\n")
                for label, value in extra:
                    file.write(f"<li><strong>{escape(label)}</strong> {escape(value)}</li>\n")
                file.write("</ul>\n")
            target = item["reply_to"]["target_index"]
            if isinstance(target, int) and target > 0:
                file.write(f'<a href="#m{target}">Go to message #{target}</a>\n')
            for attachment in item["attachments"]:
                local = attachment.get("local_path") or attachment.get("preview_local_path")
                if local and re.fullmatch(r"media/[0-9a-f]{64}\.[a-z0-9]+", local):
                    file.write(f'<div><a href="{local}" download>Saved file</a></div>\n')
            file.write("</article>\n")
        file.write("</body></html>\n")


def export_items(items: list[dict], source_url: str, run: ExportRun, **options) -> tuple[Path, Path, Path]:
    payload = build_payload(items, source_url, run, **options)
    paths = tuple(run.conversation_dir / f"messenger_export_{run.filename_time}.{ext}" for ext in ("txt", "json", "html"))
    txt_path, json_path, html_path = paths
    write_json(json_path, payload)
    write_txt(txt_path, payload)
    write_html(html_path, payload)
    return txt_path, json_path, html_path
