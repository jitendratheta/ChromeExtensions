// Bookmark dialog (Cmd+B): save the current tab into a fuzzy-searchable
// folder. The default folder (existing bookmark's current folder, else the
// last-used one) is preselected, so plain Cmd+B → Enter files instantly;
// typing fuzzy-matches any folder path, and the trailing "➕ New folder"
// row creates the typed folder on the fly. If the URL is already
// bookmarked, saving MOVES the existing bookmark (and updates its title)
// instead of creating a duplicate; Cmd+Backspace removes it.
//
// Runs either inside the overlay iframe (?overlay=1) or in a popup window —
// same close/focus postMessage protocol as popup.js.

const { Fzf, extendedMatch } = fzf;

const $q = document.getElementById('q');
const $list = document.getElementById('list');
const $title = document.getElementById('title');

const MAX_ROWS = 200;
const LAST_FOLDER_KEY = 'lastBookmarkFolderId';
const RECENTS_KEY = 'recentBookmarkFolders';   // MRU list of folder ids
const MAX_RECENTS = 5;

let folders = [];        // { id, path } in tree order (root containers included)
let finder = null;       // Fzf over folders
let results = [];        // [{ item, positions } | { create: query }]
let sel = 0;
let tab = null;          // the tab being bookmarked
let existing = null;     // pre-existing bookmark for this URL, if any
let lastUsedId = null;
let recents = [];        // MRU folder ids (most recent first)
let defaultFolderId = null;      // pinned + preselected folder in the list
let defaultBadge = '(last used)';   // '(current)' when the page is already bookmarked
let createMode = null;           // { name } — picking a PARENT for a new folder

// ---------------------------------------------------------------- create-folder mode

/**
 * Switch the list into parent-picker mode: the user has named a new folder
 * and now fuzzy-searches WHERE to create it. Esc steps back to normal mode.
 */
function enterCreateMode(name) {
  createMode = { name };
  $q.value = '';
  $q.placeholder = 'search parent folder…';
  document.getElementById('prompt').textContent = '📁in>';
  const bar = document.getElementById('createbar');
  bar.textContent = `➕ Creating folder “${name}” — choose its parent folder (esc to go back)`;
  bar.style.display = 'block';
  runSearch();
  $q.focus();
}

/** Back to normal folder-picking without closing the dialog. */
function exitCreateMode() {
  createMode = null;
  $q.value = '';
  $q.placeholder = 'fuzzy search folder…';
  document.getElementById('prompt').textContent = '📁>';
  document.getElementById('createbar').style.display = 'none';
  runSearch();
  $q.focus();
}

// ---------------------------------------------------------------- data

/**
 * The tab this dialog acts on: the active tab of the last-focused normal
 * window. Correct in both display modes — in the overlay that's the host
 * tab; in the popup window it's the window the user came from.
 */
async function targetTab() {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true });
  return win.tabs.find(t => t.active) ?? null;
}

/** All folders (including root containers) with full paths, tree order. */
async function loadFolders() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, path) => {
    for (const c of node.children || []) {
      if (c.url) continue;
      const p = path ? `${path}/${c.title}` : c.title;
      out.push({ id: c.id, path: p });
      walk(c, p);
    }
  };
  walk(tree[0], '');
  return out;
}

// ---------------------------------------------------------------- search

/**
 * Fuzzy-match folders by path (fzf v2 — paths are short, typos welcome).
 * Normal mode appends a synthetic "➕ New folder" row to non-empty queries;
 * parent-picker mode searches the same folders but without the create row.
 * Empty query pins the default folder, then recents, then tree order.
 */
function runSearch() {
  const query = $q.value.trim();
  if (query) {
    results = finder.find(query).map(e => ({ item: e.item, positions: e.positions }));
    if (!createMode) results.push({ create: query });
    sel = 0;
  } else {
    const pinned = [];
    const seen = new Set();
    const pin = id => {
      const f = id && folders.find(x => x.id === id);
      if (f && !seen.has(f.id)) { seen.add(f.id); pinned.push(f); }
    };
    pin(defaultFolderId);
    recents.forEach(pin);
    const rest = folders.filter(f => !seen.has(f.id));
    results = [...pinned, ...rest]
      .slice(0, MAX_ROWS)
      .map(item => ({ item, positions: null }));
    sel = 0;
  }
  render();
}

// ---------------------------------------------------------------- rendering

/** Path text with fzf-matched characters wrapped in <b>. */
function highlighted(text, positions) {
  const set = new Set(positions || []);
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < text.length) {
    const bold = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === bold) j++;
    const chunk = text.slice(i, j);
    if (bold) {
      const b = document.createElement('b');
      b.textContent = chunk;
      frag.appendChild(b);
    } else {
      frag.appendChild(document.createTextNode(chunk));
    }
    i = j;
  }
  return frag;
}

function render() {
  $list.textContent = '';
  const frag = document.createDocumentFragment();
  results.slice(0, MAX_ROWS).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === sel ? ' sel' : '') + (r.create ? ' create' : '');
    const path = document.createElement('span');
    path.className = 'path';
    if (r.create) {
      path.textContent = `➕ New folder “${r.create}”… (then pick its parent)`;
    } else {
      path.appendChild(highlighted(r.item.path, r.positions));
    }
    row.appendChild(path);
    if (!r.create && (r.item.id === defaultFolderId || recents.includes(r.item.id))) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = r.item.id === defaultFolderId ? defaultBadge : '(recent)';
      row.appendChild(badge);
    }
    row.addEventListener('click', () => commit(r));
    frag.appendChild(row);
  });
  $list.appendChild(frag);
  $list.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- actions

const isOverlay = new URLSearchParams(location.search).has('overlay');

function closeUI() {
  if (isOverlay) parent.postMessage({ type: 'searchlight-close' }, '*');
  else window.close();
}

/**
 * Act on a result row.
 * Normal mode: a folder row saves into it; the "➕ New folder" row switches
 * to parent-picker mode. Parent-picker mode: the chosen row becomes the
 * parent — create the named folder under it, then save the bookmark there.
 */
async function commit(r) {
  if (createMode) {
    const folder = await chrome.bookmarks.create({ parentId: r.item.id, title: createMode.name });
    await save(folder);
    return;
  }
  if (r.create) {
    enterCreateMode(r.create);
    return;
  }
  await save(r.item);
}

/**
 * Save the tab into `folder`: move + retitle the existing bookmark when the
 * URL is already saved, otherwise create a new one. Remembers the folder
 * as the default and in the MRU recents for next time.
 */
async function save(folder) {
  if (!tab) return;
  const title = $title.value.trim() || tab.title || tab.url;
  if (existing) {
    await chrome.bookmarks.update(existing.id, { title });
    await chrome.bookmarks.move(existing.id, { parentId: folder.id });
  } else {
    await chrome.bookmarks.create({ parentId: folder.id, title, url: tab.url });
  }
  recents = [folder.id, ...recents.filter(id => id !== folder.id)].slice(0, MAX_RECENTS);
  await chrome.storage.local.set({ [LAST_FOLDER_KEY]: folder.id, [RECENTS_KEY]: recents });
  closeUI();
}

/** Remove the existing bookmark for this page (Cmd/Ctrl+Backspace). */
async function removeExisting() {
  if (!existing) return;
  await chrome.bookmarks.remove(existing.id);
  closeUI();
}

// ---------------------------------------------------------------- events

document.addEventListener('keydown', e => {
  const last = results.length - 1;
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault(); sel = Math.min(sel + 1, last); render();
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault(); sel = Math.max(sel - 1, 0); render();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (results[sel]) commit(results[sel]);
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && existing) {
    e.preventDefault();
    removeExisting();
  } else if (e.key === 'Escape') {
    createMode ? exitCreateMode() : closeUI();
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
             && document.activeElement !== $q && document.activeElement !== $title) {
    // Typing anywhere lands in the folder search box (focus race safety net).
    $q.focus();
  }
});

$q.addEventListener('input', runSearch);

// ➕ button: use the typed text as the new folder's name; if nothing is
// typed yet, nudge via the placeholder.
document.getElementById('newfolder').addEventListener('click', () => {
  if (createMode) return;
  const name = $q.value.trim();
  if (name) {
    enterCreateMode(name);
  } else {
    $q.placeholder = 'type the new folder name, then press ➕ or pick the ➕ row…';
    $q.focus();
  }
});

// ---------------------------------------------------------------- init

(async () => {
  // Apply theme before anything renders.
  chrome.storage.local.get('settings').then(({ settings }) => {
    document.documentElement.dataset.theme = settings?.theme || 'dark';
  });

  // Focus handshake — same approach as popup.js.
  const grabFocus = () => { window.focus(); $q.focus(); };
  grabFocus();
  setTimeout(grabFocus, 50);
  setTimeout(grabFocus, 200);
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'searchlight-focus') grabFocus();
  });

  const [t, fs, stored] = await Promise.all([
    targetTab(),
    loadFolders(),
    chrome.storage.local.get([LAST_FOLDER_KEY, RECENTS_KEY]),
  ]);
  tab = t;
  folders = fs;
  lastUsedId = stored[LAST_FOLDER_KEY] ?? null;
  recents = stored[RECENTS_KEY] ?? [];
  finder = new Fzf(folders, { selector: f => f.path, match: extendedMatch, limit: MAX_ROWS });

  if (!tab || !/^https?:/.test(tab.url || '')) {
    document.getElementById('url').textContent = 'No bookmarkable tab found.';
    return;
  }

  // Header: favicon, editable title, url, already-bookmarked note.
  const fav = new URL(chrome.runtime.getURL('/_favicon/'));
  fav.searchParams.set('pageUrl', tab.url);
  fav.searchParams.set('size', '16');
  document.getElementById('fav').src = fav.href;
  document.getElementById('url').textContent = tab.url;

  // Already bookmarked? Default the name to the EXISTING bookmark's title
  // (it may have been customized) and preselect its current folder; a fresh
  // bookmark defaults to the page title and the last-used folder.
  // bookmarks.search({url}) is exact-match — retry without the #fragment so
  // page#section still finds (and refiles) the bookmark saved as page.
  existing = (await chrome.bookmarks.search({ url: tab.url }))[0] ?? null;
  if (!existing && tab.url.includes('#')) {
    existing = (await chrome.bookmarks.search({ url: tab.url.split('#')[0] }))[0] ?? null;
  }
  if (existing) {
    $title.value = existing.title || tab.title || tab.url;
    defaultFolderId = existing.parentId;
    defaultBadge = '(current)';
    const parent = folders.find(f => f.id === existing.parentId);
    const note = document.getElementById('note');
    note.textContent = `★ already saved in ${parent?.path ?? 'a folder'} — saving updates name/folder`;
    note.style.display = 'block';
    document.getElementById('status').insertAdjacentHTML('beforeend',
      ' · <kbd>⌘⌫</kbd> remove bookmark');
  } else {
    $title.value = tab.title || tab.url;
    defaultFolderId = lastUsedId;
  }

  runSearch();
})();
