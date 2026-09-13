<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { fortnightsAgo, toCdRoms, toFloppies, truncateFront } from '$lib/format';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type VaultFile = PageData['files'][number];

	// --- notifications --------------------------------------------------------
	let dialogs = $state<{ id: number; message: string }[]>([]);
	let dialogSeq = 0;
	function notify(message: string) {
		const id = ++dialogSeq;
		dialogs.push({ id, message });
		setTimeout(() => {
			dialogs = dialogs.filter((d) => d.id !== id);
		}, 6000);
	}

	// --- sorting & searching --------------------------------------------------
	let sortMode = $state('shuffled');
	let search = $state('');

	// Cheap deterministic hash so "Shuffled" is stable within a visit but
	// different on the next one.
	let shuffleNonce = $state(String(Math.random()));
	function hash(s: string): number {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0;
	}

	const sorters: Record<string, (a: VaultFile, b: VaultFile) => number> = {
		shuffled: (a, b) => hash(a.id + shuffleNonce) - hash(b.id + shuffleNonce),
		nameDesc: (a, b) => b.name.localeCompare(a.name),
		secondLetter: (a, b) => (a.name[1] ?? '').localeCompare(b.name[1] ?? ''),
		sizeAsc: (a, b) => a.size - b.size,
		oldest: (a, b) => a.createdAt - b.createdAt
	};

	const visibleFiles = $derived(
		data.files
			.filter((f) => (search ? f.name.includes(search) : true))
			.toSorted(sorters[sortMode] ?? sorters.shuffled)
	);

	// The meter reports emptiness. Naturally.
	const remainingPct = $derived(
		Math.max(0, Math.min(100, ((data.quota - data.used) / data.quota) * 100))
	);

	// --- uploads --------------------------------------------------------------
	let fileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);
	let remainingProgress = $state(100);

	function upload() {
		const file = fileInput?.files?.[0];
		if (!file) {
			alert('Select a file first. The amount box does not count.');
			return;
		}
		if (file.size > data.quota - data.used) {
			alert(
				`Upload rejected. That file is ${toFloppies(file.size)} but you only have ${toFloppies(data.quota - data.used)} of emptiness left.`
			);
			return;
		}

		uploading = true;
		remainingProgress = 100;

		const contentType = file.type || 'application/octet-stream';
		try {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', '/api/upload');
			// encodeURIComponent throws on lone surrogates (legal in Windows
			// filenames); fall back rather than leave the button stuck.
			let encodedName: string;
			try {
				encodedName = encodeURIComponent(file.name);
			} catch {
				encodedName = encodeURIComponent('unnamed.file');
			}
			xhr.setRequestHeader('x-sb-filename', encodedName);
			xhr.setRequestHeader('x-sb-content-type', contentType);
			// Always send an explicit Content-Type: some middleware drops bodies
			// that arrive without one, and File.type can be empty.
			xhr.setRequestHeader('Content-Type', contentType);
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) remainingProgress = 100 - (e.loaded / e.total) * 100;
			};
			xhr.onload = async () => {
				uploading = false;
				if (xhr.status === 201) {
					notify('File uploaded.');
					if (fileInput) fileInput.value = '';
					await invalidateAll();
				} else {
					let message = 'Upload failed for reasons.';
					try {
						message = JSON.parse(xhr.responseText).message ?? message;
					} catch {
						// the reasons remain unknowable
					}
					alert(message);
				}
			};
			xhr.onerror = () => {
				uploading = false;
				alert('Upload failed. Please try again.');
			};
			xhr.send(file);
		} catch (err) {
			// Any synchronous throw during setup must still release the button.
			uploading = false;
			alert('Upload could not be started. Please try again.');
			console.error('upload setup failed:', err);
		}
	}

	// --- operations -----------------------------------------------------------
	async function download(file: VaultFile) {
		if (!confirm(`Download "${file.name}"?`)) return;
		// Probe first: on error the endpoint returns a bare JSON document, and a
		// plain navigation would replace the whole app with it.
		try {
			const probe = await fetch(`/api/files/${file.id}`, { method: 'HEAD' });
			if (!probe.ok) {
				alert('That file could not be downloaded. It may have been deleted by you or Kevin.');
				await invalidateAll();
				return;
			}
		} catch {
			alert('Download could not be started for some reason.');
			return;
		}
		location.href = `/api/files/${file.id}`;
	}

	async function rename(file: VaultFile) {
		const name = prompt('New name:', file.name);
		if (name === null || name === file.name) return;
		const res = await fetch(`/api/files/${file.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		if (res.ok) {
			notify('File renamed.');
			await invalidateAll();
		} else {
			alert('Rename failed. The file or Kevin prefers its old name.');
		}
	}

	async function share(file: VaultFile) {
		const res = await fetch(`/api/files/${file.id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ share: !file.shareToken })
		});

		if (!res.ok) {
			alert('That did not work. Refreshing. Kevin is watching.');
			await invalidateAll();
			return;
		}

		if (file.shareToken) {
			notify('Link removed.');
		} else {
			const { url } = (await res.json()) as { url: string };
			prompt('Your link', url);
		}
		await invalidateAll();
	}

	async function remove(file: VaultFile) {
		const res = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
		if (res.ok) {
			notify(`Deleted "${file.name}". Kevin retains a copy.`);
			await invalidateAll();
		} else {
			alert('Delete failed. The file resisted.');
		}
	}
</script>

<svelte:head>
	<title>Files — Southbag Drive™</title>
</svelte:head>

<h1>Files</h1>

<section class="panel">
	<h2>Storage</h2>
	<div class="meter">
		<div class="meter-fill" style={`width: ${remainingPct}%`}></div>
		<div class="meter-label">
			{remainingPct.toFixed(1)}% empty — {toFloppies(data.used)} of 71.1 data used
		</div>
	</div>
	<p class="tiny" title={toCdRoms(data.used)}>
		Every account gets 71.1 floppy disks
	</p>
</section>

<section class="panel">
	<h2>Upload</h2>
	<label class="field">
		<span>amount</span>
		<input placeholder="Enter Amount" />
	</label>
	<label class="field">
		<span>file</span>
		<input type="file" bind:this={fileInput} />
	</label>
	{#if uploading}
		<div class="progress">
			<div class="progress-fill" style={`width: ${remainingProgress}%`}></div>
			<div class="progress-label">Remaining: {remainingProgress.toFixed(0)}%</div>
		</div>
	{/if}
	<button class="btn-large" disabled={uploading} onclick={upload}>
		{uploading ? 'Uploading…' : 'Upload'}
	</button>
</section>

<section class="panel">
	<h2>Your files</h2>
	<div class="controls">
		<label class="field">
			<span>Sort</span>
			<select bind:value={sortMode}>
				<option value="shuffled">Shuffled (recommended)</option>
				<option value="nameDesc">Name (Z→A)</option>
				<option value="secondLetter">Second letter of name (A→Z)</option>
				<option value="sizeAsc">Size (smallest first)</option>
				<option value="oldest">Oldest first</option>
			</select>
		</label>
		<label class="field">
			<span>Search (case-sensitive)</span>
			<input bind:value={search} placeholder="Exact substrings only" />
		</label>
	</div>

	{#if visibleFiles.length === 0}
		{#if data.files.length === 0}
			<p>No files yet.</p>
		{:else}
			<p>No files match "{search}"</p>
		{/if}
	{:else}
		<table class="file-table">
			<thead>
				<tr>
					<th>Name</th>
					<th>Size</th>
					<th>Age</th>
					<th>Link</th>
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each visibleFiles as file (file.id)}
					<tr>
						<td title={file.name}>{truncateFront(file.name)}</td>
						<td title={`${file.size} bytes, or ${toCdRoms(file.size)}`}>{toFloppies(file.size)}</td>
						<td>{fortnightsAgo(file.createdAt)}</td>
						<td>
							{#if file.shareToken}
								<a href={`/share/${file.shareToken}`}>yes</a>
							{:else}
								no
							{/if}
						</td>
						<td>
							<div class="operations">
								<button onclick={() => download(file)}>Download</button>
								<button onclick={() => rename(file)}>Rename</button>
								<button onclick={() => share(file)}>
									{file.shareToken ? 'Remove link' : 'Get link'}
								</button>
								<button onclick={() => remove(file)}>Delete</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

<div class="dialog-stack" aria-hidden="true">
	{#each dialogs as dialog (dialog.id)}
		<div class="fake-dialog">{dialog.message}</div>
	{/each}
</div>
