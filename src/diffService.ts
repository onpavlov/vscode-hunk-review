import * as vscode from 'vscode';
import * as path from 'node:path';

export interface LineRange {
	start: number;
	end: number;
}

export interface GitRepositoryLike {
	rootUri: vscode.Uri;
	diff(cached?: boolean): Thenable<string>;
	state: {
		workingTreeChanges: Array<{ uri: vscode.Uri }>;
		indexChanges: Array<{ uri: vscode.Uri }>;
		/** Реальный API git-расширения событие несёт; в тестовых фейках может отсутствовать. */
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

	static parseDiffLines(diffText: string): Map<string, LineRange[]> {
		const result = new Map<string, LineRange[]>();
		let currentFile = '';
		const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
		for (const line of diffText.split('\n')) {
			const diffLine = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			if (diffLine) {
				currentFile = diffLine[2];
				continue;
			}
			const m = hunkRe.exec(line);
			if (m) {
				const start = Number(m[1]);
				const count = m[2] === undefined ? 1 : Number(m[2]);
				const ranges = result.get(currentFile) ?? [];
				ranges.push({ start, end: start + count - 1 });
				result.set(currentFile, ranges);
			}
		}
		return result;
	}

	async getChangedLines(): Promise<Map<string, LineRange[]>> {
		const repo = this.getRepo();
		if (!repo) {
			return new Map();
		}
		const worktree = await repo.diff();
		const staged = await repo.diff(true);
		const combined = DiffService.parseDiffLines(`${worktree}\n${staged}`);
		for (const [file, ranges] of combined) {
			combined.set(file, mergeRanges(ranges));
		}
		return combined;
	}

	async isWorktreeClean(): Promise<boolean> {
		const repo = this.getRepo();
		if (!repo) {
			return true;
		}
		return repo.state.workingTreeChanges.length === 0 && repo.state.indexChanges.length === 0;
	}

	async openDiffForFile(modifiedUri: vscode.Uri): Promise<void> {
		const api = this.gitApi();
		if (!api) {
			throw new Error('Git extension is not available');
		}
		const originalUri = api.toGitUri(modifiedUri, 'HEAD');
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
