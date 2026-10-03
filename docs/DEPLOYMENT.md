# Cloudflare Pages deployment

Production URL: https://pdoom-video.pages.dev/

The `Deploy to Cloudflare Pages` GitHub Actions workflow builds and publishes
every push to `main`. It can also be run manually from the repository's Actions
tab using **Run workflow** on `main`. Other branches do not deploy production.

The existing Cloudflare project uses Direct Upload. GitHub Actions uploads its
build to that project, preserving the production address. Cloudflare does not
support changing a Direct Upload project to its built-in Git integration.

## One-time credentials

In GitHub **Settings > Secrets and variables > Actions**, add repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account containing the `pdoom-video` Pages project.
- `CLOUDFLARE_API_TOKEN`: a custom Cloudflare API token with **Account > Cloudflare
  Pages > Edit**, restricted to that account. Store the token only as a secret;
  do not commit it or use a temporary Wrangler OAuth login token.

Create the token at https://dash.cloudflare.com/profile/api-tokens and save it at
https://github.com/ahdiua/pdoom-video/settings/secrets/actions.

If a run fails because a secret is missing, add the secret and use **Re-run failed
jobs** for that run. Existing production content remains available when a build
or the credential check fails.

## Build and deploy

CI uses Node.js 24 and Bun 1.4.2, installs `app/bun.lock` with
`bun install --frozen-lockfile`, and runs `bunx --no-install vite build` in `app/`.
Vite copies the repository's audio and timing data into `app/dist`, alongside the
JavaScript, fonts and images. Only that output directory is uploaded.

For a manual deployment from an authenticated local terminal:

```sh
cd app
bun install --frozen-lockfile
bunx --no-install vite build
bunx wrangler@4.147.0 pages deploy dist --project-name pdoom-video --branch main
```

Official guide: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
