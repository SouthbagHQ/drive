import type { SessionUser } from '$lib/server/session';

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Locals {
			user: SessionUser | null;
			sessionId: string | null;
		}

		interface Platform {
			env: {
				DB: D1Database;
				ORIGIN: string;
				IDENTITY_ISSUER: string;
				OFFICE_ORIGIN: string;
				IDENTITY_INTERNAL_SECRET?: string;
				BANKING?: {
					charge(input: Record<string, unknown>): Promise<{ balance: number | null; opened: boolean; duplicate?: boolean }>;
				};
			};
			// `context` (with waitUntil) is contributed by adapter-cloudflare.
		}
	}
}

export {};
