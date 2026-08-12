import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/environment';

// The `__Host-` prefix pins a cookie to this exact host with Secure+Path=/ and
// no Domain, so a sibling *.southbag.cc app can't shadow it (cookie tossing).
// The prefix mandates Secure, which http://localhost can't satisfy, so it's
// production-only. `hostPrefixed()` keeps read/write sites in agreement.
export function hostPrefixed(name: string): string {
	return dev ? name : `__Host-${name}`;
}

export const SESSION_COOKIE = hostPrefixed('sb_drive_session');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
	id: string;
	email: string;
	name: string;
}

export async function createSession(
	db: D1Database,
	userId: string,
	idToken?: string | null
): Promise<string> {
	const id = crypto.randomUUID();
	const now = Date.now();
	// Opportunistically reap this user's expired rows so the table doesn't grow
	// unbounded across logins (there's no background job on the free plan).
	await db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now).run();
	await db
		.prepare(
			'INSERT INTO sessions (id, user_id, created_at, expires_at, id_token) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(id, userId, now, now + SESSION_TTL_MS, idToken ?? null)
		.run();
	return id;
}

export async function takeSessionIdToken(
	db: D1Database,
	cookies: Cookies
): Promise<string | null> {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (!sessionId) return null;
	const row = await db
		.prepare('SELECT id_token FROM sessions WHERE id = ?')
		.bind(sessionId)
		.first<{ id_token: string | null }>();
	return row?.id_token ?? null;
}

export function setSessionCookie(cookies: Cookies, sessionId: string) {
	cookies.set(SESSION_COOKIE, sessionId, {
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		path: '/',
		maxAge: SESSION_TTL_MS / 1000
	});
}

export async function destroySession(db: D1Database, cookies: Cookies) {
	const sessionId = cookies.get(SESSION_COOKIE);
	if (sessionId) {
		await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

export async function loadSessionUser(
	db: D1Database,
	sessionId: string
): Promise<SessionUser | null> {
	const row = await db
		.prepare(
			`SELECT users.id AS id, users.email AS email, users.name AS name, sessions.expires_at AS expires_at
			 FROM sessions INNER JOIN users ON users.id = sessions.user_id
			 WHERE sessions.id = ?`
		)
		.bind(sessionId)
		.first<{ id: string; email: string; name: string; expires_at: number }>();

	if (!row || row.expires_at < Date.now()) return null;
	return { id: row.id, email: row.email, name: row.name };
}

export async function upsertUser(
	db: D1Database,
	user: { id: string; email: string; name: string }
) {
	await db
		.prepare(
			`INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name`
		)
		.bind(user.id, user.email, user.name, Date.now())
		.run();
}
