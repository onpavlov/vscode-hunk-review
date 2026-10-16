import type { ChangedLines, LineRange } from './diffService.js';
import type { HunkNote, HunkReviewResult, StoredComment } from './types.js';

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
 * others against the new side. Replies are skipped: hunk anchors them to their parent
 * note, which may sit on a context line outside the changed ranges.
 */
export function findStaleCommentIds(
	comments: StoredComment[],
	changedLines: ChangedLines,
): string[] {
	return comments
		.filter((c) => c.status === 'pending' && !c.replyTo && !isInDiff(c, changedLines))
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

/**
 * Cached notes whose anchor line (new side; replies share their parent's) is no longer
 * in the diff — archived together with the comments after a commit. Returns note ids.
 */
export function findOutOfDiffNoteIds(notes: HunkNote[], changedLines: ChangedLines): string[] {
	return notes
		.filter((n) => !isLineInDiff(n.filePath, { newLine: n.newRange?.[0] ?? 1 }, changedLines))
		.map((n) => n.noteId);
}

/**
 * Whether a comment anchor (file + new-side or old-side line) falls inside a changed range.
 * A deleted line (oldLine) is checked against the old side of the diff, others against the new side.
 */
export function isLineInDiff(
	filePath: string,
	target: StoredComment['target'],
	changedLines: ChangedLines,
): boolean {
	const isOld = target.oldLine !== undefined;
	const line = isOld ? target.oldLine! : (target.newLine ?? 1);
	const ranges = (isOld ? changedLines.oldLines : changedLines.newLines).get(filePath) ?? [];
	return ranges.some((r) => line >= r.start && line <= r.end);
}

function isInDiff(c: StoredComment, changedLines: ChangedLines): boolean {
	return isLineInDiff(c.filePath, c.target, changedLines);
}
