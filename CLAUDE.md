# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VS Code extension "hunk-review": lets you comment on uncommitted diffs in native VS Code diff editors and send those comments as a batch to a live [hunk](https://hunk.dev) CLI session, where a coding agent reads and replies to them. Requires the `hunk` CLI in `PATH` (built against 0.21.x's JSON output shapes).

## Commands

- `npm run compile` — typecheck + lint + bundle to `dist/extension.js` (esbuild, CJS)
- `npm run watch` — parallel esbuild + tsc watch (used by the F5 debug task)
- `npm run package` — production build (minified, no sourcemaps)
- `npm run check-types` / `npm run lint` — run individually
- `npm test` — runs `vscode-test`; `pretest` first compiles tests (`tsc -p . --outDir out`) and runs the full compile+lint. Tests live in `src/test/*.test.ts`, compiled to `out/`, discovered via `.vscode-test.mjs`. Launches a real VS Code (Electron) instance — no single-file test runner is configured. `smoke.test.ts` skips itself when no live hunk session is available.
- Manual run: `F5` in VS Code opens an Extension Development Host **without a folder**; open a project with uncommitted changes inside it, then `Developer: Reload Window` so the extension activates with the folder present, then run "hunk: Open Working Tree Review" (shows in Russian as "hunk: Открыть ревью рабочего дерева" when the host's display language is `ru`).

## Architecture

`src/extension.ts` `activate()` is the composition root: it constructs all collaborators as plain classes wired together by closures (no DI framework) and registers the `hunk-review.*` commands from `package.json`. Every collaborator takes its side-effecting dependency (git API, hunk CLI runner, terminal factory) as a constructor parameter so tests can inject fakes instead of touching real `vscode.git` or spawning the real `hunk` binary.

Collaborators (`src/*.ts`):
- **`hunkCli.ts`** — thin subprocess wrapper around the `hunk` CLI (`session list/comment/review/reload`, all `--json`). Normalizes field-name drift between hunk versions/sources (e.g. `noteId`/`commentId`, `newLines`/`new_lines`) and subprocess errors into `HunkNotInstalledError`/`HunkCommandError`.
- **`commentStore.ts`** — persists comments to `.hunk-review/comments.json` (store-and-forward: works before any hunk session exists). Comments carry `status: pending | sent | stale` and a `sessionCommentId` once applied.
- **`diffService.ts`** — reads the built-in `vscode.git` extension's API to get working-tree + staged diff text, parses `@@ ... @@` hunk headers into per-file changed-line ranges, and opens the native diff editor.
- **`sessionManager.ts`** — owns the hunk session lifecycle: spawns a **hidden** VS Code terminal (`hideFromUser: true`) running `hunk diff` so it doesn't steal focus, polls `hunk session list --json` for up to 10s waiting for registration, and auto-stops the session when the worktree goes clean.
- **`hunkSync.ts`** — polls `hunk session comment list` every 5s while a session is live, diffs the JSON against the last poll to detect changes, and declares the session "lost" after N consecutive failed polls (default 2) while the session is still supposed to be alive.
- **`commentBridge.ts`** — merges stored comments and hunk notes (agent replies) into VS Code `CommentThread`s keyed by `file:line`. Filters out echoes (the extension's own sent comments coming back from `comment list`) by `sessionCommentId` and by a `(file, line, text)` fallback match, and serializes concurrent `refresh()` calls through a promise chain to avoid duplicate threads when a send and a watcher-triggered refresh race.
- **`staleComments.ts`** — pure functions: turns `session review` hunk ranges into changed-line ranges, and finds which pending comments' anchor line no longer falls inside any changed range (marked `stale` on next refresh/send).
- **`decorations.ts`** / **`statusText.ts`** / **`debounce.ts`** — small pure/UI-only helpers (line highlighting, status bar text, a generic trigger-debouncer).

### Key flows worth understanding before editing `extension.ts`

- **Live-update loop**: `vscode.workspace.onDidSaveTextDocument` and git repo state changes both feed one 2s-debounced handler (`worktreeWatcher`) that recomputes the diff, refreshes decorations, marks now-out-of-diff pending comments `stale`, and — only if a session is live — calls `hunk session reload` and polls for new notes. Reload is skipped when the diff is empty because reloading with no changes disconnects the session from the daemon (observed on 0.21.x).
- **Session-op serialization**: `serializeSessionOp` chains `sendComments` and the watcher's reload/poll onto one promise so they can't interleave — `applyComments` validates the incoming batch against the *current* diff, so a concurrent reload could otherwise invalidate it mid-flight.
- **Sending comments**: `sendComments` batches all pending comments through `cli.applyComments`, then correlates the response back to the batch **by array index** to flip each comment's status to `sent` and stash its `sessionCommentId`. A count mismatch aborts the status update (shown as an error) rather than guessing correlation.
- **Auto-stop / loss detection are two different mechanisms**: `SessionManager.maybeAutoStop()` (polled every 5s from `extension.ts`) stops the session when the worktree is clean (commit/stash/checkout). `HunkSync`'s missed-poll counter instead detects a session that died out-of-band (crashed CLI, killed terminal) and fires `onSessionLost`, which clears session state and notifies the user — these are not the same event.
- Comments target either `newLine` or `oldLine`, never both (`CommentStore.add` throws otherwise).

## Conventions

- TypeScript strict mode, `module: Node16`, target ES2022, `rootDir: src`. Import local modules with explicit `.js` extensions (Node16 module resolution), e.g. `from './hunkCli.js'`.
- ESLint only covers `src` (run via npm scripts, not bare `eslint`).
- Tab indentation.
- `package.json` `overrides` pins `diff` and `serialize-javascript` — preserve these when touching dependencies.
- New user-facing commands must be declared in both `package.json` (`contributes.commands`) and `vscode.commands.registerCommand` in `src/extension.ts`, with matching `hunk-review.`-prefixed IDs. `activationEvents` is empty — activation is implicit via command registration.
- esbuild bundles everything except `vscode` (external) — don't assume other node built-ins/deps are available unbundled at runtime.
- Localized (l10n): UI strings in `src/*.ts` are English literals wrapped in `vscode.l10n.t('...', ...args)` (positional args use `{0}`, `{1}`); `contributes.commands` titles in `package.json` are `%key%` refs resolved via `package.nls.json`. Russian translations live in `l10n/bundle.l10n.ru.json` (runtime strings) and `package.nls.ru.json` (command titles) — every new `l10n.t()` key or `%key%` needs an entry in both the English and Russian files, and the Russian entry's key text must match the English source string byte-for-byte. To add another language, drop in `l10n/bundle.l10n.<locale>.json` and `package.nls.<locale>.json` — no source changes needed. Code comments stay Russian (repo convention, not user-facing).
