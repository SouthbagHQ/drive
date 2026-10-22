// Southbag Office™ storage. Office keeps every document in Drive as an
// ordinary encrypted .southbag* file, reached over a Cloudflare service binding
// (see office-entrypoint.ts). Drive never sees plaintext: Office encrypts and
// decrypts packages with a key only Office holds.
//
// Only relative imports here: wrangler bundles this file straight into the
// built worker, outside of Vite's `$lib` / `$app` aliases.

import { CHUNK_BYTES, MAX_FILES, QUOTA_BYTES, fileBody, sanitizeFileName } from './files';

export const OFFICE_KINDS = {
	doc: { extension: 'southbagdocs', contentType: 'application/vnd.southbag.docs', code: 1 },
	slides: { extension: 'southbagslides', contentType: 'application/vnd.southbag.slides', code: 2 },
	sheet: { extension: 'southbagsheets', contentType: 'application/vnd.southbag.sheets', code: 3 }
} as const;
export type OfficeKind = keyof typeof OFFICE_KINDS;

/** Office's encrypted package cap; anything larger is not an Office document. */
export const MAX_OFFICE_PACKAGE_BYTES = 2_500_000;
/** Office keeps at most this many tombstones in a workspace. */
export const MAX_OFFICE_TOMBSTONES = 1000;
const MAX_OFFICE_ID_LENGTH = 160;
const PENDING = 'pending:';
const MAGIC = new TextEncoder().encode('SOUTHBAG');

export interface OfficeUser {
	sub: string;
	email: string;
	name: string;
}

export interface OfficePackage {
	driveFileId: string;
	/** Null until Office adopts a package that was uploaded straight into Drive. */
	officeId: string | null;
	name: string;
	kind: OfficeKind;
	modified: string | null;
	bytes: Uint8Array;
}

export interface OfficeIndexEntry {
	driveFileId: string;
	officeId: string;
	modified: string | null;
}

interface OfficeState {
	/** False until the user's first Office save lands in Drive. */
	exists: boolean;
	revision: number;
	updatedAt: string;
	deletedIds: string[];
}

export interface OfficeSnapshot extends OfficeState {
	packages: OfficePackage[];
}

export interface OfficeIndex extends OfficeState {
	entries: OfficeIndexEntry[];
}

export interface OfficeUpsert {
	officeId: string;
	kind: OfficeKind;
	title: string;
	modified: string;
	bytes: Uint8Array;
}

export interface OfficeCommit {
	expectedRevision: number;
	deletedIds: string[];
	upserts: OfficeUpsert[];
}

export type OfficeCommitResult =
	| { ok: true; revision: number; updatedAt: string; skipped: string[] }
	| { ok: false; reason: 'conflict' | 'invalid' | 'storage_full' | 'storage_error'; revision: number };

export interface OfficeAdoption {
	driveFileId: string;
	officeId: string;
	modified: string;
}

export function officeKindOf(name: string): OfficeKind | null {
	const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
	for (const [kind, spec] of Object.entries(OFFICE_KINDS)) {
		if (spec.extension === extension) return kind as OfficeKind;
	}
	return null;
}

/** Drive filename for an Office document: the title, forced onto the right extension. */
export function officeFileName(title: string, kind: OfficeKind): string {
	const { extension } = OFFICE_KINDS[kind];
	const stem = sanitizeFileName(title).slice(0, 180).replace(/[. ]+$/, '') || 'Untitled';
	return `${stem}.${extension}`;
}

/** Cheap structural check: Drive can't decrypt, but it can refuse non-packages. */
export function isOfficePackage(bytes: Uint8Array, kind: OfficeKind): boolean {
	return (
		bytes.byteLength > MAGIC.length + 2 &&
		bytes.byteLength <= MAX_OFFICE_PACKAGE_BYTES &&
		MAGIC.every((byte, index) => bytes[index] === byte) &&
		bytes[MAGIC.length + 1] === OFFICE_KINDS[kind].code
	);
}

function validOfficeId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_OFFICE_ID_LENGTH &&
		!value.startsWith(PENDING)
	);
}

function now(): string {
	return new Date().toISOString();
}

/** Office users authenticate with the same Southbag Identity, so `sub` is the Drive user id. */
export async function ensureOfficeUser(db: D1Database, user: OfficeUser) {
	if (!validOfficeId(user.sub) || typeof user.email !== 'string') throw new Error('Invalid Office user');
	await db
		.prepare('INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)')
		.bind(user.sub, user.email, typeof user.name === 'string' ? user.name : '', Date.now())
		.run();
}

async function readState(db: D1Database, userId: string): Promise<OfficeState> {
	const [workspace, tombstones] = await db.batch<{
		revision?: number;
		updated_at?: string;
		office_id?: string;
	}>([
		db.prepare('SELECT revision, updated_at FROM office_workspaces WHERE user_id = ?').bind(userId),
		db
			.prepare(
				'SELECT office_id FROM office_tombstones WHERE user_id = ? ORDER BY deleted_at DESC LIMIT ?'
			)
			.bind(userId, MAX_OFFICE_TOMBSTONES)
	]);
	const row = workspace.results[0];
	return {
		exists: Boolean(row),
		revision: row?.revision ?? 0,
		updatedAt: row?.updated_at ?? '',
		deletedIds: tombstones.results.map((tombstone) => tombstone.office_id!)
	};
}

type OfficeRow = {
	id: string;
	name: string;
	size: number;
	office_id: string | null;
	office_modified: string | null;
	created_at: number;
};

/** Adopted rows, newest Drive copy per Office id. */
async function adoptedRows(db: D1Database, userId: string): Promise<OfficeRow[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, size, office_id, office_modified, created_at FROM files
			 WHERE user_id = ? AND office_id IS NOT NULL AND office_id NOT LIKE 'pending:%'
			 ORDER BY created_at DESC`
		)
		.bind(userId)
		.all<OfficeRow>();
	const seen = new Set<string>();
	return results.filter((row) => !seen.has(row.office_id!) && seen.add(row.office_id!));
}

/** .southbag* files uploaded straight into Drive (files page or WebDAV). */
async function unadoptedRows(db: D1Database, userId: string): Promise<OfficeRow[]> {
	const { results } = await db
		.prepare(
			`SELECT id, name, size, office_id, office_modified, created_at FROM files
			 WHERE user_id = ? AND office_id IS NULL AND size <= ?
			   AND (name LIKE '%.southbagdocs' OR name LIKE '%.southbagslides' OR name LIKE '%.southbagsheets')
			 ORDER BY created_at DESC`
		)
		.bind(userId, MAX_OFFICE_PACKAGE_BYTES)
		.all<OfficeRow>();
	return results;
}

async function readBytes(db: D1Database, id: string, size: number): Promise<Uint8Array> {
	return new Uint8Array(await new Response(fileBody(db, id, size)).arrayBuffer());
}

export async function officeIndex(db: D1Database, user: OfficeUser): Promise<OfficeIndex> {
	await ensureOfficeUser(db, user);
	const [state, rows] = await Promise.all([readState(db, user.sub), adoptedRows(db, user.sub)]);
	return {
		...state,
		entries: rows.map((row) => ({
			driveFileId: row.id,
			officeId: row.office_id!,
			modified: row.office_modified
		}))
	};
}

/** Everything Office needs to rebuild a workspace, packages included. */
export async function loadOfficeSnapshot(db: D1Database, user: OfficeUser): Promise<OfficeSnapshot> {
	await ensureOfficeUser(db, user);
	const [state, adopted, unadopted] = await Promise.all([
		readState(db, user.sub),
		adoptedRows(db, user.sub),
		unadoptedRows(db, user.sub)
	]);
	const packages: OfficePackage[] = [];
	for (const row of [...adopted, ...unadopted]) {
		const kind = officeKindOf(row.name);
		if (!kind) continue;
		try {
			packages.push({
				driveFileId: row.id,
				officeId: row.office_id,
				name: row.name,
				kind,
				modified: row.office_modified,
				bytes: await readBytes(db, row.id, row.size)
			});
		} catch (error) {
			// A missing chunk shouldn't take the whole workspace down with it.
			console.error('Office package unreadable:', row.id, error);
		}
	}
	return { ...state, packages };
}

async function claimRevision(db: D1Database, userId: string, expected: number): Promise<boolean> {
	const statement =
		expected === 0
			? db
					.prepare(
						'INSERT INTO office_workspaces (user_id, revision, updated_at) VALUES (?, 1, ?) ON CONFLICT (user_id) DO NOTHING'
					)
					.bind(userId, now())
			: db
					.prepare(
						'UPDATE office_workspaces SET revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?'
					)
					.bind(now(), userId, expected);
	return (await statement.run()).meta.changes > 0;
}

async function bumpRevision(db: D1Database, userId: string) {
	await db
		.prepare(
			`INSERT INTO office_workspaces (user_id, revision, updated_at) VALUES (?, 1, ?)
			 ON CONFLICT (user_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`
		)
		.bind(userId, now())
		.run();
}

async function tombstonedIds(db: D1Database, userId: string): Promise<Set<string>> {
	const { results } = await db
		.prepare('SELECT office_id FROM office_tombstones WHERE user_id = ?')
		.bind(userId)
		.all<{ office_id: string }>();
	return new Set(results.map((row) => row.office_id));
}

/**
 * Write a new Drive version of an Office document. The new row is quota-checked
 * as if the old versions were already gone, written under a `pending:` id so
 * nothing else sees it half-done, then swapped in atomically.
 */
async function writeOfficeFile(
	db: D1Database,
	userId: string,
	upsert: OfficeUpsert
): Promise<'ok' | 'storage_full' | 'storage_error'> {
	const { results: previous } = await db
		.prepare('SELECT id, share_token FROM files WHERE user_id = ? AND office_id = ?')
		.bind(userId, upsert.officeId)
		.all<{ id: string; share_token: string | null }>();
	const id = crypto.randomUUID();
	const size = upsert.bytes.byteLength;
	const inserted = await db
		.prepare(
			`INSERT INTO files (id, user_id, name, size, content_type, r2_key, share_token, created_at, office_id, office_modified)
			 SELECT ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
			 WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = ? AND office_id IS NOT ?) + ? <= ?
			   AND (SELECT COUNT(*) FROM files WHERE user_id = ? AND office_id IS NOT ?) < ?`
		)
		.bind(
			id,
			userId,
			officeFileName(upsert.title, upsert.kind),
			size,
			OFFICE_KINDS[upsert.kind].contentType,
			id,
			Date.now(),
			PENDING + upsert.officeId,
			upsert.modified,
			userId,
			upsert.officeId,
			size,
			QUOTA_BYTES,
			userId,
			upsert.officeId,
			MAX_FILES
		)
		.run();
	if (inserted.meta.changes === 0) return 'storage_full';

	try {
		const chunks: D1PreparedStatement[] = [];
		for (let offset = 0, index = 0; offset < size; offset += CHUNK_BYTES, index++) {
			const chunk = upsert.bytes.slice(offset, offset + CHUNK_BYTES);
			chunks.push(
				db
					.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)')
					.bind(id, index, chunk.buffer)
			);
		}
		if (chunks.length) await db.batch(chunks);

		// Claim the id before deleting old versions so the deletion trigger sees
		// a surviving copy and doesn't tombstone the document. The share link
		// follows the document to its newest version.
		const shareToken = previous.find((row) => row.share_token)?.share_token ?? null;
		await db.batch([
			db.prepare('UPDATE files SET office_id = ? WHERE id = ?').bind(upsert.officeId, id),
			...previous.map((row) =>
				db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').bind(row.id, userId)
			),
			db.prepare('UPDATE files SET share_token = ? WHERE id = ?').bind(shareToken, id)
		]);
		return 'ok';
	} catch (error) {
		console.error('Office file write failed:', error);
		await db.prepare('DELETE FROM files WHERE id = ?').bind(id).run();
		return 'storage_error';
	}
}

function validUpsert(upsert: OfficeUpsert): boolean {
	return (
		Boolean(upsert) &&
		validOfficeId(upsert.officeId) &&
		Object.hasOwn(OFFICE_KINDS, upsert.kind) &&
		typeof upsert.title === 'string' &&
		typeof upsert.modified === 'string' &&
		upsert.modified.length <= 64 &&
		upsert.bytes instanceof Uint8Array &&
		isOfficePackage(upsert.bytes, upsert.kind)
	);
}

/**
 * Apply an Office save. Optimistic: `expectedRevision` must match. Tombstones
 * are recorded first and always win, so upserts for deleted ids are skipped and
 * reported back for Office to reconcile.
 */
export async function commitOfficeWorkspace(
	db: D1Database,
	user: OfficeUser,
	commit: OfficeCommit
): Promise<OfficeCommitResult> {
	await ensureOfficeUser(db, user);
	const userId = user.sub;
	const currentRevision = async () => (await readState(db, userId)).revision;

	if (
		!Number.isInteger(commit.expectedRevision) ||
		commit.expectedRevision < 0 ||
		!Array.isArray(commit.deletedIds) ||
		commit.deletedIds.length > MAX_OFFICE_TOMBSTONES ||
		!commit.deletedIds.every(validOfficeId) ||
		!Array.isArray(commit.upserts) ||
		!commit.upserts.every(validUpsert)
	) {
		return { ok: false, reason: 'invalid', revision: await currentRevision() };
	}
	if (!(await claimRevision(db, userId, commit.expectedRevision))) {
		return { ok: false, reason: 'conflict', revision: await currentRevision() };
	}

	const tombstoned = await tombstonedIds(db, userId);
	const fresh = [...new Set(commit.deletedIds)].filter((id) => !tombstoned.has(id));
	if (fresh.length) {
		const deletedAt = now();
		// Tombstone first, then delete: the trigger then has nothing left to do.
		await db.batch(
			fresh.flatMap((officeId) => [
				db
					.prepare(
						'INSERT OR IGNORE INTO office_tombstones (user_id, office_id, deleted_at) VALUES (?, ?, ?)'
					)
					.bind(userId, officeId, deletedAt),
				db.prepare('DELETE FROM files WHERE user_id = ? AND office_id = ?').bind(userId, officeId)
			])
		);
		for (const id of fresh) tombstoned.add(id);
	}

	const skipped: string[] = [];
	for (const upsert of commit.upserts) {
		if (tombstoned.has(upsert.officeId)) {
			skipped.push(upsert.officeId);
			continue;
		}
		const written = await writeOfficeFile(db, userId, upsert);
		if (written !== 'ok') return { ok: false, reason: written, revision: await currentRevision() };
	}

	const state = await readState(db, userId);
	return { ok: true, revision: state.revision, updatedAt: state.updatedAt, skipped };
}

/** Give .southbag* files uploaded directly to Drive an Office id. */
export async function adoptOfficePackages(
	db: D1Database,
	user: OfficeUser,
	adoptions: OfficeAdoption[]
): Promise<{ revision: number; updatedAt: string; adopted: string[] }> {
	await ensureOfficeUser(db, user);
	const adopted: string[] = [];
	const valid = Array.isArray(adoptions)
		? adoptions.filter(
				(item) =>
					item &&
					typeof item.driveFileId === 'string' &&
					validOfficeId(item.officeId) &&
					typeof item.modified === 'string' &&
					item.modified.length <= 64
			)
		: [];
	if (valid.length) {
		const results = await db.batch(
			valid.map((item) =>
				db
					.prepare(
						`UPDATE files SET office_id = ?, office_modified = ?
						 WHERE id = ? AND user_id = ? AND office_id IS NULL
						   AND NOT EXISTS (SELECT 1 FROM office_tombstones WHERE user_id = ? AND office_id = ?)`
					)
					.bind(item.officeId, item.modified, item.driveFileId, user.sub, user.sub, item.officeId)
			)
		);
		results.forEach((result, index) => {
			if (result.meta.changes > 0) adopted.push(valid[index].driveFileId);
		});
		if (adopted.length) await bumpRevision(db, user.sub);
	}
	const state = await readState(db, user.sub);
	return { revision: state.revision, updatedAt: state.updatedAt, adopted };
}
