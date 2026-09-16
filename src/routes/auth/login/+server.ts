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
import { capture, palantirOptions } from '$lib/server/palantir';

export const GET: RequestHandler = async ({ locals, platform, cookies, request }) => {
	if (locals.user) redirect(302, '/files');
	if (!platform) error(500, 'Platform bindings unavailable');

	capture('drive_login_started', undefined, {}, palantirOptions(request, platform));

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
