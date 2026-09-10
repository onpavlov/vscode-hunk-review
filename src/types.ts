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
