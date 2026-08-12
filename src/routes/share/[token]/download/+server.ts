import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { contentDispositionAttachment, getFileByShareToken } from '$lib/server/files';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const file = await getFileByShareToken(platform.env.DB, params.token);
	if (!file) error(404, 'Not found');

	const object = await platform.env.BUCKET.get(file.r2_key);
	if (!object) error(404, 'Object missing');

	return new Response(object.body, {
		headers: {
			'Content-Type': file.content_type,
			'Content-Length': String(object.size),
			'Content-Disposition': contentDispositionAttachment(file.name),
			// Attacker-supplied content type on a PUBLIC endpoint — must not sniff.
			'X-Content-Type-Options': 'nosniff',
			ETag: object.httpEtag,
			'Cache-Control': 'private, no-store'
		}
	});
};
