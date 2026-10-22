// The RPC surface Southbag Office™ reaches through its `DRIVE` service binding.
// Named entrypoints have no public route: only Workers on this account that
// declare a binding to `southbag-drive` / `OfficeStorage` can call them, which
// is why Drive trusts the Southbag Identity user Office passes in.
//
// scripts/export-office-entrypoint.ts appends this export to the built worker.

import { WorkerEntrypoint } from 'cloudflare:workers';
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
	/** Workspace state plus every Office package, for a full load. */
	snapshot(user: OfficeUser) {
		return loadOfficeSnapshot(this.env.DB, user);
	}

	/** Workspace state plus package metadata, for diffing a save. */
	index(user: OfficeUser) {
		return officeIndex(this.env.DB, user);
	}

	commit(user: OfficeUser, commit: OfficeCommit) {
		return commitOfficeWorkspace(this.env.DB, user, commit);
	}

	adopt(user: OfficeUser, adoptions: OfficeAdoption[]) {
		return adoptOfficePackages(this.env.DB, user, adoptions);
	}
}
