// Injected on demand into the active tab (chrome.scripting.executeScript).
// Toggles a Spotlight-style overlay: dimmed full-viewport backdrop plus a
// centered iframe hosting an extension page (popup.html for search,
// bookmark.html for the bookmark dialog) — extension pages keep the full
// chrome.bookmarks/history/tabs access that a content script would lack.
//
// Which page to host is passed via document.documentElement.dataset.slPage,
// set by the background worker just before injecting this file (files-based
// executeScript cannot take arguments).
//
// Toggle semantics: re-running for the SAME page removes the overlay;
// running for a DIFFERENT page replaces it.
//
// postMessage protocol with the iframe (…?overlay=1):
//   parent → iframe : { type: 'searchlight-focus' }  focus the main input
//   iframe → parent : { type: 'searchlight-close' }  remove the overlay
//
// Close paths: Esc (captured on the host document AND relayed from inside
// the iframe), a click on the backdrop, re-toggle, or any completing action.

(() => {
  const ID = 'searchlight-overlay-root';
  const page = document.documentElement.dataset.slPage || 'popup.html';
  delete document.documentElement.dataset.slPage;

  const existing = document.getElementById(ID);
  if (existing) {
    const samePage = existing.dataset.page === page;
    existing.remove();
    if (samePage) return;   // toggle off; different page falls through to replace
  }

  const root = document.createElement('div');
  root.id = ID;
  root.dataset.page = page;
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);' +
    'display:flex;justify-content:center;align-items:flex-start;';

  // The bookmark dialog is a compact panel; search gets the big one.
  const size = page === 'bookmark.html'
    ? 'margin-top:14vh;width:min(864px,90vw);height:min(576px,78vh);'
    : 'margin-top:8vh;width:min(1296px,92vw);height:min(840px,84vh);';

  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL(page) + '?overlay=1';
  frame.style.cssText = size +
    'border:none;border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.55);' +
    'background:#1e1e2e;color-scheme:dark;';
  // Match the frame placeholder color to the chosen theme (no dark flash).
  chrome.storage.local.get('settings').then(({ settings }) => {
    if (settings?.theme === 'light') {
      frame.style.background = '#f5f5fa';
      frame.style.colorScheme = 'light';
    }
  });
  root.appendChild(frame);

  const close = () => {
    root.remove();
    window.removeEventListener('message', onMsg);
    document.removeEventListener('keydown', onKey, true);
  };
  const onMsg = e => {
    if (e.data && e.data.type === 'searchlight-close') close();
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  root.addEventListener('click', e => { if (e.target === root) close(); });
  window.addEventListener('message', onMsg);
  document.addEventListener('keydown', onKey, true);

  document.documentElement.appendChild(root);
  frame.addEventListener('load', () => {
    // Hand keyboard focus to the iframe's document, then tell the page to
    // focus its main input (autofocus doesn't fire inside iframes).
    frame.contentWindow.focus();
    frame.contentWindow.postMessage({ type: 'searchlight-focus' }, '*');
  });
})();
