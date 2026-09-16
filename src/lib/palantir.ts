// Client-side handle on static/palantir.js (PostHog). Every call is a no-op
// during SSR or before the script has run, so components can call it freely.
export interface PalantirUser {
	id: string;
	email?: string;
	name?: string;
}

interface Palantir {
	capture(event: string, properties?: Record<string, unknown>): void;
	identify(user: PalantirUser): void;
	reset(): void;
}

declare global {
	interface Window {
		palantir?: Palantir;
	}
}

function handle(): Palantir | undefined {
	return typeof window === 'undefined' ? undefined : window.palantir;
}

export function capture(event: string, properties?: Record<string, unknown>) {
	handle()?.capture(event, properties);
}

export function identify(user: PalantirUser) {
	handle()?.identify(user);
}

export function reset() {
	handle()?.reset();
}
