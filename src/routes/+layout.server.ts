import type { LayoutServerLoad } from './$types';

// The signed-in user (if any) for every page, so palantir.js can identify them
// as soon as the page loads rather than waiting on a round-trip to Identity.
export const load: LayoutServerLoad = async ({ locals }) => {
	return { user: locals.user };
};
