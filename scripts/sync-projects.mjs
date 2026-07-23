#!/usr/bin/env node
/**
 * sync-projects.mjs
 * ------------------
 * Discovers every public repo (for the owner in projects.json) that has GitHub
 * Pages enabled, and merges the list into projects.json.
 *
 *   - Existing entries keep ALL their curation (title, blurb, collection, any
 *     url/repo overrides). Only the `updated` date is refreshed from the repo.
 *   - Newly discovered repos are appended to the "NEW" inbox collection. Their
 *     blurb is drafted automatically: a one-sentence description written by a
 *     GitHub-hosted AI model from the repo's live page, falling back to the
 *     repo's GitHub description, then a plain TODO.
 *   - Entries whose repo no longer has Pages (deleted / disabled) are flagged
 *     with "stale": true rather than deleted, so hand-written copy is never lost.
 *
 * Usage:
 *   node scripts/sync-projects.mjs            # fetch, draft blurbs, rewrite projects.json
 *   node scripts/sync-projects.mjs --check    # report what would change, write nothing (exit 1 if changes)
 *
 * Environment:
 *   GITHUB_TOKEN   optional; raises the API rate limit AND enables AI blurb
 *                  drafting via GitHub Models. Public repos are listed without it.
 *   SYNC_MODEL     model id for GitHub Models (default "openai/gpt-4o-mini").
 *   SYNC_NO_AI     set to "1" to skip AI drafting (use repo description / TODO).
 *   SYNC_FIXTURE   path to a JSON array of repo objects, used instead of the
 *                  live repo listing (for local testing).
 *   SYNC_MODEL_MOCK set to "1" to return a deterministic fake blurb instead of
 *                  calling the model (for local testing).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "projects.json");
const INBOX = { code: "NEW", name: "New — awaiting a description", blurb: "Freshly discovered projects. Review each AI-drafted description, then move it into a collection above." };

const MODELS_ENDPOINT = process.env.SYNC_MODELS_ENDPOINT || "https://models.github.ai/inference/chat/completions";
const MODEL = process.env.SYNC_MODEL || "openai/gpt-4o-mini";

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
    return JSON.parse(await readFile(process.env.SYNC_FIXTURE, "utf8"));
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

function eligible(data, repos) {
  const ignore = new Set([...(data.meta?.ignore || []), "library"]);
  return repos.filter(
    (r) => r && r.has_pages && !r.archived && !r.private && !ignore.has(r.name)
  );
}

/* ---- Blurb drafting ------------------------------------------------------ */

function htmlToText(html) {
  const grab = (re) => { const m = html.match(re); return m ? m[1] : ""; };
  const title = grab(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDesc = grab(/name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => m[1]);
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const parts = [];
  if (title) parts.push("TITLE: " + strip(title));
  if (metaDesc) parts.push("DESCRIPTION: " + strip(metaDesc));
  const cleanHeadings = headings.map(strip).filter((h) => h && h.length > 3 && !h.includes("${")).slice(0, 4);
  if (cleanHeadings.length) parts.push("HEADINGS: " + cleanHeadings.join(" · "));
  const cleanParas = paras.map(strip).filter((p) => p.length > 40 && !p.includes("${") && !/function|const |var |=>/.test(p)).slice(0, 3);
  if (cleanParas.length) parts.push("INTRO: " + cleanParas.join(" "));
  return parts.join("\n").slice(0, 3500);
}

async function fetchPageText(owner, slug) {
  const candidates = [
    `https://raw.githubusercontent.com/${owner}/${slug}/HEAD/index.html`,
    `https://raw.githubusercontent.com/${owner}/${slug}/HEAD/README.md`,
    `https://raw.githubusercontent.com/${owner}/${slug}/HEAD/docs/index.html`,
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "library-sync" } });
      if (!res.ok) continue;
      const body = await res.text();
      const text = url.endsWith(".md") ? body.replace(/[#>*`_]/g, " ").replace(/\s+/g, " ").slice(0, 3500) : htmlToText(body);
      if (text.trim()) return text;
    } catch { /* try next */ }
  }
  return "";
}

function cleanBlurb(s) {
  let t = String(s || "").trim();
  t = t.replace(/^["'“”\s]+|["'“”\s]+$/g, ""); // strip wrapping quotes/space
  t = t.replace(/\s+/g, " ");                    // single line
  if (t && !/[.!?]$/.test(t)) t += ".";          // ensure terminal punctuation
  return t;
}

async function draftBlurb(owner, repo, token, useAI) {
  const fallback = () => (repo.description && repo.description.trim()) || "TODO — add a one-sentence description.";

  if (!useAI) return fallback();

  const content = await fetchPageText(owner, repo.name);

  if (process.env.SYNC_MODEL_MOCK === "1") {
    // Deterministic stand-in for offline testing of the wiring.
    return cleanBlurb(`Mock blurb for ${repo.name}${content ? " (page read)" : " (no page)"}`);
  }

  const system =
    "You write concise, factual one-sentence catalogue entries for a personal portfolio of " +
    "self-contained interactive web simulations and tools. British English, sentence case.";
  const user =
    `Repository: ${repo.name}\n` +
    (repo.description ? `GitHub description: ${repo.description}\n` : "") +
    `\nHomepage content:\n${content || "(none available)"}\n\n` +
    "Write ONE sentence, maximum 22 words, that says plainly what this project is and what the " +
    "visitor does. Start with a verb or the subject — not with 'This' or 'A project that'. " +
    "No marketing adjectives, no exclamation. Return only the sentence.";

  try {
    const res = await fetch(MODELS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "library-sync",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 80,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`  ! model call failed for ${repo.name} (${res.status}); using fallback. ${body.slice(0, 160)}`);
      return fallback();
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    const blurb = cleanBlurb(text);
    return blurb || fallback();
  } catch (err) {
    console.warn(`  ! model call errored for ${repo.name} (${err.message}); using fallback.`);
    return fallback();
  }
}

/* ---- Merge --------------------------------------------------------------- */

function merge(data, repos, blurbs) {
  const live = eligible(data, repos);
  const liveBySlug = new Map(live.map((r) => [r.name, r]));

  const existing = data.projects.slice();
  const existingSlugs = new Set(existing.map((p) => p.slug));
  const summary = { added: [], refreshed: [], staled: [], unstaled: [] };

  for (const p of existing) {
    const repo = liveBySlug.get(p.slug);
    if (repo) {
      const newDate = (repo.pushed_at || "").slice(0, 10);
      if (newDate && newDate !== p.updated) { p.updated = newDate; summary.refreshed.push(p.slug); }
      if (p.stale) { delete p.stale; summary.unstaled.push(p.slug); }
    } else if (!p.stale) {
      p.stale = true; summary.staled.push(p.slug);
    }
  }

  for (const repo of live) {
    if (existingSlugs.has(repo.name)) continue;
    existing.push({
      slug: repo.name,
      title: prettifyTitle(repo.name),
      blurb: blurbs.get(repo.name) || (repo.description && repo.description.trim()) || "TODO — add a one-sentence description.",
      collection: INBOX.code,
      updated: (repo.pushed_at || "").slice(0, 10),
    });
    summary.added.push(repo.name);
  }

  const hasInbox = existing.some((p) => p.collection === INBOX.code);
  const cols = data.collections.filter((c) => c.code !== INBOX.code);
  if (hasInbox) cols.push({ ...INBOX });
  data.collections = cols;
  data.projects = existing;
  return summary;
}

function stableStringify(data) {
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

  const token = process.env.GITHUB_TOKEN;
  const useAI = !checkOnly && process.env.SYNC_NO_AI !== "1" && (!!token || process.env.SYNC_MODEL_MOCK === "1");

  const repos = await fetchAllRepos(owner, token);

  // Draft blurbs only for genuinely new repos, before merging.
  const existingSlugs = new Set(data.projects.map((p) => p.slug));
  const newRepos = eligible(data, repos).filter((r) => !existingSlugs.has(r.name));
  const blurbs = new Map();
  if (newRepos.length) {
    console.log(`Drafting ${newRepos.length} new blurb(s)${useAI ? " via " + MODEL : " (AI off — using fallbacks)"}…`);
    for (const r of newRepos) {
      blurbs.set(r.name, await draftBlurb(owner, r, token, useAI));
    }
  }

  const summary = merge(data, repos, blurbs);
  const after = stableStringify(data);
  const changed = after !== before;

  console.log([
    `Discovered ${repos.length} repos for @${owner}.`,
    `  + added   : ${summary.added.length ? summary.added.join(", ") : "none"}`,
    `  ~ dates   : ${summary.refreshed.length ? summary.refreshed.join(", ") : "none"}`,
    `  ! stale   : ${summary.staled.length ? summary.staled.join(", ") : "none"}`,
    `  ✓ un-stale: ${summary.unstaled.length ? summary.unstaled.join(", ") : "none"}`,
  ].join("\n"));

  if (checkOnly) {
    console.log(changed ? "\nprojects.json is OUT OF DATE (run without --check to update)." : "\nprojects.json is up to date.");
    process.exit(changed ? 1 : 0);
  }

  if (changed) { await writeFile(DATA_PATH, after); console.log("\nprojects.json updated."); }
  else { console.log("\nNo changes — projects.json already up to date."); }

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
