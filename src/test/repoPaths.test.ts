import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInsideRoot, repoRelative } from '../repoPaths.js';

const root = path.join(path.sep, 'work', 'loyalty-fetcher');

suite('repoPaths', () => {
	test('isInsideRoot is boundary-aware', () => {
		assert.strictEqual(isInsideRoot(root, path.join(root, 'services', 'a.go')), true);
		// A sibling whose name merely starts with the root's name is another directory.
		assert.strictEqual(isInsideRoot(root, `${root}-sender${path.sep}a.go`), false);
		assert.strictEqual(isInsideRoot(root, path.join(path.sep, 'other', 'a.go')), false);
		assert.strictEqual(isInsideRoot('', path.join(root, 'a.go')), false);
	});

	test('isInsideRoot tolerates a trailing separator on the root', () => {
		assert.strictEqual(isInsideRoot(root + path.sep, path.join(root, 'a.go')), true);
	});

	test('repoRelative gives forward-slash paths relative to the root', () => {
		const uri = vscode.Uri.file(path.join(root, 'services', 'level', 'service_test.go'));
		assert.strictEqual(repoRelative(root, uri), 'services/level/service_test.go');
	});

	test('repoRelative keeps the absolute path of a file outside the root', () => {
		const outside = vscode.Uri.file(path.join(path.sep, 'work', 'contracts', 'a.proto'));
		assert.strictEqual(repoRelative(root, outside), outside.fsPath);
	});

	test('the same file is relative to its own repository, not to another one', () => {
		const file = vscode.Uri.file(path.join(root, 'services', 'a.go'));
		const contracts = path.join(path.sep, 'work', 'contracts');
		assert.strictEqual(repoRelative(contracts, file), file.fsPath);
		assert.strictEqual(repoRelative(root, file), 'services/a.go');
	});
});
