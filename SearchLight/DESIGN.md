# Searchlight — Design Document

Chrome extension (Manifest V3) providing fzf-style fuzzy search over
bookmarks, full browser history, and open tabs; a Cmd+B bookmark dialog
with a fuzzy folder picker; and a two-pane bookmark manager. Born as a
browser port of two zsh functions: `ch` (Chrome history via sqlite3 + fzf)
and `cb` (Chrome bookmarks via jq + fzf).

- Repo: `~/workspace/BookmarkPalette` (extension name: **Searchlight**)
- Language: vanilla JS, no build step; the only vendored dependency is
  `fzf.umd.js` (fzf-for-js v0.5.2, BSD-3-Clause)

---

## 1. Component map

```
manifest.json           MV3 manifest: permissions, commands, action, options page
background.js           Service worker: opens the search / bookmark UIs
overlay.js              Injected on demand: Spotlight-style iframe overlay (page-aware)
popup.html / popup.js   Search palette (runs in overlay iframe OR popup window)
bookmark.html / .js     Cmd+B bookmark dialog (same two display modes)
organize.html / .js     Two-pane bookmark manager (options page)
fzf.umd.js              Vendored fzf-for-js
pack.sh                 CRX packaging script (key-loss-hardened)
icon{16,48,128}.png     Generated pixel-glyph "S" (for Search) icons
```

### Trigger flow

```
Cmd+K ─► chrome.commands("open-search")  ──┐
toolbar click ─────────────────────────────┼─► background.openUI(kind)
Cmd+B ─► chrome.commands("bookmark-tab") ──┘        │
                                                    │ settings.display === 'window'? ──► popup window
                                                    │
                                     tab is http(s)/file? ──yes──► set dataset.slPage, inject overlay.js
                                                    │                 └ iframe src = <page>?overlay=1
                                                    no (chrome://, Web Store, PDF, new tab)
                                                    │
                                                    └► popup window (type:'popup', anchored over the
                                                       Chrome window; search 1296x672, bookmark 864x624)
```

Key decision: the UI pages are always **extension pages**, whether shown in
the overlay iframe or a window — extension pages keep full
`chrome.bookmarks` / `chrome.history` / `chrome.tabs` access; content
scripts do not. The overlay content script is a dumb frame host; which page
it hosts is passed via `document.documentElement.dataset.slPage` (set by
the background just before injection, since files-based `executeScript`
takes no arguments).

---

## 2. Search palette (popup.js)

Organized into sections: config & state → data sources → recency model →
rendering → search → actions/events/init.

### Data sources

| Source    | API                        | Freshness | Notes                          |
|-----------|----------------------------|-----------|--------------------------------|
| Bookmarks | `chrome.bookmarks.getTree` | always fresh | folder path retained; `t` = dateAdded |
| History   | `chrome.history.search`    | cached + revalidated | paginated to fetch everything the API retains |
| Open tabs | `chrome.tabs.query`        | always fresh | `t` = lastAccessed (updates on tab activation) |

`chrome.history.search` caps a single call's results (~9k observed)
regardless of `maxResults`, so `loadAllHistory()` paginates backwards in
time: each batch's oldest `lastVisitTime` becomes the next call's
`endTime`, deduping by URL, until no new URLs arrive (50-batch hard stop).
`chrome-extension://` URLs are filtered out — opening the search records a
visit to popup.html itself, which would otherwise permanently occupy the
top recency slot.

### Recency model (the subtle part)

History's `lastVisitTime` only updates on **navigation**; switching between
open tabs records nothing, and SPAs rarely re-visit their root URL. Chrome's
own tab search orders by per-tab `lastAccessed` instead. Searchlight blends
both:

- `effTime(item)` = max(own timestamp, last history visit for the URL,
  `lastAccessed` of an open tab with the URL). Used for ranking the
  empty-query view and for the age column.
- The empty-query view **pins open tabs first** (like Chrome's tab search),
  then everything else, both by effective recency. A bookmarked URL that's
  open in a tab counts as an open tab and shows a combined `★⧉` marker.
- Without this, a bookmarked SPA (e.g. chorus.aws.dev) open in a hot tab
  sank to its days-old last-navigation time because the "all" pool's dedupe
  keeps the bookmark row and drops the fresh tab entry.

### History cache (instant startup)

Full pagination takes ~1–2 s, so the flattened list is cached in
`chrome.storage.local` (`historyCache3`). The cache is **only a first
paint**: on open it renders immediately, a one-shot `recentDelta` query
(history since the cache was written, 60 s overlap) patches in
visited-then-closed pages before first render, and a full background
refresh always follows, swapping in fresh data and re-running the current
query. Bookmarks and open tabs are never cached (single fast calls; the
organizer actively moves bookmarks).

### Matching (fzf-for-js)

- One `AsyncFzf` per tab mode (`all` | `h` | `b`), built lazily and cached;
  AsyncFzf is the non-blocking variant recommended above 10k items
  (~110 ms/query over 35k items, benchmarked). Finders are invalidated when
  underlying data refreshes.
- `selector`: `` `${title} ${path} ${url}` `` — match positions are split
  back into per-segment sets by offset for **highlighting** matched
  characters in each column.
- `match: extendedMatch` + `fuzzy: false` — mirrors `fzf -e` used by the
  original shell functions: every space-separated term must appear as a
  **literal substring**; operators (`!neg`, `^prefix`, `suffix$`, `'exact`)
  still work. Rationale: pure fuzzy (subsequence) matching let 200-char
  base64 URLs (Loop/SharePoint links) weakly match almost any query.
- Tiebreakers: bookmarks before history on equal score, then shorter
  targets. Stale async results are discarded (generation counter).

### Interaction model

| Key                     | Action                                            |
|-------------------------|---------------------------------------------------|
| type                    | search (80 ms debounce)                           |
| `↑` `↓` / `^n` `^p`     | move selection                                    |
| `←` `→`                 | cycle tabs: **all → history → bookmarks** (wraps) |
| `Tab`                   | toggle multi-select (green bar at row start)      |
| `Enter`                 | open selection (all picked, if any)               |
| `⌘/^/⌥ + 1–9`           | quick-open rows 1–9                               |
| `⌥Enter`                | open the organizer                                |
| `Esc` / backdrop click  | close                                             |

"all" is the default tab. Quick-open uses `e.code` (`Digit1`) so macOS
Option-modified characters map to the right physical key; ⌥ is the
reliable modifier since many ⌘ combos are browser-reserved (⌘W, ⌘T, ⌘1-8).
Only digits are bound — modifier+letter is left to the browser so chords
like ⌘v (paste), ⌘a, and ⌘c keep working in the search box.

Row layout: `pickbar · quicklabel · marker · favicon · title · path · url ·
age`. Markers: `★` bookmark, `⧉` open tab, `★⧉` both, `·` history. Age is
relative (`42s/5m/3h/6d/4mo/2y`) from `effTime`.

### Opening behavior

`open(urls)` prefers **switching to an existing tab**: it scans all tabs in
all windows for a URL match (fragment ignored) and focuses the tab + window
if found; only otherwise creates a tab — in the last focused *normal*
window, never in the popup window itself.

### Focus handling (overlay)

Chrome blocks the declarative `autofocus` attribute in cross-origin
subframes. Instead: overlay.js focuses the iframe's content window on load
and posts `searchlight-focus`; the page responds, plus retries at
0/50/200 ms. Safety net: any printable keystroke while the input is
unfocused focuses it mid-keydown, so the character lands in the box.

---

## 3. Bookmark dialog (bookmark.html/js, Cmd+B)

A compact panel (864×576 overlay / 864×624 window) replacing Chrome's ⌘D
flow with a searchable folder picker.

- **Header**: favicon, editable name, URL. Already-bookmarked pages show a
  note with the current folder, default the name to the **existing
  bookmark's (possibly customized) title**, and pin its **current folder**
  with a `(current)` badge; fresh pages default to the page title and the
  last-used folder (`(last used)` badge).
- **Folder search**: fzf v2 (fuzzy, typo-tolerant — folder paths are short
  so subsequence matching helps: `rdc` → Projects/RedisCache). Empty query
  pins default folder, then up to 5 MRU `(recent)` folders, then tree order.
- **Create folder in-flow**: every non-empty query ends with a
  "➕ New folder" row; selecting it (or clicking the ➕ button, which uses
  the typed text as the name) switches the list into **parent-picker
  mode** — same fuzzy search, banner showing what's being created, Esc
  steps back. Enter creates the folder under the chosen parent and saves
  the bookmark into it in one flow.
- **Save semantics**: existing bookmark → `update` (title) + `move`;
  otherwise `create`. Duplicate detection retries without the `#fragment`
  (bookmarks.search is exact-match). `⌘⌫` removes the existing bookmark
  (hint shown only when applicable).
- Target tab = active tab of the last-focused normal window — correct in
  both display modes.

---

## 4. Overlay (overlay.js)

Injected on demand via `chrome.scripting.executeScript` (no persistent
content script). Toggle semantics: re-running for the same page removes the
overlay; a different page replaces it (⌘K ↔ ⌘B swap cleanly).

- Backdrop `div` (`position:fixed; inset:0; rgba(0,0,0,.35)`,
  `z-index: 2147483647`) + centered iframe: search `min(1296px,92vw) ×
  min(672px,80vh)` at 12vh; bookmark `min(864px,90vw) × min(576px,78vh)`
  at 14vh. Rounded, shadowed; placeholder background follows the theme
  setting to avoid a flash.
- UI pages are listed in `web_accessible_resources` to be embeddable.
- Close paths: `Esc` (captured on the host document AND relayed from
  inside the iframe via `searchlight-close`), backdrop click, re-toggle,
  or any completing action.
- Fallback popup window: anchored over the host Chrome window (centered,
  ~8% from its top); position re-applied via `windows.update()` after
  `create()` because macOS clamps create-time coordinates to the primary
  display (coordinates are NOT clamped to ≥0 — negative values are valid
  on multi-monitor setups). An existing window for the same page is
  focused and repositioned instead of duplicated.

---

## 5. Organizer (organize.html/js)

A deliberate pivot: earlier versions had a 3-pass suggestion engine
(TF-IDF, background content fetching, Gemini Nano verdicts — see git
history around `0f8d5c0`). It proved unreliable and was replaced by a
hands-on manager (`0913736`).

Two panes with a draggable divider (width persisted; min 180px, max 70vw):

- **Left — folder tree** in tree order, indented, with per-folder
  direct-bookmark counts. Collapsible via disclosure triangles (default
  expanded; a node hides if any ancestor is collapsed). Hover actions:
  **✏ rename** (inline input: Enter/blur saves, Esc cancels; roots
  excluded) and **＋ new subfolder** (prompt).
- **Right — bookmark list**: the selected folder's direct bookmarks, or —
  when the filter box is non-empty — a substring search across *all*
  bookmarks (capped 500). Titles are real links (`target=_blank`); hover
  **✏** renames inline.
- **Selection** (`checked` set) persists across folder switches and
  searches → cross-folder batch operations: **Move** (dropdown incl.
  "➕ New folder…"), **Open selected** (background tabs), **Delete**
  (instant for one; "Are you sure?" with a 5-title preview for >1 —
  deletion has no undo and syncs).
- **Drag & drop**: folder rows drag to reorder (top/bottom-edge zones =
  before/after, middle = nest into; roots immovable, self/descendant drops
  rejected; same-parent forward moves compensate for
  `chrome.bookmarks.move`'s post-removal index semantics). Bookmark rows
  drag onto tree folders; dragging a checked row drags the whole selection.
- **Header settings**: search UI style (overlay / popup window) and theme
  (dark / light), saved to the shared `settings` key.
- Live refresh on all `chrome.bookmarks` events, so external changes
  (search popup, Cmd+B dialog, Chrome's own UI) appear immediately.

---

## 6. Settings & storage keys

| Key                      | Contents                                        |
|--------------------------|-------------------------------------------------|
| `settings`               | `{ display: 'overlay'\|'window', theme: 'dark'\|'light' }` |
| `historyCache3`          | `{ at, items }` — flattened history for first paint |
| `treeWidth`              | organizer tree pane width (px)                  |
| `lastBookmarkFolderId`   | default folder for the Cmd+B dialog             |
| `recentBookmarkFolders`  | MRU list (≤5) of folder ids for `(recent)` pins |

Theme is applied via CSS variable overrides on `:root[data-theme]` in every
page; the overlay iframe placeholder color follows it too.

---

## 7. Permissions rationale

| Permission              | Why                                               |
|-------------------------|---------------------------------------------------|
| `bookmarks`, `history`  | the data                                          |
| `favicon`               | `_favicon/` endpoint for row icons                |
| `tabs`                  | open-tab recency, switch-to-tab, open results     |
| `scripting` + `<all_urls>` | inject overlay.js into the active tab          |
| `storage` + `unlimitedStorage` | caches, settings, MRU state               |

---

## 8. Packaging

`./pack.sh` produces `Searchlight.crx` inside the repo using the persistent
`key.pem` (same key ⇒ same extension ID ⇒ installs as an update). Chrome
refuses to pack a directory containing a `.pem`, so the script parks a
**copy-first** safety duplicate outside the tree, removes the original only
after the copy exists, and refuses to report success unless the key is
verified back in place — the original move-based script silently lost the
first key (builds before/after that point have different extension IDs).
`key.pem` and `Searchlight.crx` are gitignored; the key must never be
committed or shared.

Install paths: "Load unpacked" (recommended for self), or drag the CRX onto
`chrome://extensions` with Developer Mode (may be blocked by enterprise
policy on managed profiles).

---

## 9. Known limitations

- History depth is bounded by Chrome's retention (~90 days of visits); the
  SQLite `urls` table read by the old `ch` shell function can hold more
  rows than the API exposes.
- Exact matching means no typo tolerance in the search palette (same
  trade-off as `fzf -e`); the bookmark dialog's folder picker uses fuzzy
  v2 deliberately (short paths, no noise problem).
- The overlay cannot appear on `chrome://` pages, the Web Store, PDF views,
  or the new tab page — those get the popup window, which has a native
  title bar (Chrome offers no frameless windows to extensions).
- ⌘+digit quick-open keys may be consumed by browser shortcuts in
  the overlay; ⌥ always works.
- `suggested_key` only binds on first install; both shortcuts (⌘K, ⌘B)
  need manual binding at `chrome://extensions/shortcuts` on existing
  installs.
- The popup records itself in Chrome's history (hidden from results, but
  visible in chrome://history).

## 10. Ideas / future work

- Bookmark all tabs in the current window into a chosen folder.
- Recently closed tabs (`chrome.sessions`) blended into the recency view
  with restore-on-Enter.
- Shift+Enter in the palette: open in background without closing.
- Frecency ranking (visit count × recency) for the empty-query view.
- Organizer hygiene tools: duplicate finder, dead-link checker.
- Persist tree collapse state.
