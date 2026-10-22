<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { fortnightsAgo, toCdRoms, toFloppies, truncateFront } from '$lib/format';
	import { capture } from '$lib/palantir';
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
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	function onSortChange() {
		capture('drive_sort_changed', { sort: sortMode, files: data.files.length });
	}

	// Searching fires per keystroke; report once the typing pauses.
	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			if (!search) return;
			capture('drive_files_searched', {
				query_length: search.length,
				results: visibleFiles.length,
				files: data.files.length
			});
		}, 600);
	}

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

	function fileProps(file: File) {
		return {
			size: file.size,
			content_type: file.type || 'application/octet-stream',
			extension: file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() : null
		};
	}

	function onFilePicked() {
		const file = fileInput?.files?.[0];
		if (file) capture('drive_upload_file_picked', fileProps(file));
	}

	function onAmountTyped() {
		// The amount box does nothing. People still fill it in.
		capture('drive_amount_box_used');
	}

	function upload() {
		const file = fileInput?.files?.[0];
		if (!file) {
			capture('drive_upload_without_file');
			alert('Select a file first. The amount box does not count.');
			return;
		}
		if (file.size > data.quota - data.used) {
			capture('drive_upload_blocked_client', {
				...fileProps(file),
				remaining: data.quota - data.used
			});
			alert(
				`Upload rejected. That file is ${toFloppies(file.size)} but you only have ${toFloppies(data.quota - data.used)} left.`
			);
			return;
		}

		uploading = true;
		remainingProgress = 100;
		const startedAt = Date.now();
		capture('drive_upload_started', fileProps(file));

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
					capture('drive_upload_succeeded', {
						...fileProps(file),
						duration_ms: Date.now() - startedAt
					});
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
					capture('drive_upload_error_shown', {
						...fileProps(file),
						status: xhr.status,
						duration_ms: Date.now() - startedAt
					});
					alert(message);
				}
			};
			xhr.onerror = () => {
				uploading = false;
				capture('drive_upload_error_shown', {
					...fileProps(file),
					status: 0,
					duration_ms: Date.now() - startedAt
				});
				alert('Upload failed. Please try again.');
			};
			xhr.send(file);
		} catch (err) {
			// Any synchronous throw during setup must still release the button.
			uploading = false;
			capture('drive_upload_error_shown', { ...fileProps(file), status: -1, stage: 'setup' });
			alert('Upload could not be started. Please try again.');
			console.error('upload setup failed:', err);
		}
	}

	// --- operations -----------------------------------------------------------
	function fileRowProps(file: VaultFile) {
		return { file_id: file.id, size: file.size, content_type: file.contentType, shared: Boolean(file.shareToken) };
	}

	async function download(file: VaultFile) {
		if (!confirm(`Download "${file.name}"?`)) {
			capture('drive_download_cancelled', fileRowProps(file));
			return;
		}
		capture('drive_download_clicked', fileRowProps(file));
		// Probe first: on error the endpoint returns a bare JSON document, and a
		// plain navigation would replace the whole app with it.
		try {
			const probe = await fetch(`/api/files/${file.id}`, { method: 'HEAD' });
			if (!probe.ok) {
				capture('drive_download_probe_failed', { ...fileRowProps(file), status: probe.status });
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
		capture('drive_rename_clicked', fileRowProps(file));
		const name = prompt('New name:', file.name);
		if (name === null || name === file.name) {
			capture('drive_rename_cancelled', fileRowProps(file));
			return;
		}
		const res = await fetch(`/api/files/${file.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		if (res.ok) {
			notify('File renamed.');
			await invalidateAll();
		} else {
			capture('drive_rename_error_shown', { ...fileRowProps(file), status: res.status });
			alert('Rename failed. The file or Kevin prefers its old name.');
		}
	}

	async function share(file: VaultFile) {
		capture(file.shareToken ? 'drive_remove_link_clicked' : 'drive_get_link_clicked', fileRowProps(file));
		const res = await fetch(`/api/files/${file.id}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ share: !file.shareToken })
		});

		if (!res.ok) {
			capture('drive_share_error_shown', { ...fileRowProps(file), status: res.status });
			alert('That did not work. Refreshing. Kevin is watching.');
			await invalidateAll();
			return;
		}

		if (file.shareToken) {
			notify('Link removed.');
		} else {
			const { url } = (await res.json()) as { url: string };
			prompt('Your link', url);
			capture('drive_share_link_shown', fileRowProps(file));
		}
		await invalidateAll();
	}

	async function remove(file: VaultFile) {
		// No confirmation dialog. Deliberately.
		capture('drive_delete_clicked', fileRowProps(file));
		const res = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
		if (res.ok) {
			notify(`Deleted "${file.name}". Kevin retains a copy.`);
			await invalidateAll();
		} else {
			capture('drive_delete_error_shown', { ...fileRowProps(file), status: res.status });
			alert('Delete failed. The file resisted.');
		}
	}

	let webdavBusy = $state(false);

	function selectField(e: Event) {
		(e.currentTarget as HTMLInputElement).select();
	}

	async function issueWebdavToken() {
		webdavBusy = true;
		capture('drive_webdav_issue_clicked', { already: data.webdavConfigured });
		try {
			const res = await fetch('/api/webdav/token', { method: 'POST' });
			if (!res.ok) {
				capture('drive_webdav_issue_error_shown', { status: res.status });
				alert('Token could not be issued. Kevin shrugged.');
				return;
			}
			const { token } = (await res.json()) as { token: string };
			prompt('Your WebDAV password. This is the only time.', token);
			capture('drive_webdav_token_shown');
			notify('WebDAV token issued.');
			await invalidateAll();
		} finally {
			webdavBusy = false;
		}
	}

	async function revokeWebdavToken() {
		webdavBusy = true;
		capture('drive_webdav_revoke_clicked');
		try {
			const res = await fetch('/api/webdav/token', { method: 'DELETE' });
			if (res.ok) {
				notify('WebDAV token revoked. Existing mounts will sulk.');
				await invalidateAll();
			} else {
				capture('drive_webdav_revoke_error_shown', { status: res.status });
				alert('Revoke failed. The token resisted.');
			}
		} finally {
			webdavBusy = false;
		}
	}
</script>

<svelte:head>
	<title>Files — Southbag Drive™</title>
</svelte:head>

<h1>Files</h1>

<section class="panel">
	<h2>Storage</h2>
	<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
	<div
		class="meter"
		onclick={() => capture('drive_storage_meter_clicked', { remaining_pct: remainingPct, used: data.used })}
	>
		<div class="meter-fill" style={`width: ${remainingPct}%`}></div>
		<div class="meter-label">
			{remainingPct.toFixed(1)}% empty — {toFloppies(data.used)} of 71.1 data used
		</div>
	</div>
	<p
		class="tiny"
		title={toCdRoms(data.used)}
		onmouseenter={() => capture('drive_floppy_hint_hovered', { used: data.used })}
	>
		Every account gets 71.1 floppy disks
	</p>
</section>

<section class="panel">
	<h2>Upload</h2>
	<label class="field">
		<span>amount</span>
		<input placeholder="Enter Amount" onchange={onAmountTyped} />
	</label>
	<label class="field">
		<span>file</span>
		<input type="file" bind:this={fileInput} onchange={onFilePicked} />
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
	<h2>WebDAV</h2>
	<p>Mount this account as a network disk. Folders are not supported. Swapfiles are, until you run out of floppies.</p>
	<label class="field">
		<span>server</span>
		<input readonly value={data.webdavUrl} onclick={selectField} onfocus={selectField} />
	</label>
	<label class="field">
		<span>username</span>
		<input readonly value={data.webdavUsername} onclick={selectField} onfocus={selectField} />
	</label>
	<p class="tiny">
		Windows Explorer eats "@" signs. If it does, use {data.webdavUsernameAlt} instead.
	</p>
	<p class="tiny">
		Password is not your Southbag password. It is a token we mint because WebDAV predates OIDC and we
		are not going to un-invent that.
	</p>
	<div class="button-row">
		<button disabled={webdavBusy} onclick={issueWebdavToken}>
			{data.webdavConfigured ? 'Issue a new token' : 'Issue a token'}
		</button>
		{#if data.webdavConfigured}
			<button disabled={webdavBusy} onclick={revokeWebdavToken}>Revoke token</button>
		{/if}
	</div>
	{#if data.webdavConfigured}
		<p class="tiny">A token is already issued. Issuing another one forgets the old one.</p>
	{/if}
</section>

<section class="panel">
	<h2>Your files</h2>
	<div class="controls">
		<label class="field">
			<span>Sort</span>
			<select bind:value={sortMode} onchange={onSortChange}>
				<option value="shuffled">Shuffled (recommended)</option>
				<option value="nameDesc">Name (Z→A)</option>
				<option value="secondLetter">Second letter of name (A→Z)</option>
				<option value="sizeAsc">Size (smallest first)</option>
				<option value="oldest">Oldest first</option>
			</select>
		</label>
		<label class="field">
			<span>Search</span>
			<input bind:value={search} placeholder="Exact substrings only" oninput={onSearchInput} />
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
								<a
									href={`/share/${file.shareToken}`}
									onclick={() => capture('drive_own_share_link_clicked', fileRowProps(file))}>yes</a
								>
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
