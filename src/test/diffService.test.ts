import * as assert from 'node:assert';
import { DiffService } from '../diffService.js';

suite('DiffService.parseDiffLines', () => {
	test('parses hunk headers into per-file new-line ranges', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -10,3 +10,4 @@ function a() {',
			'@@ -40,1 +42,2 @@',
			'diff --git a/src/b.ts b/src/b.ts',
			'--- a/src/b.ts',
			'+++ b/src/b.ts',
			'@@ -1,1 +1,1 @@',
		].join('\n');
		const { newLines } = DiffService.parseDiffLines(diff);
		const a = newLines.get('src/a.ts');
		assert.deepStrictEqual(a, [
			{ start: 10, end: 13 },
			{ start: 42, end: 43 },
		]);
		const b = newLines.get('src/b.ts');
		assert.deepStrictEqual(b, [{ start: 1, end: 1 }]);
	});

	test('parses hunk headers into per-file old-line ranges', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -10,3 +10,4 @@ function a() {',
			'@@ -40,1 +42,2 @@',
		].join('\n');
		const { oldLines } = DiffService.parseDiffLines(diff);
		assert.deepStrictEqual(oldLines.get('src/a.ts'), [
			{ start: 10, end: 12 },
			{ start: 40, end: 40 },
		]);
	});

	test('parses single-line hunk headers without count', () => {
		const { newLines } = DiffService.parseDiffLines('@@ -5 +5,0 @@');
		assert.deepStrictEqual(newLines.get(''), [{ start: 5, end: 4 }]); // +5,0 → empty range
	});

	test('a pure deletion yields an old-side range but no new-side one', () => {
		const { newLines, oldLines } = DiffService.parseDiffLines('@@ -5,2 +4,0 @@');
		assert.deepStrictEqual(oldLines.get(''), [{ start: 5, end: 6 }]);
		assert.deepStrictEqual(newLines.get(''), [{ start: 4, end: 3 }]); // +4,0 → empty range
	});
});
