# hunk-review

Comment on diffs in VS Code and send the comments to a live hunk session
where a coding agent can read them.

## What the extension does

- Opens a review of uncommitted changes (working tree + staging) in native
  VS Code diff editors; changed lines are highlighted.
- Lets you comment on changed lines: click "+" → type text in the thread
  editor → press the "Add Comment" button. This works on both
  sides of the diff editor — added/context lines on the new (right) side and
  deleted lines on the original/HEAD (left) side.
- Stores comments locally in `.hunk-review/comments.json`
  (store-and-forward: you can comment even without hunk running).
- "Send comments to agent" — sends pending comments as a batch to the live
  hunk session; if no session exists, it starts one in a hidden background
  terminal ("hunk review session") that does not steal focus.
- "Connect to session" (`hunk-review.connectToSession`) — reveals the hidden
  terminal with the running hunk TUI so you can interact with the session.
- Picks up agent replies and notes from hunk into VS Code threads (replies
  land in the thread of the original comment).
- Keeps the review live: saving files or git operations (commit/stash/checkout)
  refresh the highlights and threads, reload the hunk session contents so the
  agent reviews fresh code, and mark comments whose lines drifted out of the
  diff as `stale`.
- Detects a session that died outside VS Code (or when the diff became empty),
  stops polling, clears the state and shows session liveness in the status bar
  (`hunk • live`).
- After you commit, comments whose lines went into the commit are moved to
  `.hunk-review/archive.json` (with the commit sha); comments on lines that
  are still changed stay active.
- Stops the session when the working tree becomes clean (committed or
  reverted), or via the "Stop hunk Session" command.

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
5. `Cmd+Shift+P` → "Open Working Tree Review".

Tests: `npm test` (launches a real VS Code instance; the smoke test skips
itself when no live hunk session is available). Types and lint: `npm run
check-types`, `npm run lint`. Build: `npm run compile`; production package:
`npm run package`.

## Typical review loop

1. Click "Start review" in the status bar (or the compare button in the editor toolbar or the Source Control title, or run "Open Working Tree Review") → the diff opens in VS Code. If the hunk CLI is not installed, a warning with install instructions is shown.
2. "+" on a changed line → text → "Add Comment" (status bar
   shows `hunk: N pending`).
3. "Send Comments to Agent" → a hidden terminal with the hunk
   TUI starts in the background, comments are sent as a batch and become
   `you (sent)`. Use "Connect to Session" to open the TUI.
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
