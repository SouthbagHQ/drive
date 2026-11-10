import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, loadSessionUser } from '$lib/server/session';
import { authenticateBearer } from '$lib/server/bearer';
import { authenticateWebdav } from '$lib/server/webdav-auth';
import { isWebdavPath } from '$lib/server/webdav-util';
import { centralStatus, frozenResponse, FROZEN_TEXT, STATUS_UNKNOWN_TEXT } from '$lib/server/identity';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.sessionId = null;

	const db = event.platform?.env.DB;
	const sessionId = event.cookies.get(SESSION_COOKIE);
	if (db && sessionId) {
		const user = await loadSessionUser(db, sessionId);
		if (user) {
			event.locals.user = user;
			event.locals.sessionId = sessionId;
		} else {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		}
	}

	// WebDAV clients speak Basic, not cookies. A session still wins if both
	// are present so the browser listing at /webdav/ works after login.
	if (!event.locals.user && db && isWebdavPath(event.url.pathname)) {
		event.locals.user = await authenticateWebdav(db, event.request.headers.get('authorization'));
	}

	// Native clients (Southbag Browser on Southbag OS) hold an Identity access
	// token instead of a cookie session and present it as a bearer token on the
	// API. Validated fresh against Identity; fail closed when Identity is down.
	if (
		!event.locals.user &&
		db &&
		event.platform?.env &&
		event.url.pathname.startsWith('/api/') &&
		event.request.headers.get('authorization')
	) {
		const bearer = await authenticateBearer(
			event.platform.env,
			event.request.headers.get('authorization')
		);
		if (bearer.ok) {
			event.locals.user = bearer.user;
		} else if (bearer.reason === 'identity_unavailable') {
			return new Response(
				'Southbag Identity is unavailable, so your sign-in cannot be checked. Try again shortly.',
				{ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
			);
		}
	}

	// The account-level freeze covers everything a signed-in user can do, reads included -
	// every file here is private account data. While the central answer is UNKNOWN (Identity
	// configured but unreachable) EVERYTHING fails closed. Logout stays reachable.
	if (event.locals.user && event.platform?.env && !event.url.pathname.startsWith('/auth/')) {
		const central = await centralStatus(event.platform.env, event.locals.user.id);
		if (central === 'unknown')
			return frozenResponse(event.url.pathname, STATUS_UNKNOWN_TEXT, 503);
		if (central !== 'off' && central.frozen)
			return frozenResponse(event.url.pathname, FROZEN_TEXT, 423);
	}

	return resolve(event);
};
