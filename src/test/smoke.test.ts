import * as assert from 'node:assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHunkCli } from '../hunkCli.js';

suite('smoke with real hunk CLI', function () {
	this.timeout(60_000);

	test('comment apply round-trip against real session', async function () {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hunk-smoke-'));
		cp.execSync('git init -q', { cwd: root });
		fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n');
		cp.execSync('git add .', { cwd: root });
		cp.execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
		fs.appendFileSync(path.join(root, 'a.txt'), 'world\n');

		const cli = createHunkCli();
		let session;
		try {
			// Check apply on a live session: skip if there's no tty to launch the TUI.
			session = await cli.findSession(root);
			if (!session) {
				this.skip();
			}
			const result = await cli.applyComments(root, {
				comments: [{ filePath: 'a.txt', newLine: 2, summary: 'smoke probe' }],
			});
			assert.strictEqual(result.applied.length, 1);
			const notes = await cli.listNotes(root, 'all');
			assert.ok(notes.some((n) => n.body === 'smoke probe'));
		} finally {
			if (session) {
				// Stop the session: kill the TUI process by pid from session list.
				try {
					process.kill(session.pid ?? -1);
				} catch {
					// session already finished
				}
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
