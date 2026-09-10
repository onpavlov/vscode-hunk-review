import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('extension activation', () => {
	test('registers all hunk-review commands', async () => {
		// The extension ID is <publisher>.<name>, or if publisher is missing, undefined_publisher.<name>
		const ext = vscode.extensions.getExtension('undefined_publisher.hunk-review') || 
			vscode.extensions.all.find(e => e.id.includes('hunk-review'));
		
		if (ext) {
			await ext.activate();
		}
		
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'hunk-review.openDiff',
			'hunk-review.sendComments',
			'hunk-review.stopSession',
			'hunk-review.showSessionTerminal',
			'hunk-review.menu',
		]) {
			assert.ok(commands.includes(id), `missing command ${id}`);
		}
	});
});
