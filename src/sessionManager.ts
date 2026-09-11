import * as vscode from 'vscode';
import type { HunkCli } from './hunkCli.js';
import type { HunkSession } from './types.js';

export interface Toaster {
	info(message: string): void;
	error(message: string): void;
}

export type TerminalFactory = (cwd: string, onDispose: () => void) => vscode.Terminal;

export const vscodeTerminalFactory: TerminalFactory = (cwd, onDispose) => {
	const terminal = vscode.window.createTerminal({
		name: 'hunk review session',
		cwd,
		// Запускаем TUI как процесс терминала; без этого открывается пустой shell
		// и hunk никогда не стартует.
		shellPath: 'hunk',
		shellArgs: ['diff'],
	});
	void onDispose;
	return terminal;
};

const REGISTRATION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

export class SessionManager implements vscode.Disposable {
	private terminal?: vscode.Terminal;
	private session?: HunkSession;

	constructor(
		private readonly cli: HunkCli,
		private readonly repoRoot: string,
		private readonly terminalFactory: TerminalFactory = vscodeTerminalFactory,
		private readonly toaster: Toaster = defaultToaster(),
		private readonly isWorktreeClean: () => Promise<boolean> = async () => false,
	) {}

	currentSession(): HunkSession | undefined {
		return this.session;
	}

	async findSession(): Promise<HunkSession | undefined> {
		const found = await this.cli.findSession(this.repoRoot);
		if (found) {
			this.session = found;
		}
		return found;
	}

	async ensureSession(): Promise<HunkSession> {
		const existing = await this.findSession();
		if (existing) {
			return existing;
		}
		if (await this.isWorktreeClean()) {
			throw new Error('Рабочее дерево чистое — ревьюить нечего');
		}
		this.terminal = this.terminalFactory(this.repoRoot, () => {
			this.session = undefined;
			this.terminal = undefined;
		});
		const registered = await this.waitForRegistration();
		if (!registered) {
			// Терминал мог закрыться сам (крэш TUI) и обнулить this.terminal через onDispose.
			this.terminal?.dispose();
			this.terminal = undefined;
			throw new Error('hunk-сессия не зарегистрировалась за 10 секунд');
		}
		this.session = registered;
		return registered;
	}

	private async waitForRegistration(): Promise<HunkSession | undefined> {
		const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await sleep(POLL_INTERVAL_MS);
			const found = await this.findSession();
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	async stopSession(reason?: string): Promise<void> {
		this.terminal?.dispose();
		this.terminal = undefined;
		this.session = undefined;
		if (reason) {
			this.toaster.info(`hunk-сессия остановлена: ${reason}`);
		}
	}

	async maybeAutoStop(): Promise<void> {
		if (!this.session) {
			return;
		}
		if (await this.isWorktreeClean()) {
			await this.stopSession('изменения закоммичены или отменены');
		}
	}

	showTerminal(): void {
		if (this.terminal) {
			this.terminal.show();
		} else {
			this.toaster.info('Фоновая hunk-сессия не запущена');
		}
	}

	dispose(): void {
		this.terminal?.dispose();
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultToaster(): Toaster {
	return {
		info: (m) => void vscode.window.showInformationMessage(m),
		error: (m) => void vscode.window.showErrorMessage(m),
	};
}
