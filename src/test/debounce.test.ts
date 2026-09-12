import * as assert from 'node:assert';
import { createDebouncer } from '../debounce.js';

suite('createDebouncer', function () {
	this.timeout(3000);

	test('collapses rapid triggers into a single call', () => {
		return new Promise<void>((resolve) => {
			let calls = 0;
			const d = createDebouncer(50, () => {
				calls += 1;
			});
			d.trigger();
			d.trigger();
			d.trigger();
			setTimeout(() => {
				assert.strictEqual(calls, 1);
				resolve();
			}, 200);
		});
	});

	test('fires again for a trigger after the window elapsed', () => {
		return new Promise<void>((resolve) => {
			let calls = 0;
			const d = createDebouncer(50, () => {
				calls += 1;
			});
			d.trigger();
			setTimeout(() => {
				assert.strictEqual(calls, 1);
				d.trigger();
			}, 150);
			setTimeout(() => {
				assert.strictEqual(calls, 2);
				resolve();
			}, 350);
		});
	});

	test('dispose cancels a pending call', () => {
		return new Promise<void>((resolve) => {
			let calls = 0;
			const d = createDebouncer(50, () => {
				calls += 1;
			});
			d.trigger();
			d.dispose();
			setTimeout(() => {
				assert.strictEqual(calls, 0);
				resolve();
			}, 150);
		});
	});
});
