#!/usr/bin/env node
/**
 * sync-projects.mjs
 * ------------------
 * Discovers every public repo (for the owner in projects.json) that has GitHub
 * Pages enabled, and merges the list into projects.json.
 *
 *   - Existing entries keep ALL their curation (title, blurb, collection, any
 *     url/repo overrides). Only the `updated` date is refreshed from the repo.
 *   - Newly discovered repos are appended to the "NEW" inbox collection with a
 *     placeholder blurb (the repo's GitHub description if it has one), ready for
 *     you to write copy and file under a real collection.
 *   - Entries whose repo no longer has Pages (deleted / disabled) are flagged
 *     with "stale": true rather than deleted, so hand-written copy is never lost.
 *
 * Usage:
 *   node scripts/sync-projects.mjs            # fetch from the GitHub API, rewrite projects.json
 *   node scripts/sync-projects.mjs --check    # report what would change, write nothing (exit 1 if changes)
 *
 * Environment:
 *   GITHUB_TOKEN   optional; raises the API rate limit. Public repos are listed
 *                  without it, so no token is required for public Pages sites.
 *   SYNC_FIXTURE   optional path to a JSON array of repo objects, used instead
 *                  of the live API (for local testing).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "projects.json");
const INBOX = { code: "NEW", name: "New — awaiting a description", blurb: "Freshly discovered projects. Give each a real description and move it into a collection above." };

const checkOnly = process.argv.includes("--check");

function prettifyTitle(slug) {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function fetchAllRepos(owner, token) {
  if (process.env.SYNC_FIXTURE) {
    const raw = await readFile(process.env.SYNC_FIXTURE, "utf8");
    return JSON.parse(raw);
  }
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "library-sync" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    const url = `https://api.github.com/users/${owner}/repos?per_page=100&type=owner&sort=pushed&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status} for ${url}\n${body.slice(0, 300)}`);
    }
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function merge(data, repos) {
  const owner = data.meta?.owner;
  const ignore = new Set([...(data.meta?.ignore || []), "library"]);

  // Eligible = public, not archived, has Pages, not on the ignore list.
  const live = repos.filter(
    (r) => r && r.has_pages && !r.archived && !r.private && !ignore.has(r.name)
  );
  const liveBySlug = new Map(live.map((r) => [r.name, r]));

  const existing = data.projects.slice();
  const existingSlugs = new Set(existing.map((p) => p.slug));

  const summary = { added: [], refreshed: [], staled: [], unstaled: [] };

  // 1. Update existing entries in place (preserve curation).
  for (const p of existing) {
    const repo = liveBySlug.get(p.slug);
    if (repo) {
      const newDate = (repo.pushed_at || "").slice(0, 10);
      if (newDate && newDate !== p.updated) {
        p.updated = newDate;
        summary.refreshed.push(p.slug);
      }
      if (p.stale) {
        delete p.stale;
        summary.unstaled.push(p.slug);
      }
    } else if (!p.stale) {
      // Was catalogued but no longer has Pages — flag, don't delete.
      p.stale = true;
      summary.staled.push(p.slug);
    }
  }

  // 2. Append genuinely new repos to the NEW inbox.
  for (const repo of live) {
    if (existingSlugs.has(repo.name)) continue;
    existing.push({
      slug: repo.name,
      title: prettifyTitle(repo.name),
      blurb: (repo.description && repo.description.trim()) || "TODO — add a one-sentence description.",
      collection: INBOX.code,
      updated: (repo.pushed_at || "").slice(0, 10),
    });
    summary.added.push(repo.name);
  }

  // 3. Ensure the NEW collection exists iff there is at least one entry in it.
  const hasInbox = existing.some((p) => p.collection === INBOX.code);
  const cols = data.collections.filter((c) => c.code !== INBOX.code);
  if (hasInbox) cols.push({ ...INBOX });
  data.collections = cols;

  data.projects = existing;
  return summary;
}

function stableStringify(data) {
  // Re-emit projects with a consistent key order for clean diffs.
  const order = ["slug", "title", "blurb", "collection", "updated", "url", "repo", "stale"];
  const ordered = {
    ...data,
    projects: data.projects.map((p) => {
      const o = {};
      for (const k of order) if (k in p) o[k] = p[k];
      for (const k of Object.keys(p)) if (!(k in o)) o[k] = p[k];
      return o;
    }),
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

async function main() {
  const before = await readFile(DATA_PATH, "utf8");
  const data = JSON.parse(before);
  const owner = data.meta?.owner;
  if (!owner) throw new Error("projects.json: meta.owner is required.");

  const repos = await fetchAllRepos(owner, process.env.GITHUB_TOKEN);
  const summary = merge(data, repos);
  const after = stableStringify(data);
  const changed = after !== before;

  const report = [
    `Discovered ${repos.length} repos for @${owner}.`,
    `  + added   : ${summary.added.length ? summary.added.join(", ") : "none"}`,
    `  ~ dates   : ${summary.refreshed.length ? summary.refreshed.join(", ") : "none"}`,
    `  ! stale   : ${summary.staled.length ? summary.staled.join(", ") : "none"}`,
    `  ✓ un-stale: ${summary.unstaled.length ? summary.unstaled.join(", ") : "none"}`,
  ].join("\n");
  console.log(report);

  if (checkOnly) {
    console.log(changed ? "\nprojects.json is OUT OF DATE (run without --check to update)." : "\nprojects.json is up to date.");
    process.exit(changed ? 1 : 0);
  }

  if (changed) {
    await writeFile(DATA_PATH, after);
    console.log("\nprojects.json updated.");
  } else {
    console.log("\nNo changes — projects.json already up to date.");
  }

  // Emit a machine-readable summary for CI (GitHub Actions picks this up).
  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `changed=${changed}`,
      `added_count=${summary.added.length}`,
      `added_list=${summary.added.join(", ")}`,
    ];
    await writeFile(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n", { flag: "a" });
  }
}

main().catch((err) => {
  console.error("sync failed:", err.message);
  process.exit(2);
});
