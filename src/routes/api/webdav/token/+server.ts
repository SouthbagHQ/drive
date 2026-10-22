import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hasWebdavToken, issueWebdavToken, revokeWebdavToken } from '$lib/server/webdav-auth';
import { capture, palantirOptions } from '$lib/server/palantir';

export const POST: RequestHandler = async ({ locals, platform, request }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	const replaced = await hasWebdavToken(platform.env.DB, locals.user.id);
	const token = await issueWebdavToken(platform.env.DB, locals.user.id);
	capture(
		'drive_webdav_token_issued',
		locals.user.id,
		{ replaced },
		palantirOptions(request, platform)
	);
	return json({
		token,
		username: locals.user.email,
		usernameAlt: locals.user.id,
		url: `${platform.env.ORIGIN}/webdav/`
	});
};

export const DELETE: RequestHandler = async ({ locals, platform, request }) => {
	if (!locals.user) return json({ error: 'unauthorized' }, { status: 401 });
	if (!platform) return json({ error: 'no_platform' }, { status: 500 });

	const revoked = await revokeWebdavToken(platform.env.DB, locals.user.id);
	capture(
		revoked ? 'drive_webdav_token_revoked' : 'drive_webdav_token_revoke_noop',
		locals.user.id,
		{},
		palantirOptions(request, platform)
	);
	return json({ revoked });
};
