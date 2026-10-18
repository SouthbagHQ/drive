export const QUOTA_BYTES = 100 * 1024 * 1024; // 100MB per customer. No exceptions. Not even for Kevin.

// A byte quota alone can't bound zero-byte files, so cap the row/object count
// too. 71.1 floppies of 500-byte files is already absurd; 2000 is generous.
export const MAX_FILES = 2000;
export const CHUNK_BYTES = 1024 * 1024;

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

export async function getFileByName(
	db: D1Database,
	userId: string,
	name: string
): Promise<FileRow | null> {
	return db
		.prepare(
			'SELECT * FROM files WHERE user_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1'
		)
		.bind(userId, name)
		.first<FileRow>();
}

/**
 * Insert a file row only if it fits in both the byte quota AND the file-count
 * cap. Both checks and the insert happen in one statement so concurrent
 * uploads can't race past either limit. Returns false when storage is full.
 */
export async function insertFileIfWithinQuota(
	db: D1Database,
	file: Omit<FileRow, 'share_token'>,
	options: { exceptFileId?: string | null } = {}
): Promise<boolean> {
	const exceptFileId = options.exceptFileId ?? null;
	const result = await db
		.prepare(
			`INSERT INTO files (id, user_id, name, size, content_type, r2_key, share_token, created_at)
			 SELECT ?, ?, ?, ?, ?, ?, NULL, ?
			 WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE user_id = ? AND (? IS NULL OR id != ?)) + ? <= ?
			   AND (SELECT COUNT(*) FROM files WHERE user_id = ? AND (? IS NULL OR id != ?)) < ?`
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
			exceptFileId,
			exceptFileId,
			file.size,
			QUOTA_BYTES,
			file.user_id,
			exceptFileId,
			exceptFileId,
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

export function fileBody(db: D1Database, id: string, size: number) {
	return fileBodyRange(db, id, size, 0, Math.max(0, size - 1));
}

/** Inclusive `start`/`end`. Empty files produce an immediately-closing stream. */
export function fileBodyRange(db: D1Database, id: string, size: number, start: number, end: number) {
	if (size <= 0 || end < start) {
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			}
		});
	}
	let remaining = end - start + 1;
	let index = Math.floor(start / CHUNK_BYTES);
	let skip = start % CHUNK_BYTES;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (remaining <= 0) return controller.close();
			const row = await db
				.prepare('SELECT data FROM file_chunks WHERE file_id = ? AND chunk_index = ?')
				.bind(id, index++)
				.first<{ data: ArrayBuffer }>();
			if (!row) return controller.error(new Error('File chunk missing'));
			let data = new Uint8Array(row.data);
			if (skip) {
				data = data.subarray(skip);
				skip = 0;
			}
			if (data.length > remaining) data = data.subarray(0, remaining);
			remaining -= data.length;
			controller.enqueue(data);
		}
	});
}

export type StoreFileResult =
	| { ok: true; id: string; name: string; size: number; chunks: number }
	| {
			ok: false;
			error: 'empty_file' | 'storage_full' | 'size_mismatch' | 'storage_error' | 'too_large';
			declared?: number;
			received?: number;
	  };

/**
 * Reserve quota with a conditional INSERT, then stream the body into 1MB D1
 * chunks. `replaceFileId` (if set) is excluded from the quota/count checks and
 * deleted only after the new object is fully written.
 */
export async function storeRequestBodyAsFile(
	db: D1Database,
	args: {
		userId: string;
		name: string;
		contentType: string;
		body: ReadableStream<Uint8Array> | null;
		declaredLength: number;
		allowEmpty?: boolean;
		replaceFileId?: string | null;
	}
): Promise<StoreFileResult> {
	const { userId, name, contentType, body, declaredLength, allowEmpty, replaceFileId } = args;
	if (!Number.isInteger(declaredLength) || declaredLength < 0) {
		return { ok: false, error: 'empty_file', declared: declaredLength };
	}
	if (declaredLength === 0 && !allowEmpty) {
		return { ok: false, error: 'empty_file', declared: 0 };
	}
	if (declaredLength > QUOTA_BYTES) {
		return { ok: false, error: 'too_large', declared: declaredLength };
	}

	const id = crypto.randomUUID();
	const inserted = await insertFileIfWithinQuota(
		db,
		{
			id,
			user_id: userId,
			name,
			size: declaredLength,
			content_type: contentType,
			r2_key: id,
			created_at: Date.now()
		},
		{ exceptFileId: replaceFileId }
	);
	if (!inserted) return { ok: false, error: 'storage_full', declared: declaredLength };

	let received = 0;
	let chunks = 0;
	if (declaredLength > 0) {
		let index = 0;
		let pending = new Uint8Array();
		const reader = body?.getReader();
		try {
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				const combined = new Uint8Array(pending.length + value.length);
				combined.set(pending);
				combined.set(value, pending.length);
				let offset = 0;
				while (combined.length - offset >= CHUNK_BYTES) {
					const chunk = combined.slice(offset, offset + CHUNK_BYTES);
					await db
						.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)')
						.bind(id, index++, chunk.buffer)
						.run();
					received += chunk.length;
					offset += CHUNK_BYTES;
				}
				pending = combined.slice(offset);
			}
			if (pending.length) {
				await db
					.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)')
					.bind(id, index, pending.buffer)
					.run();
				received += pending.length;
				index += 1;
			}
			chunks = index;
		} catch (err) {
			console.error('D1 file write failed:', err);
			await deleteFileRow(db, userId, id);
			return { ok: false, error: 'storage_error', declared: declaredLength, received };
		}
		if (received !== declaredLength) {
			await deleteFileRow(db, userId, id);
			return { ok: false, error: 'size_mismatch', declared: declaredLength, received };
		}
	}

	if (replaceFileId) await deleteFileRow(db, userId, replaceFileId);
	return { ok: true, id, name, size: received, chunks };
}

export async function copyFileToName(
	db: D1Database,
	userId: string,
	source: FileRow,
	destName: string,
	replaceFileId: string | null
): Promise<FileRow | null> {
	const id = crypto.randomUUID();
	const inserted = await insertFileIfWithinQuota(
		db,
		{
			id,
			user_id: userId,
			name: destName,
			size: source.size,
			content_type: source.content_type,
			r2_key: id,
			created_at: Date.now()
		},
		{ exceptFileId: replaceFileId }
	);
	if (!inserted) return null;
	try {
		if (source.size > 0) {
			await db
				.prepare(
					'INSERT INTO file_chunks (file_id, chunk_index, data) SELECT ?, chunk_index, data FROM file_chunks WHERE file_id = ?'
				)
				.bind(id, source.id)
				.run();
		}
	} catch (err) {
		console.error('D1 file copy failed:', err);
		await deleteFileRow(db, userId, id);
		return null;
	}
	if (replaceFileId) await deleteFileRow(db, userId, replaceFileId);
	return getFile(db, userId, id);
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
