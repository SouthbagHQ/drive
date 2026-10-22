declare module 'bun:test' {
	export function test(name: string, fn: () => unknown | Promise<unknown>): void;
	export function describe(name: string, fn: () => void): void;
	export function expect(value: unknown): {
		toEqual(expected: unknown): void;
		toBe(expected: unknown): void;
		toBeNull(): void;
		toContain(expected: unknown): void;
		toMatchObject(expected: unknown): void;
		toHaveLength(length: number): void;
	};
}

declare module 'bun:sqlite' {
	interface Statement {
		get(...args: unknown[]): unknown;
		all(...args: unknown[]): unknown[];
		run(...args: unknown[]): { changes: number };
	}
	export class Database {
		constructor(filename: string);
		run(sql: string): void;
		exec(sql: string): void;
		query(sql: string): Statement;
		transaction<T>(fn: () => T): () => T;
	}
}

interface ImportMeta {
	/** Bun: directory of the current module. */
	readonly dir: string;
}
