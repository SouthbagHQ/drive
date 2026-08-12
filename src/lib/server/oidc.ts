// OIDC client for Southbag Identity™ — discovery-based rather than hardcoded
// paths, so identity's exact route layout stays the canonical source of truth.

import { hostPrefixed } from './session';

interface OidcMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
	registration_endpoint: string;
	end_session_endpoint?: string;
}

type Env = App.Platform['env'];

// Cookie holding the in-flight authorization state + PKCE verifier.
export const OIDC_COOKIE = hostPrefixed('sb_oidc');

const metadataCache = new Map<string, Promise<OidcMetadata>>();

function validateMetadata(issuer: string, meta: OidcMetadata): OidcMetadata {
	// A 2xx response that parses as JSON is not necessarily valid discovery.
	// Reject a malformed doc so a partial/proxied response can't be cached for
	// the isolate's lifetime and brick every login with `new URL(undefined)`.
	if (meta.issuer !== issuer) {
		throw new Error(`OIDC issuer mismatch: expected ${issuer}, got ${meta.issuer}`);
	}
	for (const key of [
		'authorization_endpoint',
		'token_endpoint',
		'userinfo_endpoint',
		'registration_endpoint'
	] as const) {
		if (typeof meta[key] !== 'string' || !meta[key]) {
			throw new Error(`OIDC metadata missing ${key}`);
		}
	}
	return meta;
}

async function getClientId(env: Env): Promise<string> {
	const existing = await env.DB.prepare(
		'SELECT client_id FROM oidc_clients WHERE issuer = ? AND origin = ?'
	)
		.bind(env.IDENTITY_ISSUER, env.ORIGIN)
		.first<{ client_id: string | null }>();
	if (existing?.client_id) return existing.client_id;

	const nonce = crypto.randomUUID();
	await env.DB.prepare(
		'INSERT OR IGNORE INTO oidc_clients (issuer, origin, nonce, created_at) VALUES (?, ?, ?, ?)'
	)
		.bind(env.IDENTITY_ISSUER, env.ORIGIN, nonce, Date.now())
		.run();
	const row = await env.DB.prepare(
		'SELECT nonce, client_id FROM oidc_clients WHERE issuer = ? AND origin = ?'
	)
		.bind(env.IDENTITY_ISSUER, env.ORIGIN)
		.first<{ nonce: string; client_id: string | null }>();
	if (row?.client_id) return row.client_id;
	if (row?.nonce !== nonce) throw new Error('OIDC client registration is already in progress');

	try {
		const { registration_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
		const res = await fetch(registration_endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Southbag Drive™',
				client_uri: env.ORIGIN,
				redirect_uris: [redirectUri(env)],
				post_logout_redirect_uris: [env.ORIGIN],
				token_endpoint_auth_method: 'none',
				grant_types: ['authorization_code'],
				response_types: ['code']
			})
		});
		if (!res.ok) throw new Error(`OIDC client registration failed: ${res.status} ${await res.text()}`);
		const credentials = (await res.json()) as { client_id?: string; client_secret?: string };
		if (!credentials.client_id) throw new Error('OIDC client registration returned no client_id');
		await env.DB.prepare(
			'UPDATE oidc_clients SET client_id = ?, client_secret = ? WHERE issuer = ? AND origin = ? AND nonce = ?'
		)
			.bind(
				credentials.client_id,
				credentials.client_secret ?? null,
				env.IDENTITY_ISSUER,
				env.ORIGIN,
				nonce
			)
			.run();
		return credentials.client_id;
	} catch (error) {
		await env.DB.prepare('DELETE FROM oidc_clients WHERE issuer = ? AND origin = ? AND nonce = ?')
			.bind(env.IDENTITY_ISSUER, env.ORIGIN, nonce)
			.run();
		throw error;
	}
}

function getMetadata(issuer: string): Promise<OidcMetadata> {
	let cached = metadataCache.get(issuer);
	if (!cached) {
		cached = fetch(`${issuer}/.well-known/openid-configuration`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`Failed to fetch identity OIDC metadata: ${res.status}`);
				return validateMetadata(issuer, (await res.json()) as OidcMetadata);
			})
			.catch((err) => {
				metadataCache.delete(issuer); // allow retry on next call
				throw err;
			});
		metadataCache.set(issuer, cached);
	}
	return cached;
}

export async function endSessionUrl(env: Env, idTokenHint?: string): Promise<string | null> {
	const { end_session_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
	if (!end_session_endpoint) return null;
	const url = new URL(end_session_endpoint);
	url.searchParams.set('post_logout_redirect_uri', env.ORIGIN);
	url.searchParams.set('client_id', await getClientId(env));
	if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
	return url.toString();
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

export function generateState(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function redirectUri(env: Env): string {
	return `${env.ORIGIN}/auth/callback`;
}

export async function buildAuthorizeUrl(
	env: Env,
	state: string,
	codeChallenge: string
): Promise<string> {
	const { authorization_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
	const url = new URL(authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', await getClientId(env));
	url.searchParams.set('redirect_uri', redirectUri(env));
	url.searchParams.set('scope', 'openid profile email');
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');
	return url.toString();
}

interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in?: number;
	refresh_token?: string;
	id_token?: string;
}

export async function exchangeCode(
	env: Env,
	code: string,
	codeVerifier: string
): Promise<TokenResponse> {
	const { token_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
	const res = await fetch(token_endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri(env),
			client_id: await getClientId(env),
			code_verifier: codeVerifier
		})
	});
	if (!res.ok) {
		throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
	}
	return res.json() as Promise<TokenResponse>;
}

export interface IdentityUserinfo {
	sub: string;
	name?: string | null;
	email?: string | null;
	picture?: string | null;
}

export async function fetchUserinfo(env: Env, accessToken: string): Promise<IdentityUserinfo> {
	const { userinfo_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
	const res = await fetch(userinfo_endpoint, {
		headers: { Authorization: `Bearer ${accessToken}` }
	});
	if (!res.ok) {
		throw new Error(`Userinfo fetch failed: ${res.status} ${await res.text()}`);
	}
	const info = (await res.json()) as IdentityUserinfo;
	if (!info.sub) throw new Error('Userinfo response missing sub');
	return info;
}
