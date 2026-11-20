import type { TextAnchor } from './types.js';

/** How many neighbouring lines captureAnchor takes by default. */
export const DEFAULT_ANCHOR_CONTEXT = 2;
/** Upper bound for the context size, so a settings value cannot blow up the store. */
export const MAX_ANCHOR_CONTEXT = 5;

function clampContext(context: number): number {
	const truncated = Math.trunc(context);
	if (!Number.isFinite(truncated)) {
		return DEFAULT_ANCHOR_CONTEXT;
	}
	return Math.min(Math.max(truncated, 0), MAX_ANCHOR_CONTEXT);
}

/**
 * Captures the anchor of `line` (1-based) in `lines`: the trimmed text of the line itself and
 * `context` trimmed neighbours above and below. Returns undefined for a blank line — jumping
 * between empty lines would be worse than keeping the line number.
 */
export function captureAnchor(
	lines: string[],
	line: number,
	context: number = DEFAULT_ANCHOR_CONTEXT,
): TextAnchor | undefined {
	const index = line - 1;
	const text = lines[index]?.trim() ?? '';
	if (!text) {
		return undefined;
	}
	const size = clampContext(context);
	const before: string[] = [];
	for (let distance = 1; distance <= size && index - distance >= 0; distance += 1) {
		before.push(lines[index - distance].trim());
	}
	const after: string[] = [];
	for (let distance = 1; distance <= size && index + distance < lines.length; distance += 1) {
		after.push(lines[index + distance].trim());
	}
	return { line, text, before, after };
}

/** How many of the anchor's neighbours sit around `line` at the same distance. */
function contextScore(lines: string[], anchor: TextAnchor, line: number): number {
	const index = line - 1;
	let score = 0;
	for (let distance = 1; distance <= anchor.before.length; distance += 1) {
		if (lines[index - distance]?.trim() === anchor.before[distance - 1]) {
			score += 1;
		}
	}
	for (let distance = 1; distance <= anchor.after.length; distance += 1) {
		if (lines[index + distance]?.trim() === anchor.after[distance - 1]) {
			score += 1;
		}
	}
	return score;
}

/**
 * Finds the current line of `anchor` in `lines`. Candidates are trimmed-equal lines, filtered by
 * `isInDiff` when it is given (a line outside the diff is never a candidate); the best one matches
 * most `before`/`after` positions, ties break towards `anchor.line`. Returns undefined when there
 * is no candidate — the caller keeps the last known line.
 */
export function resolveAnchor(
	lines: string[],
	anchor: TextAnchor,
	isInDiff?: (line: number) => boolean,
): number | undefined {
	let best: number | undefined;
	let bestScore = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = index + 1;
		if (lines[index].trim() !== anchor.text) {
			continue;
		}
		if (isInDiff && !isInDiff(line)) {
			continue;
		}
		const score = contextScore(lines, anchor, line);
		const closer = best !== undefined && Math.abs(line - anchor.line) < Math.abs(best - anchor.line);
		if (score > bestScore || (score === bestScore && closer)) {
			best = line;
			bestScore = score;
		}
	}
	return best;
}
