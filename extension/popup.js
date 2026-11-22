const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
const open = document.querySelector('#open');

open.addEventListener('click', async () => {
  open.disabled = true;
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    if (!threadUrl(tab?.url)) {
      status.textContent = 'Open a Messenger conversation first. On Android, try Desktop site.';
      return;
    }
    const target = {tabId: tab.id};
    await api.scripting.executeScript({target, files: ['content.js']});
    const [injection] = await api.scripting.executeScript({
      target, func: () => Boolean(document.getElementById('messscrap-export-panel')),
    });
    if (injection?.result !== true) {
      status.textContent = 'The conversation changed before the panel could open.';
      return;
    }
    status.textContent = 'The panel is open in the active conversation.';
    window.close();
  } catch {
    status.textContent = 'The browser could not open the panel in this tab.';
  } finally {
    open.disabled = false;
  }
});
