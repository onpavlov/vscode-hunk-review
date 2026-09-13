import * as assert from 'node:assert';
import { findStaleCommentIds, hunksToChangedLines } from '../staleComments.js';
import type { HunkReviewResult } from '../types.js';
import type { StoredComment } from '../types.js';
import type { LineRange } from '../diffService.js';

function comment(id: string, filePath: string, line: number, status: StoredComment['status'] = 'pending'): StoredComment {
	return {
		id,
		filePath,
		target: { newLine: line },
		summary: `note ${id}`,
		status,
		createdAt: '2026-09-12T00:00:00Z',
	};
}

function deletedLineComment(id: string, filePath: string, line: number): StoredComment {
	return {
		id,
		filePath,
		target: { oldLine: line },
		summary: `note ${id}`,
		status: 'pending',
		createdAt: '2026-09-12T00:00:00Z',
	};
}

suite('findStaleCommentIds', () => {
	const changed = {
		newLines: new Map<string, LineRange[]>([['a.ts', [{ start: 2, end: 4 }]]]),
		oldLines: new Map<string, LineRange[]>(),
	};

	test('keeps pending comments whose line falls in a changed range', () => {
		const ids = findStaleCommentIds([comment('c1', 'a.ts', 3)], changed);
		assert.deepStrictEqual(ids, []);
	});

	test('marks pending comments outside every changed range stale', () => {
		const ids = findStaleCommentIds([comment('c1', 'a.ts', 10)], changed);
		assert.deepStrictEqual(ids, ['c1']);
	});

	test('marks pending comments in files without changes stale', () => {
		const ids = findStaleCommentIds([comment('c1', 'gone.ts', 2)], changed);
		assert.deepStrictEqual(ids, ['c1']);
	});

	test('never marks sent or stale comments', () => {
		const ids = findStaleCommentIds(
			[comment('s1', 'a.ts', 10, 'sent'), comment('s2', 'a.ts', 10, 'stale')],
			changed,
		);
		assert.deepStrictEqual(ids, []);
	});

	test('several comments: only out-of-range pending ids returned', () => {
		const ids = findStaleCommentIds(
			[
				comment('in', 'a.ts', 2),
				comment('out', 'a.ts', 9),
				comment('other-file', 'b.ts', 1),
			],
			changed,
		);
		assert.deepStrictEqual(ids, ['out', 'other-file']);
	});

	test('deleted-line comment is checked against the old-side ranges, not new', () => {
		const changedWithOld = {
			newLines: new Map<string, LineRange[]>([['a.ts', [{ start: 2, end: 4 }]]]),
			oldLines: new Map<string, LineRange[]>([['a.ts', [{ start: 8, end: 9 }]]]),
		};
		// line 3 is a new-side range, not an old-side one → stale despite matching newLines
		assert.deepStrictEqual(
			findStaleCommentIds([deletedLineComment('c1', 'a.ts', 3)], changedWithOld),
			['c1'],
		);
		// line 8 falls inside the old-side range → kept
		assert.deepStrictEqual(
			findStaleCommentIds([deletedLineComment('c2', 'a.ts', 8)], changedWithOld),
			[],
		);
	});

	suite('hunksToChangedLines', () => {
		test('converts session review hunks to per-file line ranges', () => {
			const review: HunkReviewResult = {
				files: [
					{ path: 'a.ts', hunks: [{ newStart: 10, newLines: 3 }] },
					{ path: 'b.ts', hunks: [{ newStart: 1, newLines: 1 }] },
				],
			};
			const changed = hunksToChangedLines(review);
			assert.deepStrictEqual(changed.get('a.ts'), [{ start: 10, end: 12 }]);
			assert.deepStrictEqual(changed.get('b.ts'), [{ start: 1, end: 1 }]);
		});

		test('empty review yields empty map', () => {
			assert.strictEqual(hunksToChangedLines({ files: [] }).size, 0);
		});
	});
});
