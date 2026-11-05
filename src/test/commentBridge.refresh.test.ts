import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { CommentBridge } from '../commentBridge.js';
import type { CommentStore } from '../commentStore.js';
import type { StoredComment } from '../types.js';

const emptyChangedLines = async () => ({ newLines: new Map(), oldLines: new Map() });
const fakeOriginalUri = (file: string) => vscode.Uri.file(file);

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeContext(): { subscriptions: Array<{ dispose(): void }>; extensionUri: vscode.Uri } {
	return { subscriptions: [], extensionUri: vscode.Uri.file('/ext') };
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

suite('CommentBridge avatar resolution', () => {
	// 'old' side: doRefresh resolves its uri via originalUri(), not workspaceRoot(),
	// so this works without a workspace folder open (as in the test host here).
	function storedComment(): StoredComment {
		return {
			id: 'c1',
			filePath: 'src/a.ts',
			target: { oldLine: 1 },
			summary: 'hi',
			status: 'pending',
			createdAt: '2026-09-10T00:00:00Z',
		};
	}

	test('uses the resolved GitHub avatar for the user role', async () => {
		const store = { load: async () => ({ version: 1 as const, comments: [storedComment()] }) } as unknown as CommentStore;
		const bridge = new CommentBridge(
			store,
			async () => [],
			emptyChangedLines,
			fakeOriginalUri,
			() => vscode.Uri.parse('https://github.com/octocat.png'),
		);
		bridge.activate(fakeContext() as never);
		try {
			await bridge.refresh();
			const thread = (bridge as unknown as { threadByKey: Map<string, vscode.CommentThread> }).threadByKey.get(
				'src/a.ts:old:1',
			);
			assert.strictEqual(thread?.comments[0].author.iconPath?.toString(), 'https://github.com/octocat.png');
		} finally {
			bridge.dispose();
		}
	});

	test('falls back to the local icon when no GitHub avatar is resolved', async () => {
		const store = { load: async () => ({ version: 1 as const, comments: [storedComment()] }) } as unknown as CommentStore;
		const bridge = new CommentBridge(store, async () => [], emptyChangedLines, fakeOriginalUri, () => undefined);
		bridge.activate(fakeContext() as never);
		try {
			await bridge.refresh();
			const thread = (bridge as unknown as { threadByKey: Map<string, vscode.CommentThread> }).threadByKey.get(
				'src/a.ts:old:1',
			);
			assert.ok(thread?.comments[0].author.iconPath?.toString().endsWith('avatar-user.svg'));
		} finally {
			bridge.dispose();
		}
	});
});

suite('CommentBridge thread anchors', () => {
	// Where the new side lives can change between refreshes: the same file is reviewed against
	// the working tree in one tab and against the index of a staged change in another, and a
	// thread cannot be re-anchored to a different document once created.
	function storedOnNewLine(): CommentStore {
		return {
			load: async () => ({
				version: 1 as const,
				comments: [
					{
						id: 'c1',
						filePath: 'src/a.ts',
						target: { newLine: 5 },
						summary: 'hi',
						status: 'pending',
						createdAt: '2026-09-10T00:00:00Z',
					},
				],
			}),
		} as unknown as CommentStore;
	}

	function bridgeAnchoringAt(uri: () => vscode.Uri): CommentBridge {
		return new CommentBridge(
			storedOnNewLine(),
			async () => [],
			emptyChangedLines,
			fakeOriginalUri,
			() => undefined,
			() => false,
			uri,
		);
	}

	function threadOf(bridge: CommentBridge): vscode.CommentThread | undefined {
		const threads = (bridge as unknown as { threadByKey: Map<string, vscode.CommentThread> }).threadByKey;
		return threads.get('src/a.ts:new:5');
	}

	test('anchors a new-side comment on the document the diff editor shows', async () => {
		const shownAsNew = vscode.Uri.file('/repo/src/a.ts').with({ scheme: 'git', query: '{"ref":""}' });
		const bridge = bridgeAnchoringAt(() => shownAsNew);
		bridge.activate(fakeContext() as never);
		try {
			await bridge.refresh();
			assert.strictEqual(threadOf(bridge)?.uri.toString(), shownAsNew.toString());
		} finally {
			bridge.dispose();
		}
	});

	test('re-anchors the thread when the open diff switches documents', async () => {
		const workingTree = vscode.Uri.file('/repo/src/a.ts');
		const shownAsNew = workingTree.with({ scheme: 'git', query: '{"ref":""}' });
		let anchor = shownAsNew;
		const bridge = bridgeAnchoringAt(() => anchor);
		bridge.activate(fakeContext() as never);
		try {
			await bridge.refresh();
			anchor = workingTree;
			await bridge.refresh();
			assert.strictEqual(threadOf(bridge)?.uri.toString(), workingTree.toString());
		} finally {
			bridge.dispose();
		}
	});
});
