import argparse
import math
import sys
from pathlib import Path

from .browser import ChromeAttachError, attach_to_browser, select_conversation
from .config import EXPORT_DIR
from .exporter import create_export_run, export_items, write_json


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lokalny eksport otwartej rozmowy z Messengera.")
    parser.add_argument("--from-current", action="store_true", help="zacznij od bieżącej pozycji i zbieraj w dół")
    parser.add_argument("--scroll-up-first", action="store_true", help="dodaj ograniczony przebieg w górę przed zbiorem w dół")
    parser.add_argument("--scroll-up-until-top", action="store_true", help="zacznij od przebiegu do góry, potem zbieraj w dół")
    parser.add_argument("--max-rounds", type=int, help="ogranicz liczbę rund w dół")
    parser.add_argument("--until-bottom", action="store_true", help="próbuj dojść do dołu (domyślnie bez --max-rounds)")
    parser.add_argument("--safety-max-rounds", type=int, default=5000, help="limit rund na kierunek (domyślnie 5000)")
    parser.add_argument("--scroll-up-rounds", type=int, default=30, help="limit rund dla --scroll-up-first")
    parser.add_argument("--sleep", type=float, default=0.25, help="przerwa między rundami w dół")
    parser.add_argument("--scroll-up-sleep", type=float, default=0.45, help="przerwa między rundami w górę")
    parser.add_argument("--no-new-stop", type=int, default=10, help="ile stabilnych rund na krawędzi kończy przebieg")
    parser.add_argument("--output", type=Path, default=EXPORT_DIR, help="katalog eksportu")
    parser.add_argument("--download-media", action="store_true", help="spróbuj zapisać dostępne pliki do folderu media/")
    prompt = parser.add_mutually_exclusive_group()
    prompt.add_argument("--prompt", action="store_true", help="zawsze poczekaj na Enter przed zbiorem")
    prompt.add_argument("--no-prompt", action="store_true", help="zacznij bez pytania o gotowość")
    debug = parser.add_mutually_exclusive_group()
    debug.add_argument("--debug", action="store_true", help="zapisz diagnostykę pominięć w parserze awaryjnym")
    debug.add_argument("--debug-lite", action="store_true", help="zapisz ograniczoną diagnostykę parsera awaryjnego")
    parser.add_argument("--dump-dom-samples", action="store_true", help="zapisz do 30 lokalnych próbek DOM")
    parser.add_argument("--fast-dedupe", action=argparse.BooleanOptionalAction, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.from_current and (args.scroll_up_first or args.scroll_up_until_top):
        parser.error("--from-current nie łączy się z opcjami przewijania w górę")
    for field in ("max_rounds", "safety_max_rounds", "scroll_up_rounds", "no_new_stop"):
        value = getattr(args, field)
        if value is not None and value < 1:
            parser.error(f"--{field.replace('_', '-')} musi wynosić co najmniej 1")
    for field in ("sleep", "scroll_up_sleep"):
        value = getattr(args, field)
        if not math.isfinite(value) or value < 0:
            parser.error(f"--{field.replace('_', '-')} musi być skończoną liczbą nieujemną")
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
        print("Zainstaluj zależności poleceniem python -m pip install -r requirements.txt", file=sys.stderr)
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
                input("Otwórz rozmowę w przeglądarce i naciśnij Enter. ")
            try:
                source_url = select_conversation(driver)
            except ChromeAttachError:
                if args.no_prompt or args.prompt or not sys.stdin.isatty():
                    raise
                input("Otwórz jedną rozmowę w profilu eksportera i naciśnij Enter. ")
                source_url = select_conversation(driver)
        except (ChromeAttachError, WebDriverException, EOFError) as exc:
            print(str(exc) or "Nie wybrano rozmowy.", file=sys.stderr)
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
            print("\nPrzerwano. Zapisuję zebrane wiadomości.")
        except (NoChatContainerFound, ConversationChanged, WebDriverException, OSError) as exc:
            print((str(exc).splitlines() or [type(exc).__name__])[0], file=sys.stderr)
            exit_code = 2

        records = scraper.history.records()
        if records:
            partial = interrupted or any(value != "edge_stable" for value in scraper.directions.values())
            paths = export_items(
                records, source_url, run, partial=partial, interrupted=interrupted, directions=scraper.directions,
            )
            print(f"Zapisano {len(records)} wiadomości{' (eksport częściowy)' if partial else ''}.")
            for path in paths:
                print(path)
        elif not exit_code:
            print("Brak zebranych wiadomości. Sprawdź, czy rozmowa jest odblokowana.", file=sys.stderr)
            exit_code = 2

        if args.debug or args.debug_lite:
            write_json(run.debug_dir / f"debug_skipped_{run.filename_time}.json", scraper.skipped)
        if args.dump_dom_samples:
            write_json(run.debug_dir / f"dom_samples_{run.filename_time}.json", scraper.samples)
        return exit_code
    except OSError as exc:
        print(f"Błąd zapisu: {exc}", file=sys.stderr)
        return 1
    finally:
        try:
            driver.quit()
        except WebDriverException:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
