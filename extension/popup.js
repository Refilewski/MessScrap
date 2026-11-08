const status = document.querySelector('#status');
const open = document.querySelector('#open');

open.addEventListener('click', async () => {
  open.disabled = true;
  try {
    const [tab] = await browser.tabs.query({active: true, currentWindow: true});
    if (!threadUrl(tab?.url)) {
      status.textContent = 'Otwórz konkretną rozmowę na facebook.com/messages. Na telefonie spróbuj włączyć widok komputerowy.';
      return;
    }

    const [injection] = await browser.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['content.js'],
    });
    if (injection?.result !== true) {
      status.textContent = 'Nie udało się otworzyć panelu. Sprawdź, czy rozmowa jest nadal otwarta.';
      return;
    }
    status.textContent = 'Panel jest gotowy w karcie rozmowy.';
    window.close();
  } catch {
    status.textContent = 'Firefox nie pozwolił otworzyć panelu w tej karcie.';
  } finally {
    open.disabled = false;
  }
});
