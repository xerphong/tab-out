/**
 * background.js - Service Worker for Badge Updates and Context Menus
 *
 * Keeps the toolbar badge showing the current open tab count and provides a
 * page context menu action that saves the current tab to Saved for later.
 */

const SAVE_CURRENT_TAB_MENU_ID = 'tab-out-save-current-tab';

const FRIENDLY_DOMAINS = {
  'mail.google.com': 'Gmail',
  'x.com': 'X',
  'twitter.com': 'X',
  'www.linkedin.com': 'LinkedIn',
  'github.com': 'GitHub',
  'www.youtube.com': 'YouTube',
  'local-files': 'Local Files',
};

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(t => isSavableUrl(t.url || '')).length;

    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count === 0) return;

    let color;
    if (count <= 10) {
      color = '#3d7a4a';
    } else if (count <= 20) {
      color = '#b8892e';
    } else {
      color = '#b35a5a';
    }

    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

function isSavableUrl(url) {
  return Boolean(url) &&
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://');
}

function getSavableUrl(tab) {
  const url = tab?.url || '';
  return isSavableUrl(url) ? url : '';
}

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  const clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function makeGroupId(value) {
  return 'domain-' + String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getSavedGroupForTab(tab) {
  const url = getSavableUrl(tab);
  if (!url) return null;

  if (url.startsWith('file://')) {
    return {
      id: makeGroupId('local-files'),
      domain: 'local-files',
      label: 'Local Files',
      splitKeyword: '',
    };
  }

  try {
    const parsed = new URL(url);
    return {
      id: makeGroupId(parsed.hostname),
      domain: parsed.hostname,
      label: friendlyDomain(parsed.hostname),
      splitKeyword: '',
    };
  } catch {
    return null;
  }
}

async function saveTabForLater(tab) {
  const url = getSavableUrl(tab);
  if (!url) return false;

  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.unshift({
    id: Date.now().toString(),
    url,
    title: tab.title || url,
    savedAt: new Date().toISOString(),
    completed: false,
    dismissed: false,
    savedGroup: getSavedGroupForTab(tab),
  });
  await chrome.storage.local.set({ deferred });
  return true;
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: SAVE_CURRENT_TAB_MENU_ID,
      title: 'Save current tab for later',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
    });
  });
}

async function notifyDeferredUpdated() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('index.html') });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
    type: 'tab-out:deferred-updated',
  })));
}

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  updateBadge();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== SAVE_CURRENT_TAB_MENU_ID) return;

  try {
    const saved = await saveTabForLater(tab);
    if (!saved) return;

    await notifyDeferredUpdated();
    if (Number.isInteger(tab?.id) && !tab.pinned) {
      await chrome.tabs.remove(tab.id);
    }
    updateBadge();
  } catch (err) {
    console.warn('[tab-out] Failed to save current tab from context menu:', err);
  }
});

chrome.tabs.onCreated.addListener(() => {
  updateBadge();
});

chrome.tabs.onRemoved.addListener(() => {
  updateBadge();
});

chrome.tabs.onUpdated.addListener(() => {
  updateBadge();
});

createContextMenus();
updateBadge();
