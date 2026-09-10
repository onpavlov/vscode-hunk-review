import * as assert from 'node:assert';
import { expandRanges } from '../decorations.js';

suite('expandRanges', () => {
	test('produces per-line decoration options', () => {
		const options = expandRanges([{ start: 5, end: 7 }]);
		assert.deepStrictEqual(options, [5, 6, 7]);
	});
});
