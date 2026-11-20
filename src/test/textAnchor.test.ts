import * as assert from 'node:assert';
import { captureAnchor, resolveAnchor } from '../textAnchor.js';
import type { TextAnchor } from '../types.js';

function anchorAt(line: number, text: string, before: string[] = [], after: string[] = []): TextAnchor {
	return { line, text, before, after };
}

suite('textAnchor', () => {
	test('captureAnchor: captures the anchor line with the two neighbours above and below', () => {
		const lines = ['import x', '', 'fn main() {', '\tconst y = 1', '}', 'end'];
		assert.deepStrictEqual(captureAnchor(lines, 4), {
			line: 4,
			text: 'const y = 1',
			before: ['fn main() {', ''],
			after: ['}', 'end'],
		});
	});

	test('captureAnchor: captures nothing for a blank line', () => {
		assert.strictEqual(captureAnchor(['a', '  ', 'b'], 2), undefined);
	});

	test('captureAnchor: clamps the context at the start and the end of the file', () => {
		const lines = ['one', 'two', 'three'];
		assert.deepStrictEqual(captureAnchor(lines, 1), {
			line: 1,
			text: 'one',
			before: [],
			after: ['two', 'three'],
		});
		assert.deepStrictEqual(captureAnchor(lines, 3), {
			line: 3,
			text: 'three',
			before: ['two', 'one'],
			after: [],
		});
	});

	test('captureAnchor: respects the configured context size and clamps it to 0…5', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

		assert.deepStrictEqual(captureAnchor(lines, 10, 0), {
			line: 10,
			text: 'line 10',
			before: [],
			after: [],
		});

		const three = captureAnchor(lines, 10, 3);
		assert.deepStrictEqual(three?.before, ['line 9', 'line 8', 'line 7']);
		assert.deepStrictEqual(three?.after, ['line 11', 'line 12', 'line 13']);

		// A value from the settings file can exceed the schema range: it is clamped, not honoured.
		const clamped = captureAnchor(lines, 10, 99);
		assert.strictEqual(clamped?.before.length, 5);
		assert.strictEqual(clamped?.after.length, 5);
	});

	test('resolveAnchor: follows an insertion above the anchor', () => {
		const lines = ['// added', '// added', 'fn main() {', 'const x = 1;', '}'];
		const anchor = anchorAt(2, 'const x = 1;', ['fn main() {'], ['}']);
		assert.strictEqual(resolveAnchor(lines, anchor), 4);
	});

	test('resolveAnchor: follows a deletion above the anchor', () => {
		const lines = ['fn main() {', 'const x = 1;', '}'];
		const anchor = anchorAt(4, 'const x = 1;', ['fn main() {'], ['}']);
		assert.strictEqual(resolveAnchor(lines, anchor), 2);
	});

	test('resolveAnchor: picks the duplicate whose neighbours match, not the first one', () => {
		const lines = ['if a {', 'return nil', '}', 'if b {', 'return nil', '}'];
		const anchor = anchorAt(5, 'return nil', ['if b {'], ['}']);
		assert.strictEqual(resolveAnchor(lines, anchor), 5);
	});

	test('resolveAnchor: picks the nearest candidate when the contexts are equally close', () => {
		const lines = ['x', 'return nil', 'x', 'x', 'return nil', 'x'];
		assert.strictEqual(resolveAnchor(lines, anchorAt(5, 'return nil')), 5);
	});

	test('resolveAnchor: prefers a candidate inside the changed lines over a closer one outside', () => {
		const lines = ['a', 'return nil', 'b', 'c', 'd', 'return nil', 'e'];
		const inDiff = (line: number) => line === 2;
		assert.strictEqual(resolveAnchor(lines, anchorAt(6, 'return nil'), inDiff), 2);
	});

	test('resolveAnchor: keeps the stored line when the only candidate is outside the changed lines', () => {
		const lines = ['a', 'return nil', 'b', 'c', 'd', 'return nil', 'e'];
		const anchor = anchorAt(2, 'return nil');
		const inDiff = (line: number) => line === 4;

		assert.strictEqual(resolveAnchor(lines, anchor, inDiff), undefined);
		assert.strictEqual(resolveAnchor(lines, anchor, inDiff) ?? anchor.line, 2);
	});

	test('resolveAnchor: keeps the stored line when the commented text was rewritten', () => {
		const lines = ['a', 'new', 'b', 'c', 'old', 'd'];
		const anchor = anchorAt(2, 'old');
		const inDiff = (line: number) => line <= 4;

		assert.strictEqual(resolveAnchor(lines, anchor, inDiff), undefined);
		assert.strictEqual(resolveAnchor(lines, anchor, inDiff) ?? anchor.line, 2);
	});
});
