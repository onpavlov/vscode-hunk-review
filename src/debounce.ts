export interface Debouncer {
	trigger(): void;
	dispose(): void;
}

export function createDebouncer(delayMs: number, fn: () => void | Promise<void>): Debouncer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		trigger() {
			if (timer) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				void fn();
			}, delayMs);
		},
		dispose() {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
