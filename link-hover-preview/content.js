(() => {
  const DEFAULTS = {
    enabled: true,
    delay: 1000,
    width: 640,
    height: 420,
    allowBlocked: false
  };
  const HIDE_GRACE_MS = 300;
  const MARGIN = 8;

  let settings = { ...DEFAULTS };
  let hoverTimer = null;
  let hideTimer = null;
  let pendingLink = null;
  let currentLink = null;
  let currentUrl = null;

  let host = null;
  let box = null;
  let frame = null;
  let urlLabel = null;

  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    if (!settings.enabled) hide();
    else if (isVisible() && currentLink) position(currentLink);
  });

  function previewableUrl(a) {
    if (!a || !a.href) return null;
    let url;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const here = new URL(location.href);
    const samePage =
      url.origin === here.origin &&
      url.pathname === here.pathname &&
      url.search === here.search;
    if (samePage) return null; // in-page anchors like #section
    return url.href;
  }

  function isVisible() {
    return !!host && host.style.display !== 'none';
  }

  function inPreview(e) {
    return !!host && e.composedPath().includes(host);
  }

  function linkFrom(target) {
    return target && target.closest ? target.closest('a[href]') : null;
  }

  function buildPreview() {
    host = document.createElement('div');
    host.style.cssText =
      'all: initial; position: fixed; z-index: 2147483647; display: none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box {
          display: flex; flex-direction: column;
          width: 100%; height: 100%;
          background: #fff; color: #222;
          border: 1px solid rgba(0,0,0,.2); border-radius: 8px;
          box-shadow: 0 8px 28px rgba(0,0,0,.28);
          overflow: hidden;
          font: 12px/1.4 system-ui, -apple-system, Segoe UI, sans-serif;
        }
        .bar {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 6px; background: #f2f3f5;
          border-bottom: 1px solid rgba(0,0,0,.12);
        }
        .url {
          flex: 1; min-width: 0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: #555;
        }
        button {
          all: unset; cursor: pointer; padding: 2px 8px; border-radius: 4px;
          color: #333;
        }
        button:hover { background: rgba(0,0,0,.08); }
        iframe { flex: 1; width: 100%; border: 0; background: #fff; }
        @media (prefers-color-scheme: dark) {
          .box { background: #1f2023; color: #ddd; border-color: rgba(255,255,255,.18); }
          .bar { background: #2a2b2f; border-color: rgba(255,255,255,.12); }
          .url { color: #aaa; }
          button { color: #ddd; }
          button:hover { background: rgba(255,255,255,.1); }
        }
      </style>
      <div class="box">
        <div class="bar">
          <span class="url"></span>
          <button class="open" title="Open in new tab">Open ↗</button>
          <button class="close" title="Close (Esc)">✕</button>
        </div>
        <iframe
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>`;
    box = root.querySelector('.box');
    frame = root.querySelector('iframe');
    urlLabel = root.querySelector('.url');
    root.querySelector('.open').addEventListener('click', () => {
      if (currentUrl) window.open(currentUrl, '_blank', 'noopener');
      hide();
    });
    root.querySelector('.close').addEventListener('click', hide);
    document.documentElement.appendChild(host);
  }

  function position(link) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(Number(settings.width) || DEFAULTS.width, vw - 2 * MARGIN);
    const h = Math.min(Number(settings.height) || DEFAULTS.height, vh - 2 * MARGIN);
    const r = link.getBoundingClientRect();

    // Prefer below the link, then above, then pin to the top edge.
    let top = r.bottom + MARGIN;
    if (top + h > vh - MARGIN) top = r.top - h - MARGIN;
    if (top < MARGIN) top = MARGIN;
    let left = Math.min(Math.max(MARGIN, r.left), vw - w - MARGIN);

    host.style.width = `${w}px`;
    host.style.height = `${h}px`;
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
  }

  async function show(link) {
    const url = previewableUrl(link);
    if (!url || !link.isConnected) return;
    if (!host) buildPreview();
    clearTimeout(hideTimer);
    currentLink = link;
    pendingLink = null;

    if (settings.allowBlocked) {
      try {
        await chrome.runtime.sendMessage({ type: 'allow-frame', url });
      } catch {
        // Extension reloaded or background unavailable; load the frame anyway.
      }
      if (currentLink !== link) return; // user moved on while we waited
    }

    if (currentUrl !== url) {
      currentUrl = url;
      frame.src = url;
    }
    urlLabel.textContent = url;
    urlLabel.title = url;
    position(link);
    host.style.display = 'block';
  }

  function hide() {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    pendingLink = null;
    currentLink = null;
    if (!host) return;
    host.style.display = 'none';
    // Unload the page so it stops playing audio/video and using CPU.
    frame.src = 'about:blank';
    currentUrl = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_GRACE_MS);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (!settings.enabled) return;
      if (inPreview(e)) {
        clearTimeout(hideTimer);
        return;
      }
      const link = linkFrom(e.target);
      if (isVisible()) {
        if (link && link === currentLink) {
          clearTimeout(hideTimer);
          return;
        }
        scheduleHide();
      }
      if (link && link !== pendingLink && previewableUrl(link)) {
        clearTimeout(hoverTimer);
        pendingLink = link;
        hoverTimer = setTimeout(() => show(link), Number(settings.delay) || 0);
      }
    },
    true
  );

  document.addEventListener(
    'mouseout',
    (e) => {
      const link = linkFrom(e.target);
      const to = e.relatedTarget;
      if (!link || (to && link.contains(to))) return;
      if (link === pendingLink) {
        clearTimeout(hoverTimer);
        pendingLink = null;
      }
      if (link === currentLink && !(host && to === host)) scheduleHide();
    },
    true
  );

  // Clicking or scrolling means the user is doing something else.
  document.addEventListener(
    'mousedown',
    (e) => {
      clearTimeout(hoverTimer);
      pendingLink = null;
      if (isVisible() && !inPreview(e)) hide();
    },
    true
  );
  window.addEventListener('scroll', () => isVisible() && hide(), { passive: true });
  window.addEventListener('blur', () => clearTimeout(hoverTimer));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
})();
