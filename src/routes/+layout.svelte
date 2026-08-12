<script lang="ts">
	import './layout.css';

	let { children }: { children: import('svelte').Snippet } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/logo.png" type="image/png" />
</svelte:head>

{@render children()}
