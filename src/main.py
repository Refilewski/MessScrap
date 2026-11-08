import argparse
import math
import sys
from pathlib import Path

from .browser import ChromeAttachError, attach_to_browser, select_conversation
from .config import EXPORT_DIR
from .exporter import create_export_run, export_items, write_json


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="MessScrap - Facebook Messenger Chat Exporter")
    parser.add_argument("--from-current", action="store_true", help="start at the current position and collect newer messages")
    parser.add_argument("--scroll-up-first", action="store_true", help="scan a limited number of older messages before collecting newer ones")
    parser.add_argument("--scroll-up-until-top", action="store_true", help="scan to the oldest available message first")
    parser.add_argument("--max-rounds", type=int, help="limit rounds toward newer messages")
    parser.add_argument("--until-bottom", action="store_true", help="scan to the newest available message (default without --max-rounds)")
    parser.add_argument("--safety-max-rounds", type=int, default=5000, help="limit rounds per direction (default 5000)")
    parser.add_argument("--scroll-up-rounds", type=int, default=30, help="round limit for --scroll-up-first")
    parser.add_argument("--sleep", type=float, default=0.25, help="seconds between rounds toward newer messages")
    parser.add_argument("--scroll-up-sleep", type=float, default=0.45, help="seconds between rounds toward older messages")
    parser.add_argument("--no-new-stop", type=int, default=10, help="stable rounds at an edge before ending a scan")
    parser.add_argument("--output", type=Path, default=EXPORT_DIR, help="export directory")
    parser.add_argument("--download-media", action="store_true", help="try to save available attachments under media/")
    prompt = parser.add_mutually_exclusive_group()
    prompt.add_argument("--prompt", action="store_true", help="always wait for Enter before collecting messages")
    prompt.add_argument("--no-prompt", action="store_true", help="start without asking for confirmation")
    debug = parser.add_mutually_exclusive_group()
    debug.add_argument("--debug", action="store_true", help="save fallback parser diagnostics")
    debug.add_argument("--debug-lite", action="store_true", help="save limited fallback parser diagnostics")
    parser.add_argument("--dump-dom-samples", action="store_true", help="save up to 30 local DOM samples")
    parser.add_argument("--fast-dedupe", action=argparse.BooleanOptionalAction, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.from_current and (args.scroll_up_first or args.scroll_up_until_top):
        parser.error("--from-current cannot be combined with upward scrolling options")
    for field in ("max_rounds", "safety_max_rounds", "scroll_up_rounds", "no_new_stop"):
        value = getattr(args, field)
        if value is not None and value < 1:
            parser.error(f"--{field.replace('_', '-')} must be at least 1")
    for field in ("sleep", "scroll_up_sleep"):
        value = getattr(args, field)
        if not math.isfinite(value) or value < 0:
            parser.error(f"--{field.replace('_', '-')} must be a finite, non-negative number")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        from selenium.common.exceptions import WebDriverException

        from .media import MediaDownloader
        from .scraper import ConversationChanged, MessengerScraper, NoChatContainerFound
    except ModuleNotFoundError as exc:
        if exc.name != "selenium":
            raise
        print("Install dependencies with python -m pip install -r requirements.txt", file=sys.stderr)
        return 1

    try:
        driver = attach_to_browser()
    except ChromeAttachError as exc:
        print(exc, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130

    try:
        try:
            if args.prompt:
                input("Open a conversation in the browser and press Enter. ")
            try:
                source_url = select_conversation(driver)
            except ChromeAttachError:
                if args.no_prompt or args.prompt or not sys.stdin.isatty():
                    raise
                input("Open one conversation in the export browser profile and press Enter. ")
                source_url = select_conversation(driver)
        except (ChromeAttachError, WebDriverException, EOFError) as exc:
            print(str(exc) or "No conversation selected.", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            return 130

        run = create_export_run(source_url, driver.title, args.output)
        media = MediaDownloader(driver, run.conversation_dir) if args.download_media else None
        scraper = MessengerScraper(
            driver, source_url, debug=args.debug or args.debug_lite,
            debug_lite=args.debug_lite, dump_samples=args.dump_dom_samples, media=media,
        )
        down_limit = args.safety_max_rounds if args.until_bottom else args.max_rounds or args.safety_max_rounds
        limited_start = args.from_current or (args.max_rounds is not None and not args.until_bottom)
        phases = [(1, down_limit, args.sleep)]
        if args.scroll_up_first or args.scroll_up_until_top:
            up_limit = args.safety_max_rounds if args.scroll_up_until_top else args.scroll_up_rounds
            phases.insert(0, (-1, up_limit, args.scroll_up_sleep))
        elif not limited_start:
            phases.append((-1, args.safety_max_rounds, args.scroll_up_sleep))

        exit_code = 0
        interrupted = False
        scraper.directions["older"] = "not_requested"
        for direction, _, _ in phases:
            scraper.directions["older" if direction < 0 else "newer"] = "not_started"
        try:
            for direction, limit, pause in phases:
                scraper.scan_direction(direction, limit=limit, pause=pause, stable_rounds=args.no_new_stop)
        except KeyboardInterrupt:
            interrupted, exit_code = True, 130
            print("\nInterrupted. Saving collected messages.")
        except (NoChatContainerFound, ConversationChanged, WebDriverException, OSError) as exc:
            print((str(exc).splitlines() or [type(exc).__name__])[0], file=sys.stderr)
            exit_code = 2

        records = scraper.history.records()
        if records:
            partial = interrupted or any(value != "edge_stable" for value in scraper.directions.values())
            paths = export_items(
                records, source_url, run, partial=partial, interrupted=interrupted, directions=scraper.directions,
            )
            print(f"Saved {len(records)} messages{' (partial export)' if partial else ''}.")
            for path in paths:
                print(path)
        elif not exit_code:
            print("No messages collected. Check that the conversation is unlocked.", file=sys.stderr)
            exit_code = 2

        if args.debug or args.debug_lite:
            write_json(run.debug_dir / f"debug_skipped_{run.filename_time}.json", scraper.skipped)
        if args.dump_dom_samples:
            write_json(run.debug_dir / f"dom_samples_{run.filename_time}.json", scraper.samples)
        return exit_code
    except OSError as exc:
        print(f"Write error: {exc}", file=sys.stderr)
        return 1
    finally:
        try:
            driver.quit()
        except WebDriverException:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
