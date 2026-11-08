const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
const open = document.querySelector('#open');

open.addEventListener('click', async () => {
  open.disabled = true;
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    if (!threadUrl(tab?.url)) {
      status.textContent = 'Open a specific conversation on facebook.com/messages. On Android, try Desktop site.';
      return;
    }

    const [injection] = await api.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['content.js'],
    });
    if (injection?.result !== true) {
      status.textContent = 'Could not open the panel. Check that the conversation is still open.';
      return;
    }
    status.textContent = 'The panel is ready in the conversation tab.';
    window.close();
  } catch {
    status.textContent = 'The browser did not allow the panel to open in this tab.';
  } finally {
    open.disabled = false;
  }
});
