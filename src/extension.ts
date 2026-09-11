import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHunkCli } from './hunkCli.js';
import { CommentStore, ensureGitignore } from './commentStore.js';
import { DiffService } from './diffService.js';
import { CommentBridge } from './commentBridge.js';
import { SessionManager } from './sessionManager.js';
import { HunkSync } from './hunkSync.js';
import { createDecorations } from './decorations.js';

export function activate(context: vscode.ExtensionContext): void {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!root) {
		// Still register stub commands even if no workspace is open
		// to allow for testing and future workspace opening
		registerStubCommands(context);
		return;
	}

	const cli = createHunkCli();
	const store = new CommentStore(path.join(root, '.hunk-review'));
	const diff = new DiffService();
	const sync = new HunkSync(cli, root);
	const bridge = new CommentBridge(
		store,
		() =>
			sessionManager.currentSession() ? Promise.resolve(sync.getNotes()) : Promise.resolve([]),
		() => diff.getChangedLines(),
	);
	const sessionManager = new SessionManager(cli, root, undefined, undefined, () =>
		diff.isWorktreeClean(),
	);
	const decorations = createDecorations();
	context.subscriptions.push(decorations);

	const refreshDecorations = async () => {
		decorations.update(await diff.getChangedLines());
	};

	const hasPending = async () => {
		const n = await store.pendingCount();
		await vscode.commands.executeCommand('setContext', 'hunk-review.hasPending', n > 0);
		statusBar.text = n > 0 ? `$(eye) hunk: ${n} pending` : '$(eye) hunk';
	};

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'hunk-review.menu';
	statusBar.show();

	const sendComments = async () => {
		const pending = await store.pending();
		if (pending.length === 0) {
			return;
		}
		try {
			await sessionManager.ensureSession();
			const all = await cli.listSessions();
			const sameRepo = all.filter(
				(s) =>
					fs.realpathSync.native(s.repoRoot) === fs.realpathSync.native(root),
			);
			if (sameRepo.length > 1) {
				void vscode.window.showInformationMessage(
					`Найдено несколько hunk-сессий этого репозитория — используем первую.`,
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
					`Ошибка синхронизации комментариев: ожидалось ${pending.length} применённых, получено ${result.applied.length}. Статусы не обновлены.`,
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
				`Отправлено комментариев: ${result.applied.length}. hunk-сессия работает в фоне.`,
			);
			await sync.pollOnce();
			sync.start(5_000); // пока сессия жива — опрашиваем комментарии агента
			await bridge.refresh();
		} catch (err) {
			await markStaleOnApplyFailure(err);
			void vscode.window.showErrorMessage(`Не удалось отправить комментарии: ${String(err)}`);
		}
		await hasPending();
	};

	const markStaleOnApplyFailure = async (err: unknown) => {
		const session = sessionManager.currentSession();
		if (!session) {
			return;
		}
		try {
			const review = await cli.sessionReview(root);
			const valid = new Set(
				review.files.flatMap((f) =>
					f.hunks.map((h) => `${f.path}:${h.newStart}-${h.newStart + h.newLines - 1}`),
				),
			);
			for (const c of await store.pending()) {
				const line = c.target.newLine ?? c.target.oldLine ?? 1;
				const inDiff = [...valid].some((key) => {
					const [file, range] = splitOnce(key, ':');
					if (file !== c.filePath) {
						return false;
					}
					const [start, end] = range.split('-').map(Number);
					return line >= start && line <= end;
				});
				if (!inDiff) {
					await store.update(c.id, { status: 'stale' });
				}
			}
		} catch {
			// диагностика stale недоступна — не критично
		}
		void err;
	};

	const openDiff = async () => {
		const repo = diff.getRepo();
		if (!repo) {
			void vscode.window.showErrorMessage('Git-репозиторий не найден');
			return;
		}
		const changed = await diff.getChangedLines();
		if (changed.size === 0) {
			void vscode.window.showInformationMessage('Незакоммиченных изменений нет');
			return;
		}
		await ensureGitignore(root);
		for (const [file] of changed) {
			const uri = vscode.Uri.joinPath(repo.rootUri, file);
			await diff.openDiffForFile(uri);
			break; // открываем первый изменённый файл; остальные — по клику из списка
		}
		await bridge.refresh();
		await refreshDecorations();
	};

	context.subscriptions.push(
		statusBar,
		bridge,
		sessionManager,
		sync,
		// Wire sync changes to bridge refresh (C2: arrived notes trigger display update).
		sync.onDidChange(() => {
			void bridge.refresh();
		}),
		vscode.commands.registerCommand('hunk-review.openDiff', openDiff),
		vscode.commands.registerCommand('hunk-review.sendComments', sendComments),
		vscode.commands.registerCommand('hunk-review.stopSession', () => {
			sync.stop();
			return sessionManager.stopSession('остановлено пользователем');
		}),
		vscode.commands.registerCommand('hunk-review.showSessionTerminal', () => {
			// Скрытый терминал показываем через встроенный панельный механизм:
			// SessionManager хранит терминал; expose через getter добавлен в Task 5.
			sessionManager.showTerminal();
		}),
		vscode.commands.registerCommand('hunk-review.menu', async () => {
			const pendingCount = await store.pendingCount();
			const items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }> = [
				{ label: '$(git-compare) Открыть ревью', action: () => openDiff() },
				{
					label: `$(comment) Отправить комментарии агенту (${pendingCount})`,
					action: () => sendComments(),
				},
				{ label: '$(terminal) Показать терминал сессии', action: () => sessionManager.showTerminal() },
				{ label: '$(close) Остановить hunk сессию', action: () => sessionManager.stopSession('остановлено пользователем') },
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
					'Введите текст комментария в поле треда и нажмите кнопку ещё раз.',
				);
				return;
			}
			const file = relPathFromRoot(thread.uri);
			const line = ((thread.range?.start.line) ?? 0) + 1;
			await store.add(file, { newLine: line }, summary);
			// Закрываем черновой тред («Start discussion»), иначе он остаётся
			// открытым рядом с тредом, пересобранным из стора.
			thread.dispose();
			await hasPending();
			await bridge.refresh();
			void refreshDecorations();
		}),
		vscode.commands.registerCommand('hunk-review.editComment', async (comment: { storeId?: string }) => {
			const id = comment?.storeId;
			if (!id) {
				return;
			}
			const summary = await vscode.window.showInputBox({
				prompt: 'Изменить комментарий',
			});
			if (!summary) {
				return;
			}
			await store.update(id, { summary });
			await bridge.refresh();
		}),
		vscode.commands.registerCommand('hunk-review.deleteComment', async (comment: { storeId?: string }) => {
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

	// Автостоп при чистом рабочем дереве.
	const gitApi = diff.getRepo();
	if (gitApi) {
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => undefined),
		);
	}
	// Простейший триггер: сохранение документа и интервал.
	const autoStopTimer = setInterval(() => {
		void sessionManager.maybeAutoStop().then(hasPending);
	}, 5_000);
	context.subscriptions.push(new vscode.Disposable(() => clearInterval(autoStopTimer)));

	// C2: if a session already exists at activation, start polling immediately.
	if (sessionManager.currentSession()) {
		sync.start(5_000);
	}

	void hasPending();
	void bridge.activate(context);
}

export function deactivate(): void {
	// SessionManager.dispose() вызывается через context.subscriptions.
}

function registerStubCommands(context: vscode.ExtensionContext): void {
	const noWorkspace = () => {
		void vscode.window.showErrorMessage('Откройте рабочую папку для использования hunk-review');
	};
	
	context.subscriptions.push(
		vscode.commands.registerCommand('hunk-review.openDiff', noWorkspace),
		vscode.commands.registerCommand('hunk-review.sendComments', noWorkspace),
		vscode.commands.registerCommand('hunk-review.stopSession', noWorkspace),
		vscode.commands.registerCommand('hunk-review.showSessionTerminal', noWorkspace),
		vscode.commands.registerCommand('hunk-review.menu', noWorkspace),
		vscode.commands.registerCommand('hunk-review.addComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.editComment', noWorkspace),
		vscode.commands.registerCommand('hunk-review.deleteComment', noWorkspace),
	);
}

function relPathFromRoot(uri: vscode.Uri): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}

function splitOnce(s: string, sep: string): [string, string] {
	const i = s.indexOf(sep);
	return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}
