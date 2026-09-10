import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHunkCli, HunkNotInstalledError, HunkCommandError, HunkRunner } from '../hunkCli.js';

suite('HunkCli', () => {
	test('listSessions parses --json output', async () => {
		const stdout = JSON.stringify({
			sessions: [{ sessionId: 's1', pid: 1, cwd: '/tmp/r', repoRoot: '/tmp/r' }],
		});
		const runner: HunkRunner = async (file, args) => {
			assert.ok(args.includes('session') && args.includes('list') && args.includes('--json'));
			return { stdout, stderr: '' };
		};
		const cli = createHunkCli(runner);
		const sessions = await cli.listSessions();
		assert.strictEqual(sessions.length, 1);
		assert.strictEqual(sessions[0].sessionId, 's1');
	});

	test('findSession normalizes macOS /private prefix', async () => {
		const root = fs.realpathSync(os.tmpdir()); // real path of tmpdir
		const stdout = JSON.stringify({
			sessions: [{ sessionId: 's1', pid: 1, cwd: root, repoRoot: path.join(root, 'myrepo') }],
		});
		const cli = createHunkCli(async () => ({ stdout, stderr: '' }));
		const found = await cli.findSession(path.join(root, 'myrepo'));
		assert.strictEqual(found?.sessionId, 's1');
	});

	test('applyComments sends batch via stdin and parses result', async () => {
		let capturedInput = '';
		const runner: HunkRunner = async (_file, args, options) => {
			assert.ok(args.includes('comment') && args.includes('apply') && args.includes('--stdin'));
			capturedInput = options.input ?? '';
			return {
				stdout: JSON.stringify({
					result: { applied: [{ commentId: 'mcp:1:0', filePath: 'a.txt', side: 'new', line: 2 }] },
				}),
				stderr: '',
			};
		};
		const cli = createHunkCli(runner);
		const res = await cli.applyComments('/tmp/r', {
			comments: [{ filePath: 'a.txt', newLine: 2, summary: 'probe' }],
		});
		const batch = JSON.parse(capturedInput);
		assert.strictEqual(batch.comments[0].newLine, 2);
		assert.strictEqual(res.applied.length, 1);
	});

	test('non-zero exit raises HunkCommandError with stderr', async () => {
		const runner: HunkRunner = async () => {
			const err = new Error('spawn failed') as Error & { code: number; stderr: string };
			err.code = 1;
			err.stderr = 'No active Hunk sessions.';
			throw err;
		};
		const cli = createHunkCli(runner);
		await assert.rejects(() => cli.listSessions(), (e: unknown) => e instanceof HunkCommandError);
	});

	test('missing binary raises HunkNotInstalledError', async () => {
		const runner: HunkRunner = async () => {
			const err = new Error('not found') as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		};
		const cli = createHunkCli(runner);
		await assert.rejects(() => cli.listSessions(), (e: unknown) => e instanceof HunkNotInstalledError);
	});

	test('real CLI (if installed) returns JSON sessions', async function () {
		this.timeout(5000);
		const cli = createHunkCli();
		const sessions = await cli.listSessions(); // must not throw on real hunk
		assert.ok(Array.isArray(sessions));
	});
});
