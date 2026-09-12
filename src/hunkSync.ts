import * as vscode from 'vscode';
import type { HunkCli } from './hunkCli.js';
import type { HunkNote } from './types.js';

export interface HunkSyncOptions {
	/** Проверка живости сессии; вызывается только при ошибке полла. */
	isSessionAlive?: () => Promise<boolean>;
	/** Сколько подряд неудачных поллов считать потерей сессии (по умолчанию 2). */
	missedPollsBeforeLoss?: number;
}

const DEFAULT_MISSED_POLLS = 2;

export class HunkSync {
	private timer?: ReturnType<typeof setInterval>;
	private notes: HunkNote[] = [];
	private readonly emitter = new vscode.EventEmitter<HunkNote[]>();
	readonly onDidChange = this.emitter.event;
	private readonly lostEmitter = new vscode.EventEmitter<void>();
	readonly onSessionLost = this.lostEmitter.event;
	private missedPolls = 0;
	private lostReported = false;

	constructor(
		private readonly cli: Pick<HunkCli, 'listNotes'>,
		private readonly repoRoot: string,
		private readonly opts: HunkSyncOptions = {},
	) {}

	start(intervalMs: number): void {
		this.stop();
		this.missedPolls = 0;
		this.lostReported = false;
		this.timer = setInterval(() => {
			void this.pollOnce().catch(() => undefined);
		}, intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	async pollOnce(): Promise<void> {
		let notes: HunkNote[];
		try {
			notes = await this.cli.listNotes(this.repoRoot, 'all');
		} catch {
			await this.handlePollFailure();
			return;
		}
		const changed = JSON.stringify(notes) !== JSON.stringify(this.notes);
		this.notes = notes;
		this.missedPolls = 0;
		if (changed) {
			this.emitter.fire(notes);
		}
	}

	getNotes(): HunkNote[] {
		return this.notes;
	}

	dispose(): void {
		this.stop();
		this.emitter.dispose();
		this.lostEmitter.dispose();
	}

	private async handlePollFailure(): Promise<void> {
		const alive = this.opts.isSessionAlive ? await this.opts.isSessionAlive() : true;
		if (alive) {
			return;
		}
		this.missedPolls += 1;
		const limit = this.opts.missedPollsBeforeLoss ?? DEFAULT_MISSED_POLLS;
		if (this.missedPolls >= limit && !this.lostReported) {
			this.lostReported = true;
			this.lostEmitter.fire();
			this.stop();
		}
	}
}
