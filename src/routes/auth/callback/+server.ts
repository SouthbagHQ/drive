import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OIDC_COOKIE, exchangeCode, fetchUserinfo } from '$lib/server/oidc';
import { createSession, setSessionCookie, upsertUser } from '$lib/server/session';

export const GET: RequestHandler = async ({ url, platform, cookies }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const stored = cookies.get(OIDC_COOKIE);
	cookies.delete(OIDC_COOKIE, { path: '/' });

	if (url.searchParams.get('error')) {
		redirect(302, `/?denied=${encodeURIComponent(url.searchParams.get('error')!)}`);
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state || !stored) redirect(302, '/?denied=missing_bits');

	let tx: { s: string; v: string };
	try {
		tx = JSON.parse(atob(stored));
	} catch {
		redirect(302, '/?denied=cookie_soup');
	}
	if (tx.s !== state) redirect(302, '/?denied=state_mismatch');

	let userId: string;
	let idToken: string | null = null;
	try {
		const tokens = await exchangeCode(platform.env, code, tx.v);
		idToken = tokens.id_token ?? null;
		const info = await fetchUserinfo(platform.env, tokens.access_token);
		userId = info.sub;
		await upsertUser(platform.env.DB, {
			id: info.sub,
			email: info.email ?? '',
			name: info.name ?? ''
		});
	} catch (err) {
		console.error('OIDC callback failed:', err);
		redirect(302, '/?denied=identity_crisis');
	}

	const sessionId = await createSession(platform.env.DB, userId, idToken);
	setSessionCookie(cookies, sessionId);
	redirect(302, '/files');
};
