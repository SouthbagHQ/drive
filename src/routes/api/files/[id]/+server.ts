import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	contentDispositionAttachment,
	deleteFileRow,
	getFile,
	purgeObject,
	renameFile,
	sanitizeFileName,
	setShareToken
} from '$lib/server/files';

// HEAD — the client probes this before navigating to GET, so an error surfaces
// as an alert instead of replacing the whole app with a bare JSON document.
export const HEAD: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return new Response(null, { status: 401 });
	if (!platform) return new Response(null, { status: 500 });
	const file = await getFile(platform.env.DB, locals.user.id, params.id);
	return new Response(null, { status: file ? 200 : 404 });
};

// GET — stream the object out of R2 as an attachment.
export const GET: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	const file = await getFile(platform.env.DB, locals.user.id, params.id);
	if (!file) return json({ error: 'not_found' }, { status: 404 });

	const object = await platform.env.BUCKET.get(file.r2_key);
	if (!object) return json({ error: 'object_missing' }, { status: 404 });

	return new Response(object.body, {
		headers: {
			'Content-Type': file.content_type,
			'Content-Length': String(object.size),
			'Content-Disposition': contentDispositionAttachment(file.name),
			// The content type is attacker-supplied; never let the browser sniff
			// an uploaded blob into something executable on our origin.
			'X-Content-Type-Options': 'nosniff',
			ETag: object.httpEtag,
			'Cache-Control': 'private, no-store'
		}
	});
};

// PATCH — rename.
export const PATCH: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	let body: { name?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'bad_json' }, { status: 400 });
	}
	if (typeof body.name !== 'string') return json({ error: 'name_required' }, { status: 400 });

	const name = sanitizeFileName(body.name);
	const ok = await renameFile(platform.env.DB, locals.user.id, params.id, name);
	if (!ok) return json({ error: 'not_found' }, { status: 404 });
	return json({ id: params.id, name });
};

// DELETE — object first, THEN the row: if the request is cancelled
// mid-delete the worst case is a row whose object is gone (download 404, quota
// still charged) — never the abusable inverse where quota frees but bytes stay.
export const DELETE: RequestHandler = async ({ params, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	const file = await getFile(platform.env.DB, locals.user.id, params.id);
	if (!file) return json({ error: 'not_found' }, { status: 404 });

	// Only drop the row once the bytes are really gone: freeing the quota while
	// the object survives would let a user store more than their 100MB.
	const purged = await purgeObject(platform, file.r2_key);
	if (!purged) {
		return json(
			{ error: 'delete_failed', message: 'The file could not be deleted. It remains. Try again.' },
			{ status: 500 }
		);
	}
	await deleteFileRow(platform.env.DB, locals.user.id, params.id);
	return json({ deleted: true });
};

// POST — toggle the public share link.
export const POST: RequestHandler = async ({ params, request, locals, platform }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	let body: { share?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'bad_json' }, { status: 400 });
	}

	if (body.share) {
		const existing = await getFile(platform.env.DB, locals.user.id, params.id);
		if (!existing) return json({ error: 'not_found' }, { status: 404 });
		const token = existing.share_token ?? crypto.randomUUID().replaceAll('-', '');
		await setShareToken(platform.env.DB, locals.user.id, params.id, token);
		return json({ token, url: `${platform.env.ORIGIN}/share/${token}` });
	}

	const ok = await setShareToken(platform.env.DB, locals.user.id, params.id, null);
	if (!ok) return json({ error: 'not_found' }, { status: 404 });
	return json({ token: null });
};
