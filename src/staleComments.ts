import type { LineRange } from './diffService.js';
import type { HunkReviewResult, StoredComment } from './types.js';

/** Приводит hunk-диапазоны из `session review` к карте изменённых строк. */
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
 * Ищет pending-комментарии, чей якорь (файл, строка) больше не попадает
 * ни в один изменённый диапазон диффа. Возвращает их store id.
 */
export function findStaleCommentIds(
	comments: StoredComment[],
	changedLines: Map<string, LineRange[]>,
): string[] {
	const stale: string[] = [];
	for (const c of comments) {
		if (c.status !== 'pending') {
			continue;
		}
		const line = c.target.newLine ?? c.target.oldLine ?? 1;
		const ranges = changedLines.get(c.filePath) ?? [];
		const inDiff = ranges.some((r) => line >= r.start && line <= r.end);
		if (!inDiff) {
			stale.push(c.id);
		}
	}
	return stale;
}
