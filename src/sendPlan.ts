import type { StoredComment } from './types.js';

/**
 * Splits pending comments by whether hunk can place them. `comment apply` validates the whole
 * batch up front and rejects all of it over a single path outside the session's diff
 * ("No diff file matches …"), so those are separated before sending instead of sinking the rest.
 *
 * A reply is exempt: hunk anchors it to its parent note, not by path. `sessionFiles === undefined`
 * means the session's diff is unknown (review call failed) — nothing is filtered then, and hunk
 * gets the final say.
 */
export function splitDeliverable(
	comments: StoredComment[],
	sessionFiles: Set<string> | undefined,
): { deliverable: StoredComment[]; skipped: StoredComment[] } {
	if (!sessionFiles) {
		return { deliverable: [...comments], skipped: [] };
	}
	const deliverable: StoredComment[] = [];
	const skipped: StoredComment[] = [];
	for (const c of comments) {
		if (c.replyTo || sessionFiles.has(c.filePath)) {
			deliverable.push(c);
		} else {
			skipped.push(c);
		}
	}
	return { deliverable, skipped };
}

/**
 * Applies a batch, and on refusal retries the items one at a time so one anchor hunk cannot
 * place doesn't sink the comments it accepts. `apply` returns how many items it applied.
 */
export async function applyWithFallback(
	comments: StoredComment[],
	apply: (batch: StoredComment[]) => Promise<number>,
): Promise<{ sent: number; failed: StoredComment[] }> {
	try {
		return { sent: await apply(comments), failed: [] };
	} catch {
		// The batch was refused — try each comment on its own below.
	}
	let sent = 0;
	const failed: StoredComment[] = [];
	for (const comment of comments) {
		try {
			sent += await apply([comment]);
		} catch {
			failed.push(comment);
		}
	}
	return { sent, failed };
}
