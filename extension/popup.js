const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
const open = document.querySelector('#open');

open.addEventListener('click', async () => {
  if (typeof api?.tabs?.query !== 'function' || typeof api?.scripting?.executeScript !== 'function') {
    status.textContent = 'Unsupported browser functionality. Opening the panel requires the WebExtensions tabs and scripting APIs.';
    return;
  }
  open.disabled = true;
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    if (!Number.isInteger(tab?.id) || tab.id < 0) {
      status.textContent = 'No active tab was available. Return to your Messenger conversation and open MessScrap again.';
      return;
    }
    if (!tab.url) {
      status.textContent = 'The active tab URL is unavailable. Open MessScrap from the browser menu while viewing Messenger and allow access if prompted.';
      return;
    }
    if (!threadUrl(tab?.url)) {
      status.textContent = 'Unsupported conversation URL. Open a specific Messenger conversation, then try again. On mobile, request the desktop site if needed.';
      return;
    }
    const target = {tabId: tab.id};
    await api.scripting.executeScript({target, files: ['content.js']});
    const [injection] = await api.scripting.executeScript({
      target, func: () => Boolean(document.getElementById('messscrap-export-panel')),
    });
    if (injection?.result !== true) {
      status.textContent = 'The panel could not be confirmed. Return to Messenger and retry after the conversation loads.';
      return;
    }
    status.textContent = 'The panel is open in the active conversation.';
    window.close();
  } catch {
    status.textContent = 'The browser could not open the panel. Check site access for MessScrap and reopen it from the active Messenger tab.';
  } finally {
    open.disabled = false;
  }
});
