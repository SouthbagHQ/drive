<script lang="ts">
	import { fortnightsAgo, toCdRoms, toFloppies } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.file.name} — Southbag Drive™</title>
</svelte:head>

<img class="logo-strip" alt="Southbag" src="/logo.png" />

<div class="shell">
	<main class="content">
		<h1>A file has been shared with you</h1>

		<section class="panel">
			<p><strong>Name:</strong> {data.file.name}</p>
			<p title={`${data.file.size} bytes`}>
				<strong>Size:</strong>
				{toFloppies(data.file.size)} ({toCdRoms(data.file.size)})
			</p>
			<p><strong>Age:</strong> {fortnightsAgo(data.file.createdAt)}</p>
			<div class="button-row">
				<a class="button-link btn-large" href={`/share/${data.token}/download`}>Download</a>
				<a class="button-link" href="https://support.southbag.cc/ai">Chat with a Human</a>
			</div>
		</section>

		<p class="tiny">
			Anyone with this link can download this file. <a href="/">Get your own Southbag Drive™</a>.
		</p>
	</main>

	<footer class="tiny">Kevin is watching this file too</footer>
</div>
