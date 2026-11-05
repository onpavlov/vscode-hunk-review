import * as vscode from 'vscode';
import * as path from 'node:path';

export interface LineRange {
	start: number;
	end: number;
}

/** Changed line ranges on both sides of the diff: the new one (working tree) and the old one (HEAD). */
export interface ChangedLines {
	newLines: Map<string, LineRange[]>;
	oldLines: Map<string, LineRange[]>;
	/**
	 * Lines git actually added or removed, without the hunk's context lines. Optional because
	 * callers that only reconcile ranges (e.g. from `session review`) do not have it.
	 */
	highlights?: DiffHighlights;
}

/** Which single lines were added (new side) or removed (old side); hunk context excluded. */
export interface DiffHighlights {
	added: Map<string, number[]>;
	removed: Map<string, number[]>;
}

export interface GitRepositoryLike {
	rootUri: vscode.Uri;
	diff(cached?: boolean): Thenable<string>;
	getConfig(key: string): Thenable<string>;
	state: {
		/** Current branch and commit; absent in test fakes. */
		HEAD?: { name?: string; commit?: string };
		workingTreeChanges: Array<{ uri: vscode.Uri }>;
		indexChanges: Array<{ uri: vscode.Uri }>;
		/**
		 * Untracked files when `git.untrackedChanges` is "separate" (with the default "mixed"
		 * they are in workingTreeChanges). Missing from older git API versions and test fakes.
		 */
		untrackedChanges?: Array<{ uri: vscode.Uri }>;
		/** The real git extension API event carries this; may be absent in test fakes. */
		onDidChange?: vscode.Event<unknown>;
	};
}

export interface GitApiLike {
	repositories: GitRepositoryLike[];
	toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export function getGitApi(): GitApiLike | undefined {
	const ext = vscode.extensions.getExtension<{ getAPI(id: number): GitApiLike }>('vscode.git');
	if (!ext) {
		return undefined;
	}
	return ext.isActive ? ext.exports.getAPI(1) : undefined;
}

export class DiffService {
	constructor(private readonly gitApi: () => GitApiLike | undefined = getGitApi) {}

	getRepo(): GitRepositoryLike | undefined {
		const api = this.gitApi();
		if (!api || api.repositories.length === 0) {
			return undefined;
		}
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			return api.repositories[0];
		}
		return (
			api.repositories.find((r) => r.rootUri.fsPath === workspaceFolder.uri.fsPath) ??
			api.repositories[0]
		);
	}

	getHead(): { name?: string; commit?: string } | undefined {
		const head = this.getRepo()?.state.HEAD;
		return head ? { name: head.name, commit: head.commit } : undefined;
	}

	/** `user.email` from the repo's git config, or undefined if unset/unreadable. */
	async getUserEmail(): Promise<string | undefined> {
		const repo = this.getRepo();
		if (!repo) {
			return undefined;
		}
		try {
			const email = await repo.getConfig('user.email');
			return email || undefined;
		} catch {
			return undefined;
		}
	}

	static parseDiffLines(diffText: string): ChangedLines & { highlights: DiffHighlights } {
		const newLines = new Map<string, LineRange[]>();
		const oldLines = new Map<string, LineRange[]>();
		const highlights: DiffHighlights = { added: new Map(), removed: new Map() };
		let currentFile = '';
		// Counters into the hunk body: where the next context/added/removed line sits on each side.
		let oldLine = 0;
		let newLine = 0;
		let inHunk = false;
		const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
		for (const line of diffText.split('\n')) {
			const diffLine = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			if (diffLine) {
				currentFile = diffLine[2];
				inHunk = false;
				continue;
			}
			const m = hunkRe.exec(line);
			if (m) {
				const oldStart = Number(m[1]);
				const oldCount = m[2] === undefined ? 1 : Number(m[2]);
				const newStart = Number(m[3]);
				const newCount = m[4] === undefined ? 1 : Number(m[4]);
				const newRanges = newLines.get(currentFile) ?? [];
				newRanges.push({ start: newStart, end: newStart + newCount - 1 });
				newLines.set(currentFile, newRanges);
				const oldRanges = oldLines.get(currentFile) ?? [];
				oldRanges.push({ start: oldStart, end: oldStart + oldCount - 1 });
				oldLines.set(currentFile, oldRanges);
				oldLine = oldStart;
				newLine = newStart;
				inHunk = true;
				continue;
			}
			if (!inHunk) {
				continue;
			}
			// Hunk body lines are prefixed with ' ', '+' or '-' ('\\' marks a missing trailing newline).
			if (line.startsWith('+')) {
				appendLine(highlights.added, currentFile, newLine);
				newLine += 1;
			} else if (line.startsWith('-')) {
				appendLine(highlights.removed, currentFile, oldLine);
				oldLine += 1;
			} else if (line.startsWith(' ')) {
				oldLine += 1;
				newLine += 1;
			}
		}
		return { newLines, oldLines, highlights };
	}

	async getChangedLines(): Promise<ChangedLines> {
		const repo = this.getRepo();
		if (!repo) {
			return { newLines: new Map(), oldLines: new Map() };
		}
		const worktree = await repo.diff();
		const staged = await repo.diff(true);
		const { newLines, oldLines, highlights } = DiffService.parseDiffLines(`${worktree}\n${staged}`);
		// `git diff` never lists untracked files, so comments anchored there would
		// have no changed-line range and go stale immediately; treat the whole
		// file as changed for anything git status flags but git diff is silent on.
		await this.addUntrackedFiles(repo, newLines, highlights);
		for (const [file, ranges] of newLines) {
			newLines.set(file, mergeRanges(ranges));
		}
		for (const [file, ranges] of oldLines) {
			oldLines.set(file, mergeRanges(ranges));
		}
		return { newLines, oldLines, highlights };
	}

	private async addUntrackedFiles(
		repo: GitRepositoryLike,
		newLines: Map<string, LineRange[]>,
		highlights: DiffHighlights,
	): Promise<void> {
		for (const { uri } of [...repo.state.workingTreeChanges, ...(repo.state.untrackedChanges ?? [])]) {
			const file = path.relative(repo.rootUri.fsPath, uri.fsPath).split(path.sep).join('/');
			if (newLines.has(file)) {
				continue;
			}
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const lineCount = Buffer.from(bytes).toString('utf8').split('\n').length;
				newLines.set(file, [{ start: 1, end: lineCount }]);
				// Every line of a new file is an addition on the new side.
				highlights.added.set(
					file,
					Array.from({ length: lineCount }, (_, i) => i + 1),
				);
			} catch {
				// file vanished since the status snapshot (renamed/deleted mid-poll) — skip it
			}
		}
	}

	async isWorktreeClean(): Promise<boolean> {
		const repo = this.getRepo();
		if (!repo) {
			return true;
		}
		return (
			repo.state.workingTreeChanges.length === 0 &&
			repo.state.indexChanges.length === 0 &&
			(repo.state.untrackedChanges?.length ?? 0) === 0
		);
	}

	/** URI of the pre-revision (HEAD) version of the file — the same side that opens on the left in the diff editor. */
	getOriginalUri(modifiedUri: vscode.Uri): vscode.Uri {
		const api = this.gitApi();
		if (!api) {
			throw new Error('Git extension is not available');
		}
		return api.toGitUri(modifiedUri, 'HEAD');
	}

	async openDiffForFile(modifiedUri: vscode.Uri): Promise<void> {
		const originalUri = this.getOriginalUri(modifiedUri);
		await vscode.commands.executeCommand(
			'vscode.diff',
			originalUri,
			modifiedUri,
			`hunk review: ${path.basename(modifiedUri.fsPath)}`,
		);
	}
}

/** Collects a line number per file, de-duplicated: the same file appears in both the
 * staged and the working-tree diff, so a line can be listed twice. */
function appendLine(target: Map<string, number[]>, file: string, line: number): void {
	const lines = target.get(file);
	if (!lines) {
		target.set(file, [line]);
		return;
	}
	if (lines.at(-1) !== line) {
		lines.push(line);
	}
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const merged: LineRange[] = [];
	for (const r of sorted) {
		const last = merged[merged.length - 1];
		if (last && r.start <= last.end + 1) {
			last.end = Math.max(last.end, r.end);
		} else {
			merged.push({ ...r });
		}
	}
	return merged;
}
