# The Library of mxtdnl

A single-page **hub / portfolio** that catalogues every one of my published
[GitHub Pages](https://pages.github.com/) projects and links out to each live site.
It is deployed with GitHub Pages and lives at:

**https://mxtdnl.github.io/library/**

## How it works

- **`index.html`** — the catalogue. It fetches `projects.json` at load time and
  renders each project as a shelf-marked entry, grouped into thematic collections.
  Vanilla HTML/CSS/JS, no build step, no runtime dependencies (fonts aside).
- **`projects.json`** — the data. This is maintained **by hand**; it was initially
  seeded from the GitHub API and each project's own page content.
- **`favicon.svg`** — the tab icon.

## Adding a project

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
