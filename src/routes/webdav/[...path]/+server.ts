import type { RequestHandler } from './$types';
import { handleWebdav } from '$lib/server/webdav';

// Both `/webdav` and `/webdav/` are the collection. Redirecting PROPFIND
// between them is how you lose Finder and Explorer in the same afternoon.
export const trailingSlash = 'ignore';

const run: RequestHandler = async (event) => handleWebdav(event);

export const GET = run;
export const HEAD = run;
export const PUT = run;
export const DELETE = run;
export const OPTIONS = run;
export const fallback = run;
