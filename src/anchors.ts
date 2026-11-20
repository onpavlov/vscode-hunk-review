import type { CommentStore } from './commentStore.js';
import type { ChangedLines, LineRange } from './diffService.js';
import type { StoredComment, TextAnchor } from './types.js';
import { resolveAnchor } from './textAnchor.js';

/** Content of a working-tree file as lines; undefined when the file cannot be read. */
export type ReadLines = (file: string) => Promise<string[] | undefined>;

/** A comment that can be re-anchored: only new-side comments carry a content anchor. */
type AnchoredComment = StoredComment & { anchor: TextAnchor };

function isAnchored(comment: StoredComment): comment is AnchoredComment {
	return comment.anchor !== undefined && comment.replyTo === undefined && comment.target.oldLine === undefined;
}

/**
 * Keeps stored comment anchors in sync with the working tree: re-resolves every comment that has
 * a content anchor and moves it to the line its code lives on now.
 */
export class CommentAnchors {
	constructor(
		private readonly store: CommentStore,
		private readonly readLines: ReadLines,
	) {}

	/**
	 * Re-resolves the anchors of all stored comments and writes the moved ones in one batch.
	 * `changed` is required: a candidate outside the changed lines must never be picked, otherwise a
	 * comment would jump into code the user did not touch. Returns how many comments moved. Never
	 * throws: a failure must not cancel the rest of the worktree update (archive, stale marking, re-render).
	 */
	async reanchorAll(changed: ChangedLines): Promise<number> {
		try {
			const data = await this.store.load();
			const byFile = new Map<string, AnchoredComment[]>();
			for (const comment of data.comments) {
				if (!isAnchored(comment)) {
					continue;
				}
				byFile.set(comment.filePath, [...(byFile.get(comment.filePath) ?? []), comment]);
			}

			const updates: Array<{ id: string; line: number }> = [];
			for (const [file, comments] of byFile) {
				const lines = await this.readLines(file);
				if (!lines) {
					continue; // deleted or unreadable file: the comment keeps its last known line
				}
				const isInDiff = lineFilter(changed.newLines.get(file) ?? []);
				for (const comment of comments) {
					const line = resolveAnchor(lines, comment.anchor, isInDiff);
					if (line !== undefined && line !== comment.target.newLine) {
						updates.push({ id: comment.id, line });
					}
				}
			}

			if (updates.length === 0) {
				return 0;
			}
			return await this.store.reanchor(updates);
		} catch (err) {
			// A store failure must not cancel archive/stale/re-render in the watcher.
			console.warn('[hunk-review] failed to re-anchor comments', err);
			return 0;
		}
	}
}

/** Candidates are restricted to the changed lines: a line outside the diff is never considered. */
function lineFilter(ranges: LineRange[]): (line: number) => boolean {
	return (line) => ranges.some((r) => line >= r.start && line <= r.end);
}
