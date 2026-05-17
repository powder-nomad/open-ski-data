// check-aliases.mjs — validate registry/aliases.json
//
// Rules:
//   - File parses as JSON.
//   - `renames` is an array.
//   - Each entry has `from` (kebab-case slug), `to` (kebab-case slug),
//     `at` (ISO date YYYY-MM-DD).
//   - `from` != `to`.
//   - No duplicate `from` values (a slug can only be renamed once;
//     follow-up renames should chain through the new slug).
//   - Each `to` resolves to a real place_slug under registry/<...>/<to>/.
//     Otherwise the alias points nowhere and consumers will produce
//     orphans. Emits a warning, not an error, in case a `to` was
//     planned but the place file hasn't been added yet.

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

  const seenFrom = new Map();
  const slugIndex = await buildSlugIndex();

  for (const [i, entry] of renames.entries()) {
    const ctx = `${rel(aliasesPath)}#/renames/${i}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${ctx}: each entry must be an object`);
      continue;
    }
    const okFrom = expectSlug(entry.from, `${ctx}/from`);
    const okTo = expectSlug(entry.to, `${ctx}/to`);
    expectDate(entry.at, `${ctx}/at`);

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

  finalize(renames.length);
}

function finalize(count) {
  if (warnings.length > 0) {
    for (const w of warnings) console.warn(`warn: ${w}`);
  }
  if (errors.length === 0) {
    console.log(`aliases.json ok (${count ?? 0} entries valid)`);
    process.exit(0);
  }
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`unhandled: ${err?.stack || err}`);
  process.exit(2);
});
