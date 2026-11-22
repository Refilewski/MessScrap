"""Compatibility launcher for the source checkout's MessScrap CLI."""

import shutil
import subprocess
import sys
from pathlib import Path


def main() -> int:
    node = shutil.which("node")
    if not node:
        print("MessScrap 2 requires Node.js 22 or later.", file=sys.stderr)
        return 1
    cli = Path(__file__).resolve().parent / "cli" / "messscrap.mjs"
    try:
        return subprocess.call([node, str(cli), *sys.argv[1:]])
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
