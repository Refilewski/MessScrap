import json
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import urlopen

from .config import DEBUGGER_ADDRESS, START_URL

THREAD_PATHS = {
    "messenger.com": re.compile(r"/(?:e2ee/)?t/[^/]+/?$"),
    "facebook.com": re.compile(r"/messages/(?:e2ee/)?t/[^/]+/?$"),
}
BROWSERS = (
    ("Brave", Path("BraveSoftware/Brave-Browser/Application/brave.exe")),
    ("Chrome", Path("Google/Chrome/Application/chrome.exe")),
)


class ChromeAttachError(RuntimeError):
    pass


def conversation_url(url: str) -> str | None:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    host = (parsed.hostname or "").removeprefix("www.").removeprefix("web.")
    path_pattern = THREAD_PATHS.get(host)
    if parsed.username is None and parsed.scheme in {"http", "https"} and path_pattern and path_pattern.fullmatch(parsed.path):
        return f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
    return None


def debugger_version() -> dict:
    try:
        with urlopen(f"http://{DEBUGGER_ADDRESS}/json/version", timeout=1) as response:
            data = json.load(response)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def start_browser() -> Path | None:
    for name, relative_path in BROWSERS:
        for directory in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(directory)
            if not base:
                continue
            executable = Path(base) / relative_path
            if not executable.is_file():
                continue
            profile_base = os.environ.get("LOCALAPPDATA")
            if not profile_base:
                raise ChromeAttachError("Brak katalogu LOCALAPPDATA dla profilu przeglądarki.")
            profile = Path(profile_base) / f"MessengerExport{name}"
            print(f"Uruchamiam {name} z osobnym profilem.")
            subprocess.Popen([
                str(executable),
                "--remote-debugging-port=9222",
                f"--user-data-dir={profile}",
                START_URL,
            ])
            return executable
    return None


def cached_chromedriver(chromium_version: str) -> Path | None:
    cache = Path(os.environ.get("SE_CACHE_PATH") or Path.home() / ".cache" / "selenium").expanduser()
    build = chromium_version.rsplit(".", 1)[0]
    drivers = []
    for platform in ("win64", "win32"):
        directory = cache / "chromedriver" / platform
        for candidate in directory.glob(f"{build}.*/chromedriver.exe"):
            patch = candidate.parent.name.rsplit(".", 1)[-1]
            if patch.isdecimal() and candidate.is_file():
                drivers.append((int(patch), platform == "win64", candidate))
    return max(drivers)[-1] if drivers else None


def attach_to_browser():
    from selenium import webdriver
    from selenium.common.exceptions import WebDriverException
    from selenium.webdriver.chrome.service import Service

    executable = None
    version = debugger_version()
    if not version:
        try:
            executable = start_browser()
        except OSError as exc:
            raise ChromeAttachError(f"Nie udało się uruchomić przeglądarki: {exc}") from exc
        if executable:
            for _ in range(30):
                version = debugger_version()
                if version:
                    break
                time.sleep(0.5)
    if not version:
        raise ChromeAttachError("Port 9222 jest niedostępny. Uruchom przeglądarkę zgodnie z README.")

    options = webdriver.ChromeOptions()
    options.debugger_address = DEBUGGER_ADDRESS
    match = re.search(r"/(\d+\.\d+\.\d+\.\d+)", version.get("Browser", ""))
    chromium_version = match[1] if match else ""
    cached_driver = cached_chromedriver(chromium_version) if chromium_version and os.name == "nt" else None
    if executable:
        options.binary_location = str(executable)
    elif chromium_version and not cached_driver:
        options.browser_version = chromium_version.split(".", 1)[0]
    try:
        service = Service(executable_path=str(cached_driver)) if cached_driver else None
        return webdriver.Chrome(options=options, service=service)
    except WebDriverException as exc:
        detail = str(exc).splitlines()[0]
        raise ChromeAttachError(f"Nie udało się połączyć z przeglądarką na porcie 9222. {detail}") from exc


def select_conversation(driver) -> str:
    from selenium.common.exceptions import NoSuchWindowException

    candidates = []
    for handle in driver.window_handles:
        try:
            driver.switch_to.window(handle)
            url = conversation_url(driver.current_url)
            if url:
                visible = driver.execute_script("return document.visibilityState === 'visible';")
                candidates.append((handle, url, visible))
        except NoSuchWindowException:
            continue
    visible = [(handle, url) for handle, url, shown in candidates if shown]
    if len(visible) == 1:
        handle, url = visible[0]
    elif len(candidates) == 1:
        handle, url, _ = candidates[0]
    elif candidates:
        raise ChromeAttachError("Wybór rozmowy jest niejednoznaczny. Zostaw jedną otwartą rozmowę w tym profilu.")
    else:
        raise ChromeAttachError("Otwórz konkretną rozmowę w oknie uruchomionym do eksportu.")
    driver.switch_to.window(handle)
    return url
