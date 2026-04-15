# Obsidian GitHub Query Plugin

Live-rendered `github-query` code blocks for PR and commit activity in notes.

## Development

- `npm install`
- `npm run dev` for watch mode
- `npm run build` for production build
- `OBSIDIAN_VAULT_PATH="/path/to/vault" npm run install:local` to copy plugin files into your local vault

Copy `manifest.json`, `main.js`, and `styles.css` into your vault plugin folder:

`.obsidian/plugins/github-query/`

## Example blocks

```github-query
entity: prs
mode: merged
# date is optional; omitted means from-note
# date: from-note
# date: 2026-04-15
author: @me
limit: 20
```

```github-query
entity: prs
mode: created
date: 2026-04-15
author: @me
repo: your-org/your-repo
```

```github-query
entity: commits
date: from-note
author: @me
repo: your-org/your-repo
limit: 10
exclude_merge_commits: true
```

## Authentication

The plugin supports GitHub OAuth Device Flow.

1. Create a GitHub OAuth App and copy its client ID.
2. Either:
   - set `BUNDLED_GITHUB_OAUTH_CLIENT_ID` in `src/main.ts` before `npm run build` (recommended for releases), or
   - paste the client ID under **GitHub OAuth client ID (optional override)** in settings.
3. Click `Sign in with GitHub` and complete authorization in browser.
4. The plugin stores the OAuth access token and auto-fills your GitHub username.

PAT fallback is still available if OAuth is not configured.

## Current status

- Live renderer is implemented.
- PR queries (`created` and `merged`) are implemented.
- Commits queries are implemented for a specific repository.
- OAuth Device Flow is implemented with PAT fallback.
- Explicit `date: YYYY-MM-DD` takes precedence; omitted date falls back to note date.
- Query result caching and a refresh command are implemented.
- Access check tooling is available in settings.
