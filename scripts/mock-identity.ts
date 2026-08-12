// Minimal local stand-in for identity.southbag.cc so the OIDC flow can be
// exercised offline: discovery, authorize (auto-approve page), token with
// S256 PKCE verification, and userinfo. Run with: bun scripts/mock-identity.ts

const PORT = Number(process.env.PORT ?? 8788);
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = process.env.MOCK_CLIENT_ID ?? 'drive-local';
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET ?? 'drive-local-secret';

const USER = {
	sub: 'mock-user-1',
	email: 'kevin@southbag.cc',
	email_verified: true,
	name: 'Kevin Mockery'
};

interface PendingCode {
	challenge: string;
	redirectUri: string;
}

const codes = new Map<string, PendingCode>();
const tokens = new Set<string>();

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === '/.well-known/openid-configuration') {
			return json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				userinfo_endpoint: `${ISSUER}/userinfo`,
				end_session_endpoint: `${ISSUER}/end-session`,
				jwks_uri: `${ISSUER}/jwks`,
				response_types_supported: ['code'],
				code_challenge_methods_supported: ['S256']
			});
		}

		if (url.pathname === '/authorize') {
			const clientId = url.searchParams.get('client_id');
			const redirectUri = url.searchParams.get('redirect_uri');
			const state = url.searchParams.get('state');
			const challenge = url.searchParams.get('code_challenge');
			const method = url.searchParams.get('code_challenge_method');
			if (clientId !== CLIENT_ID) return new Response('unknown client', { status: 400 });
			if (!redirectUri || !state || !challenge || method !== 'S256') {
				return new Response('bad authorize request', { status: 400 });
			}

			const code = crypto.randomUUID();
			codes.set(code, { challenge, redirectUri });
			const target = new URL(redirectUri);
			target.searchParams.set('code', code);
			target.searchParams.set('state', state);

			return new Response(
				`<!doctype html><title>Mock Southbag Identity</title>
				 <h1>Mock Southbag Identity&trade;</h1>
				 <p>Southbag Drive wants to know who you are. You are ${USER.name}.</p>
				 <p><a id="approve" href="${target.toString().replaceAll('&', '&amp;')}">Approve</a></p>`,
				{ headers: { 'Content-Type': 'text/html' } }
			);
		}

		if (url.pathname === '/token' && req.method === 'POST') {
			const form = new URLSearchParams(await req.text());
			if (form.get('grant_type') !== 'authorization_code') {
				return json({ error: 'unsupported_grant_type' }, 400);
			}
			if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
				return json({ error: 'invalid_client' }, 401);
			}
			const pending = codes.get(form.get('code') ?? '');
			if (!pending) return json({ error: 'invalid_grant' }, 400);
			codes.delete(form.get('code')!);
			if (pending.redirectUri !== form.get('redirect_uri')) {
				return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);
			}
			const verifier = form.get('code_verifier');
			if (!verifier || (await s256(verifier)) !== pending.challenge) {
				return json({ error: 'invalid_grant', error_description: 'pkce failed' }, 400);
			}
			const token = crypto.randomUUID();
			tokens.add(token);
			// A cosmetic unsigned JWT so the client has an id_token to persist and
			// later replay as id_token_hint at logout. NOT verified anywhere.
			const idToken = [
				Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
				Buffer.from(JSON.stringify({ iss: ISSUER, sub: USER.sub, aud: CLIENT_ID })).toString('base64url'),
				''
			].join('.');
			return json({ access_token: token, id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
		}

		if (url.pathname === '/userinfo') {
			const auth = req.headers.get('authorization') ?? '';
			const token = auth.replace(/^Bearer /, '');
			if (!tokens.has(token)) return json({ error: 'invalid_token' }, 401);
			return json(USER);
		}

		if (url.pathname === '/end-session') {
			// RP-initiated logout: honour post_logout_redirect_uri.
			const back = url.searchParams.get('post_logout_redirect_uri') ?? '/';
			return new Response(null, { status: 302, headers: { Location: back } });
		}

		return new Response('not found', { status: 404 });
	}
});

console.log(`Mock Southbag Identity™ listening on ${ISSUER}`);
