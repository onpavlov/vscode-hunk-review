import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
	createHunkCli,
	HunkNotInstalledError,
	HunkCommandError,
	HunkRunner,
	isHunkTooOldForReplies,
	supportsReplies,
} from '../hunkCli.js';

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
			comments: [{ filePath: 'a.txt', newLine: 2, summary: 'probe', author: 'user' }],
		});
		const batch = JSON.parse(capturedInput);
		assert.strictEqual(batch.comments[0].newLine, 2);
		assert.strictEqual(batch.comments[0].author, 'user');
		assert.strictEqual(res.applied.length, 1);
	});

	test('applyComments sends a reply as replyTo without a line anchor', async () => {
		let capturedInput = '';
		const cli = createHunkCli(async (_file, _args, options) => {
			capturedInput = options.input ?? '';
			return { stdout: JSON.stringify({ result: { applied: [] } }), stderr: '' };
		});
		await cli.applyComments('/tmp/r', { comments: [{ replyTo: 'mcp:7', summary: 'done' }] });
		assert.deepStrictEqual(JSON.parse(capturedInput).comments[0], { replyTo: 'mcp:7', summary: 'done' });
	});

	test('listNotes keeps the author, so a human note is not mistaken for an agent one', async () => {
		const stdout = JSON.stringify({
			comments: [
				{ noteId: 'mcp:0', source: 'agent', author: 'user', body: 'mine', newRange: [7, 7] },
				{ noteId: 'mcp:1', source: 'agent', body: 'theirs', newRange: [7, 7] },
			],
		});
		const cli = createHunkCli(async () => ({ stdout, stderr: '' }));
		const notes = await cli.listNotes('/tmp/r');
		assert.deepStrictEqual(
			notes.map((n) => [n.noteId, n.author, n.body]),
			[
				['mcp:0', 'user', 'mine'],
				['mcp:1', undefined, 'theirs'],
			],
		);
	});

	test('version runs "hunk --version" and trims the output', async () => {
		const cli = createHunkCli(async (_file, args) => {
			assert.deepStrictEqual(args, ['--version']);
			return { stdout: '0.23.0\n', stderr: '' };
		});
		assert.strictEqual(await cli.version(), '0.23.0');
	});

	test('supportsReplies requires hunk 0.22 or newer', () => {
		assert.strictEqual(supportsReplies('0.21.1'), false);
		assert.strictEqual(supportsReplies('0.22.0-beta.0'), true);
		assert.strictEqual(supportsReplies('0.23.0'), true);
		assert.strictEqual(supportsReplies('1.0.0'), true);
		assert.strictEqual(supportsReplies('hunk dev'), false);
		assert.strictEqual(supportsReplies(undefined), false);
	});

	test('isHunkTooOldForReplies flags only parseable versions below 0.22', () => {
		assert.strictEqual(isHunkTooOldForReplies('0.21.1'), true);
		assert.strictEqual(isHunkTooOldForReplies('0.22.0'), false);
		assert.strictEqual(isHunkTooOldForReplies('hunk dev'), false);
		assert.strictEqual(isHunkTooOldForReplies(undefined), false);
	});

	test('reload swaps session contents with the working tree signal, not a ref', async () => {
		const captured: string[][] = [];
		const runner: HunkRunner = async (_file, args) => {
			captured.push(args);
			return { stdout: 'Reloaded repo /tmp/r (1 files).', stderr: '' };
		};
		const cli = createHunkCli(runner);
		await cli.reload('/tmp/r');
		// `diff` without a ref: the review covers the working tree only, so staged changes never
		// enter the session (comments on them are refused before sending).
		assert.deepStrictEqual(captured, [['session', 'reload', '--repo', '/tmp/r', '--', 'diff']]);
	});

	test('sessionReview reads the files out of a payload wrapped in "review"', async () => {
		const stdout = JSON.stringify({
			review: {
				files: [
					{ path: 'a.go', hunks: [{ newStart: 3, newLines: 2 }] },
					{ path: 'b.go', hunks: [] },
				],
			},
		});
		const runner: HunkRunner = async () => ({ stdout, stderr: '' });
		const cli = createHunkCli(runner);
		const review = await cli.sessionReview('/tmp/r');
		assert.deepStrictEqual(review.files.map((f) => f.path), ['a.go', 'b.go']);
		assert.deepStrictEqual(review.files[0].hunks, [{ newStart: 3, newLines: 2 }]);
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
