import type { SessionUser } from './session';
import { parseBasicAuth, sha256Hex, timingSafeEqual } from './webdav-util';

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
	return `sbdav_${encoded}`;
}

export async function issueWebdavToken(db: D1Database, userId: string): Promise<string> {
	const token = randomToken();
	const tokenHash = await sha256Hex(token);
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO webdav_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`
		)
		.bind(userId, tokenHash, now)
		.run();
	return token;
}

export async function revokeWebdavToken(db: D1Database, userId: string): Promise<boolean> {
	const result = await db.prepare('DELETE FROM webdav_tokens WHERE user_id = ?').bind(userId).run();
	return result.meta.changes > 0;
}

export async function hasWebdavToken(db: D1Database, userId: string): Promise<boolean> {
	const row = await db
		.prepare('SELECT user_id FROM webdav_tokens WHERE user_id = ?')
		.bind(userId)
		.first();
	return Boolean(row);
}

export async function authenticateWebdav(
	db: D1Database,
	authorization: string | null
): Promise<SessionUser | null> {
	const parsed = parseBasicAuth(authorization);
	if (!parsed?.password) return null;
	const tokenHash = await sha256Hex(parsed.password);
	const row = await db
		.prepare(
			`SELECT users.id AS id, users.email AS email, users.name AS name, webdav_tokens.token_hash AS token_hash
			 FROM webdav_tokens
			 INNER JOIN users ON users.id = webdav_tokens.user_id
			 WHERE users.id = ? OR lower(users.email) = lower(?)`
		)
		.bind(parsed.username, parsed.username)
		.first<{ id: string; email: string; name: string; token_hash: string }>();
	if (!row || !timingSafeEqual(row.token_hash, tokenHash)) return null;
	return { id: row.id, email: row.email, name: row.name };
}
