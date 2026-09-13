<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Southbag Drive™</title>
	<meta name="description" content="Southbag Drive™" />
</svelte:head>

<img class="logo-strip" alt="Southbag" src="/logo.png" />

<main class="landing">
	<h1>Southbag Drive™</h1>
	<p>100MB of storage</p>

	{#if data.denied}
		<p><strong>Login failed. Your account may have been disabled by Kevin.</strong></p>
	{/if}

	<div class="button-row">
		<a class="button-link btn-large" href="/auth/login">Log in with Southbag</a>
		<a class="button-link" href="https://support.southbag.cc/ai">Chat with a Human</a>
	</div>
</main>
