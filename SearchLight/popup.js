// Searchlight popup: fuzzy search over bookmarks, history, and open tabs.
// Matching is powered by fzf-for-js (vendored as fzf.umd.js, BSD-3-Clause)
// in exact mode with extendedMatch, so real fzf syntax works: space-separated
// AND terms, 'exact, ^prefix, suffix$, !negation.
//
// File layout:
//   1. config & state          4. rendering
//   2. data sources            5. search
//   3. recency model           6. actions, events, init

const { AsyncFzf, extendedMatch } = fzf;

// ---------------------------------------------------------------- 1. config & state

const MAX_ROWS = 150;
const MATCH_POOL = 1000;   // fzf keeps this many matches; we re-sort by recency, then cap to MAX_ROWS
const MODES = ['all', 'h', 'b'];             // tab order: all | history | bookmarks
const HISTORY_CACHE_KEY = 'historyCache4';   // full history record
const HOT_CACHE_KEY = 'historyHot4';         // small top-slice for instant first paint
const HOT_SIZE = 500;                        // hot record size (>> MAX_ROWS for headroom)
const FULL_REFRESH_MS = 15 * 60_000;         // full history reload at most this often

const $q = document.getElementById('q');
const $list = document.getElementById('list');
const $count = document.getElementById('count');

let bookmarks = [];   // { kind:'b', title, url, path, t:dateAdded }
let history = [];     // { kind:'h', title, url, path:'', t:lastVisitTime }
let openTabs = [];    // { kind:'t', title, url, path:'', t:lastAccessed }

let mode = 'all';
let results = [];              // [{ item, positions }] — at most MAX_ROWS
let sel = 0;                   // selected row index
let poolSize = 0;              // size of the searched pool (status bar)
const picked = new Set();      // multi-selected urls
const finders = {};            // mode -> { pool, fzf }, built lazily

// ---------------------------------------------------------------- 2. data sources

/**
 * Flatten the whole bookmark tree into searchable items.
 * `path` is the folder chain ("Projects/RedisCache"); `t` is dateAdded so
 * never-visited bookmarks still get a recency signal.
 * @returns {Promise<Array<{kind:'b',title:string,url:string,path:string,t:number}>>}
 */
async function loadBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    for (const c of node.children || []) {
      if (c.url) out.push({ kind: 'b', title: c.title || c.url, url: c.url, path, t: c.dateAdded || 0 });
      else walk(c, path ? `${path}/${c.title}` : c.title);
    }
  };
  // Skip root container names ("Bookmarks Bar" …) to keep paths short.
  for (const container of tree[0].children || []) walk(container, '');
  return out;
}

// Open tabs carry lastAccessed — updated on tab ACTIVATION, which history's
// lastVisitTime is not (that only updates on navigation). Blending these in
// is what makes the recency view match Chrome's own tab search.
async function loadOpenTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter(t => t.url && !isExtensionUrl(t.url))
    .map(t => ({ kind: 't', title: t.title || t.url, url: t.url, path: '', t: t.lastAccessed || 0 }));
}

// Our own pages must never appear in results: opening the search records a
// history visit to popup.html, which would permanently sit at #1.
const isExtensionUrl = url => url.startsWith('chrome-extension://');

const histItem = it =>
  ({ kind: 'h', title: it.title || it.url, url: it.url, path: '', t: it.lastVisitTime || 0 });

// chrome.history.search caps how much a single call returns regardless of
// maxResults (~9k observed). Paginate backwards in time: each batch's oldest
// lastVisitTime becomes the next call's endTime, until nothing new arrives.
async function loadAllHistory() {
  const out = [];
  const seen = new Set();
  let endTime = Date.now() + 864e5;   // tomorrow, to include everything
  for (let i = 0; i < 50; i++) {      // hard stop: 50 batches
    const batch = await chrome.history.search({ text: '', startTime: 0, endTime, maxResults: 10000 });
    if (!batch.length) break;
    let oldest = endTime, added = 0;
    for (const it of batch) {
      if (it.lastVisitTime && it.lastVisitTime < oldest) oldest = it.lastVisitTime;
      if (isExtensionUrl(it.url) || seen.has(it.url)) continue;
      seen.add(it.url);
      out.push(histItem(it));
      added++;
    }
    if (added === 0 || oldest >= endTime) break;   // no progress — done
    endTime = oldest;   // boundary overlap is deduped via `seen`
  }
  return out.sort((a, b) => b.t - a.t);
}

// Single fast call: everything visited since `sinceMs`. Closes the staleness
// window of the cached list before first paint. `truncated` means the call
// hit its cap and may have missed visits — caller must fall back to a full
// reload to stay accurate.
async function recentDelta(sinceMs) {
  const raw = await chrome.history.search({ text: '', startTime: sinceMs, maxResults: 2000 });
  return {
    items: raw.filter(it => !isExtensionUrl(it.url)).map(histItem),
    truncated: raw.length >= 2000,
  };
}

// ---------------------------------------------------------------- 3. recency model

// URLs are keyed without their fragment throughout the recency model so
// that `page#section` (open tab) and `page` (history/bookmark) merge into
// one recency signal instead of missing each other.
const canon = url => url.split('#')[0];

// Memoized canonical key per item object — canon() allocates via split, and
// these lookups sit inside sort comparators over ~10k-item pools. The `c`
// field is stripped before items are persisted to the history cache.
const ckey = it => it.c ?? (it.c = canon(it.url));

let histTime = new Map();    // canon url -> lastVisitTime
let tabTime = new Map();     // canon url -> lastAccessed of an open tab
let visitTime = new Map();   // canon url -> last activation (background.js visit log)
let bmUrls = new Set();      // canon urls of all bookmarks (for row markers)

function setHistory(items) {
  history = items;
  histTime = new Map(items.map(i => [ckey(i), i.t]));
}

function setOpenTabs(items) {
  openTabs = items;
  tabTime = new Map(items.map(i => [ckey(i), i.t]));
}

// Effective recency of a row: freshest of its own timestamp, its last
// history visit, the lastAccessed of an open tab with the same URL, and the
// activation log persisted by background.js. History alone is not enough:
// tab switches record no history visit, and a tab's lastAccessed dies with
// the tab — only the persisted visit log survives tab closes and browser
// restarts.
const effTime = item => {
  const key = ckey(item);
  return Math.max(
    item.t || 0,
    histTime.get(key) || 0,
    tabTime.get(key) || 0,
    visitTime.get(key) || 0,
  );
};

// Merge lists keeping the freshest entry per (canonical) URL, most-recent-first.
function mergeFreshest(...lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const it of list) {
      const key = ckey(it);
      const prev = seen.get(key);
      if (!prev || (it.t || 0) > (prev.t || 0)) seen.set(key, it);
    }
  }
  return [...seen.values()].sort((a, b) => (b.t || 0) - (a.t || 0));
}

// ---------------------------------------------------------------- 4. rendering

/**
 * Tiny DOM builder.
 * @param {string} tag - element tag name
 * @param {string} [className]
 * @param {string|Node} [textOrNode] - plain text (set as textContent) or a child node
 * @returns {HTMLElement}
 */
function el(tag, className, textOrNode) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof textOrNode === 'string') node.textContent = textOrNode;
  else if (textOrNode) node.appendChild(textOrNode);
  return node;
}

/**
 * Chrome's extension favicon endpoint for a page URL (requires the
 * "favicon" permission). Returns a chrome-extension://…/_favicon/ URL.
 */
function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '16');
  return u.href;
}

// Split fzf's match positions (indices into the selector string
// `${title} ${path} ${url}`) into per-segment sets for highlighting.
function segmentPositions(item, positions) {
  const tEnd = item.title.length;
  const pStart = tEnd + 1, pEnd = pStart + item.path.length;
  const uStart = pEnd + 1;
  const t = new Set(), p = new Set(), u = new Set();
  for (const pos of positions || []) {
    if (pos < tEnd) t.add(pos);
    else if (pos >= pStart && pos < pEnd) p.add(pos - pStart);
    else if (pos >= uStart) u.add(pos - uStart);
  }
  return { t, p, u };
}

// Text with matched characters wrapped in <b>.
function highlighted(text, set) {
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < text.length) {
    const bold = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === bold) j++;
    const chunk = text.slice(i, j);
    frag.appendChild(bold ? el('b', '', chunk) : document.createTextNode(chunk));
    i = j;
  }
  return frag;
}

// Relative age: "42s", "5m", "3h", "6d", "4mo", "2y".
function ageStr(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 365 * 86400) return `${Math.floor(s / (30 * 86400))}mo`;
  return `${Math.floor(s / (365 * 86400))}y`;
}

// Quick-open labels: rows 1-9 get digits. Letters are deliberately not
// used so modifier+letter chords (⌘v paste, ⌘a, ⌘c) reach the browser.
function quickLabel(i) {
  return i < 9 ? String(i + 1) : '';
}

// Row marker: one glyph per source the URL belongs to, each in its own
// color — ★ bookmark, ⧉ open tab, · history. A URL in several sources
// shows all of them (e.g. ★⧉· = bookmarked, open in a tab, and visited).
// Derived from membership, not the row's kind: after mergeFreshest the
// surviving row is often the history entry even when the tab is open.
function kindMarker(item) {
  const key = ckey(item);
  const frag = document.createDocumentFragment();
  if (item.kind === 'b' || bmUrls.has(key)) frag.appendChild(el('i', 'k-b', '★'));
  if (item.kind === 't' || tabTime.has(key)) frag.appendChild(el('i', 'k-t', '⧉'));
  if (item.kind === 'h' || histTime.has(key)) frag.appendChild(el('i', 'k-h', '·'));
  return frag;
}

/**
 * Render `results` into the list plus the status-bar counters.
 * Row layout: pick-bar · quick-open label · kind marker · favicon · title ·
 * folder path · url · relative age. Row `sel` is highlighted and scrolled
 * into view; rows in `picked` show the green multi-select bar.
 */
function render() {
  $list.textContent = '';
  const frag = document.createDocumentFragment();
  results.forEach((r, i) => {
    const item = r.item;
    const row = el('div',
      'row' + (i === sel ? ' sel' : '') + (picked.has(item.url) ? ' picked' : ''));
    const segs = segmentPositions(item, r.positions);
    const img = document.createElement('img');
    img.src = favicon(item.url);

    row.append(
      el('span', 'mark', '▌'),
      el('span', 'num', quickLabel(i)),
      el('span', 'kind', kindMarker(item)),
      img,
      el('span', 'title', highlighted(item.title, segs.t)),
      el('span', 'path', highlighted(item.path, segs.p)),
      el('span', 'url', highlighted(item.url, segs.u)),
      el('span', 'age', ageStr(effTime(item))),
    );
    row.addEventListener('click', () => open([item.url]));
    frag.appendChild(row);
  });
  $list.appendChild(frag);

  $count.textContent = `${results.length} result${results.length === 1 ? '' : 's'}` +
    (poolSize ? ` / ${poolSize.toLocaleString()} indexed` : '') +
    (picked.size ? ` · ${picked.size} selected` : '');
  $list.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

// Selection move without a full re-render: arrow keys (held down, they
// repeat fast) only need two class toggles, not 150 rows rebuilt.
function moveSel(next) {
  const rows = $list.children;
  rows[sel]?.classList.remove('sel');
  sel = next;
  const row = rows[sel];
  if (row) {
    row.classList.add('sel');
    row.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- 5. search

// selector layout must stay `${title} ${path} ${url}` — segmentPositions
// depends on these offsets.
const selector = item => `${item.title} ${item.path} ${item.url}`;

/**
 * Lazily build (and cache) the search pool + AsyncFzf instance for the
 * current tab mode:
 *   'b'   → bookmarks only
 *   'h'   → open tabs + history (freshest per URL)
 *   'all' → bookmarks first, then tabs/history not already covered by a
 *           bookmark URL (the bookmark row wins the dedupe; its recency is
 *           recovered via effTime at ranking/display time)
 * Invalidated by invalidateFinders() whenever the underlying data changes.
 */
function getFinder() {
  if (!finders[mode]) {
    let pool = [];
    if (mode !== 'h') pool = pool.concat(bookmarks);
    if (mode !== 'b') {
      const seen = new Set(pool.map(b => ckey(b)));
      for (const it of mergeFreshest(openTabs, history)) {
        const key = ckey(it);
        if (!seen.has(key)) { seen.add(key); pool.push(it); }
      }
    }
    finders[mode] = {
      pool,
      fzf: new AsyncFzf(pool, {
        selector,
        match: extendedMatch,
        fuzzy: false,   // exact substring per term, like `fzf -e` in ch/cb
        limit: MATCH_POOL,
        tiebreakers: [
          (a, b) => (a.item.kind === 'b' ? 0 : 1) - (b.item.kind === 'b' ? 0 : 1),
          (a, b) => selector(a.item).length - selector(b.item).length,
        ],
      }),
    };
  }
  return finders[mode];
}

/** Drop all cached finders so the next search rebuilds over fresh data. */
function invalidateFinders() {
  for (const k in finders) delete finders[k];
}

let debounceTimer;
let searchGen = 0;   // monotonically increasing search id; guards stale async results

/** Debounced entry point for keystrokes (80 ms). */
function scheduleSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 80);
}

/**
 * Execute the current query and render.
 * Empty query → recency view: strict most-recently-visited order (cached
 * per finder). Non-empty → AsyncFzf ranked matches; results from superseded
 * keystrokes are discarded via fzf's cancellation plus the searchGen guard.
 */
async function runSearch() {
  const query = $q.value.trim();
  const gen = ++searchGen;
  const f = getFinder();
  poolSize = f.pool.length;

  if (!query) {
    // effTime blends history, open-tab lastAccessed, and the background
    // visit log, so the tab you just left is #1 and everything else follows
    // in visit order. Decorate-sort (effTime once per item, not per
    // comparison) and cache the view — invalidated together with the pool.
    if (!f.recent) {
      f.recent = f.pool
        .map(item => ({ item, t: effTime(item) }))
        .sort((a, b) => b.t - a.t)
        .slice(0, MAX_ROWS)
        .map(({ item }) => ({ item, positions: null }));
    }
    results = f.recent;
  } else {
    let entries;
    try {
      entries = await f.fzf.find(query);
    } catch { return; }              // cancelled by a newer keystroke
    if (gen !== searchGen) return;   // stale — a newer search finished after us
    // All matches contain every term (exact mode), so order by effective
    // recency — most recently used first — instead of fzf's score. Ties
    // keep fzf's relevance order (Array.sort is stable). Decorate-sort:
    // effTime once per entry, not per comparison.
    results = entries
      .map(e => ({ item: e.item, positions: e.positions, t: effTime(e.item) }))
      .sort((a, b) => b.t - a.t)
      .slice(0, MAX_ROWS)
      .map(({ item, positions }) => ({ item, positions }));
  }
  sel = 0;
  render();
}

// ---------------------------------------------------------------- 6. actions

// In overlay mode we're an iframe inside the page — window.close() is a
// no-op there; ask the injected overlay script to remove us instead.
const isOverlay = new URLSearchParams(location.search).has('overlay');

function closeUI() {
  if (isOverlay) parent.postMessage({ type: 'searchlight-close' }, '*');
  else window.close();
}

/**
 * Open one or more result URLs, then close the search UI.
 * Prefers switching to an already-open tab with the same URL (fragment
 * ignored) across all windows; otherwise creates a tab in the last focused
 * normal window (never inside the search popup window itself). A single
 * new URL opens focused; multi-select opens background tabs.
 * @param {string[]} urls
 */
async function open(urls) {
  const allTabs = await chrome.tabs.query({});
  let windowId;
  try {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  } catch { /* no normal window: Chrome will create one */ }

  const single = urls.length === 1;
  for (const url of urls) {
    const hit = allTabs.find(t => t.url && canon(t.url) === canon(url));
    if (hit) {
      chrome.tabs.update(hit.id, { active: true });
      chrome.windows.update(hit.windowId, { focused: true });
    } else {
      if (single && windowId !== undefined) chrome.windows.update(windowId, { focused: true });
      chrome.tabs.create({ url, windowId, active: single });
    }
  }
  closeUI();
}

// ---------------------------------------------------------------- events

/** Switch the active tab mode ('all' | 'h' | 'b'), update pills, re-search. */
function setMode(k) {
  mode = k;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.k === k));
  runSearch();
  $q.focus();
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => setMode(t.dataset.k)));

$q.addEventListener('input', scheduleSearch);

// Quick-open: modifier + digit (rows 1-9). Letters are intentionally left
// alone so chords like ⌘v (paste into the search box) still work.
// e.code-based so macOS Option-modified characters map to the right key.
function quickOpenIndex(code) {
  if (/^Digit[1-9]$/.test(code)) return +code.slice(5) - 1;
  return -1;
}

document.addEventListener('keydown', e => {
  const last = results.length - 1;
  const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
  const quickIdx = hasModifier ? quickOpenIndex(e.code) : -1;

  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault(); moveSel(Math.min(sel + 1, last));
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault(); moveSel(Math.max(sel - 1, 0));
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    setMode(MODES[(MODES.indexOf(mode) + step + MODES.length) % MODES.length]);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const r = results[sel];
    if (r) {
      picked.has(r.item.url) ? picked.delete(r.item.url) : picked.add(r.item.url);
      sel = Math.min(sel + 1, last);
      render();
    }
  } else if (e.key === 'Enter' && e.altKey) {
    chrome.runtime.openOptionsPage();
    closeUI();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (picked.size) open([...picked]);
    else if (results[sel]) open([results[sel].item.url]);
  } else if (quickIdx >= 0 && results[quickIdx]) {
    e.preventDefault();
    open([results[quickIdx].item.url]);
  } else if (e.key === 'Escape') {
    closeUI();
  } else if (e.key.length === 1 && !hasModifier && document.activeElement !== $q) {
    // Typing anywhere lands in the search box (focus race safety net):
    // focusing during keydown makes the character insert into the input.
    $q.focus();
  }
});

// ---------------------------------------------------------------- init

// Full reload of history + cache rewrite. Expensive (dozens of paginated
// history.search calls, multi-MB storage write) — init runs it only when the
// delta patch can't guarantee accuracy (see the throttle logic there).
async function refreshHistory() {
  // Stamp BEFORE the (potentially multi-second) load: visits made while the
  // full load runs must stay inside the next popup's recentDelta window.
  const at = Date.now();
  setHistory(await loadAllHistory());
  // Strip the ckey memo field — keeps the cache shape stable and lean.
  const strip = ({ c, ...it }) => it;
  // Hot record: top slice by effTime (NOT raw lastVisitTime), so pages whose
  // recency comes only from the visit log / open tabs still make first paint.
  const hot = history
    .map(it => ({ it, t: effTime(it) }))
    .sort((a, b) => b.t - a.t)
    .slice(0, HOT_SIZE)
    .map(({ it }) => strip(it));
  await chrome.storage.local.set({
    [HISTORY_CACHE_KEY]: { at, items: history.map(strip) },
    [HOT_CACHE_KEY]: { at, items: hot },
  });
  invalidateFinders();
  runSearch();   // re-run whatever the user is currently searching
}

(async () => {
  // Apply theme before anything renders.
  chrome.storage.local.get('settings').then(({ settings }) => {
    document.documentElement.dataset.theme = settings?.theme || 'dark';
  });

  // Grab keyboard focus. Inside the overlay iframe, focus can land on the
  // host page first — respond to the overlay's focus message and retry a
  // few times to win the race.
  const grabFocus = () => { window.focus(); $q.focus(); };
  grabFocus();
  setTimeout(grabFocus, 50);
  setTimeout(grabFocus, 200);
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'searchlight-focus') grabFocus();
  });

  // Bookmarks and open tabs are always loaded fresh: both are single fast
  // calls, bookmarks move (organizer) and tabs provide live recency.
  // Only the SMALL hot record is read before first paint — the multi-MB
  // full record would gate it on storage deserialization time.
  const bookmarksReady = loadBookmarks();
  const tabsReady = loadOpenTabs();
  const { [HOT_CACHE_KEY]: hot, visitTimes } =
    await chrome.storage.local.get([HOT_CACHE_KEY, 'visitTimes']);
  // Visit log kept by background.js: the authoritative "you were just on
  // this tab" signal — survives tab closes, unlike tabs' lastAccessed.
  visitTime = new Map(Object.entries(visitTimes || {}));
  bookmarks = await bookmarksReady;
  bmUrls = new Set(bookmarks.map(b => canon(b.url)));
  setOpenTabs(await tabsReady);

  if (hot?.items?.length) {
    setHistory(hot.items);
    // Close the hot record's staleness window before first paint: one fast
    // call for everything visited since it was written (60s overlap for
    // clock safety). Without this, a recently-visited-then-closed tab is
    // missing from the top until the full record lands.
    let deltaOk = false;
    try {
      const { items: delta, truncated } = await recentDelta((hot.at || 0) - 60_000);
      if (delta.length) setHistory(mergeFreshest(delta, history));
      deltaOk = !truncated;
    } catch { /* delta is best-effort */ }
    runSearch();   // instant first paint: hot slice + delta + tabs + bookmarks

    // Stage 2: merge in the full record. Deep history becomes searchable a
    // beat after paint; mergeFreshest keeps the delta-patched fresh entries.
    const { [HISTORY_CACHE_KEY]: cache } = await chrome.storage.local.get(HISTORY_CACHE_KEY);
    if (cache?.items?.length) {
      setHistory(mergeFreshest(history, cache.items));
      invalidateFinders();
      runSearch();
    }

    // Cache + delta is exact for everything except history DELETIONS (the
    // delta only sees additions; background.js flags removals) and titles of
    // long-untouched entries. Run the expensive full reload only when one of
    // those accuracy guarantees is actually broken, or on the throttle.
    const { historyDirty } = await chrome.storage.local.get('historyDirty');
    const stale = Date.now() - (cache?.at || 0) > FULL_REFRESH_MS;
    if (historyDirty || stale || !deltaOk || !cache?.items?.length) {
      // Clear the flag BEFORE reloading: a deletion that lands mid-reload
      // re-sets it, so the next open repairs it (clearing after would lose it).
      chrome.storage.local.remove('historyDirty');
      refreshHistory();
    }
  } else {
    await refreshHistory();
  }
})();
