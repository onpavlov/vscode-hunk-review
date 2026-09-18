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
}

export interface GitRepositoryLike {
	rootUri: vscode.Uri;
	diff(cached?: boolean): Thenable<string>;
	state: {
		workingTreeChanges: Array<{ uri: vscode.Uri }>;
		indexChanges: Array<{ uri: vscode.Uri }>;
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

	static parseDiffLines(diffText: string): ChangedLines {
		const newLines = new Map<string, LineRange[]>();
		const oldLines = new Map<string, LineRange[]>();
		let currentFile = '';
		const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
		for (const line of diffText.split('\n')) {
			const diffLine = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			if (diffLine) {
				currentFile = diffLine[2];
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
			}
		}
		return { newLines, oldLines };
	}

	async getChangedLines(): Promise<ChangedLines> {
		const repo = this.getRepo();
		if (!repo) {
			return { newLines: new Map(), oldLines: new Map() };
		}
		const worktree = await repo.diff();
		const staged = await repo.diff(true);
		const { newLines, oldLines } = DiffService.parseDiffLines(`${worktree}\n${staged}`);
		for (const [file, ranges] of newLines) {
			newLines.set(file, mergeRanges(ranges));
		}
		for (const [file, ranges] of oldLines) {
			oldLines.set(file, mergeRanges(ranges));
		}
		return { newLines, oldLines };
	}

	async isWorktreeClean(): Promise<boolean> {
		const repo = this.getRepo();
		if (!repo) {
			return true;
		}
		return repo.state.workingTreeChanges.length === 0 && repo.state.indexChanges.length === 0;
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
