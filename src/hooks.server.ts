import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, loadSessionUser } from '$lib/server/session';

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

	return resolve(event);
};
