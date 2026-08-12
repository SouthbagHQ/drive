import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import {
	OIDC_COOKIE,
	buildAuthorizeUrl,
	generateCodeChallenge,
	generateCodeVerifier,
	generateState
} from '$lib/server/oidc';

export const GET: RequestHandler = async ({ locals, platform, cookies }) => {
	if (locals.user) redirect(302, '/files');
	if (!platform) error(500, 'Platform bindings unavailable');

	const state = generateState();
	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);

	cookies.set(OIDC_COOKIE, btoa(JSON.stringify({ s: state, v: verifier })), {
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		path: '/',
		maxAge: 600
	});

	redirect(302, await buildAuthorizeUrl(platform.env, state, challenge));
};
