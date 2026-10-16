export type CommentStatus = 'pending' | 'sent' | 'stale';

export interface CommentTarget {
	newLine?: number;
	oldLine?: number;
}

export interface StoredComment {
	id: string;
	filePath: string;
	target: CommentTarget;
	summary: string;
	status: CommentStatus;
	sessionCommentId?: string;
	/** hunk note id this comment replies to; sent as `replyTo` instead of a line anchor */
	replyTo?: string;
	createdAt: string;
}

/** A comment moved out of the active store after the commit that included its lines. */
export interface ArchivedComment extends StoredComment {
	archivedAt: string;
	/** HEAD commit sha at the time of archiving (the commit that swallowed the change). */
	commit?: string;
}

export interface CommentArchiveData {
	version: 1;
	comments: ArchivedComment[];
	/** absent in archives written before notes were persisted */
	notes?: ArchivedNote[];
}

export interface CommentStoreData {
	version: 1;
	comments: StoredComment[];
	/**
	 * hunk notes (agent replies, TUI notes) cached from the live session, so they outlive it.
	 * Optional on disk: files written before 0.5.0 have no `notes` and load as [].
	 */
	notes?: StoredNote[];
}

/** A hunk note persisted in comments.json, tagged with the session it was read from. */
export interface StoredNote extends HunkNote {
	sessionId?: string;
}

export interface ArchivedNote extends StoredNote {
	archivedAt: string;
	commit?: string;
}

export interface HunkSession {
	sessionId: string;
	pid?: number;
	repoRoot: string;
	title?: string;
}

export interface SessionListResult {
	sessions: HunkSession[];
}

export interface AppliedComment {
	commentId: string;
	filePath: string;
	side: string;
	line: number;
}

export interface ApplyResult {
	applied: AppliedComment[];
}

export interface HunkNote {
	noteId: string;
	parentId?: string;
	source: string;
	filePath: string;
	hunkIndex: number;
	newRange: [number, number];
	body: string;
	createdAt: string;
	editable: boolean;
}

export interface NoteListResult {
	comments: HunkNote[];
}

export interface HunkReviewFile {
	path: string;
	hunks: Array<{ newStart: number; newLines: number }>;
}

export interface HunkReviewResult {
	files: HunkReviewFile[];
}
