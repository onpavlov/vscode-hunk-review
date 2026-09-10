import * as assert from 'node:assert';
import { HunkSync } from '../hunkSync.js';
import type { HunkNote } from '../types.js';

suite('HunkSync', () => {
	test('polls cli and caches notes snapshot', async () => {
		const notes: HunkNote[] = [
			{
				noteId: 'n1',
				source: 'agent',
				filePath: 'a.ts',
				hunkIndex: 0,
				newRange: [2, 2],
				body: 'probe',
				createdAt: '2026-09-10T00:00:00Z',
				editable: false,
			},
		];
		let calls = 0;
		const cli = {
			listNotes: async () => {
				calls += 1;
				return notes;
			},
		};
		const sync = new HunkSync(cli as never, '/tmp/r');
		await sync.pollOnce();
		assert.strictEqual(calls, 1);
		assert.strictEqual(sync.getNotes().length, 1);
		sync.stop();
	});

	test('start schedules polling via setInterval', function () {
		this.timeout(3000);
		let calls = 0;
		const cli = {
			listNotes: async () => {
				calls += 1;
				return [];
			},
		};
		const sync = new HunkSync(cli as never, '/tmp/r');
		sync.start(50);
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				sync.stop();
				assert.ok(calls >= 2, `expected at least 2 polls, got ${calls}`);
				resolve();
			}, 200);
		});
	});
});
