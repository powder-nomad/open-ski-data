#!/usr/bin/env node
/**
 * Stable-ID drift guard.
 *
 * Open-ski-data is the source of truth for Altera's catalog. Altera's
 * sync upserts rows by a stable key derived from the JSON files here:
 *   - slope / lift `id` fields
 *   - webcam `label` fields
 *   - slope-graph node / edge `id` fields
 *   - place_slug / region_slug / country_code
 *
 * When a stable id vanishes from the head revision of a PR, Altera will
 * tombstone the corresponding row. That's usually wrong — contributors
 * typo, re-import, or rename something without realising it breaks
 * historical ActivityRun references downstream.
 *
 * This script diffs stable ids between a base ref and the working tree,
 * fails the PR if any were removed or renamed.
 *
 * Acknowledged renames: if the change is deliberate, record it in
 * `registry/aliases.json` (see ../docs/SLUG-LIFECYCLE.md). The script
 * applies those rewrites to the base set before diffing, so a removal
 * that matches a ledger entry is logged as "acknowledged" rather than
 * treated as drift.
 *   - `renames[]` rewrites every id under the old place_slug to the new.
 *   - `items[]` rewrites `<kind>:<place_slug>/<from>` → `.../<to>`.
 *
 * Escape hatch: `ALLOW_ID_CHANGE=1` (or `allow-id-change` PR label) for
 * one-off removals where appending to aliases.json doesn't make sense
 * (eg. tombstoning a lift that was never published).
 *
 * Usage:
 *   node scripts/check-stable-ids.mjs origin/main
 *   ALLOW_ID_CHANGE=1 node scripts/check-stable-ids.mjs origin/main
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const baseRef = process.argv[2];
if (!baseRef) {
  console.error("usage: node scripts/check-stable-ids.mjs <base-ref>");
  process.exit(2);
}
const allowIdChange = process.env.ALLOW_ID_CHANGE === "1";

// ── collect ids ────────────────────────────────────────────────────

/**
 * Extract every stable id we care about from a JSON document, namespaced
 * by kind so the diff is unambiguous. Returns a Set<string> of keys.
 */
function extractIds(relativePath, json) {
  const ids = new Set();
  if (!json || typeof json !== "object") return ids;

  // place_slug lives in most catalog files; capture it as a placement
  // invariant so moving a file between country/region dirs is flagged.
  if (typeof json.place_slug === "string") {
    ids.add(`place:${json.place_slug}`);
  }
  // Country / region index files.
  if (Array.isArray(json.countries)) {
    for (const c of json.countries) {
      if (c?.country_code) ids.add(`country:${c.country_code}`);
    }
  }
  if (Array.isArray(json.regions)) {
    for (const r of json.regions) {
      if (r?.region_slug && json.country?.country_code) {
        ids.add(`region:${json.country.country_code}/${r.region_slug}`);
      }
    }
  }

  // Catalog entities per place.
  const slug = json.place_slug;
  if (slug) {
    if (Array.isArray(json.slopes)) {
      for (const s of json.slopes) {
        if (s?.id != null) ids.add(`slope:${slug}/${s.id}`);
      }
    }
    if (Array.isArray(json.lifts)) {
      for (const l of json.lifts) {
        if (l?.id != null) ids.add(`lift:${slug}/${l.id}`);
      }
    }
    if (Array.isArray(json.webcams)) {
      for (const w of json.webcams) {
        // Webcams have no id in the schema — label is the stable handle.
        if (w?.label) ids.add(`webcam:${slug}/${w.label}`);
      }
    }
    if (Array.isArray(json.nodes) || Array.isArray(json.edges)) {
      for (const n of json.nodes ?? []) {
        if (n?.id) ids.add(`graph-node:${slug}/${n.id}`);
      }
      for (const e of json.edges ?? []) {
        if (e?.id) ids.add(`graph-edge:${slug}/${e.id}`);
      }
    }
  }

  return ids;
}

/** Walk the registry dir in a given tree, return a Set of all stable ids. */
async function collectFromWorkingTree() {
  const all = new Set();
  const root = path.join(repoRoot, "registry");
  await walk(root, async (abs) => {
    if (!abs.endsWith(".json")) return;
    if (abs.endsWith(".live.json")) return; // generated, not source-of-truth
    const rel = path.relative(repoRoot, abs);
    try {
      const json = JSON.parse(await fs.readFile(abs, "utf8"));
      for (const id of extractIds(rel, json)) all.add(id);
    } catch {
      // ignore unreadable files — check-reference-data.mjs catches schema issues
    }
  });
  return all;
}

async function walk(dir, visit) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(abs, visit);
    else await visit(abs);
  }
}

function collectFromBase(ref) {
  // `git ls-tree -r` lists every blob at the ref. Filter to registry/
  // JSON, read each via `git show`, parse, extract ids.
  const out = execSync(`git ls-tree -r --name-only ${ref} -- registry`, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const all = new Set();
  for (const line of out.split("\n")) {
    const rel = line.trim();
    if (!rel.endsWith(".json") || rel.endsWith(".live.json")) continue;
    const r = spawnSync("git", ["show", `${ref}:${rel}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (r.status !== 0) continue;
    try {
      const json = JSON.parse(r.stdout);
      for (const id of extractIds(rel, json)) all.add(id);
    } catch {
      // Malformed JSON on the base side is someone else's problem.
    }
  }
  return all;
}

// ── aliases-driven rewriting ──────────────────────────────────────

/**
 * Load aliases.json (HEAD working tree). Returns {renames, items} with
 * empty arrays as the fallback so callers can iterate without guards.
 */
async function readAliases() {
  const aliasesPath = path.join(repoRoot, "registry", "aliases.json");
  try {
    const doc = JSON.parse(await fs.readFile(aliasesPath, "utf8"));
    return {
      renames: Array.isArray(doc?.renames) ? doc.renames : [],
      items: Array.isArray(doc?.items) ? doc.items : [],
    };
  } catch {
    return { renames: [], items: [] };
  }
}

/**
 * Apply both rename ledgers to a single base id. Order matters: a
 * place rename rewrites the place_slug component first, then the item
 * rename (whose place_slug is recorded as the post-place-rename slug)
 * can match.
 */
function applyOne(id, placeRenameMap, itemRenameMap) {
  const colon = id.indexOf(":");
  if (colon < 0) return id;
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);

  const slash = rest.indexOf("/");
  let placePart = slash < 0 ? rest : rest.slice(0, slash);
  const itemPart = slash < 0 ? "" : rest.slice(slash);

  if (placeRenameMap.has(placePart)) {
    placePart = placeRenameMap.get(placePart);
  }
  const withPlace = `${kind}:${placePart}${itemPart}`;
  return itemRenameMap.get(withPlace) ?? withPlace;
}

/**
 * Returns {rewritten: Set<id>, acknowledged: Array<{from, to}>}.
 * `rewritten` is the base set after applying ledger rewrites.
 * `acknowledged` is the list of (base, head) pairs that the ledger
 * resolved (useful for logging).
 */
function applyAliases(baseIds, aliases) {
  // `kind` namespaces affected by a `renames` entry — see extractIds().
  // `country` and `region` ids don't carry a place_slug component so
  // they're never rewritten by a place rename.
  const PLACE_RENAMABLE_KINDS = new Set([
    "place", "slope", "lift", "webcam", "graph-node", "graph-edge",
  ]);
  const placeRenameMap = new Map();
  for (const r of aliases.renames) {
    if (typeof r?.from === "string" && typeof r?.to === "string") {
      placeRenameMap.set(r.from, r.to);
    }
  }
  const itemRenameMap = new Map();
  for (const it of aliases.items) {
    if (
      typeof it?.kind === "string" &&
      typeof it?.place_slug === "string" &&
      typeof it?.from === "string" &&
      typeof it?.to === "string"
    ) {
      const key = `${it.kind}:${it.place_slug}/${it.from}`;
      const val = `${it.kind}:${it.place_slug}/${it.to}`;
      itemRenameMap.set(key, val);
    }
  }

  const rewritten = new Set();
  const acknowledged = [];
  for (const id of baseIds) {
    const colon = id.indexOf(":");
    const kind = colon < 0 ? "" : id.slice(0, colon);
    // Skip place-rename application for kinds without a place component.
    const next = PLACE_RENAMABLE_KINDS.has(kind) || itemRenameMap.size > 0
      ? applyOne(id, placeRenameMap, itemRenameMap)
      : id;
    if (next !== id) acknowledged.push({ from: id, to: next });
    rewritten.add(next);
  }
  return { rewritten, acknowledged };
}

// ── main ──────────────────────────────────────────────────────────

function main() {
  const baseIds = collectFromBase(baseRef);
  return Promise.all([collectFromWorkingTree(), readAliases()]).then(
    ([headIds, aliases]) => {
      const { rewritten: rewrittenBase, acknowledged } = applyAliases(baseIds, aliases);

      const removed = [...rewrittenBase].filter((id) => !headIds.has(id)).sort();
      const added = [...headIds].filter((id) => !rewrittenBase.has(id)).sort();

      // Only surface ledger entries that actually resolved a removal —
      // a base id rewritten to something that *also* isn't in HEAD is
      // still drift, and we don't want to claim the ledger "fixed" it.
      const reconciled = acknowledged.filter((a) => headIds.has(a.to));
      if (reconciled.length > 0) {
        console.log(`\nAcknowledged renames via aliases.json (${reconciled.length}):`);
        for (const a of reconciled) console.log(`  ${a.from}  →  ${a.to}`);
      }

      if (added.length > 0) {
        console.log(`\nNew stable ids (${added.length}):`);
        for (const id of added) console.log(`  + ${id}`);
      }

      if (removed.length === 0) {
        console.log(`\n✓ No unacknowledged stable-id removals between ${baseRef} and HEAD.`);
        return 0;
      }

      console.log(`\nRemoved or renamed stable ids (${removed.length}):`);
      for (const id of removed) console.log(`  - ${id}`);

      if (allowIdChange) {
        console.log(`\n⚠ ALLOW_ID_CHANGE=1 — accepting these removals.`);
        console.log(`  Make sure Altera's catalog has been manually checked`);
        console.log(`  (these rows will be tombstoned on the next sync).`);
        return 0;
      }

      console.error(`\n✗ Stable-id drift detected. If this is deliberate:`);
      console.error(`  - Append an entry to registry/aliases.json (preferred — see docs/SLUG-LIFECYCLE.md)`);
      console.error(`  - OR add the \`allow-id-change\` label to the PR`);
      console.error(`  - OR re-run the script locally with ALLOW_ID_CHANGE=1`);
      console.error(`  Historical Altera rows referencing these ids will be soft-deleted unless aliased.`);
      return 1;
    },
  );
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(2);
});
