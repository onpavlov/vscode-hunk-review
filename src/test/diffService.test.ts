import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { DiffService } from '../diffService.js';
import type { GitApiLike, GitRepositoryLike } from '../diffService.js';

function fakeRepo(getConfig: (key: string) => Thenable<string>): GitRepositoryLike {
	return {
		rootUri: vscode.Uri.file('/repo'),
		diff: async () => '',
		getConfig,
		state: { workingTreeChanges: [], indexChanges: [] },
	};
}

suite('DiffService.parseDiffLines', () => {
	test('parses hunk headers into per-file new-line ranges', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -10,3 +10,4 @@ function a() {',
			'@@ -40,1 +42,2 @@',
			'diff --git a/src/b.ts b/src/b.ts',
			'--- a/src/b.ts',
			'+++ b/src/b.ts',
			'@@ -1,1 +1,1 @@',
		].join('\n');
		const { newLines } = DiffService.parseDiffLines(diff);
		const a = newLines.get('src/a.ts');
		assert.deepStrictEqual(a, [
			{ start: 10, end: 13 },
			{ start: 42, end: 43 },
		]);
		const b = newLines.get('src/b.ts');
		assert.deepStrictEqual(b, [{ start: 1, end: 1 }]);
	});

	test('parses hunk headers into per-file old-line ranges', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -10,3 +10,4 @@ function a() {',
			'@@ -40,1 +42,2 @@',
		].join('\n');
		const { oldLines } = DiffService.parseDiffLines(diff);
		assert.deepStrictEqual(oldLines.get('src/a.ts'), [
			{ start: 10, end: 12 },
			{ start: 40, end: 40 },
		]);
	});

	test('parses single-line hunk headers without count', () => {
		const { newLines } = DiffService.parseDiffLines('@@ -5 +5,0 @@');
		assert.deepStrictEqual(newLines.get(''), [{ start: 5, end: 4 }]); // +5,0 → empty range
	});

	test('a pure deletion yields an old-side range but no new-side one', () => {
		const { newLines, oldLines } = DiffService.parseDiffLines('@@ -5,2 +4,0 @@');
		assert.deepStrictEqual(oldLines.get(''), [{ start: 5, end: 6 }]);
		assert.deepStrictEqual(newLines.get(''), [{ start: 4, end: 3 }]); // +4,0 → empty range
	});
});

suite('DiffService.getUserEmail', () => {
	test('returns user.email from the repo config', async () => {
		const repo = fakeRepo(async (key) => (key === 'user.email' ? 'octocat@example.com' : ''));
		const api: GitApiLike = { repositories: [repo], toGitUri: (u) => u };
		const service = new DiffService(() => api);
		assert.strictEqual(await service.getUserEmail(), 'octocat@example.com');
	});

	test('returns undefined when there is no repository', async () => {
		const api: GitApiLike = { repositories: [], toGitUri: (u) => u };
		const service = new DiffService(() => api);
		assert.strictEqual(await service.getUserEmail(), undefined);
	});

	test('returns undefined when the config value is empty', async () => {
		const repo = fakeRepo(async () => '');
		const api: GitApiLike = { repositories: [repo], toGitUri: (u) => u };
		const service = new DiffService(() => api);
		assert.strictEqual(await service.getUserEmail(), undefined);
	});

	test('returns undefined when getConfig rejects (e.g. key unset)', async () => {
		const repo = fakeRepo(async () => {
			throw new Error('no such config key');
		});
		const api: GitApiLike = { repositories: [repo], toGitUri: (u) => u };
		const service = new DiffService(() => api);
		assert.strictEqual(await service.getUserEmail(), undefined);
	});
});
