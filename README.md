# Southbag Drive™

Cloud file storage the way nobody asked for it. A ***deliberately unintuitive*** Google Drive
parody in the Southbag family — visually faithful to
[Southbag Identity™](https://github.com/SouthbagHQ/identity) and
[Southbag Online Banking](https://github.com/SouthbagHQ/banking), functionally an actual working
file store.

Upload files. Download files. Delete files. Share them by link. Storage is measured in floppy
disks, file age in fortnights, the upload progress bar counts down, and the storage meter reports
emptiness. Every account receives exactly **71.1 floppy disks (100MB)**. Kevin is watching.

## What actually works (everything)

- Sign in with **Southbag Identity™** via OIDC (authorization code + PKCE, discovery-driven
  against `https://identity.southbag.cc/.well-known/openid-configuration`)
- Upload — raw-body PUT split into 1MB D1 BLOB chunks
- **100MB per-user quota**, enforced server-side with a quota-guarded conditional `INSERT` so
  concurrent uploads can't squeeze past the limit (the loser's blob is deleted)
- Download, rename, delete, and public share links
- **WebDAV** at `/webdav/` (Class 1+2, Basic auth with an access token from the files page)
- Sorting (Shuffled is the default and the recommendation) and case-sensitive search
- **Southbag Office™ storage** — every Office document lives here as an encrypted
  `.southbag*` file, counted against your 71.1 floppies (see below)

The interface is deliberately unhelpful in small ways: the upload form has a decoy "amount" box,
sorting defaults to Shuffled, search is case-sensitive substring-only, downloading asks you to
confirm while deleting does not, and the storage meter measures how *empty* your account is.

## Stack

SvelteKit (Svelte 5) + `@sveltejs/adapter-cloudflare` on **Cloudflare Workers**, with **D1**
for metadata, sessions, and chunked file blobs.

## Local development

```sh
bun install
bun run db:migrate:local
cp .dev.vars.example .dev.vars   # defaults point at the mock issuer below
bun scripts/mock-identity.ts     # terminal 1 — fake Southbag Identity™ on :8788
bun run dev                      # terminal 2 — app on :5173
```

The mock issuer implements discovery, authorize (auto-approve as Kevin Mockery), token with real
S256 PKCE verification, and userinfo — so the full login flow works offline. To develop against
the real identity service instead, fill in real values in `.dev.vars` (see Production, step 2).

## Production (Cloudflare free plan)

1. **Create resources** (once):

   ```sh
   bunx wrangler d1 create drive          # copy database_id into wrangler.jsonc
   bun run db:migrate:remote              # run again whenever migrations/ changes
   ```

2. **Configure**: set `ORIGIN` in `wrangler.jsonc`. On the first login, Drive dynamically
   registers a PKCE public client with Southbag Identity™ and stores its credentials in D1.

3. **Deploy** (always build first — the build exports the Office entrypoint):

   ```sh
   bun run build && bun run cf:deploy
   ```

## WebDAV

Issue a token on the files page, then mount `https://drive.southbag.cc/webdav/`. Username is your
Southbag email (Windows Explorer eats `@`; if it does, use the account id shown next to it).
Password is the token, not your Southbag password.

There are still no folders. `MKCOL` is refused. A swapfile is allowed in the sense that it is a
file named `swapfile` that counts against 71.1 floppy disks.

```sh
curl -u 'kevin@southbag.cc:sbdav_…' -X PROPFIND https://drive.southbag.cc/webdav/ -H 'Depth: 1'
```

## Southbag Office™

[Southbag Office](https://github.com/SouthbagHQ/office) stores its documents in Drive. Its
Worker reaches Drive over a Cloudflare **service binding** to the named RPC entrypoint
`OfficeStorage` (`src/lib/server/office-entrypoint.ts`). That entrypoint has no public route — only
Workers on this account that bind to `southbag-drive` / `OfficeStorage` can call it — so Drive
trusts the Southbag Identity™ user Office passes in. Office users are the same Identity `sub`, so
their documents land in the same Drive account they sign into.

- Each Office document is an ordinary Drive file (`Title.southbagdocs`, `.southbagslides`,
  `.southbagsheets`). Drive only ever holds the **encrypted** package; the key stays in Office.
- Office documents count against the quota like anything else. You can download, share, and
  WebDAV them. **Open in Office™** on the files page opens one in Office.
- `.southbag*` files you upload yourself (browser or WebDAV) join your Office workspace on the
  next Office load.
- Deleting an Office document **from Drive** deletes it from Office too: a trigger records a
  tombstone and bumps the workspace revision so open Office tabs can't resurrect it.

adapter-cloudflare only exports the default fetch handler, so `bun run build` runs
`scripts/export-office-entrypoint.ts` to append the `OfficeStorage` export to the built worker.
Always deploy with `bun run build && bun run cf:deploy`. For local Office development against
Drive, run a built Drive under `bunx wrangler dev` (not `vite dev`) so the entrypoint is registered
with the local dev registry.

## Answers to anticipated support tickets

- **Where are folders?** There are none.
- **Does it support WebDAV?** Yes. `/webdav/`. Folders remain a rumour. Swapfiles are a PUT.
- **Why is my storage full?** You used all 71.1 floppies. Delete something.
- **Can deleting be undone?** No, and it does not ask first. Be careful.
- **Why are my documents in my Drive?** Southbag Office™ keeps them there. They cost floppies.
- **Who is Kevin?** Kevin is watching.

---
*This is satire. The UX crimes are load-bearing. Please don't actually build interfaces like
this — but if you must, at least enforce your quotas server-side like we do.*
