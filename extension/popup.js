const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');
const open = document.querySelector('#open');

function showStatus(message, state) {
  status.textContent = message;
  status.dataset.state = state;
}

open.addEventListener('click', async () => {
  if (open.disabled) return;
  open.disabled = true;
  showStatus('Opening the export panel…', 'working');
  try {
    if (!api?.tabs?.query || !api?.scripting?.executeScript) {
      showStatus('The browser’s extension API is unavailable. Try reopening MessScrap from the toolbar.', 'error');
      return;
    }

    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    if (tab?.id == null) {
      showStatus('Switch to a Messenger tab and try again.', 'error');
      return;
    }
    if (!threadUrl(tab?.url)) {
      showStatus('Open a specific conversation on messenger.com or facebook.com/messages. On mobile, try Desktop site.', 'error');
      return;
    }

    const [injection] = await api.scripting.executeScript({
      target: {tabId: tab.id},
      files: ['content.js'],
    });
    if (injection?.result !== true) {
      showStatus('The conversation may have changed. Open it again and retry.', 'error');
      return;
    }
    showStatus('The export panel is ready in the conversation tab.', 'success');
    window.close();
  } catch {
    showStatus('Could not open the panel. Switch to the conversation tab and reopen MessScrap from the toolbar.', 'error');
  } finally {
    open.disabled = false;
  }
});
