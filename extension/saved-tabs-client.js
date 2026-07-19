/* SavedTabsStore proxy for extension pages. The service worker owns writes. */

'use strict';

(() => {
  async function request(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({
      type: 'tab-out:saved-tabs-store',
      action,
      ...payload,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Saved tabs storage request failed');
    }
    return response.result;
  }

  globalThis.SavedTabsStore = Object.freeze({
    getAll: () => request('getAll'),
    save: tab => request('save', { tab }),
    removeIds: ids => request('removeIds', { ids }),
  });
})();
