export const QUOTA_BYTES = 100 * 1024 * 1024; // 100MB per customer. No exceptions. Not even for Kevin.

// A byte quota alone can't bound zero-byte files, so cap the row/object count
// too. 71.1 floppies of 500-byte files is already absurd; 2000 is generous.
export const MAX_FILES = 2000;

export interface FileRow {
	id: string;
	user_id: string;
	name: string;
	size: number;
	content_type: string;
	r2_key: string;
	share_token: string | null;
	created_at: number;
}

// Lone (unpaired) surrogates are legal in NTFS filenames but make
// encodeURIComponent — used to build Content-Disposition — throw. Valid pairs
// are preserved so emoji filenames survive.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export function sanitizeFileName(raw: string): string {
	const cleaned = raw
		.replace(/[\x00-\x1f\x7f]/g, '')
		.replace(LONE_SURROGATE, '')
		.replaceAll('/', '_')
		.replaceAll('\\', '_')
		.trim();
	if (!cleaned) return 'unnamed.file';
	if (cleaned.length <= 200) return cleaned;
	// Truncating can split a surrogate pair, so strip again after slicing.
	const truncated = cleaned.slice(cleaned.length - 200).replace(LONE_SURROGATE, '');
	return truncated || 'unnamed.file';
}

export function contentDispositionAttachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'");
	let encoded: string;
	try {
		encoded = encodeURIComponent(name).replace(
			/['()*]/g,
			(c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
		);
	} catch {
		// Defence in depth: sanitizeFileName already strips lone surrogates,
		// but never let a name break the download response.
		encoded = encodeURIComponent(ascii);
	}
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function listFiles(db: D1Database, userId: string): Promise<FileRow[]> {
	const { results } = await db
		.prepare('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC')
		.bind(userId)
		.all<FileRow>();
	return results;
}

export async function getFile(db: D1Database, userId: string, id: string): Promise<FileRow | null> {
	return db
		.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.first<FileRow>();
}

export async function getFileByShareToken(db: D1Database, token: string): Promise<FileRow | null> {
	return db.prepare('SELECT * FROM files WHERE share_token = ?').bind(token).first<FileRow>();
}

export async function storageUsed(db: D1Database, userId: string): Promise<number> {
	const row = await db
		.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = ?')
		.bind(userId)
		.first<{ used: number }>();
	return row?.used ?? 0;
}

/**
 * Insert a file row only if it fits in both the byte quota AND the file-count
 * cap. Both checks and the insert happen in one statement so concurrent
 * uploads can't race past either limit. Returns false when storage is full.
 */
export async function insertFileIfWithinQuota(
	db: D1Database,
	file: Omit<FileRow, 'share_token'>
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO files (id, user_id, name, size, content_type, r2_key, share_token, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, NULL, ?
			 WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = ?) + ? <= ?
			   AND (SELECT COUNT(*) FROM files WHERE user_id = ?) < ?`
		)
		.bind(
			file.id,
			file.user_id,
			file.name,
			file.size,
			file.content_type,
			file.r2_key,
			file.created_at,
			file.user_id,
			file.size,
			QUOTA_BYTES,
			file.user_id,
			MAX_FILES
		)
		.run();
	return result.meta.changes > 0;
}

export async function renameFile(
	db: D1Database,
	userId: string,
	id: string,
	name: string
): Promise<boolean> {
	const result = await db
		.prepare('UPDATE files SET name = ? WHERE id = ? AND user_id = ?')
		.bind(name, id, userId)
		.run();
	return result.meta.changes > 0;
}

export async function deleteFileRow(db: D1Database, userId: string, id: string): Promise<boolean> {
	const result = await db
		.prepare('DELETE FROM files WHERE id = ? AND user_id = ?')
		.bind(id, userId)
		.run();
	return result.meta.changes > 0;
}

export async function setShareToken(
	db: D1Database,
	userId: string,
	id: string,
	token: string | null
): Promise<boolean> {
	const result = await db
		.prepare('UPDATE files SET share_token = ? WHERE id = ? AND user_id = ?')
		.bind(token, id, userId)
		.run();
	return result.meta.changes > 0;
}

/**
 * Delete an R2 object such that the delete still completes even if the client
 * disconnects mid-request: we register it with `waitUntil` (production Workers)
 * AND await it, so an orphaned object never survives a compensating cleanup.
 *
 * Resolves true only when the object is really gone. Callers that free quota
 * MUST check this — dropping the row after a failed delete would leave bytes
 * stored but uncharged.
 */
export function purgeObject(
	platform: Readonly<App.Platform> | undefined,
	r2Key: string
): Promise<boolean> {
	const bucket = platform?.env.BUCKET;
	if (!bucket) return Promise.resolve(false);
	const done = bucket
		.delete(r2Key)
		.then(() => true)
		.catch((err) => {
			console.error('R2 delete failed (possible orphan):', r2Key, err);
			return false;
		});
	// `context` is absent under the local vite platform proxy; await still runs.
	platform?.context?.waitUntil?.(done);
	return done;
}
