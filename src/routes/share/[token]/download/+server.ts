import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { contentDispositionAttachment, fileBody, getFileByShareToken } from '$lib/server/files';
import { capture, palantirOptions } from '$lib/server/palantir';

export const GET: RequestHandler = async ({ params, platform, locals, request }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const file = await getFileByShareToken(platform.env.DB, params.token);
	if (!file) error(404, 'Not found');

	capture(
		'drive_share_link_downloaded',
		locals.user?.id,
		{
			file_id: file.id,
			size: file.size,
			content_type: file.content_type,
			is_owner: locals.user?.id === file.user_id
		},
		palantirOptions(request, platform)
	);

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
