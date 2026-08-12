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
- Sorting (Shuffled is the default and the recommendation) and case-sensitive search

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
   bun run db:migrate:remote
   ```

2. **Configure**: set `ORIGIN` in `wrangler.jsonc`. On the first login, Drive dynamically
   registers a PKCE public client with Southbag Identity™ and stores its credentials in D1.

3. **Deploy**:

   ```sh
   bun run cf:deploy
   ```

## Answers to anticipated support tickets

- **Where are folders?** There are none.
- **Why is my storage full?** You used all 71.1 floppies. Delete something.
- **Can deleting be undone?** No, and it does not ask first. Be careful.
- **Who is Kevin?** Kevin is watching.

---
*This is satire. The UX crimes are load-bearing. Please don't actually build interfaces like
this — but if you must, at least enforce your quotas server-side like we do.*
