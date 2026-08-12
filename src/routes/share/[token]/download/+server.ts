import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { contentDispositionAttachment, fileBody, getFileByShareToken } from '$lib/server/files';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const file = await getFileByShareToken(platform.env.DB, params.token);
	if (!file) error(404, 'Not found');

	return new Response(fileBody(platform.env.DB, file.id, file.size), {
		headers: {
			'Content-Type': file.content_type,
			'Content-Length': String(file.size),
			'Content-Disposition': contentDispositionAttachment(file.name),
			// Attacker-supplied content type on a PUBLIC endpoint — must not sniff.
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store'
		}
	});
};
