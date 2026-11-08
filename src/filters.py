import re

MEDIA_TYPES = {"photo", "gif", "video", "audio", "sticker", "attachment", "call", "event"}
MESSAGE_TYPES = MEDIA_TYPES | {"text", "unknown"}
LEGACY_UI = re.compile(
    r"^(?:sent (?:just now|\d+[smhd] ago)|delivered|seen(?: by .+)?|call back|"
    r"\d{1,2}:\d{2}\s*(?:am|pm)?)$",
    re.IGNORECASE,
)
BAD_AUTHORS = {"go to", "go to message", "open", "see more", "you", "ty"}


def normalize_text(value: object) -> str:
    return " ".join(str(value or "").split())


def optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return value.replace("\r\n", "\n").replace("\r", "\n").strip() or None


def clean_author(value: object) -> str | None:
    name = optional_text(value)
    if not name:
        return None
    lowered = name.casefold()
    if lowered in BAD_AUTHORS or lowered.startswith(("go to ", "see more ", "open ")):
        return None
    return name


def clean_record(raw: dict) -> dict | None:
    text = optional_text(raw.get("text")) or ""
    kind = raw.get("message_type")
    if kind not in MESSAGE_TYPES:
        kind = "unknown"
    structured = raw.get("structured") is True
    if not structured and (not text or (kind not in MEDIA_TYPES and LEGACY_UI.fullmatch(text))):
        return None

    direction = raw.get("direction")
    record = {
        "source_message_id": optional_text(raw.get("source_message_id")),
        "node_id": raw.get("node_id"),
        "text": text,
        "author": clean_author(raw.get("author")),
        "direction": direction if direction in {"me", "other"} else "unknown",
        "message_type": kind,
    }
    for field in ("date", "time", "datetime_raw", "timestamp", "accessibility_label"):
        record[field] = optional_text(raw.get(field))
    for field in ("avatar", "reply_to"):
        value = raw.get(field)
        record[field] = value if isinstance(value, dict) else {}
    for field in ("attachments", "links", "reactions", "receipts"):
        value = raw.get(field)
        record[field] = value if isinstance(value, list) else []
    return record
