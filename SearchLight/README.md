# Searchlight

Chrome extension version of the `ch`/`cb` shell functions: fzf-style fuzzy
search over bookmarks + history, plus a content-aware bookmark organizer with
background analysis. All bookmark changes go through the official
`chrome.bookmarks` API — the Bookmarks JSON file is never touched directly,
so it's safe with Chrome running and with sync enabled.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this directory

## Search popup

- Open with **Cmd+K** (configurable at `chrome://extensions/shortcuts`)
  or click the toolbar icon
- Type to fuzzy-match across title, folder path, and URL
  (`★` = bookmark, `·` = history)
- `↑`/`↓` or `Ctrl+n`/`Ctrl+p` — move selection
- `Tab` — multi-select (like `fzf --multi`)
- `Enter` — open selection (all selected, if any)
- `Alt+Enter` — jump to the organizer page
- Tabs at the top filter to bookmarks-only or history-only

## Organizer

Open via `Alt+Enter` from the search popup, or right-click the extension
icon → **Options**. A simple two-pane manager:

- **Left**: your folder tree with per-folder counts. Click a folder to
  browse its bookmarks; hover and hit ＋ to create a subfolder inside it.
- **Right**: the selected folder's bookmarks, or — when you type in the
  filter box — a search across *all* bookmarks. Click any title to open
  it in a new tab.
- Check bookmarks (across folders/searches — selection persists), then:
  - **Move** them to any existing folder or a "➕ New folder…"
  - **Open selected** in background tabs

The page live-refreshes when bookmarks change anywhere in Chrome. All
mutations go through the `chrome.bookmarks` API.

## Privacy / network note

Everything is local: bookmark and history data is read via Chrome's
extension APIs and never sent anywhere. The 1-hour history cache lives in
local extension storage.
