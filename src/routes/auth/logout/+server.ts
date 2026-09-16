import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { destroySession, takeSessionIdToken } from '$lib/server/session';
import { endSessionUrl } from '$lib/server/oidc';
import { capture, palantirOptions } from '$lib/server/palantir';

export const POST: RequestHandler = async ({ platform, cookies, locals, request }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	capture('drive_logout', locals.user?.id, {}, palantirOptions(request, platform));

	// Grab the id_token before we drop the session, so we can ask the identity
	// provider to end the SSO session too — otherwise "Sign out" only clears the
	// local session and the next visitor is silently re-logged-in.
	const idToken = await takeSessionIdToken(platform.env.DB, cookies);
	await destroySession(platform.env.DB, cookies);

	let target = '/';
	try {
		const end = await endSessionUrl(platform.env, idToken ?? undefined);
		if (end) target = end;
	} catch (err) {
		console.error('RP-initiated logout unavailable, falling back to local logout:', err);
	}

	redirect(302, target);
};
