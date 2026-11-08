# MessScrap po polsku

MessScrap zapisuje historię z otwartej, odblokowanej rozmowy Messengera. Na Windows wersja Pythonowa zapisuje JSON, TXT i HTML. Rozszerzenie Firefoksa zapisuje JSON na komputerze i Androidzie.

## Windows

W katalogu projektu uruchom:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

Zaloguj się w profilu otwartym przez program, wejdź w konkretną rozmowę i odblokuj historię, jeśli Messenger tego wymaga. Gdy terminal czeka, naciśnij Enter. Pliki znajdziesz w `exports/conversations/`.

- Dodaj `--download-media`, aby zapisać dostępne multimedia i podglądy.
- Dodaj `--from-current --prompt`, aby zacząć od bieżącej pozycji i zbierać tylko w stronę nowszych wiadomości.
- Naciśnij **Ctrl+C** raz, aby przerwać i zapisać zebrane wiadomości.
- Użyj `--help`, aby zobaczyć wszystkie opcje.

## Android i Firefox

1. Zbuduj paczkę przez `python extension/build.py`.
2. Włącz debugowanie USB w Androidzie i **Zdalne debugowanie przez USB** w Firefoksie. Podłącz odblokowany telefon i potwierdź połączenie.
3. Na komputerze wpisz `adb devices`. Zastąp `ID_Z_LISTY` identyfikatorem telefonu.

```powershell
npx web-ext run --target=firefox-android --android-device=ID_Z_LISTY --firefox-apk=org.mozilla.firefox --source-dir=bin/firefox-extension
```

Otwórz i odblokuj konkretną rozmowę w Firefoksie. W menu wybierz **Rozszerzenia → MessScrap → Otwórz panel → Zbierz historię → Zapisz JSON**. Jeśli telefon pokazuje stronę bez historii, spróbuj włączyć widok komputerowy. Przycisk **Zatrzymaj** pozwala zapisać część rozmowy.

Do stałej instalacji prześlij wygenerowany ZIP do podpisania przez Mozillę jako **Unlisted**, a potem wskaż podpisany plik `.xpi` w opcji **Zainstaluj rozszerzenie z pliku**. [Instrukcja Mozilli](https://extensionworkshop.com/documentation/publish/install-self-distributed/)

## Gdy brakuje wiadomości

Sprawdź, czy Messenger otworzył właściwy wątek i wyświetla starszą historię po przewinięciu. JSON zawiera pole `coverage`, które pomaga ustalić, czy skan doszedł do stabilnej krawędzi, został przerwany albo osiągnął limit rund. Rozszerzenie zapisuje metadane multimediów. Pliki multimedialne można pobierać opcją `--download-media` w wersji Pythonowej.

[Wróć do głównego README](../README.md)
