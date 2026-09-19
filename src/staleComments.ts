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
	return comments
		.filter((c) => c.status === 'pending' && !isInDiff(c, changedLines))
		.map((c) => c.id);
}

/**
 * Finds comments of any status whose anchor no longer falls inside the diff —
 * after a commit these are the ones whose lines went into the commit. Returns their store ids.
 */
export function findOutOfDiffCommentIds(
	comments: StoredComment[],
	changedLines: ChangedLines,
): string[] {
	return comments.filter((c) => !isInDiff(c, changedLines)).map((c) => c.id);
}

function isInDiff(c: StoredComment, changedLines: ChangedLines): boolean {
	const isOld = c.target.oldLine !== undefined;
	const line = isOld ? c.target.oldLine! : (c.target.newLine ?? 1);
	const ranges = (isOld ? changedLines.oldLines : changedLines.newLines).get(c.filePath) ?? [];
	return ranges.some((r) => line >= r.start && line <= r.end);
}
