// Bookmark Organizer (options page): simple two-pane manager.
//
//   Left  — folder tree: click to browse, ▾/▸ to collapse, hover ＋ to add a
//           subfolder, drag folders to reorder/nest, drop bookmarks to move.
//   Right — bookmarks of the selected folder, or a global substring search
//           when the filter box is non-empty. Checkbox selection persists
//           across folder switches/searches (enables cross-folder batches).
//   Toolbar — select all/clear, open selected, delete (confirm for >1),
//           move to any folder or a new one.
//
// All mutations go through the chrome.bookmarks API (the Bookmarks JSON
// file is never touched), and the page live-refreshes on bookmark events
// from anywhere in Chrome. Settings (search UI style, theme) and the tree
// pane width persist in chrome.storage.local.

/** Shorthand for document.getElementById. */
const $ = id => document.getElementById(id);

let folders = [];        // tree order: { id, title, path, parentId, depth, count }
let bookmarks = [];      // { id, title, url, parentId, path }
let rootIds = new Set();
let selectedFolder = null;
const checked = new Set();   // bookmark ids selected across renders

// ---------------------------------------------------------------- data

/**
 * Rebuild `folders` (in tree order, with depth + direct-bookmark counts)
 * and `bookmarks` from chrome.bookmarks.getTree(). Also repairs state that
 * mutations may have invalidated: the selected folder and checked ids.
 */
async function load() {
  const tree = await chrome.bookmarks.getTree();
  folders = []; bookmarks = []; rootIds = new Set();
  const walk = (node, path, depth) => {
    for (const c of node.children || []) {
      if (c.url) {
        bookmarks.push({ id: c.id, title: c.title || c.url, url: c.url, parentId: c.parentId, path });
      } else {
        const p = path ? `${path}/${c.title}` : c.title;
        folders.push({ id: c.id, title: c.title, path: p, parentId: c.parentId, depth, count: 0 });
        walk(c, p, depth + 1);
      }
    }
  };
  for (const container of tree[0].children || []) {
    rootIds.add(container.id);
    folders.push({ id: container.id, title: container.title, path: container.title, parentId: tree[0].id, depth: 0, count: 0 });
    walk(container, '', 1);
  }
  // Recursive counts: each bookmark increments every ancestor folder, so a
  // folder's badge includes bookmarks in its subfolders.
  const byId = new Map(folders.map(f => [f.id, f]));
  for (const b of bookmarks) {
    for (let f = byId.get(b.parentId); f; f = byId.get(f.parentId)) f.count++;
  }

  // Keep a valid selection.
  if (!selectedFolder || !folders.find(f => f.id === selectedFolder)) {
    selectedFolder = folders[0]?.id ?? null;
  }
  // Drop checked ids that no longer exist.
  const alive = new Set(bookmarks.map(b => b.id));
  for (const id of [...checked]) if (!alive.has(id)) checked.delete(id);
}

// ---------------------------------------------------------------- helpers

/** Chrome's extension favicon endpoint (requires the "favicon" permission). */
function favicon(url) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', '16');
  return u.href;
}

/** Transient bottom-right notification (~2s). */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 2200);
}

/**
 * Bookmarks for the right pane: the selected folder's direct children, or —
 * when the filter box is non-empty — a substring search over ALL bookmarks
 * (title + path + url, capped at 500).
 */
function currentItems() {
  const q = $('filter').value.trim().toLowerCase();
  if (q) {
    return bookmarks.filter(b =>
      `${b.title} ${b.path} ${b.url}`.toLowerCase().includes(q)).slice(0, 500);
  }
  return bookmarks.filter(b => b.parentId === selectedFolder);
}

/**
 * Swap a text element for an inline rename input.
 * Enter or blur commits (onDone receives the trimmed value); Esc cancels
 * by re-rendering. Keystrokes are stopped from bubbling so row/document
 * handlers don't react while editing.
 * @param {HTMLElement} textEl - element to replace with the input
 * @param {string} current - current name
 * @param {(newTitle:string) => void} onDone - called once on commit
 */
function startRename(textEl, current, onDone) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename';
  input.value = current;
  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    save ? onDone(input.value.trim()) : refresh();
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();          // blur commits
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  textEl.replaceWith(input);
  input.focus();
  input.select();
}

/** Rename a bookmark or folder node; the bookmarks event listener re-renders. */
async function renameNode(id, oldTitle, newTitle) {
  if (newTitle && newTitle !== oldTitle) {
    await chrome.bookmarks.update(id, { title: newTitle });
  } else {
    refresh();   // nothing changed — just restore the row
  }
}

// ---------------------------------------------------------------- tree

const collapsed = new Set();   // folder ids collapsed (default: all expanded)
let dragState = null;          // { type:'folder', id } | { type:'bm', ids:[…] }

const DROP_CLASSES = ['drop-into', 'drop-before', 'drop-after'];
function clearDrop(el) { el.classList.remove(...DROP_CLASSES); }

/**
 * Move a dragged folder relative to a target folder row.
 * @param {string} draggedId - id of the folder being dragged
 * @param {{id:string,title:string,path:string}} target - drop-target folder
 * @param {'into'|'before'|'after'} zone - 'into' nests inside the target;
 *   'before'/'after' reorder around it within the target's parent
 */
async function dropFolder(draggedId, target, zone) {
  const dragged = folders.find(x => x.id === draggedId);
  if (!dragged || dragged.id === target.id) return;
  // Refuse dropping a folder into itself or its own descendant.
  if (target.path === dragged.path || target.path.startsWith(dragged.path + '/')) {
    toast("Can't move a folder into itself"); return;
  }
  if (zone === 'into') {
    await chrome.bookmarks.move(dragged.id, { parentId: target.id });
    toast(`Moved "${dragged.title}" into "${target.title}"`);
    return;
  }
  const [tgt] = await chrome.bookmarks.get(target.id);
  const [src] = await chrome.bookmarks.get(dragged.id);
  let index = tgt.index + (zone === 'after' ? 1 : 0);
  // chrome.bookmarks.move interprets index after the node is removed from
  // its old slot — compensate when moving forward within the same parent.
  if (src.parentId === tgt.parentId && src.index < index) index -= 1;
  await chrome.bookmarks.move(dragged.id, { parentId: tgt.parentId, index });
  toast(`Moved "${dragged.title}" ${zone} "${target.title}"`);
}

/**
 * Render the folder tree. Rows under a collapsed ancestor are skipped.
 * Each row wires: click (browse), ▾/▸ (collapse toggle), ＋ (new subfolder),
 * and drag & drop (drag the folder itself; accept folder drops with
 * before/after/into zones and bookmark drops as 'into').
 */
function renderTree() {
  const host = $('tree');
  host.textContent = '';
  const byId = new Map(folders.map(f => [f.id, f]));
  const hasKids = new Set(folders.map(f => f.parentId));

  const isHidden = f => {
    for (let p = byId.get(f.parentId); p; p = byId.get(p.parentId)) {
      if (collapsed.has(p.id)) return true;
    }
    return false;
  };

  for (const f of folders) {
    if (isHidden(f)) continue;
    const row = document.createElement('div');
    row.className = 'fnode' + (f.id === selectedFolder ? ' sel' : '');
    row.style.paddingLeft = `${10 + f.depth * 16}px`;

    const tri = document.createElement('span');
    tri.className = 'tri';
    tri.textContent = hasKids.has(f.id) ? (collapsed.has(f.id) ? '▸' : '▾') : ' ';
    if (hasKids.has(f.id)) {
      tri.addEventListener('click', e => {
        e.stopPropagation();
        collapsed.has(f.id) ? collapsed.delete(f.id) : collapsed.add(f.id);
        renderTree();
      });
    }

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `📁 ${f.title}`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = f.count ? `(${f.count})` : '';

    // hover actions: rename + new subfolder + delete
    const actions = document.createElement('span');
    actions.className = 'actions';
    const ren = document.createElement('button');
    ren.textContent = '✏';
    ren.title = `Rename "${f.title}"`;
    const add = document.createElement('button');
    add.className = 'addsub';
    add.textContent = '＋';
    add.title = `New folder inside "${f.title}"`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '🗑';
    del.title = `Delete "${f.title}" and everything inside it`;
    if (!rootIds.has(f.id)) actions.append(ren);   // roots can't be renamed/deleted
    actions.append(add);
    if (!rootIds.has(f.id)) actions.append(del);

    row.append(tri, name, cnt, actions);

    del.addEventListener('click', async e => {
      e.stopPropagation();
      // Count everything the removeTree call will take with it.
      const bmCount = bookmarks.filter(b =>
        b.path === f.path || b.path.startsWith(f.path + '/')).length;
      const subCount = folders.filter(x => x.path.startsWith(f.path + '/')).length;
      const contents = [
        bmCount && `${bmCount} bookmark(s)`,
        subCount && `${subCount} subfolder(s)`,
      ].filter(Boolean).join(' and ');
      if (!confirm(`Are you sure? Deleting folder "${f.title}"${contents ? ` removes ${contents}` : ''} — this cannot be undone.`)) return;
      await chrome.bookmarks.removeTree(f.id);
      toast(`Deleted folder "${f.title}"`);
      refresh();
    });

    ren.addEventListener('click', e => {
      e.stopPropagation();
      row.draggable = false;   // don't let text selection start a drag
      startRename(name, f.title, t => renameNode(f.id, f.title, t));
    });

    // --- drag & drop ---
    row.draggable = !rootIds.has(f.id);   // root containers can't move
    row.addEventListener('dragstart', e => {
      dragState = { type: 'folder', id: f.id };
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { dragState = null; });
    row.addEventListener('dragover', e => {
      if (!dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDrop(row);
      if (dragState.type === 'bm') { row.classList.add('drop-into'); return; }
      if (dragState.id === f.id) return;
      const r = row.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      // Root containers only accept nesting; others get edge zones too.
      const zone = rootIds.has(f.id) ? 'into'
        : y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into';
      row.classList.add(`drop-${zone}`);
    });
    row.addEventListener('dragleave', () => clearDrop(row));
    row.addEventListener('drop', async e => {
      e.preventDefault();
      const zone = DROP_CLASSES.find(c => row.classList.contains(c))?.slice(5);
      clearDrop(row);
      if (!dragState || !zone) return;
      if (dragState.type === 'bm') {
        for (const id of dragState.ids) await chrome.bookmarks.move(id, { parentId: f.id });
        toast(`Moved ${dragState.ids.length} bookmark(s) → ${f.path}`);
        checked.clear();
      } else {
        await dropFolder(dragState.id, f, zone);
      }
      dragState = null;
      refresh();
    });
    row.addEventListener('click', () => {
      selectedFolder = f.id;
      $('filter').value = '';
      renderTree(); renderList();
    });
    add.addEventListener('click', async e => {
      e.stopPropagation();
      const title = prompt(`New folder inside "${f.title}":`);
      if (!title?.trim()) return;
      const created = await chrome.bookmarks.create({ parentId: f.id, title: title.trim() });
      selectedFolder = created.id;
      toast(`Created "${created.title}"`);
      refresh();
    });
    host.appendChild(row);
  }
}

// ---------------------------------------------------------------- list

/**
 * Render the right-pane bookmark list from currentItems().
 * Rows: checkbox (feeds the persistent `checked` set) · favicon · title
 * link (opens in a new tab) · folder path · url. Rows are draggable onto
 * tree folders.
 */
function renderList() {
  const host = $('list');
  host.textContent = '';
  const items = currentItems();
  const q = $('filter').value.trim();

  if (!items.length) {
    host.innerHTML = `<div class="empty">${q ? 'No matches.' : 'No bookmarks directly in this folder.'}</div>`;
  }
  const frag = document.createDocumentFragment();
  for (const b of items) {
    const row = document.createElement('div');
    row.className = 'bm';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked.has(b.id);
    cb.addEventListener('change', () => {
      cb.checked ? checked.add(b.id) : checked.delete(b.id);
      updateCount();
    });

    const img = document.createElement('img');
    img.src = favicon(b.url);

    const a = document.createElement('a');
    a.className = 't';
    a.textContent = b.title;
    a.href = b.url;
    a.target = '_blank';
    a.rel = 'noopener';

    const p = document.createElement('span');
    p.className = 'p';
    p.textContent = b.path;

    const u = document.createElement('span');
    u.className = 'u';
    u.textContent = b.url;

    const ren = document.createElement('button');
    ren.className = 'rowedit';
    ren.textContent = '✏';
    ren.title = 'Rename bookmark';
    ren.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      row.draggable = false;   // don't let text selection start a drag
      startRename(a, b.title, t => renameNode(b.id, b.title, t));
    });

    row.append(cb, img, a, ren, p, u);

    // Drag to a tree folder to move. Dragging a checked row drags the
    // whole selection; an unchecked row drags just itself.
    row.draggable = true;
    a.draggable = false;   // let the row own the drag, not the anchor
    row.addEventListener('dragstart', e => {
      const ids = checked.has(b.id) && checked.size ? [...checked] : [b.id];
      dragState = { type: 'bm', ids };
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragState = null;
      row.classList.remove('dragging');
    });

    frag.appendChild(row);
  }
  host.appendChild(frag);
  updateCount();
}

/** Refresh the "N shown · M selected" badge. */
function updateCount() {
  const n = currentItems().length;
  $('count').textContent = `${n} shown · ${checked.size} selected`;
}

// ---------------------------------------------------------------- toolbar

/**
 * (Re)build the move-destination dropdown: "➕ New folder…" plus every
 * folder (depth-indented). Preserves the previous selection when possible;
 * choosing "new" reveals the folder-name input.
 */
function renderTarget() {
  const target = $('target');
  const prev = target.value;
  target.textContent = '';
  const optNew = document.createElement('option');
  optNew.value = '__new__';
  optNew.textContent = '➕ New folder…';
  target.appendChild(optNew);
  for (const f of folders) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = `${'\u00a0'.repeat(f.depth * 2)}${f.path.split('/').pop()}`;
    o.title = f.path;
    target.appendChild(o);
  }
  target.value = [...target.options].some(o => o.value === prev) && prev ? prev : (folders[0]?.id ?? '__new__');
  target.onchange = () => {
    $('newname').style.display = target.value === '__new__' ? '' : 'none';
  };
  target.onchange();
}

$('filter').addEventListener('input', renderList);

$('sel-all').addEventListener('click', () => {
  for (const b of currentItems()) checked.add(b.id);
  renderList();
});
$('sel-none').addEventListener('click', () => {
  checked.clear();
  renderList();
});

$('open-sel').addEventListener('click', () => {
  const items = bookmarks.filter(b => checked.has(b.id));
  if (!items.length) { toast('Nothing selected'); return; }
  for (const b of items) chrome.tabs.create({ url: b.url, active: false });
  toast(`Opened ${items.length} tab(s)`);
});

// Delete selected. A single bookmark deletes immediately; >1 requires an
// "Are you sure?" confirm (deletion has no undo and syncs to other devices).
$('del-sel').addEventListener('click', async () => {
  const items = bookmarks.filter(b => checked.has(b.id));
  if (!items.length) { toast('Nothing selected'); return; }
  if (items.length > 1) {
    const preview = items.slice(0, 5).map(b => `• ${b.title}`).join('\n');
    const more = items.length > 5 ? `\n…and ${items.length - 5} more` : '';
    if (!confirm(`Are you sure? You are deleting ${items.length} bookmarks — this cannot be undone.\n\n${preview}${more}`)) return;
  }
  for (const b of items) await chrome.bookmarks.remove(b.id);
  checked.clear();
  toast(`Deleted ${items.length} bookmark(s)`);
  refresh();
});

// Move selected to the dropdown destination. "New folder…" creates it under
// the currently browsed folder (or the first root when in filter mode).
$('move').addEventListener('click', async () => {
  const ids = [...checked];
  if (!ids.length) { toast('Nothing selected'); return; }
  let dest = $('target').value, destName;
  if (dest === '__new__') {
    const title = $('newname').value.trim();
    if (!title) { toast('Enter a folder name'); return; }
    const parent = selectedFolder && !$('filter').value.trim() ? selectedFolder : rootIds.values().next().value;
    const folder = await chrome.bookmarks.create({ parentId: parent, title });
    dest = folder.id;
    destName = title;
  } else {
    destName = folders.find(f => f.id === dest)?.path ?? dest;
  }
  for (const id of ids) await chrome.bookmarks.move(id, { parentId: dest });
  checked.clear();
  $('newname').value = '';
  toast(`Moved ${ids.length} bookmark(s) → ${destName}`);
  refresh();
});

// ---------------------------------------------------------------- settings
// Shared with background.js (search UI style) and popup.js (theme); stored
// under the single "settings" key in chrome.storage.local.

const DEFAULT_SETTINGS = { display: 'overlay', theme: 'dark' };

/** Read settings, filling in defaults for missing keys. */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/** Set the data-theme attribute that the CSS variable overrides key off. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

// Settings init: reflect stored values in the header dropdowns and save
// (+ re-theme) on change.
(async () => {
  const s = await getSettings();
  applyTheme(s.theme);
  $('set-display').value = s.display;
  $('set-theme').value = s.theme;
  const save = async () => {
    const settings = { display: $('set-display').value, theme: $('set-theme').value };
    await chrome.storage.local.set({ settings });
    applyTheme(settings.theme);
    toast('Settings saved');
  };
  $('set-display').addEventListener('change', save);
  $('set-theme').addEventListener('change', save);
})();

// ---------------------------------------------------------------- pane resizer
// Drag handle between the panes; width is clamped in CSS (min/max) and the
// chosen size persists under "treeWidth".

(async () => {
  const tree = $('tree'), rez = $('resizer');
  const { treeWidth } = await chrome.storage.local.get('treeWidth');
  if (treeWidth) tree.style.width = `${treeWidth}px`;

  rez.addEventListener('mousedown', e => {
    e.preventDefault();
    rez.classList.add('dragging');
    document.body.style.userSelect = 'none';
    const onMove = ev => {
      tree.style.width = `${Math.max(180, ev.clientX)}px`;
    };
    const onUp = () => {
      rez.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      chrome.storage.local.set({ treeWidth: tree.getBoundingClientRect().width });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// ---------------------------------------------------------------- main

/** Reload data and re-render everything. The single entry point after any mutation. */
async function refresh() {
  await load();
  renderTree();
  renderTarget();
  renderList();
}

// Live-refresh when bookmarks change elsewhere (search popup, Chrome UI).
for (const ev of ['onCreated', 'onRemoved', 'onMoved', 'onChanged']) {
  chrome.bookmarks[ev].addListener(() => refresh());
}

refresh();
