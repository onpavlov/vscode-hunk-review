import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHunkCli, HunkCommandError, HunkNotInstalledError } from './hunkCli.js';
import { CommentStore, ensureGitignore } from './commentStore.js';
import { DiffService } from './diffService.js';
import { CommentBridge } from './commentBridge.js';
import type { HunkComment } from './commentBridge.js';
import { SessionManager } from './sessionManager.js';
import { HunkSync } from './hunkSync.js';
import { createDecorations } from './decorations.js';
import { createDebouncer } from './debounce.js';
import { formatStatusText } from './statusText.js';
import { findOutOfDiffCommentIds, findStaleCommentIds, hunksToChangedLines } from './staleComments.js';
import type { ChangedLines } from './diffService.js';
import { createUserAvatarResolver } from './userAvatar.js';

export function activate(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		// Still register stub commands even if no workspace is open
		// to allow for testing and future workspace opening
		registerStubCommands(context);
		return;
	}

	const cli = createHunkCli();
	const hunkDir = path.join(root, '.hunk-review');
	const store = new CommentStore(hunkDir);
	const diff = new DiffService();
	const sync = new HunkSync(cli, root, {
		isSessionAlive: () => cli.findSession(root).then((s) => s !== undefined),
	});
	const userAvatar = createUserAvatarResolver(() => diff.getUserEmail());
	const bridge = new CommentBridge(
		store,
		() =>
			sessionManager.currentSession() ? Promise.resolve(sync.getNotes()) : Promise.resolve([]),
		() => diff.getChangedLines(),
		(file) => diff.getOriginalUri(vscode.Uri.joinPath(vscode.Uri.file(root), file)),
		() => userAvatar.uri(),
	);
	const sessionManager = new SessionManager(cli, root, undefined, undefined, () =>
		diff.isWorktreeClean(),
	);
	const decorations = createDecorations();
	context.subscriptions.push(decorations);

	const refreshDecorations = async (changed?: ChangedLines) => {
		decorations.update(changed ?? (await diff.getChangedLines()));
	};

	const hasPending = async () => {
		const n = await store.pendingCount();
		await vscode.commands.executeCommand('setContext', 'hunk-review.hasPending', n > 0);
		const sessionAlive = sessionManager.currentSession() !== undefined;
		statusBar.text = formatStatusText(n, sessionAlive);
		statusBar.tooltip = sessionAlive
			? vscode.l10n.t('hunk session is active (click for menu)')
			: vscode.l10n.t('hunk session is not running (click for menu)');
		if (sessionAlive) {
			startStatusBar.hide();
		} else {
			startStatusBar.show();
		}
		if (n > 0) {
			sendStatusBar.text = `$(comment) ${vscode.l10n.t('Send comments ({0})', n)}`;
			sendStatusBar.tooltip = vscode.l10n.t('Send {0} pending comment(s) to the agent', n);
			sendStatusBar.show();
		} else {
			sendStatusBar.hide();
		}
	};

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'hunk-review.menu';
	statusBar.show();

	// One-click entry point: shown until a hunk session is live.
	const startStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	startStatusBar.text = `$(git-compare) ${vscode.l10n.t('Start review')}`;
	startStatusBar.tooltip = vscode.l10n.t('Open the working tree review');
	startStatusBar.command = 'hunk-review.openDiff';

	// Separate button shown only when there are pending comments —
	// the most frequent action shouldn't be hidden behind the QuickPick menu.
	const sendStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	sendStatusBar.command = 'hunk-review.sendComments';

	// Serialize session operations: a watcher-triggered reload must not overlap
	// with sending comments (apply validates the batch against the current diff).
	let sessionOps: Promise<unknown> = Promise.resolve();
	const serializeSessionOp = <T>(op: () => Promise<T>): Promise<T> => {
		const run = sessionOps.then(op, op);
		sessionOps = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	const INSTALL_COMMAND = 'npm install --global hunkdiff';
	const INSTALL_DOCS_URL = 'https://www.hunk.dev/docs/start/install/';

	// Recommend how to install the hunk CLI. Shown after starting a review (the diff
	// itself works without hunk) and when sending comments fails because it is missing.
	const warnHunkNotInstalled = async () => {
		const copy = vscode.l10n.t('Copy install command');
		const docs = vscode.l10n.t('Open install docs');
		const pick = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'The hunk CLI was not found in PATH. Comments are saved locally, but sending them to an agent needs hunk. Install it with "{0}" (or via Homebrew / the install script), then reload the window.',
				INSTALL_COMMAND,
			),
			copy,
			docs,
		);
		if (pick === copy) {
			await vscode.env.clipboard.writeText(INSTALL_COMMAND);
		} else if (pick === docs) {
			await vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS_URL));
		}
	};

	const checkHunkInstalled = async () => {
		try {
			await cli.listSessions();
		} catch (err) {
			if (err instanceof HunkNotInstalledError) {
				void warnHunkNotInstalled();
			}
			// other errors (e.g. daemon not running) mean hunk itself is present
		}
	};

	const sendComments = async () => {
		const pending = await store.pending();
		if (pending.length === 0) {
			return;
		}
		await serializeSessionOp(async () => {
			try {
				await sessionManager.ensureSession();
				const all = await cli.listSessions();
				const sameRepo = all.filter(
					(s) =>
						fs.realpathSync.native(s.repoRoot) === fs.realpathSync.native(root),
				);
				if (sameRepo.length > 1) {
					void vscode.window.showInformationMessage(
						vscode.l10n.t('Found several hunk sessions in this repository — using the first one.'),
					);
				}
				const result = await cli.applyComments(root, {
					comments: pending.map((c) => ({
						filePath: c.filePath,
						newLine: c.target.newLine,
						oldLine: c.target.oldLine,
						summary: c.summary,
					})),
				});
				// Guard: applied count must match pending count before flipping statuses.
				if (result.applied.length !== pending.length) {
					void vscode.window.showErrorMessage(
						vscode.l10n.t(
							'Comment sync error: expected {0} applied, got {1}. Statuses not updated.',
							pending.length,
							result.applied.length,
						),
					);
				} else {
					// Correlate by filePath+line where possible; fall back to index.
					for (let i = 0; i < pending.length; i += 1) {
						await store.update(pending[i].id, {
							status: 'sent',
							sessionCommentId: result.applied[i]?.commentId,
						});
					}
				}
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						'Sent {0} comment(s). hunk session is running in the background.',
						result.applied.length,
					),
				);
				await sync.pollOnce();
				sync.start(5_000); // while the session is alive — poll for agent comments
				await bridge.refresh();
			} catch (err) {
				if (err instanceof HunkNotInstalledError) {
					void warnHunkNotInstalled();
					return;
				}
				await markStaleOnApplyFailure(err);
				// HunkCommandError.message is just "<cmd> exited with code N" — the actual
				// reason lives in stderr, which was previously dropped on the floor here.
				const detail =
					err instanceof HunkCommandError && err.stderr.trim()
						? `${err.message}: ${err.stderr.trim()}`
						: String(err);
				void vscode.window.showErrorMessage(
					vscode.l10n.t('Failed to send comments: {0}', detail),
				);
			}
		});
		await hasPending();
	};

	// A commit on the same branch changes HEAD's sha: comments whose lines went into it
	// are moved to the archive. A branch switch also changes the sha, so it is excluded by name.
	let lastHead = diff.getHead();
	const archiveAfterCommit = async (changed: ChangedLines) => {
		const prev = lastHead;
		const head = diff.getHead();
		lastHead = head;
		if (!prev?.commit || !head?.commit || prev.commit === head.commit || prev.name !== head.name) {
			return;
		}
		const { comments } = await store.load();
		const archived = await store.archive(findOutOfDiffCommentIds(comments, changed), head.commit);
		if (archived > 0) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Archived {0} comment(s) after the commit.', archived),
			);
		}
	};

	const markStaleComments = async (changed: ChangedLines) => {
		for (const id of findStaleCommentIds(await store.pending(), changed)) {
			await store.update(id, { status: 'stale' });
		}
	};

	const markStaleOnApplyFailure = async (err: unknown) => {
		if (!sessionManager.currentSession()) {
			return;
		}
		try {
			// `session review` only reports new-side hunks — old-side staleness
			// stays undetected here, caught later by the regular diff-based check.
			await markStaleComments({
				newLines: hunksToChangedLines(await cli.sessionReview(root)),
				oldLines: new Map(),
			});
		} catch {
			// stale diagnostics unavailable — not critical
		}
		void err;
	};

	// Live update: saves and git operations lead to recomputing the diff,
	// decorations, marking comments stale, and (if the session is live) reloading hunk's content.
	// Skip an empty diff: reloading with no changes disconnects the session from the daemon
	// (observed on 0.21.x); a clean tree is handled by auto-stop.
	const onWorktreeChanged = async () => {
		const changed = await diff.getChangedLines();
		await refreshDecorations(changed);
		await archiveAfterCommit(changed);
		if (changed.newLines.size > 0) {
			await markStaleComments(changed);
			if (sessionManager.currentSession()) {
				try {
					await cli.reload(root);
					await sync.pollOnce();
				} catch {
					// reload failure isn't critical — polling and the next send will still work
				}
			}
		}
		await hasPending();
		await bridge.refresh();
	};
	const worktreeWatcher = createDebouncer(2_000, () =>
		serializeSessionOp(onWorktreeChanged),
	);

	const openDiff = async () => {
		const repo = diff.getRepo();
		if (!repo) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Git repository not found'));
			return;
		}
		const changed = await diff.getChangedLines();
		if (changed.newLines.size === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No uncommitted changes'));
			return;
		}
		await ensureGitignore(hunkDir);
		for (const [file] of changed.newLines) {
			const uri = vscode.Uri.joinPath(repo.rootUri, file);
			await diff.openDiffForFile(uri);
			break; // open the first changed file; others are opened by clicking the list
		}
		await bridge.refresh();
		await refreshDecorations();
		await checkHunkInstalled();
	};

	// Flips one comment back out of the native editing textarea locally. Needed because
	// CommentBridge.refresh() now preserves whatever is still flagged 'editing' across
	// background refreshes (see commentBridge.ts) — without this, Save/Cancel would leave
	// the comment stuck in Editing mode forever, and its edit/delete menu (gated on
	// contextValue === 'pending') would never come back.
	const exitEditingMode = (comment: HunkComment) => {
		const thread = comment?.parent;
		if (!comment?.storeId || !thread) {
			return;
		}
		thread.comments = thread.comments.map((c) =>
			c === comment
				? ({ ...c, mode: vscode.CommentMode.Preview, contextValue: 'pending' } as HunkComment)
				: c,
		);
	};

	context.subscriptions.push(
		statusBar,
		sendStatusBar,
		startStatusBar,
		bridge,
		sessionManager,
		sync,
		// Wire sync changes to bridge refresh (C2: arrived notes trigger display update).
		sync.onDidChange(() => {
			void bridge.refresh();
		}),
		sync.onSessionLost(() => {
			sessionManager.clearSession();
			void hasPending();
			void vscode.window.showInformationMessage(vscode.l10n.t('hunk session ended'));
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('hunk-review.githubUsername')) {
				void userAvatar.refresh().then(() => bridge.refresh());
			}
		}),
		worktreeWatcher,
		vscode.commands.registerCommand('hunk-review.openDiff', openDiff),
		vscode.commands.registerCommand('hunk-review.sendComments', sendComments),
		vscode.commands.registerCommand('hunk-review.stopSession', async () => {
			sync.stop();
			await sessionManager.stopSession(vscode.l10n.t('stopped by user'));
			await hasPending();
		}),
		vscode.commands.registerCommand('hunk-review.connectToSession', () =>
			sessionManager.connectToSession(),
		),
		vscode.commands.registerCommand('hunk-review.menu', async () => {
			const pendingCount = await store.pendingCount();
			const items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }> = [
				{ label: `$(git-compare) ${vscode.l10n.t('Open review')}`, action: () => openDiff() },
				{
					label: `$(comment) ${vscode.l10n.t('Send comments to agent ({0})', pendingCount)}`,
					action: () => sendComments(),
				},
				{
					label: `$(plug) ${vscode.l10n.t('Connect to session')}`,
					action: () => sessionManager.connectToSession(),
				},
				{
					label: `$(close) ${vscode.l10n.t('Stop hunk session')}`,
					action: async () => {
						sync.stop();
						await sessionManager.stopSession(vscode.l10n.t('stopped by user'));
						await hasPending();
					},
				},
			];
			const pick = await vscode.window.showQuickPick(items, { title: 'hunk review' });
			if (pick) {
				await pick.action();
			}
		}),
		vscode.commands.registerCommand('hunk-review.addComment', async (reply) => {
			const { thread, text } = (reply ?? {}) as { thread?: vscode.CommentThread; text?: string };
			if (!thread) {
				return;
			}
			const summary = (text ?? '').trim();
			if (!summary) {
				void vscode.window.showInformationMessage(
					vscode.l10n.t('Enter comment text in the thread field and click the button again.'),
				);
				return;
			}
			const file = relPathFromRoot(thread.uri);
			const line = ((thread.range?.start.line) ?? 0) + 1;
			// git-scheme = original (HEAD) side of a diff editor — the target is a deleted line.
			const target = thread.uri.scheme === 'git' ? { oldLine: line } : { newLine: line };
			await store.add(file, target, summary);
			// Close the draft thread ("Start discussion"), otherwise it stays
			// open next to the thread rebuilt from the store.
			thread.dispose();
			await hasPending();
			await bridge.refresh();
			void refreshDecorations();
		}),
		vscode.commands.registerCommand('hunk-review.editComment', (comment: HunkComment) => {
			const thread = comment?.parent;
			if (!comment?.storeId || !thread) {
				return;
			}
			// Switch just this one comment into VS Code's native editing textarea;
			// nothing is written to the store until Save.
			thread.comments = thread.comments.map((c) =>
				c === comment
					? ({ ...c, mode: vscode.CommentMode.Editing, contextValue: 'editing' } as HunkComment)
					: c,
			);
		}),
		vscode.commands.registerCommand('hunk-review.saveComment', async (comment: HunkComment) => {
			const id = comment?.storeId;
			if (!id) {
				return;
			}
			const summary = (typeof comment.body === 'string' ? comment.body : comment.body.value).trim();
			if (!summary) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Comment cannot be empty.'));
				return;
			}
			await store.update(id, { summary });
			exitEditingMode(comment);
			await bridge.refresh();
		}),
		vscode.commands.registerCommand('hunk-review.cancelEditComment', async (comment: HunkComment) => {
			// Store wasn't touched — exiting Editing mode locally and refreshing
			// rebuilds this comment from the store, discarding the in-progress edit.
			exitEditingMode(comment);
			await bridge.refresh();
		}),
		vscode.commands.registerCommand('hunk-review.deleteComment', async (comment: HunkComment) => {
			const id = comment?.storeId;
			if (!id) {
				return;
			}
			await store.remove(id);
			await hasPending();
			await bridge.refresh();
			void refreshDecorations();
		}),
	);

	// Live-update triggers: file saves and git operations
	// (commit/stash/checkout) feed one debounced handler.
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(() => worktreeWatcher.trigger()),
	);
	const repo = diff.getRepo();
	if (repo?.state.onDidChange) {
		context.subscriptions.push(repo.state.onDidChange(() => worktreeWatcher.trigger()));
	}
	// Auto-stop on a clean working tree — via a periodic check.
	const autoStopTimer = setInterval(() => {
		void sessionManager.maybeAutoStop().then(() => {
			// Session stopped — don't leave polling running to accumulate errors.
			if (!sessionManager.currentSession()) {
				sync.stop();
			}
			return hasPending();
		});
	}, 5_000);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(autoStopTimer)));

	// C2: if a session already exists at activation, start polling immediately.
	if (sessionManager.currentSession()) {
		sync.start(5_000);
	}

	void hasPending();
	void bridge.activate(context);
	// Resolves in the background — comments render with the local fallback icon
	// until the GitHub avatar is known, then pick it up on the next refresh.
	void userAvatar.refresh().then(() => bridge.refresh());
	// The session may have been started earlier (or the terminal session restarted):
	// on activation, look for a live session and enable comment polling.
	void sessionManager.findSession().then((s) => {
		if (s) {
			sync.start(5_000);
		}
	});
}

export function deactivate(): void {
	// SessionManager.dispose() is called via context.subscriptions.
}

function registerStubCommands(context: vscode.ExtensionContext): void {
	const noWorkspace = () => {
		void vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder to use hunk-review'));
	};
	
	context.subscriptions.push(
		vscode.commands.registerCommand('hunk-review.openDiff', noWorkspace),
		vscode.commands.registerCommand('hunk-review.sendComments', noWorkspace),
		vscode.commands.registerCommand('hunk-review.stopSession', noWorkspace),
		vscode.commands.registerCommand('hunk-review.connectToSession', noWorkspace),
		vscode.commands.registerCommand('hunk-review.menu', noWorkspace),
		vscode.commands.registerCommand('hunk-review.addComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.editComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.saveComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.cancelEditComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.deleteComment', noWorkspace),
	);
}

function relPathFromRoot(uri: vscode.Uri): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
