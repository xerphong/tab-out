/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];
let isDeferredExpanded = false;

function applyDeferredLayoutState() {
  const dashboard = document.getElementById('dashboardColumns');
  const toggle = document.getElementById('deferredLayoutToggle');
  if (!dashboard) return;

  dashboard.classList.toggle('deferred-expanded', isDeferredExpanded);
  if (toggle) {
    toggle.classList.toggle('is-expanded', isDeferredExpanded);
    toggle.title = isDeferredExpanded ? 'Restore saved tabs sidebar' : 'Expand saved tabs';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.setAttribute('aria-pressed', String(isDeferredExpanded));
  }
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      pinned:   t.pinned,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

async function closeTabsByIds(tabIds) {
  const ids = Array.from(new Set((tabIds || []).filter(id => Number.isInteger(id))));
  if (ids.length === 0) return;
  await chrome.tabs.remove(ids);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const savedGroup = tab.savedGroup && typeof tab.savedGroup === 'object'
    ? {
        id: tab.savedGroup.id || '',
        domain: tab.savedGroup.domain || '',
        label: tab.savedGroup.label || '',
        splitKeyword: tab.savedGroup.splitKeyword || '',
      }
    : null;
  deferred.unshift({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
    savedGroup,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed && !t.completed);
  return {
    active:   visible,
    archived: [],
  };
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

function normalizeDeferredUrl(url) {
  return String(url || '').trim();
}

async function dismissSavedUrl(url) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const targetUrl = normalizeDeferredUrl(url);
  let changed = false;

  for (const item of deferred) {
    if (item.completed || item.dismissed) continue;
    if (normalizeDeferredUrl(item.url) === targetUrl) {
      item.dismissed = true;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ deferred });
  }
}

async function restoreSavedUrl(url) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const targetUrl = normalizeDeferredUrl(url);
  const item = deferred.find(entry =>
    !entry.completed &&
    !entry.dismissed &&
    normalizeDeferredUrl(entry.url) === targetUrl
  );

  if (!item?.url) return 0;

  await chrome.tabs.create({ url: item.url, active: true });
  for (const entry of deferred) {
    if (!entry.completed && !entry.dismissed && normalizeDeferredUrl(entry.url) === targetUrl) {
      entry.dismissed = true;
    }
  }

  await chrome.storage.local.set({ deferred });
  return 1;
}

async function dismissSavedDomain(domainKey) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  let changed = false;

  for (const item of deferred) {
    if (item.completed || item.dismissed) continue;
    if (getDeferredGroupKey(item) === String(domainKey || '').toLowerCase()) {
      item.dismissed = true;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ deferred });
  }
}

async function restoreSavedDomain(domainKey) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const targetKey = String(domainKey || '').toLowerCase();
  const items = deferred.filter(item =>
    !item.completed &&
    !item.dismissed &&
    getDeferredGroupKey(item) === targetKey
  );

  if (items.length === 0) return 0;

  const uniqueItems = [];
  const seenUrls = new Set();
  for (const item of items) {
    const key = normalizeDeferredUrl(item.url);
    if (!key || seenUrls.has(key)) continue;
    seenUrls.add(key);
    uniqueItems.push(item);
  }

  for (const item of uniqueItems.slice().reverse()) {
    if (!item.url) continue;
    await chrome.tabs.create({ url: item.url, active: false });
  }

  for (const item of deferred) {
    if (!item.completed && !item.dismissed && getDeferredGroupKey(item) === targetKey) {
      item.dismissed = true;
    }
  }

  await chrome.storage.local.set({ deferred });
  return uniqueItems.length;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  save:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  split:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M4 7h6m0 0 3-3m-3 3 3 3m7 7h-6m0 0-3-3m3 3-3 3M4 17h4.5A3.5 3.5 0 0 0 12 13.5v-3A3.5 3.5 0 0 1 15.5 7H20" /></svg>`,
  merge:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 14 4.5 9.5 9 5m-4.5 4.5H14a5.5 5.5 0 0 1 0 11h-1.5" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
const QUICK_LINKS_STORAGE_KEY = 'quickLinks';
const QUICK_LINK_SLOTS = 18;
const QUICK_LINKS_TRANSFER_TYPE = 'tab-out.quick-links';
const DOMAIN_SPLIT_RULES_STORAGE_KEY = 'domainSplitRules';
const DEFAULT_QUICK_LINKS = [
  { title: 'Google', url: 'https://www.google.com' },
  ...Array.from({ length: QUICK_LINK_SLOTS - 1 }, () => ({ title: '', url: '' })),
];

function makeGroupId(value) {
  return 'domain-' + String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getGroupStableId(group) {
  return makeGroupId(group?.id || group?.domain || '');
}

function findDomainGroupById(groupId) {
  return domainGroups.find(group => getGroupStableId(group) === groupId);
}

async function rebuildDomainGroupsFromOpenTabs() {
  const realTabs = getRealTabs();
  const dashboardTabs = getDashboardTabs(realTabs);
  const { totalExtras: totalDuplicateExtras } = getDuplicateSummary(dashboardTabs);

  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  const nextGroups = [];
  const groupMap = {};
  const landingTabs = [];
  const domainSplitRules = await getDomainSplitRules();
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true;
      }) || null;
    } catch { return null; }
  }

  for (const tab of dashboardTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      const splitRule = matchDomainSplitRule(hostname, tab.title, domainSplitRules);
      if (splitRule) {
        const splitKey = `${hostname}::title-split::${splitRule.keyword.toLowerCase()}`;
        if (!groupMap[splitKey]) {
          groupMap[splitKey] = {
            id: splitKey,
            domain: hostname,
            label: `${friendlyDomain(hostname)} + ${splitRule.keyword}`,
            splitKeyword: splitRule.keyword,
            tabs: [],
          };
        }
        groupMap[splitKey].tabs.push(tab);
        continue;
      }

      if (!groupMap[hostname]) groupMap[hostname] = { id: hostname, domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }

  nextGroups.push(...Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  }));

  domainGroups = nextGroups;
  return { totalDuplicateExtras };
}

function updateOpenTabsUiCounts(totalDuplicateExtras = 0) {
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const statTabs = document.getElementById('statTabs');

  if (openTabsSectionCount) {
    const closeDuplicatesBtn = totalDuplicateExtras > 0
      ? ` <button class="action-btn dedup-btn" data-action="close-all-duplicates" style="font-size:11px;padding:3px 10px;">
            Close all ${totalDuplicateExtras} duplicate${totalDuplicateExtras !== 1 ? 's' : ''}
          </button>`
      : '';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}${closeDuplicatesBtn}`;
  }

  if (statTabs) statTabs.textContent = openTabs.length;
  checkTabOutDupes();
}

async function refreshSingleDomainCard(groupId, existingCard) {
  const { totalDuplicateExtras } = await rebuildDomainGroupsFromOpenTabs();
  const nextGroup = findDomainGroupById(groupId);

  if (nextGroup && existingCard?.isConnected) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderDomainCard(nextGroup).trim();
    const nextCard = wrapper.firstElementChild;
    if (nextCard) existingCard.replaceWith(nextCard);
  } else if (existingCard?.isConnected) {
    animateCardOut(existingCard);
  }

  updateOpenTabsUiCounts(totalDuplicateExtras);
  checkAndShowEmptyState();
}

function normalizeQuickLink(entry = {}) {
  return {
    title: typeof entry.title === 'string' ? entry.title.trim() : '',
    url: typeof entry.url === 'string' ? entry.url.trim() : '',
  };
}

function normalizeQuickLinks(links = []) {
  const normalized = Array.from({ length: QUICK_LINK_SLOTS }, (_, index) => {
    return normalizeQuickLink(links[index] || {});
  });
  return normalized;
}

function normalizeDomainSplitRule(entry = {}) {
  return {
    domain: typeof entry.domain === 'string' ? entry.domain.trim().toLowerCase() : '',
    keyword: typeof entry.keyword === 'string' ? entry.keyword.trim() : '',
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
  };
}

function normalizeDomainSplitRules(rules = []) {
  const seen = new Set();
  return rules
    .map(normalizeDomainSplitRule)
    .filter(rule => {
      if (!rule.domain || !rule.keyword) return false;
      const key = `${rule.domain}::${rule.keyword.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getDomainSplitRules() {
  const { [DOMAIN_SPLIT_RULES_STORAGE_KEY]: savedRules } = await chrome.storage.local.get(DOMAIN_SPLIT_RULES_STORAGE_KEY);
  return normalizeDomainSplitRules(savedRules || []);
}

async function saveDomainSplitRules(rules) {
  await chrome.storage.local.set({
    [DOMAIN_SPLIT_RULES_STORAGE_KEY]: normalizeDomainSplitRules(rules),
  });
}

const deferredGroupCollapseState = new Map();

function deferredDomainInfo(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname || '';
    const domain = hostname.replace(/^www\./, '') || hostname || 'unknown';
    return {
      hostname,
      domain,
      label: friendlyDomain(hostname) || domain || 'Unknown',
    };
  } catch {
    return {
      hostname: '',
      domain: 'unknown',
      label: 'Unknown',
    };
  }
}

function normalizeSavedGroup(savedGroup = null) {
  if (!savedGroup || typeof savedGroup !== 'object') return null;

  const id = typeof savedGroup.id === 'string' ? savedGroup.id.trim() : '';
  const domain = typeof savedGroup.domain === 'string' ? savedGroup.domain.trim() : '';
  const label = typeof savedGroup.label === 'string' ? savedGroup.label.trim() : '';
  const splitKeyword = typeof savedGroup.splitKeyword === 'string' ? savedGroup.splitKeyword.trim() : '';

  if (!id && !domain && !label && !splitKeyword) return null;
  return { id, domain, label, splitKeyword };
}

function getDeferredGroupKey(item) {
  const savedGroup = normalizeSavedGroup(item?.savedGroup);
  if (savedGroup?.id) return savedGroup.id.toLowerCase();
  if (savedGroup?.domain && savedGroup?.splitKeyword) {
    return `${savedGroup.domain}::title-split::${savedGroup.splitKeyword.toLowerCase()}`.toLowerCase();
  }
  if (savedGroup?.domain) return savedGroup.domain.toLowerCase();
  return deferredDomainInfo(item?.url).domain.toLowerCase();
}

function groupDeferredTabsByDomain(items = []) {
  const groups = new Map();

  for (const item of items) {
    const info = deferredDomainInfo(item.url);
    const savedGroup = normalizeSavedGroup(item.savedGroup);
    const key = getDeferredGroupKey(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        id: savedGroup?.id || key,
        domain: savedGroup?.domain || info.domain,
        label: savedGroup?.label || info.label,
        hostname: info.hostname,
        splitKeyword: savedGroup?.splitKeyword || '',
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  return Array.from(groups.values())
    .map(group => ({
      ...group,
      items: group.items.slice().sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0)),
    }))
    .sort((a, b) => (a.label || a.domain).localeCompare((b.label || b.domain), undefined, { sensitivity: 'base' }));
}

function isDeferredGroupCollapsed(groupKey) {
  return deferredGroupCollapseState.get(groupKey) === true;
}

function toggleDeferredGroup(groupKey) {
  deferredGroupCollapseState.set(groupKey, !isDeferredGroupCollapsed(groupKey));
}

function collapseDeferredDuplicates(items = []) {
  const groups = new Map();

  for (const item of items) {
    const key = normalizeDeferredUrl(item.url);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { ...item, duplicateCount: 0, duplicateIds: [] });
    }
    const group = groups.get(key);
    group.duplicateCount += 1;
    group.duplicateIds.push(item.id);
    if (new Date(item.savedAt || 0) > new Date(group.savedAt || 0)) {
      group.id = item.id;
      group.title = item.title;
      group.savedAt = item.savedAt;
      group.savedGroup = item.savedGroup;
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));
}

async function addDomainSplitRule(domain, keyword) {
  const rules = await getDomainSplitRules();
  const normalized = normalizeDomainSplitRule({ domain, keyword });
  const exists = rules.some(rule =>
    rule.domain === normalized.domain &&
    rule.keyword.toLowerCase() === normalized.keyword.toLowerCase()
  );
  if (!exists) rules.push(normalized);
  await saveDomainSplitRules(rules);
}

async function removeDomainSplitRule(domain, keyword) {
  const rules = await getDomainSplitRules();
  await saveDomainSplitRules(rules.filter(rule =>
    !(rule.domain === domain && rule.keyword.toLowerCase() === keyword.toLowerCase())
  ));
}

function matchDomainSplitRule(hostname, title, rules) {
  const cleanHostname = (hostname || '').toLowerCase();
  const cleanTitle = (title || '').toLowerCase();
  return rules.find(rule =>
    rule.domain === cleanHostname &&
    cleanTitle.includes(rule.keyword.toLowerCase())
  ) || null;
}

const TITLE_KEYWORD_STOPWORDS = new Set([
  'about', 'after', 'again', 'all', 'also', 'and', 'are', 'best', 'blog', 'can', 'com',
  'docs', 'for', 'from', 'get', 'has', 'have', 'help', 'home', 'how', 'into', 'login',
  'more', 'new', 'not', 'official', 'open', 'page', 'read', 'search', 'settings', 'that',
  'the', 'this', 'using', 'view', 'with', 'www', 'your',
]);

function stripTrailingSiteBrand(title, groupDomain = '') {
  const domainRoot = String(groupDomain || '')
    .replace(/^www\./, '')
    .split('.')
    .filter(part => part && !['com', 'org', 'net', 'io', 'co', 'ai', 'dev', 'app', 'so', 'me', 'xyz', 'info', 'us', 'uk', 'jp', 'cn', 'tv'].includes(part))
    .pop();

  if (!title || !domainRoot) return title || '';

  const escapedRoot = domainRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trailingBrand = new RegExp(`\\s*[-\\u2010-\\u2015|_/]+\\s*[^-\\u2010-\\u2015|]*${escapedRoot}[^-\\u2010-\\u2015|]*$`, 'i');
  return title.replace(trailingBrand, '').trim() || title;
}

function titleKeywordTokens(title, groupDomain = '') {
  const domainName = friendlyDomain(groupDomain).toLowerCase();
  const domainTokens = new Set([
    ...titleKeywordTokensFromText(domainName),
    ...titleKeywordTokensFromText(String(groupDomain || '').replace(/^www\./, '').replace(/\.\w+$/, '')),
  ]);

  return titleKeywordTokensFromText(title).filter(token => !domainTokens.has(token));
}

function titleKeywordTokensFromText(title) {
  const clean = stripTitleNoise(title || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[._/@#?=&:+|()[\]{}"'`~!,$%^*<>\\]+/g, ' ');

  const matches = clean.match(/[\p{Script=Han}]{2,}|[a-zA-Z][a-zA-Z0-9-]{2,}/gu) || [];
  return matches
    .map(token => token.toLowerCase().replace(/^-+|-+$/g, ''))
    .filter(token =>
      token.length >= 3 &&
      !/^\d+$/.test(token) &&
      !TITLE_KEYWORD_STOPWORDS.has(token)
    );
}

function getRecommendedSplitKeywords(group, limit = 3) {
  if (!group || group.domain === '__landing-pages__' || group.splitKeyword) return [];

  const tabs = group.tabs || [];
  if (tabs.length <= 10) return [];

  const tokenStats = new Map();
  for (const tab of tabs) {
    const cleanedTitle = cleanTitle(
      stripTrailingSiteBrand(stripTitleNoise(smartTitle(tab.title || '', tab.url)), group.domain),
      group.domain
    );
    const tokens = new Set(titleKeywordTokens(cleanedTitle, group.domain));
    for (const token of tokens) {
      if (!tokenStats.has(token)) tokenStats.set(token, { count: 0, length: token.length });
      tokenStats.get(token).count += 1;
    }
  }

  const existingKeywords = new Set(
    domainGroups
      .filter(candidate => candidate.domain === group.domain && candidate.splitKeyword)
      .map(candidate => candidate.splitKeyword.toLowerCase())
  );

  return Array.from(tokenStats.entries())
    .filter(([token, stats]) =>
      stats.count >= 2 &&
      stats.count < tabs.length &&
      !existingKeywords.has(token)
    )
    .sort((a, b) => {
      const countDiff = b[1].count - a[1].count;
      if (countDiff) return countDiff;
      return b[1].length - a[1].length;
    })
    .slice(0, limit)
    .map(([keyword, stats]) => ({ keyword, count: stats.count }));
}

async function getQuickLinks() {
  const configLinks = typeof LOCAL_QUICK_LINKS !== 'undefined'
    ? normalizeQuickLinks(LOCAL_QUICK_LINKS)
    : normalizeQuickLinks(DEFAULT_QUICK_LINKS);

  const { [QUICK_LINKS_STORAGE_KEY]: savedLinks } = await chrome.storage.local.get(QUICK_LINKS_STORAGE_KEY);
  if (!savedLinks) return configLinks;
  return normalizeQuickLinks(savedLinks);
}

async function saveQuickLinks(links) {
  await chrome.storage.local.set({
    [QUICK_LINKS_STORAGE_KEY]: normalizeQuickLinks(links),
  });
}

function quickLinkFavicon(url) {
  try {
    const hostname = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return '';
  }
}

function quickLinkHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function exportQuickLinksConfig(links) {
  return JSON.stringify({
    type: QUICK_LINKS_TRANSFER_TYPE,
    version: 1,
    slots: QUICK_LINK_SLOTS,
    links: normalizeQuickLinks(links),
  }, null, 2);
}

function parseQuickLinksTransfer(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (Array.isArray(payload)) return normalizeQuickLinks(payload);
  if (payload?.type !== QUICK_LINKS_TRANSFER_TYPE || !Array.isArray(payload?.links)) return null;
  return normalizeQuickLinks(payload.links);
}

async function renderQuickLinks() {
  const quickLinksGrid = document.getElementById('quickLinksGrid');
  if (!quickLinksGrid) return;

  const quickLinks = await getQuickLinks();
  quickLinksGrid.innerHTML = quickLinks.map((link, index) => {
    const hasLink = !!link.url;
    const safeTitle = (link.title || '').replace(/"/g, '&quot;');
    const safeUrl = (link.url || '').replace(/"/g, '&quot;');
    const favicon = hasLink ? quickLinkFavicon(link.url) : '';
    const hostname = hasLink ? quickLinkHostname(link.url) : 'Click settings to add one';

    return `
      <div class="quick-link-card ${hasLink ? 'is-filled' : 'is-empty'}" ${hasLink ? `data-action="open-quick-link" data-quick-link-url="${safeUrl}"` : ''}>
        <button class="quick-link-settings chip-action" data-action="edit-quick-link" data-quick-link-index="${index}" title="Edit quick link">
          <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
        </button>
        <div class="quick-link-body">
          ${favicon ? `<img class="quick-link-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">` : `<div class="quick-link-favicon quick-link-favicon--empty" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor">
              <rect x="3.75" y="4.75" width="16.5" height="14.5" rx="3" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M8 19.25v1m8-1v1M7.5 8.5h9m-9 3.5h5" />
            </svg>
          </div>`}
          <div class="quick-link-title">${link.title || 'Empty slot'}</div>
          <div class="quick-link-meta">${hostname}</div>
        </div>
      </div>`;
  }).join('');
}

async function openQuickLinkModal(index) {
  const quickLinks = await getQuickLinks();
  const link = quickLinks[index] || { title: '', url: '' };
  const modal = document.getElementById('quickLinkModal');
  const indexInput = document.getElementById('quickLinkIndex');
  const titleInput = document.getElementById('quickLinkTitle');
  const urlInput = document.getElementById('quickLinkUrl');
  const exportEl = document.getElementById('quickLinkConfigExport');
  const importEl = document.getElementById('quickLinkConfigImport');

  if (!modal || !indexInput || !titleInput || !urlInput || !exportEl) return;

  indexInput.value = String(index);
  titleInput.value = link.title || '';
  urlInput.value = link.url || '';
  exportEl.value = exportQuickLinksConfig(quickLinks);
  if (importEl) importEl.value = '';
  modal.style.display = 'flex';
}

function closeQuickLinkModal() {
  const modal = document.getElementById('quickLinkModal');
  if (modal) modal.style.display = 'none';
}

function openDomainSplitModal(groupId) {
  const group = findDomainGroupById(groupId);
  if (!group || group.domain === '__landing-pages__') return;

  const modal = document.getElementById('domainSplitModal');
  const domainInput = document.getElementById('domainSplitDomain');
  const labelInput = document.getElementById('domainSplitLabel');
  const keywordInput = document.getElementById('domainSplitKeyword');
  if (!modal || !domainInput || !labelInput || !keywordInput) return;

  domainInput.value = group.domain || '';
  labelInput.value = group.label || friendlyDomain(group.domain);
  keywordInput.value = '';
  modal.style.display = 'flex';
  setTimeout(() => keywordInput.focus(), 0);
}

function closeDomainSplitModal() {
  const modal = document.getElementById('domainSplitModal');
  if (modal) modal.style.display = 'none';
}

async function saveDomainSplitFromModal() {
  const domain = document.getElementById('domainSplitDomain')?.value || '';
  const keyword = document.getElementById('domainSplitKeyword')?.value.trim() || '';
  if (!domain || !keyword) {
    showToast('Type a title keyword first');
    return;
  }

  await addDomainSplitRule(domain, keyword);
  closeDomainSplitModal();
  await renderDashboard();
  showToast(`Split ${friendlyDomain(domain)} by "${keyword}"`);
}

async function saveQuickLinkFromModal({ clear = false } = {}) {
  const index = Number(document.getElementById('quickLinkIndex')?.value ?? '-1');
  if (index < 0 || index >= QUICK_LINK_SLOTS) return;

  const titleInput = document.getElementById('quickLinkTitle');
  const urlInput = document.getElementById('quickLinkUrl');
  const quickLinks = await getQuickLinks();

  const title = clear ? '' : (titleInput?.value || '').trim();
  let url = clear ? '' : (urlInput?.value || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;

  quickLinks[index] = { title, url };
  await saveQuickLinks(quickLinks);

  const exportEl = document.getElementById('quickLinkConfigExport');
  if (exportEl) exportEl.value = exportQuickLinksConfig(quickLinks);

  await renderQuickLinks();
  showToast(clear ? 'Quick link cleared' : 'Quick link saved');
  closeQuickLinkModal();
}

async function importQuickLinksFromModal() {
  const importEl = document.getElementById('quickLinkConfigImport');
  const links = parseQuickLinksTransfer(importEl?.value || '');
  if (!links) {
    showToast('Paste valid quick links JSON');
    return;
  }

  await saveQuickLinks(links);

  const exportEl = document.getElementById('quickLinkConfigExport');
  if (exportEl) exportEl.value = exportQuickLinksConfig(links);

  await renderQuickLinks();
  showToast('Quick links imported');
  closeQuickLinkModal();
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

function isPinnedTab(tab) {
  return !!tab?.pinned;
}

function getDashboardTabs(tabs) {
  const urlCounts = {};
  const pinnedUrls = new Set();
  for (const tab of tabs) {
    if (!tab.url) continue;
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
    if (isPinnedTab(tab)) pinnedUrls.add(tab.url);
  }

  return tabs.filter(tab => {
    if (!isPinnedTab(tab)) return true;
    return (urlCounts[tab.url] || 0) > 1 && pinnedUrls.has(tab.url);
  });
}

function getDuplicateSummary(tabs) {
  const urlCounts = {};
  for (const tab of tabs) {
    if (!tab.url) continue;
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }

  const dupeEntries = Object.entries(urlCounts).filter(([, count]) => count > 1);
  return {
    urls: dupeEntries.map(([url]) => url),
    totalExtras: dupeEntries.reduce((sum, [, count]) => sum + count - 1, 0),
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function closeOneTabByUrl(url, { preserveFixedHidden = false } = {}) {
  if (!url) return false;

  const allTabs = await chrome.tabs.query({});
  const matching = allTabs.filter(t => t.url === url);
  if (matching.length === 0) return false;

  let target = matching[0];
  if (preserveFixedHidden && matching.some(isPinnedTab) && matching.length > 1) {
    target = matching.find(t => !t.pinned) || matching.find(t => !t.active) || matching[matching.length - 1];
  }

  await chrome.tabs.remove(target.id);
  await fetchOpenTabs();
  return true;
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

const PAGE_CHIP_BATCH_SIZE = 8;

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable page-chip-hidden${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}" style="display:none">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  const nextBatchSize = Math.min(PAGE_CHIP_BATCH_SIZE, hiddenTabs.length);

  return `
    <div class="page-chips-overflow">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${nextBatchSize}/${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = getGroupStableId(group);

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">${tabCount}</span>`;
  const recommendedKeywords = getRecommendedSplitKeywords(group);
  const keywordChips = recommendedKeywords.length > 0
    ? `<span class="split-keyword-recs" aria-label="Recommended split keywords">
        ${recommendedKeywords.map(({ keyword, count }) => {
          const safeKeyword = keyword.replace(/"/g, '&quot;');
          return `<button class="split-keyword-rec" data-action="apply-domain-split-keyword" data-domain="${group.domain}" data-keyword="${safeKeyword}" title="Split ${count} matching tabs by ${safeKeyword}">${safeKeyword}</button>`;
        }).join('')}
      </span>`
    : '';

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, PAGE_CHIP_BATCH_SIZE);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(PAGE_CHIP_BATCH_SIZE), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close All
    </button>
    <button class="action-btn save-tabs" data-action="defer-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.save}
      Save All
    </button>`;

  if (!isLanding && !group.splitKeyword) {
    actionsHtml += `
      <button class="action-btn split-tabs" data-action="open-domain-split" data-domain-id="${stableId}" title="Split this domain by title text">
        ${ICONS.split}
        Keyword
      </button>`;
  }

  if (group.splitKeyword) {
    actionsHtml += `
      <button class="action-btn split-tabs" data-action="remove-domain-split" data-domain="${group.domain}" data-split-keyword="${(group.splitKeyword || '').replace(/"/g, '&quot;')}">
        ${ICONS.merge}
        Merge
      </button>`;
  }

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn dedup-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${keywordChips}
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');

  if (!column) return;
  applyDeferredLayoutState();

  try {
    const { active } = await getSavedTabs();
    const activeGroups = groupDeferredTabsByDomain(active);

    // Hide the entire column if there's nothing to show
    if (active.length === 0) {
      column.style.display = 'none';
      isDeferredExpanded = false;
      applyDeferredLayoutState();
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${activeGroups.length} domain${activeGroups.length !== 1 ? 's' : ''}`;
      list.innerHTML = activeGroups.map(group => renderDeferredGroup(group)).join('');
      list.style.display = 'flex';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active saved item: title link, domain, time ago, dismiss button.
 */
function renderDeferredItem(item, { hidden = false } = {}) {
  const { hostname } = deferredDomainInfo(item.url);
  const faviconUrl = hostname ? `https://www.google.com/s2/favicons?domain=${hostname}&sz=16` : '';
  const hiddenClass = hidden ? ' deferred-item-hidden' : '';
  const hiddenStyle = hidden ? ' style="display:none"' : '';
  const safeUrl = (item.url || '').replace(/"/g, '&quot;');
  const safeTitle = (item.title || item.url || '').replace(/"/g, '&quot;');
  const duplicateBadge = item.duplicateCount > 1
    ? ` <span class="deferred-dupe-badge">(${item.duplicateCount}x)</span>`
    : '';

  return `
    <div class="deferred-item${hiddenClass}" data-deferred-id="${item.id}" data-deferred-url="${safeUrl}"${hiddenStyle}>
      <div class="deferred-info">
        <a href="${safeUrl}" target="_blank" rel="noopener" class="deferred-title" data-action="restore-deferred-url" data-deferred-url="${safeUrl}" title="${safeTitle}">
          ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">` : ''}${item.title || item.url}${duplicateBadge}
        </a>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred-url" data-deferred-url="${safeUrl}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

function renderDeferredItemsWithOverflow(items = []) {
  const uniqueItems = collapseDeferredDuplicates(items);
  const visibleItems = uniqueItems.slice(0, PAGE_CHIP_BATCH_SIZE);
  const hiddenItems = uniqueItems.slice(PAGE_CHIP_BATCH_SIZE);
  const nextBatchSize = Math.min(PAGE_CHIP_BATCH_SIZE, hiddenItems.length);
  const overflowButton = hiddenItems.length > 0
    ? `<button class="deferred-more" data-action="expand-deferred-items" type="button">+${nextBatchSize}/${hiddenItems.length} more</button>`
    : '';

  return `
    ${visibleItems.map(item => renderDeferredItem(item)).join('')}
    ${hiddenItems.map(item => renderDeferredItem(item, { hidden: true })).join('')}
    ${overflowButton}`;
}

function renderDeferredGroup(group) {
  const isCollapsed = isDeferredGroupCollapsed(group.key);
  const itemCount = group.items.length;
  const bodyDisplay = isCollapsed ? 'none' : 'block';
  const faviconUrl = group.hostname ? `https://www.google.com/s2/favicons?domain=${group.hostname}&sz=16` : '';

  return `
    <section class="deferred-group" data-domain-key="${group.key}">
      <div class="deferred-group-header">
        <button class="deferred-group-toggle ${isCollapsed ? '' : 'open'}" data-action="toggle-deferred-group" data-domain-key="${group.key}">
          <span class="deferred-group-title-row">
            <svg class="deferred-group-chevron" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" /></svg>
            <span class="deferred-group-title-wrap">
              ${faviconUrl ? `<img src="${faviconUrl}" alt="" class="deferred-group-favicon" onerror="this.style.display='none'">` : ''}
              <span class="deferred-group-title">${group.label}</span>
            </span>
            <span class="deferred-group-count">${itemCount}</span>
          </span>
        </button>
        <div class="deferred-group-actions">
          <button class="action-btn close-tabs deferred-group-dismiss" data-action="dismiss-deferred-domain" data-domain-key="${group.key}" data-domain-label="${group.label.replace(/"/g, '&quot;')}" title="Close this saved domain">
            ${ICONS.close}
            Close All
          </button>
          <button class="action-btn save-tabs deferred-group-restore" data-action="restore-deferred-domain" data-domain-key="${group.key}" data-domain-label="${group.label.replace(/"/g, '&quot;')}" title="Restore this saved domain">
            ${ICONS.save}
            Reopen All
          </button>
        </div>
      </div>
      <div class="deferred-group-body" style="display:${bodyDisplay}">
        ${renderDeferredItemsWithOverflow(group.items)}
      </div>
    </section>`;
}

/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  await renderQuickLinks();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const { totalDuplicateExtras } = await rebuildDomainGroupsFromOpenTabs();

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (openTabsSection) {
    openTabsSection.style.display = 'block';
  }

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    if (openTabsSectionCount) openTabsSectionCount.textContent = '0 domains';
    if (openTabsMissionsEl) openTabsMissionsEl.innerHTML = '';
  }

  updateOpenTabsUiCounts(totalDuplicateExtras);

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  if (e.target.id === 'quickLinkModal') {
    closeQuickLinkModal();
    return;
  }
  if (e.target.id === 'domainSplitModal') {
    closeDomainSplitModal();
    return;
  }

  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  if (action === 'close-quick-link-modal') {
    closeQuickLinkModal();
    return;
  }

  if (action === 'close-domain-split-modal') {
    closeDomainSplitModal();
    return;
  }

  if (action === 'edit-quick-link') {
    e.stopPropagation();
    const index = Number(actionEl.dataset.quickLinkIndex || '-1');
    if (index >= 0) await openQuickLinkModal(index);
    return;
  }

  if (action === 'open-quick-link') {
    const targetUrl = actionEl.dataset.quickLinkUrl;
    if (targetUrl) window.location.href = targetUrl;
    return;
  }

  if (action === 'open-domain-split') {
    e.stopPropagation();
    const groupId = actionEl.dataset.domainId;
    if (groupId) openDomainSplitModal(groupId);
    return;
  }

  if (action === 'apply-domain-split-keyword') {
    e.stopPropagation();
    const domain = actionEl.dataset.domain;
    const keyword = actionEl.dataset.keyword;
    if (!domain || !keyword) return;
    await addDomainSplitRule(domain, keyword);
    await renderDashboard();
    showToast(`Split ${friendlyDomain(domain)} by ${keyword}`);
    return;
  }

  if (action === 'remove-domain-split') {
    e.stopPropagation();
    const domain = actionEl.dataset.domain;
    const keyword = actionEl.dataset.splitKeyword;
    if (!domain || !keyword) return;
    await removeDomainSplitRule(domain, keyword);
    await renderDashboard();
    showToast('Merged split group back');
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  // ---- Close all duplicate tabs across the dashboard, keep one copy each ----
  if (action === 'close-all-duplicates') {
    const { urls, totalExtras } = getDuplicateSummary(getDashboardTabs(getRealTabs()));
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();
    await renderDashboard();
    showToast(`Closed ${totalExtras} duplicate tab${totalExtras !== 1 ? 's' : ''}`);
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      const hiddenChips = Array.from(overflowContainer.querySelectorAll('.page-chip-hidden'));
      const nextChips = hiddenChips.slice(0, PAGE_CHIP_BATCH_SIZE);
      nextChips.forEach(chip => {
        chip.classList.remove('page-chip-hidden');
        chip.style.display = '';
      });

      const remaining = hiddenChips.length - nextChips.length;
      if (remaining > 0) {
        const nextBatchSize = Math.min(PAGE_CHIP_BATCH_SIZE, remaining);
        const label = actionEl.querySelector('.chip-text');
        if (label) label.textContent = `+${nextBatchSize}/${remaining} more`;
      } else {
        actionEl.remove();
      }
    }
    return;
  }

  // ---- Expand saved-for-later items in batches ----
  if (action === 'expand-deferred-items') {
    const body = actionEl.closest('.deferred-group-body');
    if (body) {
      const hiddenItems = Array.from(body.querySelectorAll('.deferred-item-hidden'));
      const nextItems = hiddenItems.slice(0, PAGE_CHIP_BATCH_SIZE);
      nextItems.forEach(item => {
        item.classList.remove('deferred-item-hidden');
        item.style.display = '';
      });

      const remaining = hiddenItems.length - nextItems.length;
      if (remaining > 0) {
        const nextBatchSize = Math.min(PAGE_CHIP_BATCH_SIZE, remaining);
        actionEl.textContent = `+${nextBatchSize}/${remaining} more`;
      } else {
        actionEl.remove();
      }
    }
    return;
  }

  if (action === 'toggle-deferred-layout') {
    e.preventDefault();
    e.stopPropagation();
    isDeferredExpanded = !isDeferredExpanded;
    applyDeferredLayoutState();
    return;
  }

  if (action === 'restore-deferred-url') {
    e.preventDefault();
    e.stopPropagation();
    const url = actionEl.dataset.deferredUrl;
    if (!url) return;

    const restoredCount = await restoreSavedUrl(url);
    if (restoredCount === 0) return;

    await renderDeferredColumn();
    showToast('Restored saved tab');
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;
    const card = actionEl.closest('.mission-card');
    const groupId = card?.dataset.domainId;

    const closed = await closeOneTabByUrl(tabUrl, { preserveFixedHidden: true });
    if (!closed) return;

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      await wait(200);
      chip.remove();
    }

    if (groupId && card) {
      await refreshSingleDomainCard(groupId, card);
    } else {
      await renderDashboard();
    }

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;
    const card = actionEl.closest('.mission-card');
    const groupId = card?.dataset.domainId;

    // Save to chrome.storage.local
    try {
      const group = groupId ? findDomainGroupById(groupId) : null;
      await saveTabForLater({
        url: tabUrl,
        title: tabTitle,
        savedGroup: group ? {
          id: getGroupStableId(group),
          domain: group.domain,
          label: group.label || (group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain)),
          splitKeyword: group.splitKeyword || '',
        } : null,
      });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    const closed = await closeOneTabByUrl(tabUrl, { preserveFixedHidden: true });
    if (!closed) return;

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      await wait(200);
      chip.remove();
    }

    if (groupId && card) {
      await refreshSingleDomainCard(groupId, card);
    } else {
      await renderDashboard();
    }
    showToast('Saved for later');
    return;
  }

  if (action === 'defer-domain-tabs') {
    e.stopPropagation();
    const domainId = actionEl.dataset.domainId;
    const group = findDomainGroupById(domainId);
    const card = actionEl.closest('.mission-card');
    if (!group || !group.tabs?.length) return;

    try {
      for (const tab of group.tabs) {
        await saveTabForLater({
          url: tab.url,
          title: cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain),
          savedGroup: {
            id: getGroupStableId(group),
            domain: group.domain,
            label: group.label || (group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain)),
            splitKeyword: group.splitKeyword || '',
          },
        });
      }
    } catch (err) {
      console.error('[tab-out] Failed to save domain group:', err);
      showToast('Failed to save group');
      return;
    }

    const tabIdsToClose = group.tabs
      .filter(tab => !isPinnedTab(tab))
      .map(tab => tab.id)
      .filter(Number.isInteger);
    const pinnedDuplicateUrls = Array.from(new Set(
      group.tabs.filter(isPinnedTab).map(tab => tab.url).filter(Boolean)
    ));

    if (tabIdsToClose.length > 0) await closeTabsByIds(tabIdsToClose);
    if (pinnedDuplicateUrls.length > 0) await closeDuplicateTabs(pinnedDuplicateUrls, true);

    playCloseSound();
    if (card) animateCardOut(card);
    await renderDashboard();
    showToast(`Saved ${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''} from ${group.label || friendlyDomain(group.domain)}`);
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred-url') {
    const url = actionEl.dataset.deferredUrl;
    if (!url) return;

    await dismissSavedUrl(url);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  if (action === 'dismiss-deferred-domain') {
    const domainKey = actionEl.dataset.domainKey;
    const domainLabel = actionEl.dataset.domainLabel || 'this domain';
    if (!domainKey) return;

    await dismissSavedDomain(domainKey);

    const group = actionEl.closest('.deferred-group');
    if (group) {
      group.classList.add('removing');
      setTimeout(() => {
        group.remove();
        renderDeferredColumn();
      }, 300);
    } else {
      await renderDeferredColumn();
    }

    showToast(`Closed saved tabs from ${domainLabel}`);
    return;
  }

  if (action === 'restore-deferred-domain') {
    const domainKey = actionEl.dataset.domainKey;
    const domainLabel = actionEl.dataset.domainLabel || 'this domain';
    if (!domainKey) return;

    const restoredCount = await restoreSavedDomain(domainKey);
    if (restoredCount === 0) return;

    await renderDashboard();
    showToast(`Restored ${restoredCount} tab${restoredCount !== 1 ? 's' : ''} from ${domainLabel}`);
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = findDomainGroupById(domainId);
    if (!group) return;

    const regularTabIds = group.tabs
      .filter(tab => !isPinnedTab(tab))
      .map(tab => tab.id)
      .filter(Number.isInteger);
    const pinnedDuplicateUrls = Array.from(new Set(
      group.tabs.filter(isPinnedTab).map(tab => tab.url).filter(Boolean)
    ));
    const closedCount = regularTabIds.length + pinnedDuplicateUrls.length;

    if (regularTabIds.length > 0) await closeTabsByIds(regularTabIds);
    if (pinnedDuplicateUrls.length > 0) await closeDuplicateTabs(pinnedDuplicateUrls, true);

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    const { totalDuplicateExtras } = await rebuildDomainGroupsFromOpenTabs();
    updateOpenTabsUiCounts(totalDuplicateExtras);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${closedCount} tab${closedCount !== 1 ? 's' : ''} from ${groupLabel}`);
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;
    const groupId = card?.dataset.domainId;

    const { totalExtras } = getDuplicateSummary(
      (card?.dataset.domainId
        ? (findDomainGroupById(card.dataset.domainId)?.tabs || [])
        : [])
    );

    await closeDuplicateTabs(urls, true);
    playCloseSound();
    if (groupId && card) {
      await refreshSingleDomainCard(groupId, card);
    } else {
      await renderDashboard();
    }
    showToast(`Closed ${totalExtras} duplicate tab${totalExtras !== 1 ? 's' : ''}`);
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


document.getElementById('quickLinkForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveQuickLinkFromModal();
});

document.getElementById('domainSplitForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveDomainSplitFromModal();
});

document.getElementById('quickLinkClear')?.addEventListener('click', async () => {
  await saveQuickLinkFromModal({ clear: true });
});

document.getElementById('quickLinkImport')?.addEventListener('click', async () => {
  await importQuickLinksFromModal();
});

document.getElementById('quickLinkCopy')?.addEventListener('click', async () => {
  const exportEl = document.getElementById('quickLinkConfigExport');
  const text = exportEl?.value || '';
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    showToast('Config copied');
  } catch {
    showToast('Copy failed');
  }
});

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-action="toggle-deferred-group"]');
  if (!toggle) return;

  const groupKey = toggle.dataset.domainKey;
  if (!groupKey) return;

  toggleDeferredGroup(groupKey);
  toggle.classList.toggle('open');

  const group = toggle.closest('.deferred-group');
  const body = group?.querySelector('.deferred-group-body');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'tab-out:deferred-updated') return;
  renderDeferredColumn();
});

renderDashboard();
