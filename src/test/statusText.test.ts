import * as assert from 'node:assert';
import { formatStatusText } from '../statusText.js';

suite('formatStatusText', () => {
	test('idle: no session, no pending', () => {
		assert.strictEqual(formatStatusText(0, false), '$(eye) hunk');
	});

	test('pending only', () => {
		assert.strictEqual(formatStatusText(3, false), '$(eye) hunk: 3 pending');
	});

	test('live session only', () => {
		assert.strictEqual(formatStatusText(0, true), '$(eye) hunk • live');
	});

	test('live session with pending', () => {
		assert.strictEqual(formatStatusText(3, true), '$(eye) hunk • live • 3 pending');
	});
});
