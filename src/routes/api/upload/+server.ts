import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	QUOTA_BYTES,
	insertFileIfWithinQuota,
	purgeObject,
	sanitizeFileName,
	storageUsed
} from '$lib/server/files';

// Uploads are raw-body PUTs streamed straight into R2 — no multipart parsing,
// so a 100MB file never has to fit in Worker memory.
export const PUT: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });
	const { DB, BUCKET } = platform.env;

	// A truly absent Content-Length can't be metered up front. Number(null) is
	// 0, which would otherwise sail past the guards, so check the raw header.
	const rawLength = request.headers.get('content-length');
	if (rawLength === null) {
		return json(
			{ error: 'length_required', message: 'Declare your Content-Length. Files must be weighed.' },
			{ status: 411 }
		);
	}
	const declaredLength = Number(rawLength);
	// Empty uploads consume no quota, so unlimited ones would defeat the cap —
	// a real file has at least one byte.
	if (!Number.isInteger(declaredLength) || declaredLength < 1) {
		return json(
			{ error: 'empty_file', message: 'Empty files are not files. Upload at least one (1) byte.' },
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
	const r2Key = `u/${locals.user.id}/${id}`;

	// R2 needs a known body length. In the real Workers runtime we pin it with
	// FixedLengthStream; in local `vite dev` (Node) that global doesn't exist,
	// so buffer instead — memory is only a concern in production.
	let payload: ReadableStream | ArrayBuffer;
	if (request.body && typeof FixedLengthStream === 'function') {
		const fixed = new FixedLengthStream(declaredLength);
		void request.body.pipeTo(fixed.writable).catch(() => {});
		payload = fixed.readable;
	} else {
		payload = await request.arrayBuffer();
	}

	let size: number;
	try {
		const object = await BUCKET.put(r2Key, payload, {
			httpMetadata: { contentType }
		});
		if (!object) return json({ error: 'storage_error' }, { status: 500 });
		size = object.size;
	} catch (err) {
		console.error('R2 put failed:', err);
		return json({ error: 'storage_error' }, { status: 500 });
	}

	// An upload that arrives smaller than declared is corrupt, not a smaller
	// file — refuse it, and durably remove the partial object.
	if (size !== declaredLength) {
		await purgeObject(platform, r2Key);
		return json({ error: 'size_mismatch', declared: declaredLength, received: size }, { status: 400 });
	}

	const inserted = await insertFileIfWithinQuota(DB, {
		id,
		user_id: locals.user.id,
		name,
		size,
		content_type: contentType,
		r2_key: r2Key,
		created_at: Date.now()
	});

	if (!inserted) {
		await purgeObject(platform, r2Key);
		return json(storageFull(), { status: 413 });
	}

	return json({ id, name, size }, { status: 201 });
};

function storageFull() {
	return {
		error: 'storage_full',
		message:
			'Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks (100MB) per account. Try deleting something.'
	};
}
