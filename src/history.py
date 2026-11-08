from __future__ import annotations

from dataclasses import dataclass


@dataclass(eq=False, slots=True)
class Entry:
    record: dict
    previous: Entry | None = None
    following: Entry | None = None


def identity(record: dict) -> tuple:
    source_id = record["source_message_id"]
    if source_id:
        return "source", source_id
    # Only join observations of the same DOM node with the same text. A
    # virtual list may repurpose a node to display a different message.
    return "node", record["node_id"], record["text"]


def merge_record(existing: dict, observed: dict) -> bool:
    changed = False
    for field, value in observed.items():
        if not value or (field in {"direction", "message_type"} and value == "unknown"):
            continue
        previous = existing.get(field)
        if field in {"attachments", "links", "reactions", "receipts"}:
            value = previous + [item for item in value if item not in previous]
        elif field in {"avatar", "reply_to"}:
            value = {**previous, **{key: data for key, data in value.items() if data}}
        elif field == "node_id":
            continue
        if value != previous:
            existing[field] = value
            changed = True
    return changed


class MessageHistory:
    """Index observations by identity and keep DOM order across scroll windows."""

    def __init__(self):
        self.entries: dict[tuple, Entry] = {}
        self.first: Entry | None = None
        self.last: Entry | None = None
        self._next_unidentified = 0

    def __len__(self) -> int:
        return len(self.entries)

    def _insert_after(self, previous: Entry | None, entry: Entry) -> None:
        following = previous.following if previous else self.first
        entry.previous, entry.following = previous, following
        if previous:
            previous.following = entry
        else:
            self.first = entry
        if following:
            following.previous = entry
        else:
            self.last = entry

    def add_window(self, records: list[dict], direction: int) -> tuple[int, int]:
        keys = []
        for record in records:
            if not record["source_message_id"] and record["node_id"] is None:
                self._next_unidentified += 1
                keys.append(("unidentified", self._next_unidentified))
            else:
                keys.append(identity(record))

        anchor = next((self.entries[key] for key in keys if key in self.entries), None)
        previous = anchor.previous if anchor else (self.last if direction > 0 else None)
        added = updated = 0
        for key, record in zip(keys, records):
            entry = self.entries.get(key)
            if entry is None:
                entry = Entry(record)
                self.entries[key] = entry
                self._insert_after(previous, entry)
                added += 1
            else:
                updated += merge_record(entry.record, record)
            previous = entry
        return added, updated

    def records(self) -> list[dict]:
        items = []
        entry = self.first
        while entry:
            items.append(entry.record)
            entry = entry.following
        return items
