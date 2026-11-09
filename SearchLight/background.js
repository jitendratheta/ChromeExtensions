// Searchlight background service worker: opens the extension UIs on
// keyboard commands or a toolbar-icon click.
//
//   open-search  (Cmd+K) → popup.html    — search palette
//   bookmark-tab (Cmd+B) → bookmark.html — bookmark current tab with a
//                                          fuzzy folder picker
//
// Two display modes (user setting "display", default "overlay"):
//   overlay — inject overlay.js into the active tab, which shows a
//             Spotlight-style iframe. Forbidden on chrome:// pages, the
//             Web Store, and PDFs, where we fall back to…
//   window  — a centered popup window (also the explicit setting value).

const UIS = {
  search: { page: 'popup.html', w: 1296, h: 840 },
  bookmark: { page: 'bookmark.html', w: 864, h: 624 },
};

/**
 * Entry point: pick overlay vs window based on the user setting and the
 * active tab's injectability.
 * @param {'search'|'bookmark'} kind
 */
async function openUI(kind) {
  const ui = UIS[kind];
  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.display === 'window') { openWindow(ui); return; }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && /^(https?|file):/.test(tab.url || '')) {
    try {
      // overlay.js reads which page to host from this dataset attribute
      // (executeScript with files: cannot take arguments directly).
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: p => { document.documentElement.dataset.slPage = p; },
        args: [ui.page],
      });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
      return;
    } catch { /* injection blocked — fall through to window */ }
  }
  openWindow(ui);
}

/**
 * Open (or focus) the popup-window variant of a UI page, anchored over the
 * last-focused normal Chrome window: horizontally centered, near its top
 * (Spotlight-ish). Reuses an existing window hosting the same page.
 * @param {{page:string,w:number,h:number}} ui
 */
async function openWindow(ui) {
  let host = null;
  try {
    host = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  } catch { /* no normal window */ }
  const left = host ? Math.round(host.left + (host.width - ui.w) / 2) : undefined;
  const top = host ? Math.round(host.top + Math.max(60, host.height * 0.08)) : undefined;

  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL(ui.page) });
  if (existing.length) {
    chrome.windows.update(existing[0].windowId, { focused: true, left, top });
    return;
  }

  const win = await chrome.windows.create({
    url: ui.page, type: 'popup', focused: true,
    width: ui.w, height: ui.h, left, top,
  });
  // macOS multi-monitor quirk: create() can clamp left/top to the primary
  // display. Re-applying the position via update() lands it on the monitor
  // that actually hosts the Chrome window.
  if (left !== undefined) {
    chrome.windows.update(win.id, { left, top });
  }
}

chrome.action.onClicked.addListener(() => openUI('search'));
chrome.commands.onCommand.addListener(cmd => {
  if (cmd === 'open-search') openUI('search');
  if (cmd === 'bookmark-tab') openUI('bookmark');
});

// ---------------------------------------------------------------- visit log
//
// chrome.history only records navigations — switching to an already-loaded
// tab leaves no trace, and a tab's lastAccessed dies when the tab closes.
// So every "visit" (tab switch, window switch, in-tab navigation) is stamped
// here into storage; popup.js blends this log into its recency ranking.
// Keys are fragment-less URLs, matching popup.js's canonical form.

const VISIT_KEY = 'visitTimes';
const VISIT_MAX = 5000;   // prune oldest beyond this many URLs

const canonUrl = u => u.split('#')[0];
const trackable = u => !!u && /^(https?|file):/.test(u);

// Serialize read-modify-write cycles so rapid tab switches don't lose stamps.
let visitChain = Promise.resolve();

function recordVisit(url) {
  if (!trackable(url)) return;
  const key = canonUrl(url);
  visitChain = visitChain.then(async () => {
    const { [VISIT_KEY]: visits = {} } = await chrome.storage.local.get(VISIT_KEY);
    visits[key] = Date.now();
    const keys = Object.keys(visits);
    if (keys.length > VISIT_MAX) {
      keys.sort((a, b) => visits[a] - visits[b]);
      for (const k of keys.slice(0, keys.length - VISIT_MAX)) delete visits[k];
    }
    await chrome.storage.local.set({ [VISIT_KEY]: visits });
  }).catch(() => { /* storage hiccup — next visit re-stamps */ });
}

// A "visit" requires the tab's window to actually be FOCUSED. tab.active
// only means active-in-its-own-window, so without this guard a background
// window stamps phantom visits: a page that self-navigates (autoplay,
// rotating dashboards, token-refresh redirects) re-stamps itself on every
// URL change and permanently squats at #1 of the recency list, and a tab
// auto-activated by a neighbor closing gets stamped too.
async function inFocusedWindow(windowId) {
  try { return (await chrome.windows.get(windowId)).focused; }
  catch { return false; }
}

// Tab switch within a window.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (await inFocusedWindow(tab.windowId)) recordVisit(tab.url);
  } catch { /* tab gone */ }
});

// Window switch: the newly focused window's active tab is being "visited",
// but no onActivated fires for it.
chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) recordVisit(tab.url);
  } catch { /* window gone */ }
});

// URL change in the active tab (navigation, SPA route change) — only when
// the user is actually looking at it (focused window).
chrome.tabs.onUpdated.addListener(async (_id, info, tab) => {
  if (!info.url || !tab.active) return;
  if (await inFocusedWindow(tab.windowId)) recordVisit(info.url);
});

// History deletions are invisible to the popup's delta query (it only sees
// new visits). Flag them so the next popup open does a full history reload
// instead of trusting its cache — this is what lets the popup throttle the
// expensive full reload without ever showing deleted entries.
chrome.history.onVisitRemoved.addListener(() => {
  chrome.storage.local.set({ historyDirty: true });
});
