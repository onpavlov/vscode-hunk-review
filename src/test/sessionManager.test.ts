import * as assert from 'node:assert';
import { SessionManager, TerminalFactory } from '../sessionManager.js';
import type { HunkSession } from '../types.js';

function fakeCli(sessions: HunkSession[]) {
	return {
		findSession: async (root: string) => sessions.find((s) => s.repoRoot === root),
		listSessions: async () => sessions,
	};
}

suite('SessionManager', () => {
	const root = '/tmp/repo';

	test('ensureSession returns existing session without starting terminal', async () => {
		let terminalsStarted = 0;
		const factory: TerminalFactory = () => {
			terminalsStarted += 1;
			return { dispose: () => undefined } as never;
		};
		const toasts: string[] = [];
		const sm = new SessionManager(
			fakeCli([{ sessionId: 's1', repoRoot: root }]) as never,
			root,
			factory,
			{ info: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) },
			async () => false,
		);
		const session = await sm.ensureSession();
		assert.strictEqual(session.sessionId, 's1');
		assert.strictEqual(terminalsStarted, 0);
	});

	test('ensureSession starts hidden terminal and polls until registered', async () => {
		let terminalsStarted = 0;
		const factory: TerminalFactory = (cwd: string) => {
			assert.strictEqual(cwd, root);
			terminalsStarted += 1;
			return { dispose: () => undefined } as never;
		};
		const cli = fakeCli([]);
		// After the terminal's first launch the session "registers".
		cli.findSession = async (r: string) =>
			terminalsStarted > 0 ? { sessionId: 's9', repoRoot: r } : undefined;
		const sm = new SessionManager(
			cli as never,
			root,
			factory,
			{ info: () => undefined, error: () => undefined },
			async () => false,
		);
		const session = await sm.ensureSession();
		assert.strictEqual(session.sessionId, 's9');
		assert.strictEqual(terminalsStarted, 1);
	});

	test('stopSession disposes terminal and clears state', async () => {
		let disposed = false;
		const factory: TerminalFactory = () =>
			({ dispose: () => { disposed = true; } } as never);
		const cli = fakeCli([]);
		let findCalls = 0;
		cli.findSession = async (r: string) => {
			findCalls += 1;
			return findCalls > 1 ? { sessionId: 's9', repoRoot: r } : undefined;
		};
		const sm = new SessionManager(
			cli as never,
			root,
			factory,
			{ info: () => undefined, error: () => undefined },
			async () => false,
		);
		await sm.ensureSession();
		await sm.stopSession('test');
		assert.strictEqual(disposed, true);
		assert.strictEqual(sm.currentSession(), undefined);
	});

	test('clearSession disposes owned terminal and clears state', async () => {
		let disposed = false;
		const factory: TerminalFactory = () =>
			({ dispose: () => { disposed = true; } } as never);
		const cli = fakeCli([]);
		let findCalls = 0;
		cli.findSession = async (r: string) => {
			findCalls += 1;
			return findCalls > 1 ? { sessionId: 's9', repoRoot: r } : undefined;
		};
		const sm = new SessionManager(
			cli as never,
			root,
			factory,
			{ info: () => undefined, error: () => undefined },
			async () => false,
		);
		await sm.ensureSession();
		sm.clearSession();
		assert.strictEqual(disposed, true);
		assert.strictEqual(sm.currentSession(), undefined);
	});

	test('connectToSession shows terminal when one is owned', async () => {
		let shown = 0;
		const factory: TerminalFactory = () =>
			({ dispose: () => undefined, show: () => { shown += 1; } } as never);
		const cli = fakeCli([]);
		let findCalls = 0;
		cli.findSession = async (r: string) => {
			findCalls += 1;
			return findCalls > 1 ? { sessionId: 's9', repoRoot: r } : undefined;
		};
		const toasts: string[] = [];
		const sm = new SessionManager(
			cli as never,
			root,
			factory,
			{ info: (m: string) => toasts.push(m), error: () => undefined },
			async () => false,
		);
		await sm.ensureSession();
		await sm.connectToSession();
		assert.strictEqual(shown, 1);
		assert.strictEqual(toasts.length, 0);
	});

	test('connectToSession toasts when session runs outside VS Code', async () => {
		const toasts: string[] = [];
		const sm = new SessionManager(
			fakeCli([{ sessionId: 's1', repoRoot: root }]) as never,
			root,
			() => ({ dispose: () => undefined } as never),
			{ info: (m: string) => toasts.push(m), error: () => undefined },
			async () => false,
		);
		await sm.connectToSession();
		assert.deepStrictEqual(toasts, ['hunk session is running outside VS Code — terminal unavailable']);
	});

	test('connectToSession toasts when no session exists', async () => {
		const toasts: string[] = [];
		const sm = new SessionManager(
			fakeCli([]) as never,
			root,
			() => ({ dispose: () => undefined } as never),
			{ info: (m: string) => toasts.push(m), error: () => undefined },
			async () => false,
		);
		await sm.connectToSession();
		assert.deepStrictEqual(toasts, ['hunk session is not running']);
	});
});
