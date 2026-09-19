import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
	ArchivedComment,
	CommentArchiveData,
	CommentStoreData,
	CommentTarget,
	StoredComment,
} from './types.js';

const EMPTY: CommentStoreData = { version: 1, comments: [] };

export class CommentStore {
	private readonly file: string;
	private readonly archiveFile: string;

	constructor(private readonly dir: string) {
		this.file = path.join(dir, 'comments.json');
		this.archiveFile = path.join(dir, 'archive.json');
	}

	async load(): Promise<CommentStoreData> {
		let raw: string;
		try {
			raw = await fs.readFile(this.file, 'utf8');
		} catch {
			// File does not exist yet — start empty.
			return { ...EMPTY, comments: [] };
		}
		try {
			const data = JSON.parse(raw) as CommentStoreData;
			return { version: 1, comments: data.comments ?? [] };
		} catch {
			// Corrupt JSON — rename and start fresh.
			const corrupt = `${this.file}.corrupt-${Date.now()}`;
			try {
				await fs.rename(this.file, corrupt);
			} catch {
				// rename failed — best effort
			}
			console.warn(`[hunk-review] comments.json was corrupt; renamed to ${path.basename(corrupt)}`);
			return { ...EMPTY, comments: [] };
		}
	}

	private async write(data: CommentStoreData): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await fs.writeFile(this.file, JSON.stringify(data, null, 2), 'utf8');
	}

	async add(filePath: string, target: CommentTarget, summary: string): Promise<StoredComment> {
		if ((target.newLine !== undefined) === (target.oldLine !== undefined)) {
			throw new Error('Comment target must be exactly one of newLine or oldLine');
		}
		const data = await this.load();
		const comment: StoredComment = {
			id: crypto.randomUUID(),
			filePath,
			target,
			summary,
			status: 'pending',
			createdAt: new Date().toISOString(),
		};
		data.comments.push(comment);
		await this.write(data);
		return comment;
	}

	async update(
		id: string,
		patch: Partial<Pick<StoredComment, 'status' | 'sessionCommentId' | 'summary'>>,
	): Promise<StoredComment> {
		const data = await this.load();
		const idx = data.comments.findIndex((c) => c.id === id);
		if (idx < 0) {
			throw new Error(`Comment not found: ${id}`);
		}
		const updated: StoredComment = { ...data.comments[idx], ...patch };
		data.comments[idx] = updated;
		await this.write(data);
		return updated;
	}

	async remove(id: string): Promise<void> {
		const data = await this.load();
		data.comments = data.comments.filter((c) => c.id !== id);
		await this.write(data);
	}

	async loadArchive(): Promise<CommentArchiveData> {
		try {
			const data = JSON.parse(await fs.readFile(this.archiveFile, 'utf8')) as CommentArchiveData;
			return { version: 1, comments: data.comments ?? [] };
		} catch {
			// Missing or unreadable archive — start empty (the next archive() rewrites it).
			return { version: 1, comments: [] };
		}
	}

	/** Moves the given comments from the active store to `archive.json`. Returns how many were moved. */
	async archive(ids: string[], commit?: string): Promise<number> {
		const wanted = new Set(ids);
		const data = await this.load();
		const moved = data.comments.filter((c) => wanted.has(c.id));
		if (moved.length === 0) {
			return 0;
		}
		const archivedAt = new Date().toISOString();
		const archive = await this.loadArchive();
		archive.comments.push(...moved.map((c): ArchivedComment => ({ ...c, archivedAt, commit })));
		// Write the archive first: a crash in between duplicates a comment rather than losing it.
		await fs.mkdir(path.dirname(this.archiveFile), { recursive: true });
		await fs.writeFile(this.archiveFile, JSON.stringify(archive, null, 2), 'utf8');
		data.comments = data.comments.filter((c) => !wanted.has(c.id));
		await this.write(data);
		return moved.length;
	}

	async pending(): Promise<StoredComment[]> {
		const data = await this.load();
		return data.comments.filter((c) => c.status === 'pending');
	}

	async pendingCount(): Promise<number> {
		return (await this.pending()).length;
	}
}

/** Creates `<dir>/.gitignore` with a wildcard if it doesn't exist yet — the `.hunk-review`
 *  directory ignores itself entirely; the project's root .gitignore is left untouched. */
export async function ensureGitignore(dir: string): Promise<void> {
	const gitignore = path.join(dir, '.gitignore');
	try {
		await fs.access(gitignore);
		return;
	} catch {
		// no .gitignore yet
	}
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(gitignore, '*\n', 'utf8');
}
