import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	QUOTA_BYTES,
	CHUNK_BYTES,
	deleteFileRow,
	insertFileIfWithinQuota,
	sanitizeFileName,
	storageUsed
} from '$lib/server/files';

export const PUT: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });
	const { DB } = platform.env;

	// A truly absent Content-Length can't be metered up front. Number(null) is
	// 0, which would otherwise sail past the guards, so check the raw header.
	const rawLength = request.headers.get('content-length');
	if (rawLength === null) {
		return json(
			{ error: 'length_required', message: 'Upload rejected.' },
			{ status: 411 }
		);
	}
	const declaredLength = Number(rawLength);
	// Empty uploads consume no quota, so unlimited ones would defeat the cap —
	// a real file has at least one byte.
	if (!Number.isInteger(declaredLength) || declaredLength < 1) {
		return json(
			{ error: 'empty_file', message: 'Empty files cannot be uploaded.' },
			{ status: 400 }
		);
	}
	if (declaredLength > QUOTA_BYTES) {
		return json(storageFull(), { status: 413 });
	}

	// Fast-fail before consuming the body; the conditional INSERT below is the
	// authoritative check.
	const used = await storageUsed(DB, locals.user.id);
	if (used + declaredLength > QUOTA_BYTES) {
		return json(storageFull(), { status: 413 });
	}

	const rawName = request.headers.get('x-sb-filename') ?? '';
	let name: string;
	try {
		name = sanitizeFileName(decodeURIComponent(rawName));
	} catch {
		name = 'unnamed.file';
	}

	const contentType =
		request.headers.get('x-sb-content-type')?.slice(0, 120) || 'application/octet-stream';

	const id = crypto.randomUUID();
	const inserted = await insertFileIfWithinQuota(DB, {
		id,
		user_id: locals.user.id,
		name,
		size: declaredLength,
		content_type: contentType,
		r2_key: id,
		created_at: Date.now()
	});

	if (!inserted) {
		return json(storageFull(), { status: 413 });
	}

	let received = 0;
	let index = 0;
	let pending = new Uint8Array();
	const reader = request.body?.getReader();
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
				await DB.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)')
					.bind(id, index++, chunk.buffer)
					.run();
				received += chunk.length;
				offset += CHUNK_BYTES;
			}
			pending = combined.slice(offset);
		}
		if (pending.length) {
			await DB.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, ?, ?)')
				.bind(id, index, pending.buffer)
				.run();
			received += pending.length;
		}
	} catch (err) {
		console.error('D1 file write failed:', err);
		await deleteFileRow(DB, locals.user.id, id);
		return json({ error: 'storage_error' }, { status: 500 });
	}
	if (received !== declaredLength) {
		await deleteFileRow(DB, locals.user.id, id);
		return json({ error: 'size_mismatch', declared: declaredLength, received }, { status: 400 });
	}

	return json({ id, name, size: received }, { status: 201 });
};

function storageFull() {
	return {
		error: 'storage_full',
		message:
			'Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks per account. Try deleting something.'
	};
}
