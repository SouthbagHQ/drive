<script lang="ts">
	import './layout.css';
	import { identify, reset } from '$lib/palantir';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	// palantir.js identifies from its data-user-* attributes on first load; this
	// keeps PostHog in step when the user changes under client-side navigation.
	// Only reset on a real sign-out — resetting an anonymous visitor would mint
	// a fresh anonymous person on every page.
	let previousUserId: string | null = null;
	$effect(() => {
		const id = data.user?.id ?? null;
		if (data.user) identify(data.user);
		else if (previousUserId) reset();
		previousUserId = id;
	});
</script>

<svelte:head>
	<link rel="icon" href="/logo.png" type="image/png" />
	<script
		src="/palantir.js"
		data-app="drive"
		data-user-id={data.user?.id}
		data-user-email={data.user?.email}
		data-user-name={data.user?.name}
	></script>
</svelte:head>

{@render children()}
