import * as assert from 'node:assert';
import { buildThreadDescriptors } from '../commentBridge.js';
import type { StoredComment, HunkNote } from '../types.js';

function stored(over: Partial<StoredComment>): StoredComment {
	return {
		id: 'c1',
		filePath: 'src/a.ts',
		target: { newLine: 10 },
		summary: 'ours',
		status: 'pending',
		createdAt: '2026-09-10T00:00:00Z',
		...over,
	};
}

suite('buildThreadDescriptors', () => {
	test('our comment and agent note on same line merge into one thread', () => {
		const note: HunkNote = {
			noteId: 'n1',
			source: 'agent',
			filePath: 'src/a.ts',
			hunkIndex: 0,
			newRange: [10, 10],
			body: 'agent reply',
			createdAt: '2026-09-10T00:00:01Z',
			editable: false,
		};
		const desc = buildThreadDescriptors([stored({ status: 'sent' })], [note]);
		assert.strictEqual(desc.length, 1);
		assert.strictEqual(desc[0].comments.length, 2);
		assert.strictEqual(desc[0].comments[0].author, 'You');
		assert.strictEqual(desc[0].comments[0].label, 'sent');
		assert.strictEqual(desc[0].comments[1].author, 'AI Agent');
		assert.strictEqual(desc[0].comments[1].label, undefined);
		assert.strictEqual(desc[0].collapsed, true);
	});

	test('our echoed comment from the session is filtered out', () => {
		const echo: HunkNote = {
			noteId: 'mcp:9',
			source: 'agent',
			filePath: 'src/a.ts',
			hunkIndex: 0,
			newRange: [10, 10],
			body: 'ours',
			createdAt: '2026-09-10T00:00:01Z',
			editable: false,
		};
		const desc = buildThreadDescriptors([stored({ status: 'sent', sessionCommentId: 'mcp:9' })], [echo]);
		assert.strictEqual(desc.length, 1);
		assert.strictEqual(desc[0].comments.length, 1);
		assert.strictEqual(desc[0].comments[0].author, 'You');
	});

	test('agent note without our thread creates read-only thread', () => {
		const note: HunkNote = {
			noteId: 'n2',
			source: 'user',
			filePath: 'src/b.ts',
			hunkIndex: 0,
			newRange: [3, 4],
			body: 'human note',
			createdAt: '2026-09-10T00:00:02Z',
			editable: false,
		};
		const desc = buildThreadDescriptors([], [note]);
		assert.strictEqual(desc.length, 1);
		assert.strictEqual(desc[0].file, 'src/b.ts');
		assert.strictEqual(desc[0].start, 3);
		assert.strictEqual(desc[0].end, 4);
		assert.strictEqual(desc[0].comments[0].readOnly, true);
		assert.strictEqual(desc[0].comments[0].label, 'note');
		assert.strictEqual(desc[0].collapsed, true);
	});

	test('pending and stale comments stay separate read-only rules', () => {
		const desc = buildThreadDescriptors(
			[
				stored({ id: 'p', target: { newLine: 1 }, status: 'pending' }),
				stored({ id: 's', target: { newLine: 2 }, status: 'sent' }),
				stored({ id: 'x', target: { newLine: 3 }, status: 'stale' }),
			],
			[],
		);
		assert.strictEqual(desc.length, 3);
		assert.strictEqual(desc[0].comments[0].readOnly, false);
		assert.strictEqual(desc[1].comments[0].readOnly, true);
		assert.strictEqual(desc[2].comments[0].readOnly, true);
		// A pending thread stays open (it still needs the user's attention);
		// already-sent or stale threads collapse to keep the diff compact.
		assert.strictEqual(desc[0].collapsed, false);
		assert.strictEqual(desc[1].collapsed, true);
		assert.strictEqual(desc[2].collapsed, true);
	});

	test('a comment on a deleted line is tagged with side "old"', () => {
		const desc = buildThreadDescriptors([stored({ target: { oldLine: 7 } })], []);
		assert.strictEqual(desc.length, 1);
		assert.strictEqual(desc[0].side, 'old');
		assert.strictEqual(desc[0].start, 7);
	});

	test('an old-line comment and a new-line comment on the same line number stay separate threads', () => {
		const desc = buildThreadDescriptors(
			[
				stored({ id: 'o', target: { oldLine: 5 } }),
				stored({ id: 'n', target: { newLine: 5 } }),
			],
			[],
		);
		assert.strictEqual(desc.length, 2);
		assert.strictEqual(desc.find((d) => d.comments[0].storeId === 'o')?.side, 'old');
		assert.strictEqual(desc.find((d) => d.comments[0].storeId === 'n')?.side, 'new');
	});

	test('only pending comments get the edit/delete menu gate', () => {
		const desc = buildThreadDescriptors(
			[
				stored({ id: 'p', target: { newLine: 1 }, status: 'pending' }),
				stored({ id: 's', target: { newLine: 2 }, status: 'sent' }),
				stored({ id: 'x', target: { newLine: 3 }, status: 'stale' }),
			],
			[],
		);
		assert.strictEqual(desc[0].comments[0].contextValue, 'pending');
		assert.strictEqual(desc[1].comments[0].contextValue, undefined);
		assert.strictEqual(desc[2].comments[0].contextValue, undefined);
	});
});
