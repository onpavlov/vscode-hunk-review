# hunk-review

Comment on diffs in VS Code and send the comments to a live hunk session
where a coding agent can read them.

## What the extension does

- Opens a review of uncommitted changes (working tree + staging) in native
  VS Code diff editors; changed lines are highlighted.
- Lets you comment on changed lines: click "+" → type text in the thread
  editor → press the "hunk: Добавить комментарий" button.
- Stores comments locally in `.hunk-review/comments.json`
  (store-and-forward: you can comment even without hunk running).
- "Send comments to agent" — sends pending comments as a batch to the live
  hunk session; if no session exists, it starts one in a hidden background
  terminal ("hunk review session") that does not steal focus.
- "Connect to session" (`hunk-review.connectToSession`) — reveals the hidden
  terminal with the running hunk TUI so you can interact with the session.
- Picks up agent replies and notes from hunk into VS Code threads (replies
  land in the thread of the original comment).
- Stops the session when the working tree becomes clean (committed or
  reverted), or via the "Остановить hunk сессию" command.

## Requirements

- [hunk](https://hunk.dev) CLI in `PATH` (verified with 0.21.1) — see the
  [install docs](https://www.hunk.dev/docs/start/install/).
- VS Code 1.136+.

## Running the dev build

```bash
git clone <repo-url> hunk-review
cd hunk-review
npm install
```

Then in VS Code:

1. `File → Open Folder…` → the repository folder.
2. `F5` (the "Run Extension" config) — builds the bundle (watch task) and
   opens an **Extension Development Host** window.
3. The EDH window opens **without a folder**: inside it, `File → Open
   Folder…` → a project with uncommitted changes.
4. `Cmd+Shift+P` → `Developer: Reload Window` — so the extension activates
   with the folder already open.
5. `Cmd+Shift+P` → "hunk: Открыть ревью рабочего дерева".

Tests: `npm test` (launches a real VS Code instance; the smoke test skips
itself when no live hunk session is available). Types and lint: `npm run
check-types`, `npm run lint`. Build: `npm run compile`; production package:
`npm run package`.

## Typical review loop

1. "hunk: Открыть ревью рабочего дерева" → the diff opens in VS Code.
2. "+" on a changed line → text → "hunk: Добавить комментарий" (status bar
   shows `hunk: N pending`).
3. "hunk: Отправить комментарии агенту" → a hidden terminal with the hunk
   TUI starts in the background, comments are sent as a batch and become
   `you (sent)`. Use "hunk: Подключиться к сессии" to open the TUI.
4. Agent replies arrive in the threads automatically (~5 s).
5. Once you commit or revert the changes, the background session stops
   itself.

## Extension Settings

None so far.

## Known Issues

- The JSON shape of `hunk session * --json` may change between hunk
  versions; the extension targets 0.21.x.
- Comments on lines that no longer exist in the diff are marked `stale`
  on the next send.

## Release Notes

### 0.1.0

First working release: working-tree review, comments into a hunk session,
agent reply sync, automatic session stop.
