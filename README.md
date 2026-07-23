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
2. For any repo it doesn't already know, a GitHub-hosted AI model (GitHub Models)
   reads the repo's live page and drafts:
   - a **one-sentence blurb**,
   - the **best-fit collection** — or, if the project genuinely fits none, a
     **proposal for a brand-new collection** (capped at one per run to stop the
     taxonomy fragmenting), and
   - a few cross-cutting **tags** (reusing the existing tag vocabulary where it can).

   If the model is unavailable it falls back to the repo's GitHub description
   (then a TODO), files the repo under **New — awaiting a description**, and adds
   no tags.
3. Refreshes each project's `updated` date, and flags any project whose Pages
   site has gone offline with `"stale": true` (hidden from the live site but kept
   in the file, never silently deleted).
4. If anything changed, opens (or updates) a pull request.

**Nothing reaches the live site until you merge that PR.** Your job on each PR is
to sanity-check the AI's blurb, collection, and tags — and any **proposed new
category** especially, since that grows the taxonomy.

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
  "tags": ["forecasting", "classroom"],
  "updated": "2026-08-01"
}
```

- `slug` — the repository name. The live URL is derived as
  `https://mxtdnl.github.io/<slug>/` and the source link as
  `https://github.com/mxtdnl/<slug>/`.
  To override either (e.g. a custom domain), add `"url"` and/or `"repo"` fields.
- `collection` — the project's **one** primary home; a `code` from the
  `collections` array (`DEC`, `FOR`, `HAB`, `JDG`, `PER`). It drives the
  shelf-mark and the section the project appears in. Add a new collection object
  to create one.
- `tags` — optional array of lowercase kebab-case labels for **cross-cutting**
  themes. Unlike `collection`, a project can have several, and they power the
  *Filter by tag* chips on the page. Reuse existing tags where you can (keeps the
  filter tidy); new ones just appear automatically.
- `updated` — `YYYY-MM-DD`; entries sort newest-first within their collection.

### Collections vs tags

A project lives in exactly **one collection** (its shelf) but can carry **many
tags** (its themes). Collections are the deliberate, curated structure — the
sync tool only adds one at a time and only when nothing fits. Tags are additive
and cheap, so they can proliferate freely for discovery without cluttering the
catalogue's structure.

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
