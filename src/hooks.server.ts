import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, loadSessionUser } from '$lib/server/session';
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
