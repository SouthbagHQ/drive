// Bearer-token auth on /api/* for native Southbag clients (Southbag Browser on
// Southbag OS, which is how OS downloads reach Drive).
//
// The web app signs in with an OIDC redirect and keeps a cookie session; a
// native app already holds an Identity access token of its own (OAuth 2.1 +
// PKCE per RFC 8252) and cannot run a redirect dance inside an API call. So
// /api/* also accepts `Authorization: Bearer <identity access token>`,
// validated FRESH against Identity's userinfo endpoint on every request — no
// cache, same fail-closed posture as the freeze check: when Identity cannot be
// reached the request is refused, never silently admitted. Revocation and
// expiry therefore apply immediately.
//
// A cookie session still wins when both are present, matching /webdav/.
//
// This module must stay importable without Vite's `$app` aliases (node --test
// runs it directly), so it keeps its own copy of the user upsert rather than
// importing session.ts.

import { getMetadata } from './identity-metadata.ts';
import type { SessionUser } from './session';

type Env = App.Platform['env'];

export type BearerAuth =
	| { ok: true; user: SessionUser }
	| { ok: false; reason: 'no_token' | 'invalid_token' | 'identity_unavailable' };

export async function authenticateBearer(
	env: Env,
	authorization: string | null
): Promise<BearerAuth> {
	const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
	if (!token) return { ok: false, reason: 'no_token' };

	let info: { sub?: string; email?: string | null; name?: string | null };
	try {
		const { userinfo_endpoint } = await getMetadata(env.IDENTITY_ISSUER);
		const res = await fetch(userinfo_endpoint, {
			headers: { authorization: `Bearer ${token}` }
		});
		// A definite answer of "no" is an invalid token, not an outage.
		if (res.status === 401 || res.status === 403) return { ok: false, reason: 'invalid_token' };
		if (!res.ok) throw new Error(`userinfo ${res.status}`);
		info = (await res.json()) as typeof info;
		if (typeof info.sub !== 'string' || !info.sub) throw new Error('userinfo missing sub');
	} catch (error) {
		console.error('bearer userinfo check failed', error);
		return { ok: false, reason: 'identity_unavailable' };
	}

	const user: SessionUser = {
		id: info.sub,
		email: info.email ?? '',
		name: info.name ?? info.email ?? info.sub
	};
	await env.DB.prepare(
		`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name`
	)
		.bind(user.id, user.email, user.name, Date.now())
		.run();
	return { ok: true, user };
}
