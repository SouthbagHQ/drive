import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getFileByShareToken } from '$lib/server/files';

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform) error(500, 'Platform bindings unavailable');

	const file = await getFileByShareToken(platform.env.DB, params.token);
	if (!file) error(404, 'This file does not exist, or the link was removed.');

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
