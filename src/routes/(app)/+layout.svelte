<script lang="ts">
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>

<img class="logo-strip" alt="Southbag" src="/logo.png" />

<div class="shell">
	<div class="userbar">
		<span class="tiny">Signed in as "{data.user.email}"</span>
		<div class="button-row">
			<a class="button-link tiny" href="https://support.southbag.cc/ai">Chat with a Human</a>
			<form method="post" action="/auth/logout">
				<button>Sign out</button>
			</form>
		</div>
	</div>

	<main class="content">
		{@render children()}
	</main>

	<footer class="tiny">Kevin is watching</footer>
</div>
