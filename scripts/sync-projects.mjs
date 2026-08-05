#!/usr/bin/env node
/**
 * sync-projects.mjs
 * ------------------
 * Discovers every public repo (for the owner in projects.json) that has GitHub
 * Pages enabled, and merges the list into projects.json.
 *
 *   - Existing entries keep ALL their curation (title, blurb, collection, tags,
 *     any url/repo overrides). Only the `updated` date is refreshed.
 *   - For each newly discovered repo, a GitHub-hosted AI model (GitHub Models)
 *     reads the repo's live page and returns a one-sentence blurb, a best-fit
 *     collection (or a proposal for a brand-new collection when nothing fits),
 *     and a few cross-cutting tags. New collections are capped at one per run to
 *     keep the taxonomy from fragmenting; everything lands in a PR for review.
 *   - If the model is unavailable, new repos fall back to the "NEW" inbox with
 *     the repo's GitHub description (then a TODO) and no tags.
 *   - Entries whose repo no longer has Pages are flagged "stale": true, hidden
 *     from the live site but never deleted.
 *
 * Usage:
 *   node scripts/sync-projects.mjs            # fetch, draft, rewrite projects.json
 *   node scripts/sync-projects.mjs --check    # report changes, write nothing (exit 1 if changes)
 *
 * Environment:
 *   GITHUB_TOKEN     raises API rate limit AND enables AI drafting via GitHub Models.
 *   SYNC_MODEL       model id (default "openai/gpt-4o-mini").
 *   SYNC_NO_AI       "1" to skip AI (fallback placement + no tags).
 *   SYNC_MAX_NEW_COLLECTIONS  cap on new collections created per run (default 1).
 *   SYNC_FIXTURE     path to a JSON array of repo objects (for testing).
 *   SYNC_MODEL_MOCK  "1" to return deterministic fake drafts (for testing).
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, "..", "projects.json");
const INBOX = { code: "NEW", name: "New — awaiting a description", blurb: "Freshly discovered projects. Review each AI-drafted entry, then move it into a collection above." };

const MODELS_ENDPOINT = process.env.SYNC_MODELS_ENDPOINT || "https://models.github.ai/inference/chat/completions";
const MODEL = process.env.SYNC_MODEL || "openai/gpt-4o-mini";
const MAX_NEW_COLLECTIONS = Number(process.env.SYNC_MAX_NEW_COLLECTIONS || 1);

const checkOnly = process.argv.includes("--check");

function prettifyTitle(slug) {
  return slug.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function fetchAllRepos(owner, token) {
  if (process.env.SYNC_FIXTURE) return JSON.parse(await readFile(process.env.SYNC_FIXTURE, "utf8"));
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
  return repos.filter((r) => r && r.has_pages && !r.archived && !r.private && !ignore.has(r.name));
}

/* ---- Page reading -------------------------------------------------------- */

function htmlToText(html) {
  const grab = (re) => { const m = html.match(re); return m ? m[1] : ""; };
  const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const parts = [];
  const title = grab(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) parts.push("TITLE: " + strip(title));
  const metaDesc = grab(/name=["']description["'][^>]*content=["']([\s\S]*?)["']/i);
  if (metaDesc) parts.push("DESCRIPTION: " + strip(metaDesc));
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => strip(m[1]))
    .filter((h) => h && h.length > 3 && !h.includes("${")).slice(0, 4);
  if (headings.length) parts.push("HEADINGS: " + headings.join(" · "));
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => strip(m[1]))
    .filter((p) => p.length > 40 && !p.includes("${") && !/function|const |var |=>/.test(p)).slice(0, 3);
  if (paras.length) parts.push("INTRO: " + paras.join(" "));
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

/* ---- Sanitisers ---------------------------------------------------------- */

function cleanBlurb(s) {
  let t = String(s || "").trim().replace(/^["'“”\s]+|["'“”\s]+$/g, "").replace(/\s+/g, " ");
  if (t && !/[.!?]$/.test(t)) t += ".";
  return t;
}

function slugTag(t) {
  return String(t || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sanitizeTags(tags) {
  const out = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = slugTag(raw);
    if (t && t.length >= 2 && out.indexOf(t) === -1) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

function validCode(code, existingCodes) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (c.length < 2 || c.length > 4) return null;
  if (existingCodes.has(c)) return null; // must be genuinely new
  return c;
}

/* ---- AI drafting --------------------------------------------------------- */

async function draftEntry(owner, repo, ctx, token, useAI) {
  const existingCodes = new Set(ctx.collections.map((c) => c.code));
  const fallback = () => ({
    blurb: (repo.description && repo.description.trim()) || "TODO — add a one-sentence description.",
    collection: INBOX.code,
    tags: [],
    newCollection: null,
  });

  if (!useAI) return fallback();

  const content = await fetchPageText(owner, repo.name);

  if (process.env.SYNC_MODEL_MOCK === "1") {
    let collection = ctx.collections[0]?.code || INBOX.code;
    let newCollection = null;
    const name = repo.name.toLowerCase();
    if (/newcat/.test(name)) { newCollection = { code: "EXP", name: "Experiments & Labs", blurb: "Mock proposed category." }; collection = "EXP"; }
    else if (/habit|reward|friction/.test(name)) collection = "HAB";
    else if (/forecast|fermi|fox/.test(name)) collection = "FOR";
    return { blurb: cleanBlurb("Mock blurb for " + repo.name + (content ? " (page read)" : "")), collection, tags: sanitizeTags(["mock", name.split("-")[0]]), newCollection };
  }

  const colList = ctx.collections.map((c) => `${c.code} — ${c.name}: ${c.blurb}`).join("\n");
  const system =
    "You catalogue a personal portfolio of self-contained interactive web simulations and tools. " +
    "You reply with STRICT JSON only — no prose, no code fences.";
  const user =
    `Repository: ${repo.name}\n` +
    (repo.description ? `GitHub description: ${repo.description}\n` : "") +
    `\nHomepage content:\n${content || "(none available)"}\n\n` +
    `Existing collections:\n${colList}\n\n` +
    `Existing tags (reuse where possible): ${ctx.tags.join(", ") || "(none yet)"}\n\n` +
    "Return JSON with exactly these keys:\n" +
    '{\n' +
    '  "blurb": one sentence, max 22 words, British English, sentence case, starting with a verb or the subject (not "This"/"A project that");\n' +
    '  "collection": the CODE of the single best-fitting existing collection above;\n' +
    '  "new_collection": null, OR {"code","name","blurb"} ONLY if the project genuinely fits none of the existing collections AND a new one would plausibly hold future projects too — code is 2-4 uppercase letters, name is 2-4 words, blurb is one short sentence. Strongly prefer an existing collection;\n' +
    '  "tags": array of 2-4 lowercase kebab-case tags, reusing the existing tags above where they fit.\n' +
    "}\n" +
    'If you propose a new_collection, set "collection" to its code.';

  try {
    const res = await fetch(MODELS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "library-sync" },
      body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 220, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`  ! model call failed for ${repo.name} (${res.status}); using fallback. ${body.slice(0, 160)}`);
      return fallback();
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonText);

    const blurb = cleanBlurb(parsed.blurb) || fallback().blurb;
    const tags = sanitizeTags(parsed.tags);

    let newCollection = null;
    let collection = String(parsed.collection || "").toUpperCase().replace(/[^A-Z]/g, "");

    if (parsed.new_collection && parsed.new_collection.code) {
      const code = validCode(parsed.new_collection.code, existingCodes);
      const name = String(parsed.new_collection.name || "").trim();
      const cblurb = cleanBlurb(parsed.new_collection.blurb);
      if (code && name) {
        newCollection = { code, name, blurb: cblurb || "" };
        collection = code;
      }
    }
    if (!newCollection && !existingCodes.has(collection)) {
      // model returned an unknown/blank collection and no valid proposal → inbox
      collection = INBOX.code;
    }
    return { blurb, collection, tags, newCollection };
  } catch (err) {
    console.warn(`  ! model errored for ${repo.name} (${err.message}); using fallback.`);
    return fallback();
  }
}

/* ---- Merge --------------------------------------------------------------- */

function merge(data, repos, drafts) {
  const live = eligible(data, repos);
  const liveBySlug = new Map(live.map((r) => [r.name, r]));
  const existing = data.projects.slice();
  const existingSlugs = new Set(existing.map((p) => p.slug));
  const validCodes = new Set(data.collections.map((c) => c.code).concat(INBOX.code));
  const summary = { added: [], refreshed: [], staled: [], unstaled: [], newCollections: [] };

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
    const d = drafts.get(repo.name) || { blurb: "", collection: INBOX.code, tags: [] };
    const collection = validCodes.has(d.collection) ? d.collection : INBOX.code;
    const entry = {
      slug: repo.name,
      title: prettifyTitle(repo.name),
      blurb: d.blurb || (repo.description && repo.description.trim()) || "TODO — add a one-sentence description.",
      collection,
    };
    if (d.tags && d.tags.length) entry.tags = d.tags;
    entry.updated = (repo.pushed_at || "").slice(0, 10);
    existing.push(entry);
    summary.added.push(repo.name);
  }

  // Ensure the NEW inbox exists iff something is filed under it.
  const hasInbox = existing.some((p) => p.collection === INBOX.code);
  const cols = data.collections.filter((c) => c.code !== INBOX.code);
  if (hasInbox) cols.push({ ...INBOX });
  data.collections = cols;
  data.projects = existing;
  return summary;
}

function stableStringify(data) {
  const order = ["slug", "title", "subtitle", "blurb", "collection", "tags", "updated", "url", "repo", "stale"];
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

function registerNewCollection(data, nc) {
  if (data.collections.some((c) => c.code === nc.code)) return false;
  // Insert before a Personal (PER) collection if present, else append.
  const perIdx = data.collections.findIndex((c) => c.code === "PER");
  const entry = { code: nc.code, name: nc.name, blurb: nc.blurb || "" };
  if (perIdx === -1) data.collections.push(entry);
  else data.collections.splice(perIdx, 0, entry);
  return true;
}

async function main() {
  const before = await readFile(DATA_PATH, "utf8");
  const data = JSON.parse(before);
  const owner = data.meta?.owner;
  if (!owner) throw new Error("projects.json: meta.owner is required.");

  const token = process.env.GITHUB_TOKEN;
  const useAI = !checkOnly && process.env.SYNC_NO_AI !== "1" && (!!token || process.env.SYNC_MODEL_MOCK === "1");

  const repos = await fetchAllRepos(owner, token);

  const existingSlugs = new Set(data.projects.map((p) => p.slug));
  const newRepos = eligible(data, repos).filter((r) => !existingSlugs.has(r.name));

  // Context handed to the model: current collections + existing tag vocabulary.
  const tagVocab = Array.from(new Set(data.projects.flatMap((p) => p.tags || []))).sort();
  const drafts = new Map();
  const newCollectionsAdded = [];

  if (newRepos.length) {
    console.log(`Drafting ${newRepos.length} new entr${newRepos.length === 1 ? "y" : "ies"}${useAI ? " via " + MODEL : " (AI off — fallbacks)"}…`);
    for (const r of newRepos) {
      const ctx = { collections: data.collections.filter((c) => c.code !== INBOX.code), tags: tagVocab };
      const d = await draftEntry(owner, r, ctx, token, useAI);
      // Accept a proposed new collection, capped per run; otherwise send repo to inbox.
      if (d.newCollection) {
        const already = newCollectionsAdded.find((c) => c.code === d.newCollection.code);
        if (already) {
          // same proposed code reused — fine
        } else if (newCollectionsAdded.length < MAX_NEW_COLLECTIONS) {
          if (registerNewCollection(data, d.newCollection)) newCollectionsAdded.push(d.newCollection);
        } else {
          console.warn(`  ! new-collection cap reached; filing ${r.name} in the NEW inbox instead of "${d.newCollection.code}".`);
          d.collection = INBOX.code;
        }
      }
      drafts.set(r.name, d);
    }
  }

  const summary = merge(data, repos, drafts);
  summary.newCollections = newCollectionsAdded.map((c) => `${c.code} (${c.name})`);
  const after = stableStringify(data);
  const changed = after !== before;

  console.log([
    `Discovered ${repos.length} repos for @${owner}.`,
    `  + added        : ${summary.added.length ? summary.added.join(", ") : "none"}`,
    `  ★ new category : ${summary.newCollections.length ? summary.newCollections.join(", ") : "none"}`,
    `  ~ dates        : ${summary.refreshed.length ? summary.refreshed.join(", ") : "none"}`,
    `  ! stale        : ${summary.staled.length ? summary.staled.join(", ") : "none"}`,
    `  ✓ un-stale     : ${summary.unstaled.length ? summary.unstaled.join(", ") : "none"}`,
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
      `new_collections=${summary.newCollections.join(", ")}`,
    ];
    await writeFile(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n", { flag: "a" });
  }
}

main().catch((err) => { console.error("sync failed:", err.message); process.exit(2); });
