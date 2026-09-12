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

	suite('session liveness', () => {
		function failingCli(calls: { value: number }) {
			return {
				listNotes: async () => {
					calls.value += 1;
					throw new Error('comment list failed');
				},
			};
		}

		test('fires onSessionLost once after repeated failed polls on dead session', async () => {
			let lost = 0;
			const sync = new HunkSync(failingCli({ value: 0 }) as never, '/tmp/r', {
				isSessionAlive: async () => false,
			});
			sync.onSessionLost(() => {
				lost += 1;
			});
			await sync.pollOnce();
			assert.strictEqual(lost, 0, 'first miss must not report loss yet');
			await sync.pollOnce();
			assert.strictEqual(lost, 1, 'second miss must report loss');
			await sync.pollOnce();
			assert.strictEqual(lost, 1, 'loss must be reported only once');
		});

		test('does not report loss while session is alive', async () => {
			let lost = 0;
			const sync = new HunkSync(failingCli({ value: 0 }) as never, '/tmp/r', {
				isSessionAlive: async () => true,
			});
			sync.onSessionLost(() => {
				lost += 1;
			});
			await sync.pollOnce();
			await sync.pollOnce();
			await sync.pollOnce();
			assert.strictEqual(lost, 0);
		});

		test('successful poll resets miss counter', async () => {
			let lost = 0;
			let alive = false;
			let failing = true;
			const cli = {
				listNotes: async () => {
					if (failing) {
						throw new Error('down');
					}
					return [];
				},
			};
			const sync = new HunkSync(cli as never, '/tmp/r', {
				isSessionAlive: async () => alive,
			});
			sync.onSessionLost(() => {
				lost += 1;
			});
			await sync.pollOnce();
			failing = false;
			await sync.pollOnce();
			failing = true;
			alive = false;
			await sync.pollOnce();
			assert.strictEqual(lost, 0, 'counter must reset after a successful poll');
			await sync.pollOnce();
			assert.strictEqual(lost, 1);
		});

		test('stops scheduled polling after reporting loss', function () {
			this.timeout(3000);
			const calls = { value: 0 };
			const sync = new HunkSync(failingCli(calls) as never, '/tmp/r', {
				isSessionAlive: async () => false,
			});
			let lost = 0;
			sync.onSessionLost(() => {
				lost += 1;
			});
			sync.start(20);
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					assert.strictEqual(lost, 1);
					const atLoss = calls.value;
					setTimeout(() => {
						assert.ok(calls.value <= atLoss + 1, `polls continued after loss: ${atLoss} -> ${calls.value}`);
						resolve();
					}, 200);
				}, 300);
			});
		});

		test('start after loss resets the lost flag', async () => {
			let lost = 0;
			const sync = new HunkSync(failingCli({ value: 0 }) as never, '/tmp/r', {
				isSessionAlive: async () => false,
			});
			sync.onSessionLost(() => {
				lost += 1;
			});
			await sync.pollOnce();
			await sync.pollOnce();
			sync.start(60_000);
			await sync.pollOnce();
			await sync.pollOnce();
			assert.strictEqual(lost, 2, 'new lifecycle must be able to report loss again');
		});
	});
});
