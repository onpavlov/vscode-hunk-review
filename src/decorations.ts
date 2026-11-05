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

/** Fill and bar colors for one side of the diff. */
interface SideColors {
	fill: string;
	bar: string;
}

/**
 * Fills used on dark and light themes: the diff editor's own line backgrounds are too pale
 * to tell a change from its context. High-contrast themes keep the theme's diff colors,
 * since overriding them could break their contrast guarantees.
 */
const VIVID_COLORS: Record<'dark' | 'light', Record<'added' | 'removed', SideColors>> = {
	dark: {
		added: { fill: 'rgba(63, 185, 80, 0.28)', bar: 'rgba(63, 185, 80, 0.9)' },
		removed: { fill: 'rgba(248, 81, 73, 0.28)', bar: 'rgba(248, 81, 73, 0.9)' },
	},
	light: {
		added: { fill: 'rgba(34, 134, 58, 0.2)', bar: 'rgba(34, 134, 58, 0.85)' },
		removed: { fill: 'rgba(207, 34, 46, 0.18)', bar: 'rgba(207, 34, 46, 0.85)' },
	},
};

export function createDecorations(): {
	update(changedLines: ChangedLines): void;
	dispose(): void;
} {
	let last: ChangedLines | undefined;
	let types = createTypes();

	const apply = () => {
		if (!last) {
			return;
		}
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri;
			// Only diff editors are decorated: in a plain editor the whole-line
			// backgrounds read as unexplained color blocks over the code.
			if (!isShownInDiff(editor)) {
				editor.setDecorations(types.added, []);
				editor.setDecorations(types.removed, []);
				continue;
			}
			const file = relPath(uri);
			// git-scheme = original (HEAD) side of a diff editor, where deleted lines live.
			const isOriginalSide = uri.scheme === 'git';
			const ranges = (isOriginalSide ? last.oldLines : last.newLines).get(file) ?? [];
			const highlights = last.highlights;
			// Added/removed lines only: hunk context stays undecorated, otherwise its grey
			// fill blends with the change highlight and the whole hunk reads as one block.
			const changed = highlights
				? (isOriginalSide ? highlights.removed : highlights.added).get(file) ?? []
				: expandRanges(ranges);
			editor.setDecorations(types.added, isOriginalSide ? [] : toRanges(changed));
			editor.setDecorations(types.removed, isOriginalSide ? toRanges(changed) : []);
		}
	};
	// Decorations belong to an editor instance: re-apply when editors are (re)shown,
	// otherwise they vanish on a tab switch and only come back on the next refresh.
	const onVisible = vscode.window.onDidChangeVisibleTextEditors(apply);
	// Colors are picked for the theme kind, so a theme switch has to rebuild the types.
	const onTheme = vscode.window.onDidChangeActiveColorTheme(() => {
		types.added.dispose();
		types.removed.dispose();
		types = createTypes();
		apply();
	});

	return {
		update(changedLines) {
			last = changedLines;
			apply();
		},
		dispose() {
			onVisible.dispose();
			onTheme.dispose();
			types.added.dispose();
			types.removed.dispose();
		},
	};
}

function createTypes(): {
	added: vscode.TextEditorDecorationType;
	removed: vscode.TextEditorDecorationType;
} {
	const vivid = vividPalette();
	return {
		added: createType(vivid?.added, {
			background: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
			bar: new vscode.ThemeColor('editorGutter.addedBackground'),
			ruler: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		}),
		removed: createType(vivid?.removed, {
			background: new vscode.ThemeColor('diffEditor.removedTextBackground'),
			bar: new vscode.ThemeColor('editorGutter.deletedBackground'),
			ruler: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
		}),
	};
}

/** Vivid fills when the theme has them, otherwise the theme's own diff colors. */
function createType(
	vivid: SideColors | undefined,
	theme: { background: vscode.ThemeColor; bar: vscode.ThemeColor; ruler: vscode.ThemeColor },
): vscode.TextEditorDecorationType {
	return vscode.window.createTextEditorDecorationType({
		backgroundColor: vivid?.fill ?? theme.background,
		borderColor: vivid?.bar ?? theme.bar,
		borderStyle: 'solid',
		borderWidth: '0 0 0 3px',
		overviewRulerColor: theme.ruler,
		isWholeLine: true,
	});
}

/** Palette for the current theme kind, or undefined for themes that keep their own diff colors. */
function vividPalette(): Record<'added' | 'removed', SideColors> | undefined {
	const kind = vscode.window.activeColorTheme.kind;
	if (kind === vscode.ColorThemeKind.Dark) {
		return VIVID_COLORS.dark;
	}
	if (kind === vscode.ColorThemeKind.Light) {
		return VIVID_COLORS.light;
	}
	return undefined;
}

function toRanges(lines: number[]): vscode.Range[] {
	return lines.map((line) => new vscode.Range(line - 1, 0, line - 1, 0));
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
