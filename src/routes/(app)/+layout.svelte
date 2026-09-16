<script lang="ts">
	import { capture } from '$lib/palantir';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
</script>

<img class="logo-strip" alt="Southbag" src="/logo.png" />

<div class="shell">
	<div class="userbar">
		<span class="tiny">Signed in as "{data.user.email}"</span>
		<div class="button-row">
			<a
				class="button-link tiny"
				href="https://support.southbag.cc/ai"
				onclick={() => capture('drive_chat_with_human_clicked', { from: 'userbar' })}
				>Chat with a Human</a
			>
			<form method="post" action="/auth/logout" onsubmit={() => capture('drive_sign_out_clicked')}>
				<button>Sign out</button>
			</form>
		</div>
	</div>

	<main class="content">
		{@render children()}
	</main>

	<footer class="tiny">Kevin is watching</footer>
</div>
