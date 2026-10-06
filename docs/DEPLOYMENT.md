# Cloudflare deployment

Production: https://pdoom.ahdiua.com/

The site is a static build served by a Cloudflare Worker (static assets only,
no Worker script). Cloudflare is connected to the GitHub repository and builds
and deploys it itself: **the configuration lives in the Cloudflare dashboard,
not in this repository.** There is no GitHub Actions workflow and no
`wrangler` configuration file here.

A push to `main` deploys production. The Worker is named `pdoom-video`; the
custom domain above is attached under its **Domains & Routes** in the dashboard.

## Build configuration (Cloudflare dashboard)

Worker `pdoom-video` → **Settings → Build**:

| Setting | Value |
|---|---|
| Git repository | `ahdiua/pdoom-video`, production branch `main` |
| Root directory | `/app` |
| Build command | `bun install --frozen-lockfile && bunx vite build` |
| Deploy command | `npx wrangler deploy --assets ./dist --name pdoom-video --compatibility-date 2026-10-04` |
| Variables | `BUN_VERSION=1.4.2`, `NODE_VERSION=24` |

Both commands run in the root directory, so `./dist` is `app/dist`. Vite copies
the repository's `audio/` and `data/` into it, alongside the JavaScript, fonts
and images (`repoAssets` in `app/vite.config.ts`); only that directory is
uploaded. Asset URLs are relative (`base: './'`), so the build also works from
a subdirectory.

The build does not typecheck and runs none of the check scripts: a push that
builds is deployed. Run `bun run check` in `app/` first (see `CLAUDE.md`).

Changing any of the values above is done in the dashboard; update this table
when you do, since nothing in the repository records them.

## Manual deployment

From a terminal where `wrangler` is logged in to the account that owns the
Worker, the same two commands deploy the working tree:

```sh
cd app
bun install --frozen-lockfile && bunx vite build
npx wrangler deploy --assets ./dist --name pdoom-video --compatibility-date 2026-10-04
```

Official guides: https://developers.cloudflare.com/workers/ci-cd/builds/ and
https://developers.cloudflare.com/workers/static-assets/
