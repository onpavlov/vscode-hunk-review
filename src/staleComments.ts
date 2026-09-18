import type { ChangedLines, LineRange } from './diffService.js';
import type { HunkReviewResult, StoredComment } from './types.js';

/** Converts hunk ranges from `session review` into a map of changed lines. */
export function hunksToChangedLines(review: HunkReviewResult): Map<string, LineRange[]> {
	const changed = new Map<string, LineRange[]>();
	for (const f of review.files) {
		if (f.path) {
			changed.set(
				f.path,
				f.hunks.map((h) => ({ start: h.newStart, end: h.newStart + h.newLines - 1 })),
			);
		}
	}
	return changed;
}

/**
 * Finds pending comments whose anchor (file, line) no longer falls
 * inside any changed range of the diff. Returns their store ids.
 * Comments on a deleted line (oldLine) are checked against the old side of the diff,
 * others against the new side.
 */
export function findStaleCommentIds(
	comments: StoredComment[],
	changedLines: ChangedLines,
): string[] {
	const stale: string[] = [];
	for (const c of comments) {
		if (c.status !== 'pending') {
			continue;
		}
		const isOld = c.target.oldLine !== undefined;
		const line = isOld ? c.target.oldLine! : (c.target.newLine ?? 1);
		const ranges = (isOld ? changedLines.oldLines : changedLines.newLines).get(c.filePath) ?? [];
		const inDiff = ranges.some((r) => line >= r.start && line <= r.end);
		if (!inDiff) {
			stale.push(c.id);
		}
	}
	return stale;
}
