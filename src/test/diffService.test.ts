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
		const map = DiffService.parseDiffLines(diff);
		const a = map.get('src/a.ts');
		assert.deepStrictEqual(a, [
			{ start: 10, end: 13 },
			{ start: 42, end: 43 },
		]);
		const b = map.get('src/b.ts');
		assert.deepStrictEqual(b, [{ start: 1, end: 1 }]);
	});

	test('parses single-line hunk headers without count', () => {
		const map = DiffService.parseDiffLines('@@ -5 +5,0 @@');
		assert.deepStrictEqual(map.get(''), [{ start: 5, end: 4 }]); // +5,0 → пустой диапазон
	});
});
