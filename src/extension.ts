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
import { createDebouncer } from './debounce.js';
import { formatStatusText } from './statusText.js';
import { findStaleCommentIds, hunksToChangedLines } from './staleComments.js';
import type { LineRange } from './diffService.js';

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
	const sync = new HunkSync(cli, root, {
		isSessionAlive: () => cli.findSession(root).then((s) => s !== undefined),
	});
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

	const refreshDecorations = async (changed?: Map<string, LineRange[]>) => {
		decorations.update(changed ?? (await diff.getChangedLines()));
	};

	const hasPending = async () => {
		const n = await store.pendingCount();
		await vscode.commands.executeCommand('setContext', 'hunk-review.hasPending', n > 0);
		const sessionAlive = sessionManager.currentSession() !== undefined;
		statusBar.text = formatStatusText(n, sessionAlive);
		statusBar.tooltip = sessionAlive
			? 'hunk-сессия активна (клик — меню)'
			: 'hunk-сессия не запущена (клик — меню)';
	};

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'hunk-review.menu';
	statusBar.show();

	// Сериализуем операции с сессией: reload из вотчера не должен пересекаться
	// с отправкой комментариев (apply валидирует батч против текущего diff).
	let sessionOps: Promise<unknown> = Promise.resolve();
	const serializeSessionOp = <T>(op: () => Promise<T>): Promise<T> => {
		const run = sessionOps.then(op, op);
		sessionOps = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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
		});
		await hasPending();
	};

	const markStaleComments = async (changed: Map<string, LineRange[]>) => {
		for (const id of findStaleCommentIds(await store.pending(), changed)) {
			await store.update(id, { status: 'stale' });
		}
	};

	const markStaleOnApplyFailure = async (err: unknown) => {
		if (!sessionManager.currentSession()) {
			return;
		}
		try {
			await markStaleComments(hunksToChangedLines(await cli.sessionReview(root)));
		} catch {
			// диагностика stale недоступна — не критично
		}
		void err;
	};

	// Живое обновление: сохранения и git-операции ведут к перерасчёту диффа,
	// декораций, разметке stale и (при живой сессии) reload содержимого hunk.
	// Пустой дифф пропускаем: reload без изменений отключает сессию от демона
	// (проверено на 0.21.x), чистое дерево обрабатывает автостоп.
	const onWorktreeChanged = async () => {
		const changed = await diff.getChangedLines();
		await refreshDecorations(changed);
		if (changed.size > 0) {
			await markStaleComments(changed);
			if (sessionManager.currentSession()) {
				try {
					await cli.reload(root);
					await sync.pollOnce();
				} catch {
					// reload не критичен — поллинг и следующая отправка останутся рабочими
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
		sync.onSessionLost(() => {
			sessionManager.clearSession();
			void hasPending();
			void vscode.window.showInformationMessage('hunk-сессия завершилась');
		}),
		worktreeWatcher,
		vscode.commands.registerCommand('hunk-review.openDiff', openDiff),
		vscode.commands.registerCommand('hunk-review.sendComments', sendComments),
		vscode.commands.registerCommand('hunk-review.stopSession', async () => {
			sync.stop();
			await sessionManager.stopSession('остановлено пользователем');
			await hasPending();
		}),
		vscode.commands.registerCommand('hunk-review.connectToSession', () =>
			sessionManager.connectToSession(),
		),
		vscode.commands.registerCommand('hunk-review.menu', async () => {
			const pendingCount = await store.pendingCount();
			const items: Array<vscode.QuickPickItem & { action: () => Promise<void> | void }> = [
				{ label: '$(git-compare) Открыть ревью', action: () => openDiff() },
				{
					label: `$(comment) Отправить комментарии агенту (${pendingCount})`,
					action: () => sendComments(),
				},
				{ label: '$(plug) Подключиться к сессии', action: () => sessionManager.connectToSession() },
				{
					label: '$(close) Остановить hunk сессию',
					action: async () => {
						sync.stop();
						await sessionManager.stopSession('остановлено пользователем');
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

	// Триггеры живого обновления: сохранения файлов и git-операции
	// (commit/stash/checkout) идут в один дебаунс-обработчик.
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(() => worktreeWatcher.trigger()),
	);
	const repo = diff.getRepo();
	if (repo?.state.onDidChange) {
		context.subscriptions.push(repo.state.onDidChange(() => worktreeWatcher.trigger()));
	}
	// Автостоп при чистом рабочем дереве — периодической проверкой.
	const autoStopTimer = setInterval(() => {
		void sessionManager.maybeAutoStop().then(() => {
			// Сессия остановлена — не оставляем поллинг собирать ошибки.
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
	// Сессия могла быть запущена раньше (или перезапущена сессия терминала):
	// при активации ищем живую сессию и включаем поллинг комментариев.
	void sessionManager.findSession().then((s) => {
		if (s) {
			sync.start(5_000);
		}
	});
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
		vscode.commands.registerCommand('hunk-review.connectToSession', noWorkspace),
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
