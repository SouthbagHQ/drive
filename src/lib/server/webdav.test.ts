import { describe, expect, test } from 'bun:test';
import { handleWebdav } from './webdav';

function event(init: {
	method: string;
	path?: string;
	user?: boolean;
	platform?: boolean;
	headers?: Record<string, string>;
}) {
	const suffix = init.path ?? '';
	const url = new URL(`https://drive.southbag.cc/webdav${suffix ? '/' + suffix : '/'}`);
	return {
		request: new Request(url, { method: init.method, headers: init.headers }),
		url,
		params: { path: init.path },
		locals: {
			user: init.user ? { id: 'mock-user-1', email: 'kevin@southbag.cc', name: 'Kevin Mockery' } : null,
			sessionId: init.user ? 'session' : null
		},
		platform: init.platform
			? ({
					env: {
						DB: {} as D1Database,
						ORIGIN: 'https://drive.southbag.cc',
						IDENTITY_ISSUER: 'https://identity.southbag.cc'
					}
				} as App.Platform)
			: undefined
	};
}

describe('handleWebdav', () => {
	test('OPTIONS is unauthenticated and advertises Class 1+2', async () => {
		const res = await handleWebdav(event({ method: 'OPTIONS' }));
		expect(res.status).toBe(200);
		expect(res.headers.get('DAV')).toBe('1, 2');
		expect(res.headers.get('MS-Author-Via')).toBe('DAV');
		expect(res.headers.get('Allow') ?? '').toContain('PROPFIND');
		expect(res.headers.get('Allow') ?? '').toContain('LOCK');
	});

	test('PROPFIND without a token challenges Basic', async () => {
		const res = await handleWebdav(event({ method: 'PROPFIND' }));
		expect(res.status).toBe(401);
		expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Southbag Drive"');
	});

	test('MKCOL is refused because folders do not exist', async () => {
		const res = await handleWebdav(
			event({ method: 'MKCOL', path: 'swapdir', user: true, platform: true })
		);
		expect(res.status).toBe(403);
		expect(await res.text()).toContain('folders');
	});

	test('PUT into a nested path conflicts instead of creating folders', async () => {
		const res = await handleWebdav(
			event({
				method: 'PUT',
				path: 'dir/swapfile',
				user: true,
				platform: true,
				headers: { 'Content-Length': '4' }
			})
		);
		expect(res.status).toBe(409);
	});

	test('DELETE of the collection is forbidden', async () => {
		const res = await handleWebdav(event({ method: 'DELETE', user: true, platform: true }));
		expect(res.status).toBe(403);
	});
});
