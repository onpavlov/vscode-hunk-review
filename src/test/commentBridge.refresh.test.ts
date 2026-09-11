import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CommentBridge } from '../commentBridge.js';
import type { CommentStore } from '../commentStore.js';
import type { LineRange } from '../diffService.js';

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
			async () => new Map<string, LineRange[]>(),
		);
		bridge.activate(fakeContext() as never);
		try {
			// Паттерн из sendComments: onDidChange запускает refresh в фоне,
			// а вызывающий код параллельно делает await refresh().
			const first = bridge.refresh();
			const second = bridge.refresh();
			await Promise.all([first, second]);

			// При гонке оба load() стартуют до того, как первый завершится:
			// load:start, load:start — это и порождает дубли тредов.
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
			async () => new Map<string, LineRange[]>(),
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
