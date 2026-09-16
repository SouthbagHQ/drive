import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getFileByShareToken } from '$lib/server/files';
import { capture, palantirOptions } from '$lib/server/palantir';

export const load: PageServerLoad = async ({ params, platform, locals, request }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const file = await getFileByShareToken(platform.env.DB, params.token);
	const palantir = palantirOptions(request, platform);
	if (!file) {
		capture('drive_share_link_missing', locals.user?.id, {}, palantir);
		error(404, 'This file does not exist, or the link was removed.');
	}

	capture(
		'drive_share_link_opened',
		locals.user?.id,
		{
			file_id: file.id,
			size: file.size,
			content_type: file.content_type,
			is_owner: locals.user?.id === file.user_id
		},
		palantir
	);

	return {
		file: {
			name: file.name,
			size: file.size,
			contentType: file.content_type,
			createdAt: file.created_at
		},
		token: params.token
	};
};
