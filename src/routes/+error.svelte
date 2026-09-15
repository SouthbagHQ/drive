<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>Error — Southbag Drive™</title>
</svelte:head>

<img class="logo-strip" alt="Southbag" src="/logo.png" />

<main class="landing">
	<h1>Error {page.status}</h1>
	<p>{page.error?.message ?? 'Something went wrong. Kevin has been notified.'}</p>
	<div class="button-row">
		<a class="button-link btn-large" href="/">Go back</a>
		<a class="button-link" href="https://support.southbag.cc/ai">Chat with a Human</a>
	</div>
</main>
