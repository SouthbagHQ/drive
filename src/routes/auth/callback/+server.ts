import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OIDC_COOKIE, exchangeCode, fetchUserinfo } from '$lib/server/oidc';
import { createSession, setSessionCookie, upsertUser } from '$lib/server/session';
import { capture, identify, palantirOptions } from '$lib/server/palantir';

export const GET: RequestHandler = async ({ url, platform, cookies, request }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const palantir = palantirOptions(request, platform);
	// Explicitly typed so TypeScript treats each call as a control-flow exit.
	const denied: (reason: string) => never = (reason) => {
		capture('drive_login_failed', undefined, { reason }, palantir);
		redirect(302, `/?denied=${encodeURIComponent(reason)}`);
	};

	const stored = cookies.get(OIDC_COOKIE);
	cookies.delete(OIDC_COOKIE, { path: '/' });

	if (url.searchParams.get('error')) denied(url.searchParams.get('error')!);

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state || !stored) denied('missing_bits');

	let tx: { s: string; v: string };
	try {
		tx = JSON.parse(atob(stored));
	} catch {
		denied('cookie_soup');
	}
	if (tx.s !== state) denied('state_mismatch');

	let user: { id: string; email: string; name: string };
	let idToken: string | null = null;
	try {
		const tokens = await exchangeCode(platform.env, code, tx.v);
		idToken = tokens.id_token ?? null;
		const info = await fetchUserinfo(platform.env, tokens.access_token);
		user = { id: info.sub, email: info.email ?? '', name: info.name ?? '' };
		await upsertUser(platform.env.DB, user);
	} catch (err) {
		console.error('OIDC callback failed:', err);
		denied('identity_crisis');
	}

	const sessionId = await createSession(platform.env.DB, user.id, idToken);
	setSessionCookie(cookies, sessionId);
	// Merge the anonymous browser identity into the Identity user, then log the sign-in.
	identify(user.id, { email: user.email, name: user.name }, palantir);
	capture('drive_login_completed', user.id, {}, palantir);
	redirect(302, '/files');
};
