export function formatStatusText(pendingCount: number, sessionAlive: boolean): string {
	const pending =
		pendingCount > 0 ? `${sessionAlive ? ' • ' : ': '}${pendingCount} pending` : '';
	return `$(eye) hunk${sessionAlive ? ' • live' : ''}${pending}`;
}
