// check-aliases.mjs — validate registry/aliases.json
//
// Rules:
//   - File parses as JSON.
//   - `renames` is an array (place_slug renames).
//   - `items` is an array (lift / slope / webcam id renames within a place).
//   - Each `renames` entry has `seq` (positive integer), `from` (kebab-case
//     slug), `to` (kebab-case slug), `at` (ISO date YYYY-MM-DD).
//   - Each `items` entry has `seq` (positive integer), `kind`
//     ("lift" | "slope" | "webcam"), `place_slug` (kebab-case slug),
//     `from` (id/label), `to` (id/label), `at` (ISO date YYYY-MM-DD).
//   - `from` != `to` in both arrays.
//   - `seq` is strictly increasing and starts at 1 within each array
//     (each array has its own independent cursor space; consumers
//     subscribe to only the seq spaces they care about).
//   - No duplicate `from` values in `renames` (a slug can only be
//     renamed once; chain follow-up renames through the new slug).
//   - No duplicate (`place_slug`, `kind`, `from`) tuples in `items`
//     (same rationale: chain follow-ups through the new id).
//   - Each `renames.to` resolves to a real place_slug under
//     registry/<...>/<to>/. Otherwise the alias points nowhere and
//     consumers will produce orphans. Emits a warning, not an error,
//     in case a `to` was planned but the place file hasn't been
//     added yet.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const registryRoot = path.join(repoRoot, "registry");
const aliasesPath = path.join(registryRoot, "aliases.json");

const errors = [];
const warnings = [];

function rel(filePath) {
  return path.relative(repoRoot, filePath);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_ITEM_KINDS = new Set(["lift", "slope", "webcam"]);

function expectString(value, ctx) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${ctx}: must be a non-empty string`);
    return false;
  }
  return true;
}

function expectSlug(value, ctx) {
  if (!expectString(value, ctx)) return false;
  if (!SLUG_RE.test(value)) {
    errors.push(`${ctx}: "${value}" is not a kebab-case slug (a-z, 0-9, hyphens; must start with a-z/0-9)`);
    return false;
  }
  return true;
}

function expectDate(value, ctx) {
  if (!expectString(value, ctx)) return false;
  if (!DATE_RE.test(value)) {
    errors.push(`${ctx}: "${value}" is not ISO date YYYY-MM-DD`);
    return false;
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    errors.push(`${ctx}: "${value}" is not a valid date`);
    return false;
  }
  return true;
}

function expectPositiveInt(value, ctx) {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${ctx}: must be a positive integer (got ${JSON.stringify(value)})`);
    return false;
  }
  return true;
}

function expectKind(value, ctx) {
  if (!expectString(value, ctx)) return false;
  if (!VALID_ITEM_KINDS.has(value)) {
    errors.push(`${ctx}: "${value}" is not a valid kind (${[...VALID_ITEM_KINDS].join("|")})`);
    return false;
  }
  return true;
}

function expectNonEmptyString(value, ctx) {
  return expectString(value, ctx);
}

// Build a slug → place.json path index from registry/, so we can verify
// each rename's `to` actually points somewhere.
async function buildSlugIndex() {
  const slugs = new Map();
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      const placeJson = path.join(sub, "place.json");
      if (await exists(placeJson)) {
        slugs.set(e.name, placeJson);
        continue;
      }
      await walk(sub);
    }
  }
  await walk(registryRoot);
  return slugs;
}

async function main() {
  if (!(await exists(aliasesPath))) {
    console.log("no registry/aliases.json — skipping (no renames yet)");
    return;
  }

  let raw;
  try {
    raw = await fs.readFile(aliasesPath, "utf8");
  } catch (err) {
    errors.push(`${rel(aliasesPath)}: unreadable (${err.message})`);
    return finalize();
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    errors.push(`${rel(aliasesPath)}: invalid JSON (${err.message})`);
    return finalize();
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    errors.push(`${rel(aliasesPath)}: top-level must be a JSON object`);
    return finalize();
  }

  const renames = doc.renames;
  if (!Array.isArray(renames)) {
    errors.push(`${rel(aliasesPath)}: \`renames\` must be an array`);
    return finalize();
  }

  // `items` is optional for the empty case but required to be an array
  // if present. Treat a missing field as `[]` so older files don't error.
  const items = doc.items === undefined ? [] : doc.items;
  if (!Array.isArray(items)) {
    errors.push(`${rel(aliasesPath)}: \`items\` must be an array`);
    return finalize();
  }

  const seenFrom = new Map();
  const slugIndex = await buildSlugIndex();
  let renamesSeqCursor = 0;

  for (const [i, entry] of renames.entries()) {
    const ctx = `${rel(aliasesPath)}#/renames/${i}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${ctx}: each entry must be an object`);
      continue;
    }
    const okSeq = expectPositiveInt(entry.seq, `${ctx}/seq`);
    const okFrom = expectSlug(entry.from, `${ctx}/from`);
    const okTo = expectSlug(entry.to, `${ctx}/to`);
    expectDate(entry.at, `${ctx}/at`);

    if (okSeq) {
      const expected = renamesSeqCursor + 1;
      if (entry.seq !== expected) {
        errors.push(
          `${ctx}/seq: expected ${expected} (strictly increasing from 1, no gaps) ` +
          `but got ${entry.seq}`,
        );
      }
      renamesSeqCursor = entry.seq;
    }

    if (okFrom && okTo && entry.from === entry.to) {
      errors.push(`${ctx}: \`from\` and \`to\` must differ`);
    }

    if (okFrom) {
      if (seenFrom.has(entry.from)) {
        errors.push(
          `${ctx}/from: "${entry.from}" already renamed at index ${seenFrom.get(entry.from)} ` +
          `— a slug can only be renamed once. Chain follow-up renames through the new slug.`,
        );
      } else {
        seenFrom.set(entry.from, i);
      }
    }

    if (okTo && !slugIndex.has(entry.to)) {
      warnings.push(
        `${ctx}/to: "${entry.to}" doesn't match any place_slug under registry/. ` +
        `Either add the place.json or remove the alias.`,
      );
    }
  }

  // Items: lift / slope / webcam id renames within a single place.
  // Independent seq cursor. Dedupe key is (place_slug, kind, from) so
  // chaining `id-a → id-b → id-c` is allowed (two entries with
  // different `from`s), but renaming `id-a` twice is not.
  const seenItem = new Map();
  let itemsSeqCursor = 0;

  for (const [i, entry] of items.entries()) {
    const ctx = `${rel(aliasesPath)}#/items/${i}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${ctx}: each entry must be an object`);
      continue;
    }
    const okSeq = expectPositiveInt(entry.seq, `${ctx}/seq`);
    const okKind = expectKind(entry.kind, `${ctx}/kind`);
    const okPlace = expectSlug(entry.place_slug, `${ctx}/place_slug`);
    const okFrom = expectNonEmptyString(entry.from, `${ctx}/from`);
    const okTo = expectNonEmptyString(entry.to, `${ctx}/to`);
    expectDate(entry.at, `${ctx}/at`);

    if (okSeq) {
      const expected = itemsSeqCursor + 1;
      if (entry.seq !== expected) {
        errors.push(
          `${ctx}/seq: expected ${expected} (strictly increasing from 1, no gaps) ` +
          `but got ${entry.seq}`,
        );
      }
      itemsSeqCursor = entry.seq;
    }

    if (okFrom && okTo && entry.from === entry.to) {
      errors.push(`${ctx}: \`from\` and \`to\` must differ`);
    }

    if (okKind && okPlace && okFrom) {
      const key = `${entry.kind}:${entry.place_slug}/${entry.from}`;
      if (seenItem.has(key)) {
        errors.push(
          `${ctx}: ${key} already renamed at index ${seenItem.get(key)} ` +
          `— an item id can only be renamed once. Chain follow-up renames through the new id.`,
        );
      } else {
        seenItem.set(key, i);
      }
    }

    if (okPlace && !slugIndex.has(entry.place_slug)) {
      warnings.push(
        `${ctx}/place_slug: "${entry.place_slug}" doesn't match any place under registry/. ` +
        `If the place was also renamed, add the \`renames\` entry first and use the new slug here.`,
      );
    }
  }

  finalize(renames.length + items.length);
}

function finalize(count) {
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`warn: ${w}`);
  }
  if (errors.length === 0) {
    console.log(`aliases.json ok (${count ?? 0} entries valid across renames+items)`);
    process.exit(0);
  }
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`unhandled: ${err?.stack || err}`);
  process.exit(2);
});
