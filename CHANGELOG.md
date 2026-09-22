# Change Log

All notable changes to the "hunk-review" extension will be documented in this file.

## [0.3.0]

- Show your GitHub avatar next to your own review comments. Configure it with `hunk-review.githubUsername`, or leave it empty to auto-detect from a GitHub noreply commit email in your git config.

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
