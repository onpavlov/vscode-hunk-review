import * as vscode from 'vscode';
import type { HunkNote, StoredComment } from './types.js';
import type { CommentStore } from './commentStore.js';
import type { ChangedLines } from './diffService.js';

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
	// Сторона включена в ключ: строка N в старой и в новой версии файла — разные якоря.
	const keyOf = (file: string, side: 'old' | 'new', line: number) => `${file}:${side}:${line}`;
	// Эхо: наши же комментарии возвращаются из comment list как notes.
	// Фильтруем по sessionCommentId и по (файл, строка, текст) на случай дрейфа id.
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

	// Агентские заметки всегда приходят с newRange — привязаны к новой стороне диффа.
	const notePos = new Map(
		notes.map((n) => [n.noteId, { file: n.filePath, line: n.newRange?.[0] ?? 1 }]),
	);
	for (const n of notes) {
		// Ответы агента (parentId) клеятся к треду родительской заметки.
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

	return [...threads.values()];
}

/** Comment with an attached storeId/parent so edit/delete/save commands can identify and mutate it. */
export interface HunkComment extends vscode.Comment {
	storeId?: string;
	contextValue?: 'pending' | 'stale' | 'editing';
	/** back-reference to the owning thread, filled in right after creation */
	parent?: vscode.CommentThread;
}

export class CommentBridge {
	private controller?: vscode.CommentController;
	private extensionUri?: vscode.Uri;
	private threadByKey = new Map<string, vscode.CommentThread>();
	// Очередь рефрешей: конкурентные вызовы (sendComments + onDidChange)
	// без сериализации создают дубли тредов — осиротевшие копии остаются в UI.
	private refreshChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly store: CommentStore,
		private readonly syncNotes: () => Promise<HunkNote[]>,
		private readonly getChangedLines: () => Promise<ChangedLines>,
		/** URI дореволюционной (HEAD) версии файла — где живут удалённые строки. */
		private readonly originalUri: (file: string) => vscode.Uri,
	) {}

	activate(context: vscode.ExtensionContext): void {
		this.extensionUri = context.extensionUri;
		this.controller = vscode.comments.createCommentController(
			'hunk-review.comments',
			'Hunk Review',
		);
		this.controller.options = {
			prompt: vscode.l10n.t('Type the text and run "hunk: Add Comment"'),
			placeHolder: vscode.l10n.t('The comment text will be sent to the hunk session'),
		};

		// Provide commenting ranges only on lines that were actually changed.
		// Falls back to the whole file if the diff map has no entry for it.
		// The diff editor's original (HEAD) document — `git:`-scheme — carries
		// the deleted lines, so it needs the old-side ranges, not the new-side ones.
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: async (document) => {
				const changedLines = await this.getChangedLines();
				const rel = relPath(document.uri);
				const isOriginalSide = document.uri.scheme === 'git';
				const ranges = (isOriginalSide ? changedLines.oldLines : changedLines.newLines).get(rel);
				if (!ranges || ranges.length === 0) {
					// Fallback: allow the whole file.
					const last = document.lineCount - 1;
					return [new vscode.Range(0, 0, last, Number.MAX_SAFE_INTEGER)];
				}
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

		for (const d of descriptors) {
			seenKeys.add(d.threadKey);
			const uri =
				d.side === 'old'
					? this.originalUri(d.file)
					: vscode.Uri.joinPath(workspaceRoot(), d.file);
			const range = new vscode.Range(d.start - 1, 0, d.end - 1, Number.MAX_SAFE_INTEGER);
			const comments = d.comments.map(
				(c): HunkComment => ({
					// Markdown, чтобы ответы агента сохраняли форматирование (**жирный**, `код`, списки) —
					// строкой это превращалось в сырые звёздочки и обратные кавычки.
					body: new vscode.MarkdownString(c.body),
					author: { name: c.author, iconPath: this.avatarUri(c.avatar) },
					label: c.label,
					timestamp: c.timestamp,
					// All comments start as plain rows (Preview); editComment switches
					// one comment into Editing on demand (see extension.ts).
					mode: vscode.CommentMode.Preview,
					storeId: c.storeId,
					contextValue: c.contextValue,
				}),
			);

			const existing = this.threadByKey.get(d.threadKey);
			if (existing) {
				// Update the same thread object in place. Disposing and recreating it
				// (or reassigning collapsibleState) resets whatever expand/collapse
				// state the user set by hand in the UI, since VS Code only consults
				// collapsibleState when the thread is first created.
				existing.range = range;
				// Comments currently open in the native editing textarea keep their exact
				// object (unsaved input and Editing mode intact) instead of being replaced —
				// background refreshes (polling, other threads' saves) used to blow away
				// an in-progress edit out from under the user.
				const editingByStoreId = new Map(
					(existing.comments as HunkComment[])
						.filter((c) => c.contextValue === 'editing')
						.map((c) => [c.storeId, c] as const),
				);
				existing.comments = comments.map((c) => {
					const editing = c.storeId ? editingByStoreId.get(c.storeId) : undefined;
					return editing ?? (({ ...c, parent: existing }) as HunkComment);
				});
				continue;
			}

			const thread = this.controller.createCommentThread(uri, range, comments);
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
