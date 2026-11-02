// The RPC surface Southbag Office™ reaches through its `DRIVE` service binding.
// Named entrypoints have no public route: only Workers on this account that
// declare a binding to `southbag-drive` / `OfficeStorage` can call them, which
// is why Drive trusts the Southbag Identity user Office passes in.
//
// scripts/export-office-entrypoint.ts appends this export to the built worker.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { centralStatus } from './identity';
import {
	adoptOfficePackages,
	commitOfficeWorkspace,
	loadOfficeSnapshot,
	officeIndex,
	type OfficeAdoption,
	type OfficeCommit,
	type OfficeUser
} from './office-storage';

export class OfficeStorage extends WorkerEntrypoint<App.Platform['env']> {
	// The binding is a capability any bound Worker has, so the freeze is enforced here too, not
	// just in Office's own request hook: a KNOWN frozen account gets nothing, reads included;
	// while the central answer is unknown EVERYTHING fails closed, snapshot/index reads too.
	private async guard(user: OfficeUser, mutation: boolean): Promise<void> {
		const central = await centralStatus(this.env, user.sub);
		if (central === 'unknown')
			throw new Error('Southbag Identity is unavailable, so your account status cannot be checked. Try again shortly.');
		if (central !== 'off' && central.frozen)
			throw new Error('Your account is frozen pending review. Unfreeze at https://identity.southbag.cc/unfreeze');
	}

	/** Workspace state plus every Office package, for a full load. */
	async snapshot(user: OfficeUser) {
		await this.guard(user, false);
		return loadOfficeSnapshot(this.env.DB, user);
	}

	/** Workspace state plus package metadata, for diffing a save. */
	async index(user: OfficeUser) {
		await this.guard(user, false);
		return officeIndex(this.env.DB, user);
	}

	async commit(user: OfficeUser, commit: OfficeCommit) {
		await this.guard(user, true);
		return commitOfficeWorkspace(this.env.DB, user, commit);
	}

	async adopt(user: OfficeUser, adoptions: OfficeAdoption[]) {
		await this.guard(user, true);
		return adoptOfficePackages(this.env.DB, user, adoptions);
	}
}
