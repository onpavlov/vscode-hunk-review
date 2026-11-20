import * as assert from 'node:assert';
import { CommentAnchors } from '../anchors.js';
import type { CommentStore } from '../commentStore.js';
import type { ChangedLines, LineRange } from '../diffService.js';
import type { StoredComment, TextAnchor } from '../types.js';

const FILE = 'src/a.ts';
const WHOLE_FILE: LineRange[] = [{ start: 1, end: 20 }];

function anchor(line: number, text: string, before: string[] = [], after: string[] = []): TextAnchor {
	return { line, text, before, after };
}

function stored(over: Partial<StoredComment> & { id: string }): StoredComment {
	return {
		filePath: FILE,
		target: { newLine: 2 },
		summary: `note ${over.id}`,
		status: 'pending',
		createdAt: '2026-11-20T00:00:00Z',
		...over,
	};
}

interface FakeStore {
	store: CommentStore;
	updates: Array<{ id: string; line: number }>;
	writeCalls: number;
}

function fakeStore(comments: StoredComment[], options: { failWrite?: boolean } = {}): FakeStore {
	const fake: FakeStore = { store: undefined as unknown as CommentStore, updates: [], writeCalls: 0 };
	fake.store = {
		load: async () => ({ version: 1 as const, comments, notes: [] }),
		reanchor: async (updates: Array<{ id: string; line: number }>) => {
			fake.writeCalls += 1;
			if (options.failWrite) {
				throw new Error('comments.json is read-only');
			}
			fake.updates.push(...updates);
			return updates.length;
		},
	} as unknown as CommentStore;
	return fake;
}

function changed(ranges: LineRange[]): ChangedLines {
	return { newLines: new Map([[FILE, ranges]]), oldLines: new Map() };
}

suite('anchors', () => {
	test('CommentAnchors.reanchorAll: moves a pending comment and reports the change', async () => {
		const comment = stored({ id: 'c1', target: { newLine: 2 }, anchor: anchor(2, 'two', ['one'], ['three']) });
		const fake = fakeStore([comment]);
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'one', 'two', 'three']);

		assert.strictEqual(await anchors.reanchorAll(changed([{ start: 1, end: 4 }])), 1);
		assert.deepStrictEqual(fake.updates, [{ id: 'c1', line: 3 }]);
	});

	test('CommentAnchors.reanchorAll: moves sent and stale comments too', async () => {
		const sent = stored({
			id: 's1',
			status: 'sent',
			sessionCommentId: 'mcp:1',
			target: { newLine: 2 },
			anchor: anchor(2, 'two'),
		});
		// A stale comment whose line is still in the diff: hunk refused to accept it.
		const stale = stored({ id: 'st1', status: 'stale', target: { newLine: 2 }, anchor: anchor(2, 'two') });
		const fake = fakeStore([sent, stale]);
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'one', 'two']);

		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 2);
		assert.deepStrictEqual(fake.updates.map((u) => u.id).sort(), ['s1', 'st1']);
		assert.deepStrictEqual(fake.updates.map((u) => u.line), [3, 3]);
		assert.strictEqual(sent.status, 'sent');
		assert.strictEqual(sent.sessionCommentId, 'mcp:1');
	});

	test('CommentAnchors.reanchorAll: leaves replies on their parent anchor', async () => {
		const reply = stored({ id: 'r1', replyTo: 'mcp:7', target: { newLine: 2 }, anchor: anchor(2, 'two') });
		const fake = fakeStore([reply]);
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'one', 'two']);

		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 0);
		assert.deepStrictEqual(fake.updates, []);
		assert.strictEqual(fake.writeCalls, 0);
	});

	test('CommentAnchors.reanchorAll: leaves a deleted-line comment untouched', async () => {
		const deleted = stored({ id: 'd1', target: { oldLine: 3 }, anchor: anchor(3, 'gone') });
		const fake = fakeStore([deleted]);
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'gone', 'two']);

		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 0);
		assert.deepStrictEqual(fake.updates, []);
	});

	test('CommentAnchors.reanchorAll: leaves a comment without an anchor untouched and writes nothing', async () => {
		const legacy = stored({ id: 'l1', target: { newLine: 2 } });
		const fake = fakeStore([legacy]);
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'one', 'two']);

		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 0);
		assert.deepStrictEqual(fake.updates, []);
		assert.strictEqual(fake.writeCalls, 0);
	});

	test('CommentAnchors.reanchorAll: skips a file it cannot read', async () => {
		const comment = stored({ id: 'c1', target: { newLine: 2 }, anchor: anchor(2, 'two') });
		const fake = fakeStore([comment]);
		const anchors = new CommentAnchors(fake.store, async () => undefined);

		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 0);
		assert.deepStrictEqual(fake.updates, []);
	});

	test('CommentAnchors.reanchorAll: leaves the stored line when no candidate is in the diff', async () => {
		// The commented text was rewritten and the only remaining copy sits outside the diff.
		const comment = stored({ id: 'c1', target: { newLine: 2 }, anchor: anchor(2, 'old') });
		const fake = fakeStore([comment]);
		const anchors = new CommentAnchors(fake.store, async () => ['a', 'new', 'b', 'c', 'old', 'd']);

		assert.strictEqual(await anchors.reanchorAll(changed([{ start: 1, end: 4 }])), 0);
		assert.deepStrictEqual(fake.updates, []);
		assert.strictEqual(fake.writeCalls, 0);
	});

	test('CommentAnchors.reanchorAll: does not throw when the store write fails', async () => {
		const comment = stored({ id: 'c1', target: { newLine: 2 }, anchor: anchor(2, 'two') });
		const fake = fakeStore([comment], { failWrite: true });
		const anchors = new CommentAnchors(fake.store, async () => ['zero', 'one', 'two']);

		await assert.doesNotReject(() => anchors.reanchorAll(changed(WHOLE_FILE)));
		// The failed move is reported as "nothing moved", so the caller can continue.
		assert.strictEqual(await anchors.reanchorAll(changed(WHOLE_FILE)), 0);
	});
});
