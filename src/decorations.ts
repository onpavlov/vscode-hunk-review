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

	let last: ChangedLines | undefined;
	const apply = () => {
		if (!last) {
			return;
		}
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri;
			// Only diff editors are decorated: in a plain editor the whole-line
			// background reads as an unexplained grey block over the code.
			if (!isShownInDiff(editor)) {
				editor.setDecorations(reviewed, []);
				continue;
			}
			const file = relPath(uri);
			// git-scheme = original (HEAD) side of a diff editor, where deleted lines live.
			const isOriginalSide = uri.scheme === 'git';
			const ranges = (isOriginalSide ? last.oldLines : last.newLines).get(file) ?? [];
			editor.setDecorations(
				reviewed,
				expandRanges(ranges).map((line) => new vscode.Range(line - 1, 0, line - 1, 0)),
			);
		}
	};
	// Decorations belong to an editor instance: re-apply when editors are (re)shown,
	// otherwise they vanish on a tab switch and only come back on the next refresh.
	const onVisible = vscode.window.onDidChangeVisibleTextEditors(apply);

	return {
		update(changedLines) {
			last = changedLines;
			apply();
		},
		dispose() {
			onVisible.dispose();
			reviewed.dispose();
		},
	};
}

/** Whether this editor is a side of a diff tab (not a plain tab with the same file open). */
function isShownInDiff(editor: vscode.TextEditor): boolean {
	const uri = editor.document.uri.toString();
	const inDiff = (tab: vscode.Tab | undefined) =>
		tab?.input instanceof vscode.TabInputTextDiff &&
		(tab.input.original.toString() === uri || tab.input.modified.toString() === uri);
	// A visible editor is the active tab of its group, so the group's active tab tells
	// a diff side apart from a plain editor showing the same file elsewhere.
	const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === editor.viewColumn);
	if (group) {
		return inDiff(group.activeTab);
	}
	// No view column (e.g. the original side of an inline diff): fall back to any diff tab.
	return vscode.window.tabGroups.all.some((g) => g.tabs.some(inDiff));
}

function relPath(uri: vscode.Uri): string {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	return uri.fsPath.startsWith(root) ? uri.fsPath.slice(root.length + 1) : uri.fsPath;
}
