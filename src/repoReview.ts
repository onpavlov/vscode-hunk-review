import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { HunkCommandError, HunkNotInstalledError } from './hunkCli.js';
import type { ApplyCommentItem, HunkCli } from './hunkCli.js';
import type { StoredComment } from './types.js';
import { CommentStore, ensureGitignore } from './commentStore.js';
import { DiffService } from './diffService.js';
import type { ChangedLines } from './diffService.js';
import { CommentBridge } from './commentBridge.js';
import type { HunkComment } from './commentBridge.js';
import { CommentAnchors } from './anchors.js';
import { captureAnchor } from './textAnchor.js';
import { SessionManager } from './sessionManager.js';
import { HunkSync } from './hunkSync.js';
import { createDecorations } from './decorations.js';
import { createDebouncer } from './debounce.js';
import type { Debouncer } from './debounce.js';
import {
	findOutOfDiffCommentIds,
	findOutOfDiffNoteIds,
	findStaleCommentIds,
	hunksToChangedLines,
	isLineInDiff,
} from './staleComments.js';
import { applyWithFallback, splitDeliverable } from './sendPlan.js';
import { createUserAvatarResolver, signedInGithubLogin } from './userAvatar.js';
import type { UserAvatarResolver } from './userAvatar.js';
import { repoRelative } from './repoPaths.js';

// hunk marks `session comment apply` notes as agent-sourced (source: "agent").
// The apply JSON exposes no `source`/`type` field, only `author` — set it so the
// coding agent can recognize these as human-authored review comments.
const REVIEW_AUTHOR = 'user';

const POLL_INTERVAL_MS = 5_000;
const WORKTREE_DEBOUNCE_MS = 2_000;
const AUTO_STOP_INTERVAL_MS = 5_000;

export interface RepoReviewDeps {
	cli: HunkCli;
	/** Root of the git repository this review is bound to. */
	rootUri: vscode.Uri;
	/** Diff service pinned to this repository. */
	diff: DiffService;
	/** True for documents that belong to this repository and not to one nested inside it. */
	ownsUri(uri: vscode.Uri): boolean;
	/** The comment controller shared by all repositories of the window. */
	controller: vscode.CommentController;
	extensionUri: vscode.Uri;
	/** Whether the installed hunk accepts `replyTo` (0.22+). */
	repliesSupported(): boolean;
	anchorContextLines(): number;
	warnHunkNotInstalled(): void;
	/** Whether the window has several repositories — messages then name the one they are about. */
	isMultiRepo(): boolean;
	/** The pending count or the session liveness changed: the shared status bar needs a redraw. */
	onStateChange(): void;
}

/**
 * The whole review of one git repository: its comment store, hunk session, live-update loop,
 * comment threads and diff decorations. A window with several repositories runs one of these per
 * repository, so each has its own `.hunk-review` store and its own hunk session.
 */
export class RepoReview implements vscode.Disposable {
	readonly root: string;
	readonly name: string;
	readonly bridge: CommentBridge;

	private readonly store: CommentStore;
	private readonly diff: DiffService;
	private readonly cli: HunkCli;
	private readonly anchors: CommentAnchors;
	private readonly sync: HunkSync;
	private readonly sessionManager: SessionManager;
	private readonly decorations: ReturnType<typeof createDecorations>;
	private readonly userAvatar: UserAvatarResolver;
	private readonly worktreeWatcher: Debouncer;
	private readonly hunkDir: string;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly autoStopTimer: ReturnType<typeof setInterval>;
	// Serialize session operations: a watcher-triggered reload must not overlap
	// with sending comments (apply validates the batch against the current diff).
	private sessionOps: Promise<unknown> = Promise.resolve();
	private sessionStart: Promise<void> | undefined;
	private lastHead: { name?: string; commit?: string } | undefined;
	private disposed = false;

	constructor(private readonly deps: RepoReviewDeps) {
		this.root = deps.rootUri.fsPath;
		this.name = path.basename(this.root);
		this.cli = deps.cli;
		this.diff = deps.diff;
		this.hunkDir = path.join(this.root, '.hunk-review');
		this.store = new CommentStore(this.hunkDir);
		// Working-tree files are read under the repo root: the changed-line keys come from `git diff`
		// and are repo-relative.
		this.anchors = new CommentAnchors(this.store, (file) =>
			this.diff.readWorkingTreeLines(deps.rootUri, file),
		);
		this.sync = new HunkSync(this.cli, this.root, {
			isSessionAlive: () => this.cli.findSession(this.root).then((s) => s !== undefined),
		});
		this.userAvatar = createUserAvatarResolver(() => this.diff.getUserEmail(), signedInGithubLogin);
		this.bridge = new CommentBridge(
			this.store,
			// Notes come from the store, not the live session: cached there by each poll,
			// they survive the session ending (window reload, crash, auto-stop).
			() => this.store.load().then((d) => d.notes ?? []),
			() => this.diff.getChangedLines(),
			(file) => this.diff.getOriginalUri(vscode.Uri.joinPath(deps.rootUri, file)),
			() => this.userAvatar.uri(),
			() => deps.repliesSupported(),
			(file) => this.diff.getModifiedUri(vscode.Uri.joinPath(deps.rootUri, file)),
			(uri) => this.diff.diffSideOf(uri),
			deps.rootUri,
		);
		this.bridge.attach(deps.controller, deps.extensionUri);
		this.sessionManager = new SessionManager(this.cli, this.root, undefined, undefined, () =>
			this.diff.isWorktreeClean(),
		);
		this.decorations = createDecorations((uri) => this.diff.diffSideOf(uri), {
			repoRoot: this.root,
			ownsUri: (uri) => deps.ownsUri(uri),
		});
		this.lastHead = this.diff.getHead();
		this.worktreeWatcher = createDebouncer(WORKTREE_DEBOUNCE_MS, () =>
			this.serializeSessionOp(() => this.onWorktreeChanged()),
		);

		this.disposables.push(
			// Arrived notes trigger a display update; notes are cached in comments.json first,
			// since the bridge renders from there.
			this.sync.onDidChange(async (notes) => {
				const session = this.sessionManager.currentSession();
				if (session) {
					await this.store.mergeNotes(session.sessionId, notes).catch(() => undefined);
				}
				await this.bridge.refresh();
			}),
			this.sync.onSessionLost(() => {
				this.sessionManager.clearSession();
				this.deps.onStateChange();
				void vscode.window.showInformationMessage(
					this.deps.isMultiRepo()
						? vscode.l10n.t('hunk session ended in {0}', this.name)
						: vscode.l10n.t('hunk session ended'),
				);
			}),
		);
		const repoState = this.diff.getRepo()?.state;
		if (repoState?.onDidChange) {
			this.disposables.push(repoState.onDidChange(() => this.worktreeWatcher.trigger()));
		}
		// Auto-stop on a clean working tree — via a periodic check.
		this.autoStopTimer = setInterval(() => {
			void this.sessionManager.maybeAutoStop().then(() => {
				// Session stopped — don't leave polling running to accumulate errors.
				if (!this.sessionManager.currentSession()) {
					this.sync.stop();
				}
				this.deps.onStateChange();
			});
		}, AUTO_STOP_INTERVAL_MS);
	}

	/** First render and session discovery; call once after construction. */
	async start(): Promise<void> {
		// Resolve stored anchors before the first render: a window reload does not run the watcher, and
		// the diff (hence the candidate lines) is only known once the git extension is up. A failure here
		// must not leave the review without its threads, so it is logged and swallowed.
		try {
			await this.anchors.reanchorAll(await this.diff.getChangedLines());
		} catch (err) {
			console.warn('[hunk-review] failed to re-anchor comments on activation', err);
		}
		if (this.disposed) {
			return;
		}
		// Resolves in the background — comments render with the local fallback icon
		// until the GitHub avatar is known, then pick it up on the next refresh.
		void this.refreshAvatar();
		// The session may have been started earlier (or the terminal session restarted):
		// look for a live one and enable comment polling.
		void this.sessionManager
			.findSession()
			.then((s) => {
				if (s && !this.disposed) {
					this.sync.start(POLL_INTERVAL_MS);
				}
			})
			.catch(() => undefined) // missing hunk is reported when a review is opened
			.finally(() => this.deps.onStateChange());
		await this.refreshDecorations();
	}

	refreshAvatar(): Promise<void> {
		return this.userAvatar.refresh().then(() => this.bridge.refresh());
	}

	refreshThreads(): Promise<void> {
		return this.bridge.refresh();
	}

	/** Called for saves of files in this repository. */
	triggerWorktreeUpdate(): void {
		this.worktreeWatcher.trigger();
	}

	pendingCount(): Promise<number> {
		return this.store.pendingCount();
	}

	async hasStoredComments(): Promise<boolean> {
		const { comments, notes = [] } = await this.store.load();
		return comments.length > 0 || notes.length > 0;
	}

	hasSession(): boolean {
		return this.sessionManager.currentSession() !== undefined;
	}

	async hasChanges(): Promise<boolean> {
		return !(await this.diff.isWorktreeClean());
	}

	// --- session -----------------------------------------------------------------------------

	private serializeSessionOp<T>(op: () => Promise<T>): Promise<T> {
		const run = this.sessionOps.then(op, op);
		this.sessionOps = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async stopSession(): Promise<void> {
		this.sync.stop();
		await this.sessionManager.stopSession(vscode.l10n.t('stopped by user'));
		this.deps.onStateChange();
	}

	connectToSession(): Promise<void> {
		return this.sessionManager.connectToSession();
	}

	// Adding a comment starts the hunk session if it isn't running yet. Runs in the
	// background (the comment is already stored); concurrent adds share one attempt.
	private startSessionInBackground(): void {
		if (this.sessionManager.currentSession() || this.sessionStart) {
			return;
		}
		this.sessionStart = this.serializeSessionOp(async () => {
			try {
				await this.sessionManager.ensureSession();
				this.sync.start(POLL_INTERVAL_MS);
			} catch (err) {
				if (err instanceof HunkNotInstalledError) {
					this.deps.warnHunkNotInstalled();
					return;
				}
				void vscode.window.showWarningMessage(
					vscode.l10n.t(
						'Failed to start hunk session: {0}',
						err instanceof Error ? err.message : String(err),
					),
				);
			}
		}).finally(() => {
			this.sessionStart = undefined;
			this.deps.onStateChange();
		});
	}

	// Files the live session actually holds. `comment apply` refuses anything else ("No diff file
	// matches …") and rejects the whole batch with it, so they are split out before sending.
	private async filesInSession(): Promise<Set<string> | undefined> {
		try {
			const review = await this.cli.sessionReview(this.root);
			return new Set(review.files.map((f) => f.path));
		} catch {
			// Review unavailable (session just restarted): send everything and let hunk judge.
			return undefined;
		}
	}

	async sendComments(): Promise<void> {
		if ((await this.store.pendingCount()) === 0) {
			return;
		}
		const { cli, root, store } = this;
		await this.serializeSessionOp(async () => {
			try {
				// The numbers must be current: hunk validates the batch against its own diff.
				await this.anchors.reanchorAll(await this.diff.getChangedLines());
				const pending = await store.pending();
				if (pending.length === 0) {
					return;
				}
				await this.sessionManager.ensureSession();
				const all = await cli.listSessions();
				const sameRepo = all.filter(
					(s) => fs.realpathSync.native(s.repoRoot) === fs.realpathSync.native(root),
				);
				if (sameRepo.length > 1) {
					void vscode.window.showInformationMessage(
						vscode.l10n.t('Found several hunk sessions in this repository — using the first one.'),
					);
				}
				// A reply whose parent note is gone (session restarted, note deleted) would fail
				// the whole batch — it goes out as a regular comment on its anchor line instead.
				const liveNoteIds =
					pending.some((c) => c.replyTo) && this.deps.repliesSupported()
						? new Set((await cli.listNotes(root)).map((n) => n.noteId))
						: new Set<string>();
				const toItem = (c: StoredComment): ApplyCommentItem =>
					c.replyTo && liveNoteIds.has(c.replyTo)
						? { replyTo: c.replyTo, summary: c.summary, author: REVIEW_AUTHOR }
						: {
							filePath: c.filePath,
							newLine: c.target.newLine,
							oldLine: c.target.oldLine,
							summary: c.summary,
							author: REVIEW_AUTHOR,
						};

				// hunk rejects the whole batch over one anchor it can't place, so the comments it
				// cannot hold are sorted out before sending instead of sinking the rest.
				const { deliverable, skipped } = splitDeliverable(pending, await this.filesInSession());
				for (const c of skipped) {
					await store.update(c.id, { status: 'stale' });
				}

				// Applies one batch and flips the statuses; returns how many hunk accepted.
				const applyBatch = async (items: StoredComment[]): Promise<number> => {
					const result = await cli.applyComments(root, { comments: items.map(toItem) });
					// Guard: the applied count must match the batch size before flipping statuses.
					if (result.applied.length !== items.length) {
						void vscode.window.showErrorMessage(
							vscode.l10n.t(
								'Comment sync error: expected {0} applied, got {1}. Statuses not updated.',
								items.length,
								result.applied.length,
							),
						);
						return 0;
					}
					// The response is correlated back by array index.
					for (let i = 0; i < items.length; i += 1) {
						await store.update(items[i].id, {
							status: 'sent',
							sessionCommentId: result.applied[i]?.commentId,
						});
					}
					return items.length;
				};

				const { sent, failed } = await applyWithFallback(deliverable, applyBatch);
				for (const c of failed) {
					await store.update(c.id, { status: 'stale' });
				}
				const notSent = skipped.length + failed.length;
				if (notSent > 0) {
					void vscode.window.showWarningMessage(
						vscode.l10n.t(
							'{0} comment(s) will not be sent: their lines are not in the hunk session\u2019s diff.',
							notSent,
						),
					);
				}
				void vscode.window.showInformationMessage(
					vscode.l10n.t(
						'Sent {0} comment(s). hunk session is running in the background.',
						sent,
					),
				);
				await this.sync.pollOnce();
				this.sync.start(POLL_INTERVAL_MS); // while the session is alive — poll for agent comments
				await this.bridge.refresh();
			} catch (err) {
				if (err instanceof HunkNotInstalledError) {
					this.deps.warnHunkNotInstalled();
					return;
				}
				await this.markStaleOnApplyFailure();
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
		this.deps.onStateChange();
	}

	// Wipes the review: hunk's session comments first (they are the source of truth for what
	// was sent and what the agent answered), then the local mirror, so nothing reappears on
	// the next poll. Without a live session only the local store is cleared.
	async clearSession(): Promise<void> {
		const { comments, notes = [] } = await this.store.load();
		if (comments.length === 0 && notes.length === 0) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('There are no comments to clear.'),
			);
			return;
		}
		const confirm = vscode.l10n.t('Clear');
		const answer = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'Clear the hunk session: delete {0} stored comment(s) and every comment of the session? This cannot be undone.',
				comments.length,
			),
			{ modal: true },
			confirm,
		);
		if (answer !== confirm) {
			return;
		}
		await this.serializeSessionOp(async () => {
			const live = this.sessionManager.currentSession() !== undefined;
			try {
				if (live) {
					await this.cli.clearComments(this.root);
				}
				await this.store.clear();
				if (live) {
					// Re-read the now empty session so the next poll doesn't report the
					// cleared notes as an incoming change.
					await this.sync.pollOnce();
				}
			} catch (err) {
				if (err instanceof HunkNotInstalledError) {
					this.deps.warnHunkNotInstalled();
					return;
				}
				void vscode.window.showErrorMessage(
					vscode.l10n.t(
						'Failed to clear the hunk session: {0}',
						err instanceof Error ? err.message : String(err),
					),
				);
				return;
			}
			this.deps.onStateChange();
			await this.bridge.refresh();
		});
	}

	// --- worktree ----------------------------------------------------------------------------

	// A commit on the same branch changes HEAD's sha: comments whose lines went into it
	// are moved to the archive. A branch switch also changes the sha, so it is excluded by name.
	private async archiveAfterCommit(changed: ChangedLines): Promise<void> {
		const prev = this.lastHead;
		const head = this.diff.getHead();
		this.lastHead = head;
		if (!prev?.commit || !head?.commit || prev.commit === head.commit || prev.name !== head.name) {
			return;
		}
		const { comments, notes = [] } = await this.store.load();
		const archived = await this.store.archive(
			findOutOfDiffCommentIds(comments, changed),
			head.commit,
			findOutOfDiffNoteIds(notes, changed),
		);
		if (archived > 0) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Archived {0} comment(s) after the commit.', archived),
			);
		}
	}

	// A comment whose line left the working tree diff can never be sent — most often because the
	// change was staged (the index is not part of the review surface), or reverted. Say so instead
	// of letting the comment sit in the store until someone presses Send and nothing happens.
	private async markStaleComments(changed: ChangedLines, notify = true): Promise<void> {
		const stale = findStaleCommentIds(await this.store.pending(), changed);
		for (const id of stale) {
			await this.store.update(id, { status: 'stale' });
		}
		if (notify && stale.length > 0) {
			void vscode.window.showWarningMessage(
				vscode.l10n.t(
					'{0} comment(s) will not be sent: their lines left the working tree diff (staged or reverted).',
					stale.length,
				),
			);
		}
	}

	private async markStaleOnApplyFailure(): Promise<void> {
		if (!this.sessionManager.currentSession()) {
			return;
		}
		try {
			// `session review` only reports new-side hunks — old-side staleness
			// stays undetected here, caught later by the regular diff-based check.
			// Sending reports its own "not sent" warning, so this pass stays quiet.
			await this.markStaleComments(
				{
					newLines: hunksToChangedLines(await this.cli.sessionReview(this.root)),
					oldLines: new Map(),
				},
				false,
			);
		} catch {
			// stale diagnostics unavailable — not critical
		}
	}

	private async refreshDecorations(changed?: ChangedLines): Promise<void> {
		this.decorations.update(changed ?? (await this.diff.getChangedLines()));
	}

	// Live update: saves and git operations lead to recomputing the diff,
	// decorations, marking comments stale, and (if the session is live) reloading hunk's content.
	private async onWorktreeChanged(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const changed = await this.diff.getChangedLines();
		// Anchors move first: archiving and the stale check both decide by line numbers and must see
		// the re-resolved ones. The call never throws, so one store failure cannot cancel them.
		await this.anchors.reanchorAll(changed);
		await this.refreshDecorations(changed);
		await this.archiveAfterCommit(changed);
		// Stale marking runs even for an empty diff: staging every change empties it, and that is
		// exactly when the comments on those lines have to be reported as unsendable.
		await this.markStaleComments(changed);
		// Skip an empty diff for the reload: reloading with no changes disconnects the session
		// from the daemon (observed on 0.21.x); a clean tree is handled by auto-stop.
		if (changed.newLines.size > 0 && this.sessionManager.currentSession()) {
			try {
				await this.cli.reload(this.root);
				await this.sync.pollOnce();
			} catch {
				// reload failure isn't critical — polling and the next send will still work
			}
		}
		this.deps.onStateChange();
		await this.bridge.refresh();
	}

	/** Opens the first changed file in a diff editor; false when there was nothing to open. */
	async openDiff(): Promise<boolean> {
		const repo = this.diff.getRepo();
		if (!repo) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Git repository not found'));
			return false;
		}
		const changed = await this.diff.getChangedLines();
		if (changed.newLines.size === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No uncommitted changes'));
			return false;
		}
		await ensureGitignore(this.hunkDir);
		for (const [file] of changed.newLines) {
			const uri = vscode.Uri.joinPath(repo.rootUri, file);
			await this.diff.openDiffForFile(uri);
			break; // open the first changed file; others are opened by clicking the list
		}
		await this.bridge.refresh();
		await this.refreshDecorations();
		return true;
	}

	// --- comments ----------------------------------------------------------------------------

	async addComment(thread: vscode.CommentThread, text: string | undefined): Promise<void> {
		const summary = (text ?? '').trim();
		if (!summary) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Enter comment text in the thread field and click the button again.'),
			);
			return;
		}
		const file = repoRelative(this.root, thread.uri);
		const line = (thread.range?.start.line ?? 0) + 1;
		// The draft lives on one of the diff editor's two documents. Being `git:`-scheme
		// doesn't make it the original side: a staged change diffs HEAD against the index,
		// which VS Code serves over the same scheme.
		const target =
			this.diff.diffSideOf(thread.uri) === 'old' ? { oldLine: line } : { newLine: line };
		// The commenting ranges may be outdated by now (a save/revert between opening
		// the draft and submitting it): a line outside the diff could never be sent to hunk.
		if (!isLineInDiff(file, target, await this.diff.getChangedLines())) {
			void vscode.window.showWarningMessage(
				vscode.l10n.t(
					'Comments can only be added to lines changed in the working tree — staged changes are not part of the review.',
				),
			);
			thread.dispose();
			return;
		}
		// The content anchor is captured from the file on disk, so the comment can follow its
		// code line later. Blank lines and unreadable files simply go without one.
		const anchor =
			target.newLine === undefined
				? undefined
				: captureAnchor(
						(await this.diff.readWorkingTreeLines(this.deps.rootUri, file)) ?? [],
						line,
						this.deps.anchorContextLines(),
					);
		await this.store.add(file, target, summary, { anchor });
		// Close the draft thread ("Start discussion"), otherwise it stays
		// open next to the thread rebuilt from the store.
		thread.dispose();
		this.deps.onStateChange();
		await this.bridge.refresh();
		void this.refreshDecorations();
		this.startSessionInBackground();
	}

	replyToNote(note: HunkComment): void {
		const thread = note.parent;
		if (!note.noteId || !thread) {
			return;
		}
		// One draft per thread: a second click just keeps the open one.
		if ((thread.comments as HunkComment[]).some((c) => c.contextValue === 'replyDraft')) {
			return;
		}
		const draft: HunkComment = {
			body: '',
			author: { name: vscode.l10n.t('You'), iconPath: this.userAvatar.uri() },
			mode: vscode.CommentMode.Editing,
			contextValue: 'replyDraft',
			replyTo: note.noteId,
			parent: thread,
		};
		thread.comments = [...thread.comments, draft];
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
	}

	async saveComment(comment: HunkComment): Promise<void> {
		if (comment.contextValue === 'replyDraft') {
			await this.saveReplyDraft(comment);
			return;
		}
		const id = comment.storeId;
		if (!id) {
			return;
		}
		const summary = commentText(comment);
		if (!summary) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Comment cannot be empty.'));
			return;
		}
		await this.store.update(id, { summary });
		exitEditingMode(comment);
		await this.bridge.refresh();
	}

	async cancelEditComment(comment: HunkComment): Promise<void> {
		if (comment.contextValue === 'replyDraft') {
			removeReplyDraft(comment);
			return;
		}
		// Store wasn't touched — exiting Editing mode locally and refreshing
		// rebuilds this comment from the store, discarding the in-progress edit.
		exitEditingMode(comment);
		await this.bridge.refresh();
	}

	async deleteComment(comment: HunkComment): Promise<void> {
		const id = comment.storeId;
		if (!id) {
			return;
		}
		await this.store.remove(id);
		this.deps.onStateChange();
		await this.bridge.refresh();
		void this.refreshDecorations();
	}

	// The reply inherits its parent note's anchor in hunk, so unlike a new comment
	// it skips the changed-lines check; the stored line only places it in the thread.
	private async saveReplyDraft(draft: HunkComment): Promise<void> {
		const summary = commentText(draft);
		if (!summary) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Comment cannot be empty.'));
			return;
		}
		const anchor = draft.parent ? this.bridge.threadAnchor(draft.parent) : undefined;
		if (!anchor || !draft.replyTo) {
			return;
		}
		await this.store.add(
			anchor.file,
			anchor.side === 'old' ? { oldLine: anchor.line } : { newLine: anchor.line },
			summary,
			{ replyTo: draft.replyTo },
		);
		removeReplyDraft(draft);
		this.deps.onStateChange();
		await this.bridge.refresh();
		this.startSessionInBackground();
	}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.autoStopTimer);
		this.worktreeWatcher.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.sync.dispose();
		this.sessionManager.dispose();
		this.decorations.dispose();
		this.bridge.disposeThreads();
		this.bridge.dispose();
	}
}

function commentText(comment: vscode.Comment): string {
	return (typeof comment.body === 'string' ? comment.body : comment.body.value).trim();
}

// Flips one comment back out of the native editing textarea locally. Needed because
// CommentBridge.refresh() preserves whatever is still flagged 'editing' across
// background refreshes (see commentBridge.ts) — without this, Save/Cancel would leave
// the comment stuck in Editing mode forever, and its edit/delete menu (gated on
// contextValue === 'pending') would never come back.
function exitEditingMode(comment: HunkComment): void {
	const thread = comment.parent;
	if (!comment.storeId || !thread) {
		return;
	}
	thread.comments = thread.comments.map((c) =>
		c === comment
			? ({ ...c, mode: vscode.CommentMode.Preview, contextValue: 'pending' } as HunkComment)
			: c,
	);
}

function removeReplyDraft(draft: HunkComment): void {
	const thread = draft.parent;
	if (thread) {
		thread.comments = thread.comments.filter((c) => c !== draft);
	}
}
