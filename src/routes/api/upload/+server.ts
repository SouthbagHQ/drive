import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { QUOTA_BYTES, sanitizeFileName, storageUsed, storeRequestBodyAsFile } from '$lib/server/files';
import { capture, palantirOptions } from '$lib/server/palantir';

export const PUT: RequestHandler = async ({ request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });
	const { DB } = platform.env;
	const palantir = palantirOptions(request, platform);
	const userId = locals.user.id;
	const rejected = (reason: string, extra: Record<string, unknown> = {}) =>
		capture('drive_upload_rejected', userId, { reason, ...extra }, palantir);

	// A truly absent Content-Length can't be metered up front. Number(null) is
	// 0, which would otherwise sail past the guards, so check the raw header.
	const rawLength = request.headers.get('content-length');
	if (rawLength === null) {
		rejected('length_required');
		return json(
			{ error: 'length_required', message: 'Upload rejected.' },
			{ status: 411 }
		);
	}
	const declaredLength = Number(rawLength);
	// Empty uploads consume no quota, so unlimited ones would defeat the cap —
	// a real file has at least one byte.
	if (!Number.isInteger(declaredLength) || declaredLength < 1) {
		rejected('empty_file');
		return json(
			{ error: 'empty_file', message: 'Empty files cannot be uploaded.' },
			{ status: 400 }
		);
	}
	if (declaredLength > QUOTA_BYTES) {
		rejected('storage_full', { size: declaredLength, stage: 'larger_than_quota' });
		return json(storageFull(), { status: 413 });
	}

	// Fast-fail before consuming the body; the conditional INSERT below is the
	// authoritative check.
	const used = await storageUsed(DB, locals.user.id);
	if (used + declaredLength > QUOTA_BYTES) {
		rejected('storage_full', { size: declaredLength, used, stage: 'precheck' });
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

	const stored = await storeRequestBodyAsFile(DB, {
		userId,
		name,
		contentType,
		body: request.body,
		declaredLength,
		allowEmpty: false
	});

	if (!stored.ok) {
		if (stored.error === 'storage_full' || stored.error === 'too_large') {
			rejected('storage_full', { size: declaredLength, used, stage: 'insert' });
			return json(storageFull(), { status: 413 });
		}
		if (stored.error === 'empty_file') {
			rejected('empty_file');
			return json(
				{ error: 'empty_file', message: 'Empty files cannot be uploaded.' },
				{ status: 400 }
			);
		}
		capture(
			'drive_upload_failed',
			userId,
			{
				reason: stored.error,
				size: declaredLength,
				content_type: contentType,
				...(stored.error === 'size_mismatch'
					? { declared: stored.declared, received: stored.received }
					: {})
			},
			palantir
		);
		if (stored.error === 'size_mismatch') {
			return json(
				{ error: 'size_mismatch', declared: stored.declared, received: stored.received },
				{ status: 400 }
			);
		}
		return json({ error: 'storage_error' }, { status: 500 });
	}

	capture(
		'drive_file_uploaded',
		userId,
		{
			file_id: stored.id,
			size: stored.size,
			content_type: contentType,
			extension: name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : null,
			chunks: stored.chunks,
			storage_used_after: used + stored.size,
			quota: QUOTA_BYTES
		},
		palantir
	);
	return json({ id: stored.id, name, size: stored.size }, { status: 201 });
};

function storageFull() {
	return {
		error: 'storage_full',
		message:
			'Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks per account. Try deleting something.'
	};
}
