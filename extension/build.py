import argparse
import json
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
DOM = ROOT / "src" / "dom"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").rstrip()


def compile_script(source: str, name: str) -> str:
    build = subprocess.run(
        ["node", "--input-type=module", "-e", """
import {readFileSync} from 'node:fs';
import {buildSync} from 'esbuild';
const output = buildSync({
    bundle: true, write: false, format: 'iife', target: ['chrome120', 'firefox140'],
    loader: {'.css': 'text'},
    stdin: {contents: readFileSync(0, 'utf8'), resolveDir: process.cwd(), sourcefile: process.argv[1]},
});
process.stdout.write(output.outputFiles[0].text);
""", name],
        input=source, text=True, encoding="utf-8", capture_output=True, check=False, cwd=SOURCE,
    )
    if build.returncode:
        raise RuntimeError(build.stderr.strip() or "Install the build dependencies with npm ci.")
    return build.stdout


def compile_content() -> str:
    wrappers = [
        ("findContainer()", "container.js"),
        ("readMessages()", "messages.js"),
        ("scrollMessages(root, direction, move)", "scroll.js"),
    ]
    scripts = ["'use strict';", read(SOURCE / "thread.js")]
    for function, filename in wrappers:
        scripts.append(f"function {function} {{\n{read(DOM / filename)}\n}}")
    scripts.extend(read(SOURCE / filename) for filename in ("collect.js", "panel.js"))
    return compile_script("\n".join(scripts) + "\ninstallPanel();\n", "content.js")


def build(output: Path, target: str = "all") -> tuple[Path, ...]:
    files = {
        name: read(SOURCE / name) + "\n"
        for name in ("popup.html", "popup.css", "storage.js")
    }
    files["popup.js"] = compile_script(
        read(SOURCE / "thread.js") + "\n" + read(SOURCE / "popup.js"), "popup.js"
    )
    files["content.js"] = compile_content()
    firefox_manifest = json.loads(read(SOURCE / "manifest.json"))
    package_version = json.loads(read(ROOT / "package.json"))["version"]
    if firefox_manifest["version"] != package_version:
        raise ValueError("Extension and CLI package versions must match.")
    chromium_manifest = {
        key: value for key, value in firefox_manifest.items()
        if key != "browser_specific_settings"
    }
    chromium_manifest["background"] = {"service_worker": "storage.js"}
    manifests = {"firefox": firefox_manifest, "chromium": chromium_manifest}
    browsers = manifests if target == "all" else (target,)
    artifacts = []
    for browser in browsers:
        package_files = {
            **files,
            "manifest.json": json.dumps(manifests[browser], indent=2) + "\n",
        }
        directory = output / f"{browser}-extension"
        directory.mkdir(parents=True, exist_ok=True)
        for name, contents in package_files.items():
            (directory / name).write_text(contents, encoding="utf-8", newline="\n")

        archive = output / f"messscrap-{browser}-{package_version}.zip"
        with ZipFile(archive, "w", compression=ZIP_DEFLATED) as package:
            for name, contents in package_files.items():
                info = ZipInfo(name)
                info.compress_type = ZIP_DEFLATED
                package.writestr(info, contents.encode("utf-8"))
        artifacts.extend((directory, archive))
    return tuple(artifacts)


def main():
    parser = argparse.ArgumentParser(description="Build MessScrap for Chrome, Brave and Firefox.")
    parser.add_argument("--output", type=Path, default=ROOT / "bin")
    parser.add_argument("--target", choices=("all", "chromium", "firefox"), default="all")
    options = parser.parse_args()
    for artifact in build(options.output, options.target):
        print(artifact.resolve())


if __name__ == "__main__":
    main()
