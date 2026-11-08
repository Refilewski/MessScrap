import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
DOM = ROOT / "src" / "dom"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").rstrip()


def compile_content() -> str:
    wrappers = [
        ("findContainer()", "container.js"),
        ("readMessages()", "messages.js"),
        ("scrollMessages(root, direction, move)", "scroll.js"),
    ]
    scripts = [read(SOURCE / "thread.js")]
    for function, filename in wrappers:
        scripts.append(f"function {function} {{\n{read(DOM / filename)}\n}}")
    scripts.extend(read(SOURCE / filename) for filename in ("collect.js", "panel.js"))
    return "(() => {\n'use strict';\n" + "\n\n".join(scripts) + "\n})();\n"


def build(output: Path) -> tuple[Path, Path]:
    files = {
        name: read(SOURCE / name) + "\n"
        for name in ("manifest.json", "thread.js", "popup.html", "popup.js")
    }
    files["content.js"] = compile_content()
    version = json.loads(files["manifest.json"])["version"]
    directory = output / "firefox-extension"
    directory.mkdir(parents=True, exist_ok=True)
    for name, contents in files.items():
        (directory / name).write_text(contents, encoding="utf-8", newline="\n")

    archive = output / f"messscrap-firefox-{version}.zip"
    with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
        for name, contents in files.items():
            package.writestr(name, contents.encode("utf-8"))
    return directory, archive


def main():
    parser = argparse.ArgumentParser(description="Zbuduj rozszerzenie MessScrap do Firefoksa.")
    parser.add_argument("--output", type=Path, default=ROOT / "bin")
    options = parser.parse_args()
    for artifact in build(options.output):
        print(artifact.resolve())


if __name__ == "__main__":
    main()
