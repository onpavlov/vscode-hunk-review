import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommentStore, ensureGitignore } from '../commentStore.js';

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-review-store-'));
}

suite('CommentStore', () => {
	test('add persists comment with pending status and reloads', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const c = await store.add('src/a.ts', { newLine: 5 }, 'check this');
		assert.strictEqual(c.status, 'pending');
		assert.strictEqual(c.filePath, 'src/a.ts');

		const store2 = new CommentStore(dir);
		const data = await store2.load();
		assert.strictEqual(data.comments.length, 1);
		assert.strictEqual(data.comments[0].id, c.id);
		assert.strictEqual(data.comments[0].target.newLine, 5);
	});

	test('update changes status and session id', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const c = await store.add('a.ts', { newLine: 1 }, 'x');
		const updated = await store.update(c.id, { status: 'sent', sessionCommentId: 'mcp:9' });
		assert.strictEqual(updated.status, 'sent');
		assert.strictEqual(updated.sessionCommentId, 'mcp:9');
	});

	test('remove deletes comment', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const c = await store.add('a.ts', { oldLine: 3 }, 'x');
		await store.remove(c.id);
		const data = await store.load();
		assert.strictEqual(data.comments.length, 0);
	});

	test('pending returns only pending comments', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const a = await store.add('a.ts', { newLine: 1 }, 'x');
		await store.add('b.ts', { newLine: 2 }, 'y');
		await store.update(a.id, { status: 'sent' });
		const pending = await store.pending();
		assert.strictEqual(pending.length, 1);
		assert.strictEqual(pending[0].filePath, 'b.ts');
	});

	test('archive moves comments to archive.json and keeps the rest active', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const a = await store.add('a.ts', { newLine: 1 }, 'x');
		const b = await store.add('b.ts', { oldLine: 2 }, 'y');
		await store.update(a.id, { status: 'sent', sessionCommentId: 'mcp:1' });

		assert.strictEqual(await store.archive([a.id, 'missing'], 'abc123'), 1);

		const active = await store.load();
		assert.deepStrictEqual(active.comments.map((c) => c.id), [b.id]);
		const archive = await store.loadArchive();
		assert.strictEqual(archive.comments.length, 1);
		assert.strictEqual(archive.comments[0].id, a.id);
		assert.strictEqual(archive.comments[0].status, 'sent');
		assert.strictEqual(archive.comments[0].commit, 'abc123');
		assert.ok(archive.comments[0].archivedAt);
	});

	test('archive appends to an existing archive and is a no-op for unknown ids', async () => {
		const dir = tmpDir();
		const store = new CommentStore(dir);
		const a = await store.add('a.ts', { newLine: 1 }, 'x');
		const b = await store.add('a.ts', { newLine: 2 }, 'y');
		await store.archive([a.id]);
		assert.strictEqual(await store.archive(['nope']), 0);
		await store.archive([b.id]);
		assert.deepStrictEqual(
			(await store.loadArchive()).comments.map((c) => c.id),
			[a.id, b.id],
		);
		assert.strictEqual((await store.load()).comments.length, 0);
	});

	test('rejects target with both newLine and oldLine', async () => {
		const store = new CommentStore(tmpDir());
		await assert.rejects(() => store.add('a.ts', { newLine: 1, oldLine: 2 }, 'x'));
	});

	test('ensureGitignore creates a .gitignore with * inside the given directory', async () => {
		const dir = path.join(tmpDir(), '.hunk-review');
		await ensureGitignore(dir);
		await ensureGitignore(dir);
		const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
		assert.strictEqual(content, '*\n');
	});
});
