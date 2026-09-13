import * as vscode from 'vscode';
import type { ChangedLines, LineRange } from './diffService.js';

export function expandRanges(ranges: LineRange[]): number[] {
	return ranges.flatMap((r) => {
		const lines: number[] = [];
		for (let line = r.start; line <= r.end; line += 1) {
			lines.push(line);
		}
		return lines;
	});
}

export function createDecorations(): {
	update(changedLines: ChangedLines): void;
	dispose(): void;
} {
	const reviewed = vscode.window.createTextEditorDecorationType({
		backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentAggregation'),
		isWholeLine: true,
	});

	return {
		update(changedLines) {
			for (const editor of vscode.window.visibleTextEditors) {
				const file = relPath(editor.document.uri);
				// git-scheme = original (HEAD) side of a diff editor, where deleted lines live.
				const isOriginalSide = editor.document.uri.scheme === 'git';
				const ranges = (isOriginalSide ? changedLines.oldLines : changedLines.newLines).get(file) ?? [];
				editor.setDecorations(
					reviewed,
					expandRanges(ranges).map((line) => new vscode.Range(line - 1, 0, line - 1, 0)),
				);
			}
		},
		dispose() {
			reviewed.dispose();
		},
	};
}

function relPath(uri: vscode.Uri): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
