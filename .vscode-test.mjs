import { defineConfig } from '@vscode/test-cli';
import * as os from 'node:os';
import * as path from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Short socket path: default workspace-derived user-data dir exceeds the
	// 103-char unix socket limit in nested worktrees.
	launchArgs: ['--user-data-dir', path.join(os.tmpdir(), 'hunk-review-vsc-test')],
});
