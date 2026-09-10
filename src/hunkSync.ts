import * as vscode from 'vscode';
import type { HunkCli } from './hunkCli.js';
import type { HunkNote } from './types.js';

export class HunkSync {
	private timer?: ReturnType<typeof setInterval>;
	private notes: HunkNote[] = [];
	private readonly emitter = new vscode.EventEmitter<HunkNote[]>();
	readonly onDidChange = this.emitter.event;

	constructor(
		private readonly cli: Pick<HunkCli, 'listNotes'>,
		private readonly repoRoot: string,
	) {}

	start(intervalMs: number): void {
		this.stop();
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
		const notes = await this.cli.listNotes(this.repoRoot, 'all');
		const changed = JSON.stringify(notes) !== JSON.stringify(this.notes);
		this.notes = notes;
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
	}
}
