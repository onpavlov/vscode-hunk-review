# Change Log

All notable changes to the "hunk-review" extension will be documented in this file.

## [0.5.0]

- Reply to agent notes from VS Code: a Reply button on each agent note opens an editor for the answer, which is sent as a threaded `replyTo` reply to that note. Needs hunk 0.22+ (detected via `hunk --version`); if the parent note is gone by send time, the reply goes out as a regular comment on the same line.
- Warn once per hunk version when the installed hunk is older than 0.22.0, since replying to agent notes needs it.
- Threads show hunk's reply tree: each reply follows the comment it answers and is labeled "↳ reply to <author>"; siblings are in chronological order.
- Agent replies and hunk notes are cached in `.hunk-review/comments.json` (new optional `notes` field) and stay visible after the hunk session ends — previously a window reload killed the session and lost them. They are archived with the comments after a commit. Older extension versions ignore the field and drop it on their next write.
- Your avatar is auto-detected from the GitHub account signed in to VS Code (Accounts menu) when `hunk-review.githubUsername` is empty, before falling back to a GitHub noreply commit email.
- Comments sent from VS Code carry `author: "user"` in hunk, so the agent can tell your review comments apart from its own notes. Note that `hunk session comment list --type user` still filters by hunk's own `source` field, which `session comment apply` cannot set — such comments stay `--type agent` there.

## [0.4.0]

- Adding a comment starts the hunk session in the background if it isn't running yet.
- `.hunk-review/.gitignore` is created on every store write, so a comment added before opening the review no longer leaves `.hunk-review/` untracked in git.
- Fix a grey background flickering over code: the changed-lines highlight is now drawn only in diff editors and re-applied on tab switches instead of disappearing until the next save.

## [0.3.1]

- Only changed lines can be commented: files without changes no longer offer a commenting range, since hunk only knows files in the diff and such comments could never be sent. New files (staged or untracked) stay commentable as a whole.
- Treat untracked files as changed when `git.untrackedChanges` is set to "separate", so they stay commentable and don't make the worktree look clean.

## [0.3.0]

- Show your GitHub avatar next to your own review comments. Configure it with `hunk-review.githubUsername`, or leave it empty to auto-detect from a GitHub noreply commit email in your git config.
- Fix comments on untracked files being wrongly marked stale: `git diff` never lists untracked files, so their changed-line range was always empty; now the whole file is treated as changed when `git diff` has nothing for it.

## [0.2.1]

- Document how to set up the hunk-review skill for the coding agent.
- Add the repository link to the dev build instructions and a disclaimer that the extension is not affiliated with hunk or Modem.

## [0.2.0]

- Add a one-click "Start review" button to the editor toolbar and the status bar; the status bar now appears right after startup.
- Warn with install instructions when the hunk CLI is not found in `PATH`.
- Drop the redundant `hunk:` prefix from command titles.
- Move comments whose lines went into a commit to `.hunk-review/archive.json`.

## [0.1.0]

- Initial release
