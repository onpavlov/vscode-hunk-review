import * as assert from 'node:assert';
import { applyWithFallback, splitDeliverable } from '../sendPlan.js';
import type { StoredComment } from '../types.js';

function comment(id: string, filePath: string, replyTo?: string): StoredComment {
	return {
		id,
		filePath,
		target: { newLine: 1 },
		summary: id,
		status: 'pending',
		...(replyTo ? { replyTo } : {}),
		createdAt: '2026-09-10T00:00:00Z',
	};
}

suite('splitDeliverable', () => {
	test('keeps the comments of files the session holds', () => {
		const pending = [comment('c1', 'a.go'), comment('c2', 'b.go')];
		const { deliverable, skipped } = splitDeliverable(pending, new Set(['a.go']));
		assert.deepStrictEqual(deliverable.map((c) => c.id), ['c1']);
		assert.deepStrictEqual(skipped.map((c) => c.id), ['c2']);
	});

	test('a reply is deliverable whatever its file: hunk anchors it to the parent note', () => {
		const pending = [comment('c1', 'staged.go', 'note-1')];
		const { deliverable, skipped } = splitDeliverable(pending, new Set(['other.go']));
		assert.deepStrictEqual(deliverable.map((c) => c.id), ['c1']);
		assert.deepStrictEqual(skipped, []);
	});

	test('filters nothing when the session diff is unknown', () => {
		const pending = [comment('c1', 'a.go'), comment('c2', 'b.go')];
		const { deliverable, skipped } = splitDeliverable(pending, undefined);
		assert.strictEqual(deliverable.length, 2);
		assert.deepStrictEqual(skipped, []);
	});
});

suite('applyWithFallback', () => {
	test('a batch hunk accepts is applied in one call', async () => {
		const batches: number[] = [];
		const pending = [comment('c1', 'a.go'), comment('c2', 'b.go')];
		const result = await applyWithFallback(pending, async (batch) => {
			batches.push(batch.length);
			return batch.length;
		});
		assert.deepStrictEqual(batches, [2]);
		assert.deepStrictEqual(result, { sent: 2, failed: [] });
	});

	test('a refused batch is retried per comment, so one bad anchor does not sink the rest', async () => {
		const pending = [comment('c1', 'a.go'), comment('c2', 'bad.go'), comment('c3', 'c.go')];
		const attempted: string[][] = [];
		const result = await applyWithFallback(pending, async (batch) => {
			attempted.push(batch.map((c) => c.id));
			if (batch.some((c) => c.filePath === 'bad.go')) {
				throw new Error('hunk: No diff file matches bad.go');
			}
			return batch.length;
		});
		assert.deepStrictEqual(attempted, [['c1', 'c2', 'c3'], ['c1'], ['c2'], ['c3']]);
		assert.strictEqual(result.sent, 2);
		assert.deepStrictEqual(result.failed.map((c) => c.id), ['c2']);
	});

	test('reports every comment as failed when hunk refuses them all', async () => {
		const pending = [comment('c1', 'a.go'), comment('c2', 'b.go')];
		const result = await applyWithFallback(pending, async () => {
			throw new Error('session is gone');
		});
		assert.strictEqual(result.sent, 0);
		assert.deepStrictEqual(result.failed.map((c) => c.id), ['c1', 'c2']);
	});
});
