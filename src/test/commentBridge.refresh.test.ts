import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CommentBridge } from '../commentBridge.js';
import type { CommentStore } from '../commentStore.js';

const emptyChangedLines = async () => ({ newLines: new Map(), oldLines: new Map() });
const fakeOriginalUri = (file: string) => vscode.Uri.file(file);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeContext(): { subscriptions: Array<{ dispose(): void }> } {
	return { subscriptions: [] };
}

suite('CommentBridge.refresh concurrency', () => {
	test('concurrent refresh calls are serialized, not interleaved', async () => {
		const events: string[] = [];
		const store = {
			load: async () => {
				events.push('load:start');
				await delay(10);
				events.push('load:end');
				return { version: 1 as const, comments: [] };
			},
		} as unknown as CommentStore;
		const bridge = new CommentBridge(
			store,
			async () => {
				events.push('notes');
				return [];
			},
			emptyChangedLines,
			fakeOriginalUri,
		);
		bridge.activate(fakeContext() as never);
		try {
			// Pattern from sendComments: onDidChange kicks off refresh in the background,
			// while the calling code concurrently awaits refresh().
			const first = bridge.refresh();
			const second = bridge.refresh();
			await Promise.all([first, second]);

			// In a race both load() calls start before the first one finishes:
			// load:start, load:start — this is what produces duplicate threads.
			assert.ok(
				events.indexOf('load:end') < events.indexOf('load:start', 1),
				`refresh calls interleaved: ${events.join(',')}`,
			);
		} finally {
			bridge.dispose();
		}
	});

	test('sequential refreshes keep working after serialization', async () => {
		const store = {
			load: async () => ({ version: 1 as const, comments: [] }),
		} as unknown as CommentStore;
		const bridge = new CommentBridge(
			store,
			async () => [],
			emptyChangedLines,
			fakeOriginalUri,
		);
		bridge.activate(fakeContext() as never);
		try {
			await bridge.refresh();
			await bridge.refresh();
			assert.ok(true);
		} finally {
			bridge.dispose();
		}
	});
});
