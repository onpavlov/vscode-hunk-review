import * as vscode from 'vscode';

// GitHub's noreply commit email: either `{id}+{username}@users.noreply.github.com`
// or the older `{username}@users.noreply.github.com`.
const NOREPLY_RE = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

export function parseGithubNoreplyUsername(email: string): string | undefined {
	return NOREPLY_RE.exec(email.trim())?.[1];
}

export function githubAvatarUri(username: string): vscode.Uri {
	return vscode.Uri.parse(`https://github.com/${encodeURIComponent(username)}.png`);
}

function configuredUsername(): string | undefined {
	const raw = vscode.workspace.getConfiguration('hunk-review').get<string>('githubUsername', '');
	const trimmed = raw.trim().replace(/^@/, '');
	return trimmed || undefined;
}

export interface UserAvatarResolver {
	/** Cached avatar URI from the last refresh(), or undefined if no username is known. */
	uri(): vscode.Uri | undefined;
	/** Re-resolves from the `githubUsername` setting, falling back to a git noreply email. */
	refresh(): Promise<void>;
}

/**
 * Resolves the reviewer's GitHub avatar without any HTTP client: `https://github.com/<user>.png`
 * is a valid image URL VS Code's comment UI can load directly. Resolution reads git config
 * (`getUserEmail`), so it's cached here and only redone on refresh() rather than per render.
 */
export function createUserAvatarResolver(
	getUserEmail: () => Promise<string | undefined>,
): UserAvatarResolver {
	let cached: vscode.Uri | undefined;

	return {
		uri: () => cached,
		async refresh() {
			const username =
				configuredUsername() ?? parseGithubNoreplyUsername((await getUserEmail()) ?? '');
			cached = username ? githubAvatarUri(username) : undefined;
		},
	};
}
