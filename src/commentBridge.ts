import * as vscode from 'vscode';
import type { HunkNote, StoredComment } from './types.js';
import type { CommentStore } from './commentStore.js';
import type { ChangedLines } from './diffService.js';

/**
 * Re-applies a thread's range to VS Code even when the new range equals the
 * extension host's cached copy. `ExtHostCommentThread.range`'s setter is a no-op
 * in that case, but VS Code's main thread can have silently collapsed the comment
 * glyph to the start of an external edit (the glyph's tracked decoration carries
 * `collapseOnReplaceEdit: true`), so the two sides disagree and a plain
 * `thread.range = range` never restores the anchor. Assigning a different range
 * first makes the second assignment emit an update; both writes are coalesced by
 * the 100 ms debounce in `eventuallyUpdateCommentThread`, so only the real range
 * is sent — no flicker.
 */
function forceThreadRange(thread: vscode.CommentThread, range: vscode.Range): void {
	// (0,0)-(0,0) never equals a real anchor: real ranges end on the
	// MAX_SAFE_INTEGER column, this one ends on column 0.
	thread.range = new vscode.Range(0, 0, 0, 0);
	thread.range = range;
}

function statusLabel(status: StoredComment['status']): string | undefined {
	switch (status) {
		case 'pending':
			return vscode.l10n.t('waiting to send');
		case 'sent':
			return vscode.l10n.t('sent');
		case 'stale':
			return vscode.l10n.t('line changed');
	}
}

export interface ThreadCommentDescriptor {
	author: string;
	/** avatar shown next to the author name */
	avatar: 'user' | 'agent';
	/** short badge next to the author name, e.g. a status or role hint */
	label?: string;
	body: string;
	timestamp: Date;
	/** undefined = pending (editable by user); true = sent/stale; false = editable hunk note (unused) */
	readOnly: boolean;
	/** store id, set for pending/stale comments owned by the user (deletable) */
	storeId?: string;
	/** menu gate: 'pending' shows edit+delete, 'stale' shows delete only; unset (sent) has neither */
	contextValue?: 'pending' | 'stale';
	/** hunk note id, set for notes from the session (agent replies, TUI notes) — what "Reply" answers */
	noteId?: string;
	/** id in hunk's reply tree: note id, or our comment's sessionCommentId (store id until sent) */
	treeId?: string;
	/** treeId of the comment this one answers (hunk `parentId` / our `replyTo`) */
	parentTreeId?: string;
}

export interface ThreadDescriptor {
	file: string;
	start: number;
	end: number;
	threadKey: string;
	comments: ThreadCommentDescriptor[];
	/** collapse threads that have nothing left to act on, so the diff isn't wall-to-wall boxes */
	collapsed: boolean;
	/** 'old' = anchored to a deleted line, rendered on the HEAD (original) side of the diff editor */
	side: 'old' | 'new';
}

export function buildThreadDescriptors(
	stored: StoredComment[],
	notes: HunkNote[],
): ThreadDescriptor[] {
	const threads = new Map<string, ThreadDescriptor>();
	// Side is included in the key: line N in the old and new versions of the file are different anchors.
	const keyOf = (file: string, side: 'old' | 'new', line: number) => `${file}:${side}:${line}`;
	// Echo: our own comments come back from comment list as notes.
	// Filter by sessionCommentId and by (file, line, text) in case the id drifts.
	const ownIds = new Set(
		stored.map((c) => c.sessionCommentId).filter((id): id is string => !!id),
	);
	const ownEcho = new Set(
		stored
			.filter((c) => c.status !== 'pending')
			.map((c) =>
				keyOf(c.filePath, c.target.oldLine !== undefined ? 'old' : 'new', c.target.newLine ?? c.target.oldLine ?? 1) +
				'|' +
				c.summary,
			),
	);

	for (const c of stored) {
		const side: 'old' | 'new' = c.target.oldLine !== undefined ? 'old' : 'new';
		const line = side === 'old' ? c.target.oldLine! : c.target.newLine!;
		const key = keyOf(c.filePath, side, line);
		const existing = threads.get(key);
		const descriptor: ThreadCommentDescriptor = {
			author: vscode.l10n.t('You'),
			avatar: 'user',
			label: statusLabel(c.status),
			body: c.summary,
			timestamp: new Date(c.createdAt),
			readOnly: c.status !== 'pending',
			storeId: c.status !== 'sent' ? c.id : undefined,
			contextValue: c.status === 'pending' || c.status === 'stale' ? c.status : undefined,
			treeId: c.sessionCommentId ?? c.id,
			parentTreeId: c.replyTo,
		};
		if (existing) {
			existing.comments.push(descriptor);
			existing.collapsed &&= descriptor.readOnly;
		} else {
			threads.set(key, {
				file: c.filePath,
				start: line,
				end: line,
				threadKey: key,
				comments: [descriptor],
				collapsed: descriptor.readOnly,
				side,
			});
		}
	}

	// Agent notes always come with newRange — anchored to the new side of the diff.
	const notePos = new Map(
		notes.map((n) => [n.noteId, { file: n.filePath, line: n.newRange?.[0] ?? 1 }]),
	);
	for (const n of notes) {
		// Agent replies (parentId) attach to the parent note's thread.
		const anchor = n.parentId ? (notePos.get(n.parentId) ?? null) : null;
		const file = anchor?.file ?? n.filePath;
		const line = anchor?.line ?? n.newRange?.[0] ?? 1;
		if (ownIds.has(n.noteId) || ownEcho.has(keyOf(file, 'new', line) + '|' + n.body)) {
			continue;
		}
		const key = keyOf(file, 'new', line);
		const isAgent = n.source === 'agent';
		const descriptor: ThreadCommentDescriptor = {
			author: isAgent ? vscode.l10n.t('AI Agent') : 'hunk',
			avatar: 'agent',
			label: isAgent ? undefined : vscode.l10n.t('note'),
			body: n.body,
			timestamp: new Date(n.createdAt),
			readOnly: true,
			noteId: n.noteId,
			treeId: n.noteId,
			parentTreeId: n.parentId,
		};
		const existing = threads.get(key);
		if (existing) {
			existing.comments.push(descriptor);
		} else {
			threads.set(key, {
				file,
				start: line,
				end: n.parentId ? line : (n.newRange?.[1] ?? line),
				threadKey: key,
				comments: [descriptor],
				collapsed: true,
				side: 'new',
			});
		}
	}

	for (const t of threads.values()) {
		t.comments = orderAsReplyTree(t.comments);
	}
	return [...threads.values()];
}

/**
 * VS Code renders a thread as a flat list, so hunk's reply tree is flattened depth-first:
 * every reply follows the comment it answers (siblings chronologically) and gets a
 * "↳ reply to <author>" label. A reply whose parent isn't in this thread counts as a root.
 */
function orderAsReplyTree(comments: ThreadCommentDescriptor[]): ThreadCommentDescriptor[] {
	const byTreeId = new Map(
		comments.filter((c) => c.treeId).map((c) => [c.treeId!, c] as const),
	);
	const parentOf = (c: ThreadCommentDescriptor) => {
		const p = c.parentTreeId ? byTreeId.get(c.parentTreeId) : undefined;
		return p === c ? undefined : p;
	};
	const children = new Map<ThreadCommentDescriptor | undefined, ThreadCommentDescriptor[]>();
	for (const c of comments) {
		const p = parentOf(c);
		children.set(p, [...(children.get(p) ?? []), c]);
	}
	const ordered: ThreadCommentDescriptor[] = [];
	const visit = (parent: ThreadCommentDescriptor | undefined) => {
		const kids = (children.get(parent) ?? []).sort(
			(a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
		);
		for (const c of kids) {
			if (ordered.includes(c)) {
				continue; // malformed parent cycle — never loop
			}
			if (parent) {
				c.label = [vscode.l10n.t('↳ reply to {0}', parent.author), c.label]
					.filter(Boolean)
					.join(' · ');
			}
			ordered.push(c);
			visit(c);
		}
	};
	visit(undefined);
	// Members of a parent cycle are unreachable from the roots — keep them, unlabeled.
	return [...ordered, ...comments.filter((c) => !ordered.includes(c))];
}

/** Where a thread sits: file plus 1-based line on the diff side the thread renders on. */
export interface ThreadAnchor {
	file: string;
	side: 'old' | 'new';
	line: number;
}

/**
 * Comment with an attached storeId/parent so edit/delete/save commands can identify and mutate it.
 * 'note' = hunk note with a Reply button; 'replyDraft' = unsaved reply open in the editing textarea.
 */
export interface HunkComment extends vscode.Comment {
	storeId?: string;
	noteId?: string;
	/** for a 'replyDraft': the note being answered */
	replyTo?: string;
	contextValue?: 'pending' | 'stale' | 'editing' | 'note' | 'replyDraft';
	/** back-reference to the owning thread, filled in right after creation */
	parent?: vscode.CommentThread;
}

export class CommentBridge {
	private controller?: vscode.CommentController;
	private extensionUri?: vscode.Uri;
	private threadByKey = new Map<string, vscode.CommentThread>();
	private anchorByKey = new Map<string, ThreadAnchor>();
	// Refresh queue: concurrent calls (sendComments + onDidChange)
	// without serialization create duplicate threads — orphaned copies linger in the UI.
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: CommentStore,
		private readonly syncNotes: () => Promise<HunkNote[]>,
		private readonly getChangedLines: () => Promise<ChangedLines>,
		/** URI of the original (HEAD) version of the file — where deleted lines live. */
		private readonly originalUri: (file: string) => vscode.Uri,
		/** Cached GitHub avatar for the 'user' role; undefined falls back to the local icon. */
		private readonly resolveUserAvatarUri: () => vscode.Uri | undefined = () => undefined,
		/** Whether the installed hunk accepts `replyTo` (0.22+); gates the Reply button on notes. */
		private readonly repliesSupported: () => boolean = () => false,
	) {}

	/** Anchor of a thread this bridge manages; undefined for a draft ("Start discussion") thread. */
	threadAnchor(thread: vscode.CommentThread): ThreadAnchor | undefined {
		for (const [key, t] of this.threadByKey) {
			if (t === thread) {
				return this.anchorByKey.get(key);
			}
		}
		return undefined;
	}

	activate(context: vscode.ExtensionContext): void {
		this.extensionUri = context.extensionUri;
		this.controller = vscode.comments.createCommentController(
			'hunk-review.comments',
			'Hunk Review',
		);
		this.controller.options = {
			prompt: vscode.l10n.t('Type the text and run "Add Comment"'),
			placeHolder: vscode.l10n.t('The comment text will be sent to the hunk session'),
		};

		// Provide commenting ranges only on lines that were actually changed.
		// A file with no entry in the diff map gets none: hunk only knows files in the
		// diff, so a comment there could never be sent. New files (staged or untracked)
		// are in the map as whole-file ranges, so they stay commentable.
		// The diff editor's original (HEAD) document — `git:`-scheme — carries
		// the deleted lines, so it needs the old-side ranges, not the new-side ones.
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: async (document) => {
				const changedLines = await this.getChangedLines();
				const rel = relPath(document.uri);
				const isOriginalSide = document.uri.scheme === 'git';
				const ranges = (isOriginalSide ? changedLines.oldLines : changedLines.newLines).get(rel) ?? [];
				return ranges.map((r) => new vscode.Range(r.start - 1, 0, r.end - 1, Number.MAX_SAFE_INTEGER));
			},
		};

		context.subscriptions.push(this.controller, { dispose: () => this.dispose() });
	}

	refresh(): Promise<void> {
		const run = this.refreshChain.then(() => this.doRefresh());
		this.refreshChain = run.catch(() => undefined);
		return run;
	}

	private async doRefresh(): Promise<void> {
		if (!this.controller) {
			return;
		}

		const storeData = await this.store.load();
		const notes = await this.syncNotes();
		const descriptors = buildThreadDescriptors(storeData.comments, notes);
		const seenKeys = new Set<string>();

		const repliesSupported = this.repliesSupported();
		this.anchorByKey.clear();
		for (const d of descriptors) {
			seenKeys.add(d.threadKey);
			this.anchorByKey.set(d.threadKey, { file: d.file, side: d.side, line: d.start });
			const uri =
				d.side === 'old'
					? this.originalUri(d.file)
					: vscode.Uri.joinPath(workspaceRoot(), d.file);
			const range = new vscode.Range(d.start - 1, 0, d.end - 1, Number.MAX_SAFE_INTEGER);
			const comments = d.comments.map(
				(c): HunkComment => ({
					// Markdown so agent replies keep formatting (**bold**, `code`, lists) —
					// plain strings turned those into raw asterisks and backticks.
					body: new vscode.MarkdownString(c.body),
					author: { name: c.author, iconPath: this.avatarUri(c.avatar) },
					label: c.label,
					timestamp: c.timestamp,
					// All comments start as plain rows (Preview); editComment switches
					// one comment into Editing on demand (see extension.ts).
					mode: vscode.CommentMode.Preview,
					storeId: c.storeId,
					noteId: c.noteId,
					contextValue: c.noteId && repliesSupported ? 'note' : c.contextValue,
				}),
			);

			const existing = this.threadByKey.get(d.threadKey);
			if (existing) {
				// Update the same thread object in place. Disposing and recreating it
				// (or reassigning collapsibleState) resets whatever expand/collapse
				// state the user set by hand in the UI, since VS Code only consults
				// collapsibleState when the thread is first created.
				forceThreadRange(existing, range);
				// Comments currently open in the native editing textarea keep their exact
				// object (unsaved input and Editing mode intact) instead of being replaced —
				// background refreshes (polling, other threads' saves) used to blow away
				// an in-progress edit out from under the user.
				const editingByStoreId = new Map(
					(existing.comments as HunkComment[])
						.filter((c) => c.contextValue === 'editing')
						.map((c) => [c.storeId, c] as const),
				);
				// An open reply draft has no store entry yet — carry it over as-is, last.
				const drafts = (existing.comments as HunkComment[]).filter(
					(c) => c.contextValue === 'replyDraft',
				);
				existing.comments = [
					...comments.map((c) => {
						const editing = c.storeId ? editingByStoreId.get(c.storeId) : undefined;
						return editing ?? (({ ...c, parent: existing }) as HunkComment);
					}),
					...drafts,
				];
				continue;
			}

			const thread = this.controller.createCommentThread(uri, range, comments);
			// No always-on reply box: replies start from the Reply button on a note.
			thread.canReply = false;
			// Threads with nothing left to act on start collapsed, so the diff
			// isn't wall-to-wall boxes for every already-sent or agent comment.
			// This default only applies once, at creation — see the in-place
			// update branch above for why existing threads skip it.
			thread.collapsibleState = d.collapsed
				? vscode.CommentThreadCollapsibleState.Collapsed
				: vscode.CommentThreadCollapsibleState.Expanded;
			// Back-reference so edit/save/cancel commands can locate and mutate
			// their own thread's comments array without a full store-based refresh.
			thread.comments = thread.comments.map((c) => ({ ...c, parent: thread }) as HunkComment);
			this.threadByKey.set(d.threadKey, thread);
		}

		for (const [key, thread] of this.threadByKey) {
			if (!seenKeys.has(key)) {
				thread.dispose();
				this.threadByKey.delete(key);
			}
		}
	}

	dispose(): void {
		this.threadByKey.clear();
	}

	private avatarUri(avatar: 'user' | 'agent'): vscode.Uri | undefined {
		if (avatar === 'user') {
			const githubAvatar = this.resolveUserAvatarUri();
			if (githubAvatar) {
				return githubAvatar;
			}
		}
		if (!this.extensionUri) {
			return undefined;
		}
		return vscode.Uri.joinPath(this.extensionUri, 'media', `avatar-${avatar}.svg`);
	}
}

function workspaceRoot(): vscode.Uri {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		throw new Error('No workspace folder is open');
	}
	return root;
}

function relPath(uri: vscode.Uri): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
