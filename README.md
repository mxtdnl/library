# The Library of mxtdnl

A single-page **hub / portfolio** that catalogues every one of my published
[GitHub Pages](https://pages.github.com/) projects and links out to each live site.
It is deployed with GitHub Pages and lives at:

**https://mxtdnl.github.io/library/**

## How it works

- **`index.html`** — the catalogue. It fetches `projects.json` at load time and
  renders each project as a shelf-marked entry, grouped into thematic collections.
  Vanilla HTML/CSS/JS, no build step, no runtime dependencies (fonts aside).
- **`projects.json`** — the data. Curated **by hand**, but new projects are
  discovered automatically (see below). It was initially seeded from the GitHub
  API and each project's own page content.
- **`scripts/sync-projects.mjs`** — the auto-discovery tool.
- **`.github/workflows/sync-projects.yml`** — runs the tool weekly and opens a PR.
- **`favicon.svg`** — the tab icon.

## Adding a project — the automatic way

You usually don't edit `projects.json` by hand for new repos. A GitHub Action
(`.github/workflows/sync-projects.yml`) runs **every Monday** (and on demand via
the *Run workflow* button under the repo's **Actions** tab). It:

1. Lists every public repo you own that has GitHub Pages enabled.
2. Adds any it doesn't already know about to the **New — awaiting a description**
   collection, using the repo's GitHub description as a placeholder blurb.
3. Refreshes each project's `updated` date, and flags any project whose Pages
   site has gone offline with `"stale": true` (it is hidden from the live site
   but kept in the file, never silently deleted).
4. If anything changed, opens (or updates) a pull request.

**Nothing reaches the live site until you merge that PR.** Your job on each PR is
just to write a real one-sentence blurb for the new entries and move them out of
`NEW` into a proper collection.

> One-time setup: under **Settings → Actions → General → Workflow permissions**,
> enable *Read and write permissions* and *Allow GitHub Actions to create and
> approve pull requests*. No token or secret is needed — public repos are listed
> anonymously and the PR uses the built-in `GITHUB_TOKEN`.

### Running the sync yourself

```sh
node scripts/sync-projects.mjs          # update projects.json locally
node scripts/sync-projects.mjs --check  # report drift only, exit 1 if out of date
```

Set `GITHUB_TOKEN` in your environment to raise the API rate limit (optional for
public repos). To exclude a repo from discovery, add its name to `meta.ignore` in
`projects.json` (`library` is always excluded).

## Adding or editing a project by hand

Edit `projects.json` and add an entry to the `projects` array:

```json
{
  "slug": "my-new-repo",
  "title": "My New Project",
  "blurb": "One sentence on what it is and what the visitor does.",
  "collection": "FOR",
  "updated": "2026-08-01"
}
```

- `slug` — the repository name. The live URL is derived as
  `https://mxtdnl.github.io/<slug>/` and the source link as
  `https://github.com/mxtdnl/<slug>/`.
  To override either (e.g. a custom domain), add `"url"` and/or `"repo"` fields.
- `collection` — one of the `code` values defined in the `collections` array
  (`DEC`, `FOR`, `HAB`, `JDG`, `PER`). Add a new collection object to create one.
- `updated` — `YYYY-MM-DD`; entries sort newest-first within their collection.

## Local preview

`projects.json` is loaded over HTTP, so open the folder with a server rather than
double-clicking the file:

```sh
python3 -m http.server
# then visit http://localhost:8000/
```

## Deployment

GitHub Pages → **Settings → Pages → Deploy from a branch**, serving the repository
root of the default branch. No Jekyll configuration is required.
