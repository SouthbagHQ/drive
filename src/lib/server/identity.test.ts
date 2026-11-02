import { describe, expect, test } from 'bun:test';
import { centralStatus } from './identity';

const env = { IDENTITY_ISSUER: 'https://identity.test', IDENTITY_INTERNAL_SECRET: 's' } as never;
const json = (body: unknown) => async () => ({ ok: true, json: async () => body }) as Response;

describe('centralStatus', () => {
	test('is off without a secret (development)', async () => {
		expect(await centralStatus({} as never, 'u1')).toBe('off');
	});
	test('returns the central answer', async () => {
		expect(await centralStatus(env, `u${Date.now()}a`, json({ frozen: true }))).toEqual({ frozen: true });
		expect(await centralStatus(env, `u${Date.now()}b`, json({ frozen: false }))).toEqual({ frozen: false });
	});
	test('is unknown when Identity is unreachable', async () => {
		const down = (() => { throw new Error('connection refused'); }) as unknown as typeof fetch;
		expect(await centralStatus(env, `u${Date.now()}c`, down)).toBe('unknown');
	});
	test('does NOT cache - a cached active answer is an authorization window', async () => {
		let calls = 0;
		const counter = (async () => { calls++; return { ok: true, status: 200, json: async () => ({ frozen: false }) }; }) as unknown as typeof fetch;
		const id = `u${Date.now()}d`;
		await centralStatus(env, id, counter);
		await centralStatus(env, id, counter);
		expect(calls).toBe(2);
	});
	test('rejected secret: unknown (fail closed) with a distinct loud log', async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => errors.push(args.join(' '));
		try {
			const rejected = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch;
			expect(await centralStatus(env, `u${Date.now()}e`, rejected)).toBe('unknown');
		} finally { console.error = originalError; }
		expect(errors.some(line => /REJECTED the configured secret/.test(line))).toBe(true);
	});
});
