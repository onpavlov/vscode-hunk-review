import * as vscode from 'vscode';
import type { HunkNote, StoredComment } from './types.js';
import type { CommentStore } from './commentStore.js';
import type { LineRange } from './diffService.js';

const STATUS_LABEL: Record<StoredComment['status'], string | undefined> = {
	pending: 'ожидает отправки',
	sent: 'отправлено',
	stale: 'строка изменилась',
};

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
	/** store id, set only for pending comments owned by the user */
	storeId?: string;
	/** menu gate for edit/delete buttons; set only for pending comments owned by the user */
	contextValue?: 'pending';
}

export interface ThreadDescriptor {
	file: string;
	start: number;
	end: number;
	threadKey: string;
	comments: ThreadCommentDescriptor[];
	/** collapse threads that have nothing left to act on, so the diff isn't wall-to-wall boxes */
	collapsed: boolean;
}

export function buildThreadDescriptors(
	stored: StoredComment[],
	notes: HunkNote[],
): ThreadDescriptor[] {
	const threads = new Map<string, ThreadDescriptor>();
	const keyOf = (file: string, line: number) => `${file}:${line}`;
	// Эхо: наши же комментарии возвращаются из comment list как notes.
	// Фильтруем по sessionCommentId и по (файл, строка, текст) на случай дрейфа id.
	const ownIds = new Set(
		stored.map((c) => c.sessionCommentId).filter((id): id is string => !!id),
	);
	const ownEcho = new Set(
		stored
			.filter((c) => c.status !== 'pending')
			.map((c) =>
				keyOf(c.filePath, c.target.newLine ?? c.target.oldLine ?? 1) + '|' + c.summary,
			),
	);

	for (const c of stored) {
		const line = c.target.newLine ?? c.target.oldLine ?? 1;
		const key = keyOf(c.filePath, line);
		const existing = threads.get(key);
		const descriptor: ThreadCommentDescriptor = {
			author: 'Вы',
			avatar: 'user',
			label: STATUS_LABEL[c.status],
			body: c.summary,
			timestamp: new Date(c.createdAt),
			readOnly: c.status !== 'pending',
			storeId: c.status === 'pending' ? c.id : undefined,
			contextValue: c.status === 'pending' ? 'pending' : undefined,
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
			});
		}
	}

	const notePos = new Map(
		notes.map((n) => [n.noteId, { file: n.filePath, line: n.newRange?.[0] ?? 1 }]),
	);
	for (const n of notes) {
		// Ответы агента (parentId) клеятся к треду родительской заметки.
		const anchor = n.parentId ? (notePos.get(n.parentId) ?? null) : null;
		const file = anchor?.file ?? n.filePath;
		const line = anchor?.line ?? n.newRange?.[0] ?? 1;
		if (ownIds.has(n.noteId) || ownEcho.has(keyOf(file, line) + '|' + n.body)) {
			continue;
		}
		const key = keyOf(file, line);
		const descriptor: ThreadCommentDescriptor = {
			author: 'hunk',
			avatar: 'agent',
			label: n.source === 'agent' ? undefined : 'заметка',
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
			});
		}
	}

	return [...threads.values()];
}

/** Comment with an attached storeId/parent so edit/delete/save commands can identify and mutate it. */
export interface HunkComment extends vscode.Comment {
	storeId?: string;
	contextValue?: 'pending' | 'editing';
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
		private readonly getChangedLines: () => Promise<Map<string, LineRange[]>>,
	) {}

	activate(context: vscode.ExtensionContext): void {
		this.extensionUri = context.extensionUri;
		this.controller = vscode.comments.createCommentController(
			'hunk-review.comments',
			'Hunk Review',
		);
		this.controller.options = {
			prompt: 'Введите текст и нажмите «hunk: Добавить комментарий»',
			placeHolder: 'Текст комментария уйдёт в hunk-сессию',
		};

		// Provide commenting ranges only on lines that were actually changed.
		// Falls back to the whole file if the diff map has no entry for it.
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: async (document) => {
				const changedLines = await this.getChangedLines();
				const rel = relPath(document.uri);
				const ranges = changedLines.get(rel);
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
		for (const thread of this.threadByKey.values()) {
			thread.dispose();
		}
		this.threadByKey.clear();

		const storeData = await this.store.load();
		const notes = await this.syncNotes();
		const descriptors = buildThreadDescriptors(storeData.comments, notes);

		for (const d of descriptors) {
			const uri = vscode.Uri.joinPath(workspaceRoot(), d.file);
			const thread = this.controller.createCommentThread(
				uri,
				new vscode.Range(d.start - 1, 0, d.end - 1, Number.MAX_SAFE_INTEGER),
				d.comments.map(
					(c): HunkComment => ({
						body: c.body,
						author: { name: c.author, iconPath: this.avatarUri(c.avatar) },
						label: c.label,
						timestamp: c.timestamp,
						// All comments start as plain rows (Preview); editComment switches
						// one comment into Editing on demand (see extension.ts).
						mode: vscode.CommentMode.Preview,
						storeId: c.storeId,
						contextValue: c.contextValue,
					}),
				),
			);
			thread.canReply = false;
			// Threads with nothing left to act on start collapsed, so the diff
			// isn't wall-to-wall boxes for every already-sent or agent comment.
			thread.collapsibleState = d.collapsed
				? vscode.CommentThreadCollapsibleState.Collapsed
				: vscode.CommentThreadCollapsibleState.Expanded;
			// Back-reference so edit/save/cancel commands can locate and mutate
			// their own thread's comments array without a full store-based refresh.
			thread.comments = thread.comments.map((c) => ({ ...c, parent: thread }) as HunkComment);
			this.threadByKey.set(d.threadKey, thread);
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
