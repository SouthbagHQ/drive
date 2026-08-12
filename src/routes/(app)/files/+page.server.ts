import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { QUOTA_BYTES, listFiles, storageUsed } from '$lib/server/files';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user) error(401, 'Unauthorized');
	if (!platform) error(500, 'Platform bindings unavailable');

	const files = await listFiles(platform.env.DB, locals.user.id);
	const used = await storageUsed(platform.env.DB, locals.user.id);

	return {
		files: files.map((f) => ({
			id: f.id,
			name: f.name,
			size: f.size,
			contentType: f.content_type,
			shareToken: f.share_token,
			createdAt: f.created_at
		})),
		used,
		quota: QUOTA_BYTES
	};
};
