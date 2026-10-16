import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type {
	ApplyResult,
	HunkNote,
	HunkReviewResult,
	HunkSession,
} from './types.js';

export class HunkNotInstalledError extends Error {
	constructor() {
		super('hunk CLI is not installed or not in PATH');
	}
}

export class HunkCommandError extends Error {
	constructor(message: string, readonly stderr: string) {
		super(message);
	}
}

export interface RunOptions {
	cwd?: string;
	input?: string;
}

export type HunkRunner = (
	file: string,
	args: string[],
	options: RunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: HunkRunner = (file, args, options) =>
	new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: options.cwd });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
		child.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') {
				reject(new HunkNotInstalledError());
			} else {
				reject(err);
			}
		});
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new HunkCommandError(`hunk ${args.join(' ')} exited with code ${code}`, stderr));
			}
		});
		child.stdin.end(options.input ?? '');
	});

function parseJson<T>(stdout: string): T {
	try {
		return JSON.parse(stdout) as T;
	} catch {
		throw new HunkCommandError('hunk returned invalid JSON', stdout);
	}
}

/** One `session comment apply` item: either a line anchor or a `replyTo` parent note, never both. */
export type ApplyCommentItem =
	| { filePath: string; newLine?: number; oldLine?: number; summary: string; author?: string }
	| { replyTo: string; summary: string; author?: string };

/** First hunk release whose `session comment add/apply` accept `replyTo` (modem-dev/hunk#1012). */
const REPLY_MIN_VERSION: [number, number] = [0, 22];
export const REPLY_MIN_VERSION_LABEL = `${REPLY_MIN_VERSION[0]}.${REPLY_MIN_VERSION[1]}.0`;

function parseMajorMinor(version: string | undefined): [number, number] | undefined {
	const m = /(\d+)\.(\d+)\.\d+/.exec(version ?? '');
	return m ? [Number(m[1]), Number(m[2])] : undefined;
}

function meetsReplyMin([major, minor]: [number, number]): boolean {
	return major > REPLY_MIN_VERSION[0] || (major === REPLY_MIN_VERSION[0] && minor >= REPLY_MIN_VERSION[1]);
}

/** Whether a `hunk --version` string is new enough to send replies to existing notes. */
export function supportsReplies(version: string | undefined): boolean {
	const parsed = parseMajorMinor(version);
	return parsed !== undefined && meetsReplyMin(parsed);
}

/**
 * Whether `hunk --version` names a release known to predate replies. An unparseable
 * string (dev build) is not "too old" — replies stay off, but nobody is nagged to update.
 */
export function isHunkTooOldForReplies(version: string | undefined): boolean {
	const parsed = parseMajorMinor(version);
	return parsed !== undefined && !meetsReplyMin(parsed);
}

function normalizeRepoRoot(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return p;
	}
}

export class HunkCli {
	constructor(private readonly runner: HunkRunner = defaultRunner) {}

	private async run(args: string[], options: RunOptions = {}) {
		try {
			return await this.runner('hunk', args, options);
		} catch (err) {
			throw this.normalizeError(err, args);
		}
	}

	// Custom runners may surface raw spawn/exit errors; normalize them so
	// callers always see HunkNotInstalledError or HunkCommandError.
	private normalizeError(err: unknown, args: string[]): Error {
		if (err instanceof HunkNotInstalledError || err instanceof HunkCommandError) {
			return err;
		}
		const errno = err as NodeJS.ErrnoException & { stderr?: string };
		if (errno.code === 'ENOENT') {
			return new HunkNotInstalledError();
		}
		if (typeof errno.code === 'number') {
			return new HunkCommandError(
				`hunk ${args.join(' ')} exited with code ${errno.code}`,
				errno.stderr ?? '',
			);
		}
		return err instanceof Error ? err : new Error(String(err));
	}

	async version(): Promise<string> {
		const { stdout } = await this.run(['--version']);
		return stdout.trim();
	}

	async listSessions(): Promise<HunkSession[]> {
		const { stdout } = await this.run(['session', 'list', '--json']);
		return parseJson<{ sessions: HunkSession[] }>(stdout).sessions;
	}

	async findSession(repoRoot: string): Promise<HunkSession | undefined> {
		const want = normalizeRepoRoot(repoRoot);
		let sessions: HunkSession[];
		try {
			sessions = await this.listSessions();
		} catch (err) {
			if (err instanceof HunkCommandError) {
				// Daemon unreachable — treat session count as zero (see spec: error handling).
				return undefined;
			}
			throw err;
		}
		return sessions.find((s) => normalizeRepoRoot(s.repoRoot) === want);
	}

	async applyComments(
		repoRoot: string,
		batch: { comments: ApplyCommentItem[] },
	): Promise<ApplyResult> {
		const { stdout } = await this.run(
			['session', 'comment', 'apply', '--repo', repoRoot, '--stdin', '--json'],
			{ input: JSON.stringify(batch) },
		);
		return parseJson<{ result: ApplyResult }>(stdout).result;
	}

	async listNotes(repoRoot: string, type: 'live' | 'all' = 'all'): Promise<HunkNote[]> {
		const { stdout } = await this.run(
			['session', 'comment', 'list', '--repo', repoRoot, '--type', type, '--json'],
		);
		const raw = parseJson<{ comments?: Array<Record<string, unknown>> }>(stdout).comments ?? [];
		return raw.map((c) => this.normalizeNote(c));
	}

	// Field shapes of `comment list --json` drift between versions/sources:
	// noteId|commentId, newRange|line, body|summary, source — optional.
	private normalizeNote(c: Record<string, unknown>): HunkNote {
		const line = (c['line'] ?? 1) as number;
		return {
			noteId: (c['noteId'] ?? c['commentId'] ?? '') as string,
			parentId: c['parentId'] as string | undefined,
			source: (c['source'] ?? 'agent') as string,
			filePath: (c['filePath'] ?? '') as string,
			hunkIndex: (c['hunkIndex'] ?? 0) as number,
			newRange: (c['newRange'] ?? [line, line]) as [number, number],
			body: (c['body'] ?? c['summary'] ?? '') as string,
			createdAt: (c['createdAt'] ?? '') as string,
			editable: (c['editable'] ?? false) as boolean,
		};
	}

	async sessionReview(repoRoot: string): Promise<HunkReviewResult> {
		const { stdout } = await this.run(['session', 'review', '--repo', repoRoot, '--json']);
		return this.normalizeReview(parseJson<Record<string, unknown>>(stdout));
	}

	// `session review --json` returns hunk ranges; normalize both possible shapes.
	private normalizeReview(raw: Record<string, unknown>): HunkReviewResult {
		const files = (raw['files'] ?? []) as Array<{
			path?: string;
			filePath?: string;
			hunks?: Array<Record<string, number>>;
		}>;
		return {
			files: files.map((f) => ({
				path: (f.path ?? f.filePath ?? '') as string,
				hunks: (f.hunks ?? []).map((h) => ({
					newStart: (h['newStart'] ?? h['new_start'] ?? 0) as number,
					newLines: (h['newLines'] ?? h['new_lines'] ?? 0) as number,
				})),
			})),
		};
	}

	async reload(repoRoot: string): Promise<void> {
		// reload requires a trailing subcommand (`-- diff`): without it the CLI validates
		// arguments and fails, and the session content doesn't change.
		await this.run(['session', 'reload', '--repo', repoRoot, '--', 'diff']);
	}
}

export function createHunkCli(runner?: HunkRunner): HunkCli {
	return new HunkCli(runner);
}
