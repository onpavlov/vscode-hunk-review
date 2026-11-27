import * as vscode from 'vscode';
import {
	createHunkCli,
	HunkNotInstalledError,
	isHunkTooOldForReplies,
	REPLY_MIN_VERSION_LABEL,
	supportsReplies,
} from './hunkCli.js';
import { DiffService, getGitApi } from './diffService.js';
import type { GitApiLike, GitRepositoryLike } from './diffService.js';
import type { HunkComment } from './commentBridge.js';
import { DEFAULT_ANCHOR_CONTEXT } from './textAnchor.js';
import { RepoReview } from './repoReview.js';
import { formatStatusText } from './statusText.js';
import { isInsideRoot } from './repoPaths.js';

const INSTALL_COMMAND = 'npm install --global hunkdiff';
const INSTALL_DOCS_URL = 'https://www.hunk.dev/docs/start/install/';

interface ReviewPick extends vscode.QuickPickItem {
	review: RepoReview;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	if (!vscode.workspace.workspaceFolders?.length) {
		// Still register stub commands even if no workspace is open
		// to allow for testing and future workspace opening
		registerStubCommands(context);
		return;
	}

	const cli = createHunkCli();
	// One review per git repository of the window, keyed by repository root. A multi-root workspace
	// (or a folder holding several repositories) gets an independent review for each: its own
	// `.hunk-review` store, its own hunk session, its own comments.
	const reviews = new Map<string, RepoReview>();
	// Resolved from `hunk --version` at activation; stays false (no reply box) until then
	// or when hunk is missing / older than 0.22.
	let repliesSupported = false;

	/** The review a document belongs to: the deepest repository root containing it (nested repos win). */
	const reviewOwning = (uri: vscode.Uri): RepoReview | undefined => {
		let best: RepoReview | undefined;
		for (const review of reviews.values()) {
			if (isInsideRoot(review.root, uri.fsPath) && (!best || review.root.length > best.root.length)) {
				best = review;
			}
		}
		return best;
	};
	const reviewOfComment = (comment: HunkComment | undefined): RepoReview | undefined =>
		comment?.parent ? reviewOwning(comment.parent.uri) : undefined;

	// --- status bar --------------------------------------------------------------------------

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

	const totalPending = async (): Promise<number> => {
		let total = 0;
		for (const review of [...reviews.values()]) {
			total += await review.pendingCount();
		}
		return total;
	};

	// The status bar sums up all repositories: pending comments in any of them, a live session in any.
	const refreshStatus = async () => {
		const n = await totalPending();
		await vscode.commands.executeCommand('setContext', 'hunk-review.hasPending', n > 0);
		const sessionAlive = [...reviews.values()].some((r) => r.hasSession());
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

	// --- hunk CLI hints ----------------------------------------------------------------------

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

	// Once per installed hunk version: the warning would otherwise return on every
	// window reload for someone who can't or won't update right away.
	const TOO_OLD_WARNED_KEY = 'hunk-review.tooOldWarnedVersion';
	const warnHunkTooOld = async (version: string) => {
		if (context.globalState.get<string>(TOO_OLD_WARNED_KEY) === version) {
			return;
		}
		await context.globalState.update(TOO_OLD_WARNED_KEY, version);
		const docs = vscode.l10n.t('Open install docs');
		const pick = await vscode.window.showWarningMessage(
			vscode.l10n.t(
				'hunk {0} is older than {1}: replying to agent notes is unavailable. Update hunk, then reload the window.',
				version,
				REPLY_MIN_VERSION_LABEL,
			),
			docs,
		);
		if (pick === docs) {
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

	// --- comment controller ------------------------------------------------------------------

	// One controller for all repositories (a single "Hunk Review" entry in the Comments panel, and
	// the `commentController == hunk-review.comments` menu conditions keep working). Its range
	// provider hands each document to the review of the repository the document lives in.
	const controller = vscode.comments.createCommentController('hunk-review.comments', 'Hunk Review');
	controller.options = {
		prompt: vscode.l10n.t('Type the text and run "Add Comment"'),
		placeHolder: vscode.l10n.t('The comment text will be sent to the hunk session'),
	};
	controller.commentingRangeProvider = {
		provideCommentingRanges: (document) =>
			reviewOwning(document.uri)?.bridge.provideCommentingRanges(document) ?? [],
	};
	context.subscriptions.push(controller);

	// --- repository registry -----------------------------------------------------------------

	const addRepo = (repo: GitRepositoryLike) => {
		const root = repo.rootUri.fsPath;
		if (reviews.has(root)) {
			return;
		}
		const review: RepoReview = new RepoReview({
			cli,
			rootUri: repo.rootUri,
			diff: new DiffService(getGitApi, root),
			ownsUri: (uri) => reviewOwning(uri) === review,
			controller,
			extensionUri: context.extensionUri,
			repliesSupported: () => repliesSupported,
			anchorContextLines: () =>
				vscode.workspace
					.getConfiguration('hunk-review')
					.get<number>('anchorContextLines', DEFAULT_ANCHOR_CONTEXT),
			warnHunkNotInstalled: () => void warnHunkNotInstalled(),
			isMultiRepo: () => reviews.size > 1,
			onStateChange: () => void refreshStatus(),
		});
		reviews.set(root, review);
		review.start().catch((err) => console.warn('[hunk-review] failed to start the review', err));
		void refreshStatus();
	};

	const removeRepo = (repo: GitRepositoryLike) => {
		const root = repo.rootUri.fsPath;
		reviews.get(root)?.dispose();
		reviews.delete(root);
		void refreshStatus();
	};

	// --- choosing a repository for a command -------------------------------------------------

	/**
	 * The repository a window-level command (status bar, menu) acts on. One candidate is taken as is;
	 * with several, the repository of the file in the active editor wins, otherwise the user picks.
	 */
	const chooseReview = async (candidates: RepoReview[]): Promise<RepoReview | undefined> => {
		if (candidates.length <= 1) {
			return candidates[0];
		}
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		const active = activeUri ? reviewOwning(activeUri) : undefined;
		if (active && candidates.includes(active)) {
			return active;
		}
		const picks: ReviewPick[] = candidates.map((review) => ({
			label: `$(repo) ${review.name}`,
			description: review.root,
			review,
		}));
		const pick = await vscode.window.showQuickPick(picks, {
			placeHolder: vscode.l10n.t('Select a repository'),
		});
		return pick?.review;
	};

	const filterReviews = async (
		predicate: (review: RepoReview) => boolean | Promise<boolean>,
	): Promise<RepoReview[]> => {
		const matching: RepoReview[] = [];
		for (const review of [...reviews.values()]) {
			if (await predicate(review)) {
				matching.push(review);
			}
		}
		return matching;
	};

	// --- window-level commands ---------------------------------------------------------------

	const openDiff = async () => {
		if (reviews.size === 0) {
			void vscode.window.showErrorMessage(vscode.l10n.t('Git repository not found'));
			return;
		}
		const dirty = await filterReviews((r) => r.hasChanges());
		if (dirty.length === 0) {
			void vscode.window.showInformationMessage(vscode.l10n.t('No uncommitted changes'));
			return;
		}
		if ((await (await chooseReview(dirty))?.openDiff()) === true) {
			await checkHunkInstalled();
		}
	};

	// Every repository with pending comments sends them to its own session.
	const sendComments = async () => {
		for (const review of await filterReviews(async (r) => (await r.pendingCount()) > 0)) {
			await review.sendComments();
		}
	};

	// Stop/connect/clear prefer the repositories where there is something to act on.
	const sessionTarget = async () => {
		const live = await filterReviews((r) => r.hasSession());
		return chooseReview(live.length > 0 ? live : [...reviews.values()]);
	};

	const stopSession = async () => (await sessionTarget())?.stopSession();
	const connectToSession = async () => (await sessionTarget())?.connectToSession();
	const clearSession = async () => {
		const withData = await filterReviews((r) => r.hasStoredComments());
		await (await chooseReview(withData.length > 0 ? withData : [...reviews.values()]))?.clearSession();
	};

	context.subscriptions.push(
		statusBar,
		sendStatusBar,
		startStatusBar,
		{
			dispose: () => {
				for (const review of reviews.values()) {
					review.dispose();
				}
				reviews.clear();
			},
		},
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('hunk-review.githubUsername')) {
				for (const review of reviews.values()) {
					void review.refreshAvatar();
				}
			}
		}),
		vscode.authentication.onDidChangeSessions((e) => {
			if (e.provider.id === 'github') {
				for (const review of reviews.values()) {
					void review.refreshAvatar();
				}
			}
		}),
		// Live-update trigger: a save leads to a debounced diff recomputation in the repository
		// the file belongs to (git operations are picked up from each repository's own state events).
		vscode.workspace.onDidSaveTextDocument((doc) => reviewOwning(doc.uri)?.triggerWorktreeUpdate()),
		vscode.commands.registerCommand('hunk-review.openDiff', openDiff),
		vscode.commands.registerCommand('hunk-review.sendComments', sendComments),
		vscode.commands.registerCommand('hunk-review.stopSession', stopSession),
		vscode.commands.registerCommand('hunk-review.connectToSession', connectToSession),
		vscode.commands.registerCommand('hunk-review.clearSession', clearSession),
		vscode.commands.registerCommand('hunk-review.menu', async () => {
			const pendingCount = await totalPending();
			const items: Array<vscode.QuickPickItem & { action: () => Promise<unknown> | void }> = [
				{ label: `$(git-compare) ${vscode.l10n.t('Open review')}`, action: () => openDiff() },
				{
					label: `$(comment) ${vscode.l10n.t('Send comments to agent ({0})', pendingCount)}`,
					action: () => sendComments(),
				},
				{
					label: `$(plug) ${vscode.l10n.t('Connect to session')}`,
					action: () => connectToSession(),
				},
				{
					label: `$(close) ${vscode.l10n.t('Stop hunk session')}`,
					action: () => stopSession(),
				},
				{
					label: `$(trash) ${vscode.l10n.t('Clear hunk session')}`,
					action: () => clearSession(),
				},
			];
			const pick = await vscode.window.showQuickPick(items, { title: 'hunk review' });
			if (pick) {
				await pick.action();
			}
		}),

		// --- comment-level commands: routed to the repository of the comment's document ---------
		vscode.commands.registerCommand('hunk-review.addComment', async (reply) => {
			const { thread, text } = (reply ?? {}) as { thread?: vscode.CommentThread; text?: string };
			if (!thread) {
				return;
			}
			const review = reviewOwning(thread.uri);
			if (!review) {
				thread.dispose();
				return;
			}
			await review.addComment(thread, text);
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
		vscode.commands.registerCommand('hunk-review.replyToNote', (note: HunkComment) =>
			reviewOfComment(note)?.replyToNote(note),
		),
		vscode.commands.registerCommand('hunk-review.saveComment', (comment: HunkComment) =>
			reviewOfComment(comment)?.saveComment(comment),
		),
		vscode.commands.registerCommand('hunk-review.cancelEditComment', (comment: HunkComment) =>
			reviewOfComment(comment)?.cancelEditComment(comment),
		),
		vscode.commands.registerCommand('hunk-review.deleteComment', (comment: HunkComment) =>
			reviewOfComment(comment)?.deleteComment(comment),
		),
	);

	void refreshStatus();

	// Repositories come from the git extension. They are discovered asynchronously, and more can
	// open later (a folder added to the workspace, a submodule), so both the ones already known
	// and the ones announced afterwards get a review. A failure here must not leave the extension
	// without its commands, so it is logged and swallowed.
	try {
		await vscode.extensions.getExtension('vscode.git')?.activate();
		const api: GitApiLike | undefined = getGitApi();
		if (api) {
			for (const repo of api.repositories) {
				addRepo(repo);
			}
			if (api.onDidOpenRepository) {
				context.subscriptions.push(api.onDidOpenRepository(addRepo));
			}
			if (api.onDidCloseRepository) {
				context.subscriptions.push(api.onDidCloseRepository(removeRepo));
			}
		}
	} catch (err) {
		console.warn('[hunk-review] failed to attach to the git extension', err);
	}

	void cli.version().then(
		(v) => {
			repliesSupported = supportsReplies(v);
			if (isHunkTooOldForReplies(v)) {
				void warnHunkTooOld(v);
			}
			return Promise.all([...reviews.values()].map((r) => r.refreshThreads()));
		},
		() => undefined, // missing hunk is reported by checkHunkInstalled when a review opens
	);
}

export function deactivate(): void {
	// Reviews and the comment controller are disposed via context.subscriptions.
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
		vscode.commands.registerCommand('hunk-review.clearSession', noWorkspace),
		vscode.commands.registerCommand('hunk-review.menu', noWorkspace),
		vscode.commands.registerCommand('hunk-review.addComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.editComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.replyToNote', noWorkspace),
		vscode.commands.registerCommand('hunk-review.saveComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.cancelEditComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.deleteComment', noWorkspace),
	);
}
