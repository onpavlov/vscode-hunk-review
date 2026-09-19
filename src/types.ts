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
}

export interface CommentStoreData {
	version: 1;
	comments: StoredComment[];
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
