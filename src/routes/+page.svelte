<script lang="ts">
	import { capture } from '$lib/palantir';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	$effect(() => {
		if (data.denied) capture('drive_login_denied_shown', { reason: data.denied });
	});
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
		<a
			class="button-link btn-large"
			href="/auth/login"
			onclick={() => capture('drive_login_clicked', { denied: data.denied })}>Log in with Southbag</a
		>
		<a
			class="button-link"
			href="https://support.southbag.cc/ai"
			onclick={() => capture('drive_chat_with_human_clicked', { from: 'landing' })}
			>Chat with a Human</a
		>
	</div>
</main>
