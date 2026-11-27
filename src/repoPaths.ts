import * as path from 'node:path';
import type * as vscode from 'vscode';

function withoutTrailingSeparator(root: string): string {
	return root.length > 1 && root.endsWith(path.sep) ? root.slice(0, -1) : root;
}

/**
 * Whether `fsPath` lies inside the directory `root`. Boundary-aware: `/work/api-gateway` is not
 * inside `/work/api`, which a bare `startsWith` would claim.
 */
export function isInsideRoot(root: string, fsPath: string): boolean {
	const base = withoutTrailingSeparator(root);
	return base !== '' && fsPath.startsWith(base + path.sep);
}

/**
 * Path of `uri` relative to the repository `root`, with forward slashes — the key shape of the
 * diff maps and the comment store. A uri outside the root keeps its absolute path, which matches
 * no key, so such a file is simply not part of the review.
 */
export function repoRelative(root: string, uri: vscode.Uri): string {
	const fsPath = uri.fsPath;
	if (!isInsideRoot(root, fsPath)) {
		return fsPath;
	}
	return fsPath
		.slice(withoutTrailingSeparator(root).length + 1)
		.split(path.sep)
		.join('/');
}
