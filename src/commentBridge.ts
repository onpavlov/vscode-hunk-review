import * as vscode from 'vscode';
import type { HunkNote, StoredComment } from './types.js';
import type { CommentStore } from './commentStore.js';
import type { LineRange } from './diffService.js';

export interface ThreadCommentDescriptor {
	author: string;
	body: string;
	/** undefined = pending (editable by user); true = sent/stale; false = editable hunk note (unused) */
	readOnly: boolean;
	/** store id, set only for pending comments owned by the user */
	storeId?: string;
}

export interface ThreadDescriptor {
	file: string;
	start: number;
	end: number;
	threadKey: string;
	comments: ThreadCommentDescriptor[];
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
			author: `you (${c.status})`,
			body: c.summary,
			readOnly: c.status !== 'pending',
			storeId: c.status === 'pending' ? c.id : undefined,
		};
		if (existing) {
			existing.comments.push(descriptor);
		} else {
			threads.set(key, {
				file: c.filePath,
				start: line,
				end: line,
				threadKey: key,
				comments: [descriptor],
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
		const author = n.source === 'agent' ? 'hunk (agent)' : 'hunk (note)';
		const descriptor: ThreadCommentDescriptor = { author, body: n.body, readOnly: true };
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
			});
		}
	}

	return [...threads.values()];
}

/** Comment with an attached storeId so edit/delete commands can identify it. */
interface HunkComment extends vscode.Comment {
	storeId?: string;
}

export class CommentBridge {
	private controller?: vscode.CommentController;
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
						author: { name: c.author },
						// Pending comments are shown as plain rows (Preview), not editing boxes.
						// Sent/stale/notes are also Preview.
						mode: vscode.CommentMode.Preview,
						storeId: c.storeId,
					}),
				),
			);
			thread.canReply = false;
			this.threadByKey.set(d.threadKey, thread);
		}
	}

	dispose(): void {
		this.threadByKey.clear();
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
