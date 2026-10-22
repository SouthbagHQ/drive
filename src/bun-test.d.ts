declare module 'bun:test' {
	export function test(name: string, fn: () => unknown | Promise<unknown>): void;
	export function describe(name: string, fn: () => void): void;
	export function expect(value: unknown): {
		toEqual(expected: unknown): void;
		toBe(expected: unknown): void;
		toBeNull(): void;
		toContain(expected: unknown): void;
	};
}
