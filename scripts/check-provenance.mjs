// check-provenance.mjs — report provenance coverage across the registry.
//
// Walks every place.json / lifts.json / slopes.json / webcams.json and
// counts how many records carry a `provenance` field (see NOTICE +
// CONTRIBUTING.md for the field shape and per-source guidance).
//
// Current mode: WARN ONLY. The script always exits 0 — coverage today
// is near-zero because the field is new, and we don't want to break
// existing CI while contributors backfill. The output makes the
// coverage gap visible so future PRs can budget the backfill work.
//
// Future mode: pass `--strict` to fail when coverage is below the
// threshold (default 80%), or fail when any newly-added record lacks
// provenance. The web editor will populate the field automatically
// once it ships, so coverage will climb as new edits land.
//
// Why this script exists at all (vs deferring until the field is
// universal): captures the *current* coverage so we can spot
// regressions where a PR strips provenance from a record that had it.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const registryRoot = path.join(repoRoot, "registry");

const STRICT = process.argv.includes("--strict");
const THRESHOLD_PCT = 80;

const VALID_SOURCES = new Set(["osm", "operator", "user-edit", "import"]);

const stats = {
  byFile: new Map(),    // fileType -> { total, withProvenance }
  bySource: new Map(),  // source -> count (only counts records that have provenance)
  errors: [],           // structural problems (invalid source, malformed object)
};

function bumpFile(fileType, total, withProvenance) {
  const cur = stats.byFile.get(fileType) || { total: 0, withProvenance: 0 };
  cur.total += total;
  cur.withProvenance += withProvenance;
  stats.byFile.set(fileType, cur);
}

function bumpSource(source) {
  stats.bySource.set(source, (stats.bySource.get(source) || 0) + 1);
}

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

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    stats.errors.push(`${rel(filePath)}: ${err.message}`);
    return null;
  }
}

function validateProvenance(prov, ctx) {
  if (prov === undefined || prov === null) return false;
  if (typeof prov !== "object" || Array.isArray(prov)) {
    stats.errors.push(`${ctx}: provenance must be an object`);
    return false;
  }
  if (!VALID_SOURCES.has(prov.source)) {
    stats.errors.push(
      `${ctx}: provenance.source "${prov.source}" not in ${[...VALID_SOURCES].join(", ")}`,
    );
    return false;
  }
  bumpSource(prov.source);
  return true;
}

// Walks registry/ and yields every place.json + its sibling array
// files (lifts/slopes/webcams). Mirrors the layout doc in README.md.
async function* walkResorts() {
  const countries = await fs.readdir(registryRoot, { withFileTypes: true });
  for (const country of countries) {
    if (!country.isDirectory() || ["live", "ski-domains"].includes(country.name)) continue;
    const countryPath = path.join(registryRoot, country.name);
    const regions = await fs.readdir(countryPath, { withFileTypes: true });
    for (const region of regions) {
      if (!region.isDirectory()) continue;
      const regionPath = path.join(countryPath, region.name);
      const places = await fs.readdir(regionPath, { withFileTypes: true });
      for (const placeDir of places) {
        if (!placeDir.isDirectory()) continue;
        const placePath = path.join(regionPath, placeDir.name);
        const placeJson = path.join(placePath, "place.json");
        if (await exists(placeJson)) yield { placePath, slug: placeDir.name };
      }
    }
  }
}

async function checkPlace(placePath, slug) {
  const placeJson = path.join(placePath, "place.json");
  const data = await readJson(placeJson);
  if (!data) return;
  const has = validateProvenance(data.provenance, `${rel(placeJson)}#/`);
  bumpFile("place.json", 1, has ? 1 : 0);
}

async function checkArrayFile(placePath, filename, arrayKey) {
  const filePath = path.join(placePath, filename);
  if (!(await exists(filePath))) return;
  const data = await readJson(filePath);
  if (!data || !Array.isArray(data[arrayKey])) return;
  let withProv = 0;
  for (const [i, item] of data[arrayKey].entries()) {
    if (item && typeof item === "object" && "provenance" in item) {
      if (validateProvenance(item.provenance, `${rel(filePath)}#/${arrayKey}/${i}`)) {
        withProv++;
      }
    }
  }
  bumpFile(filename, data[arrayKey].length, withProv);
}

async function main() {
  for await (const { placePath, slug } of walkResorts()) {
    await checkPlace(placePath, slug);
    await checkArrayFile(placePath, "lifts.json", "lifts");
    await checkArrayFile(placePath, "slopes.json", "slopes");
    await checkArrayFile(placePath, "webcams.json", "webcams");
  }
  finalize();
}

function finalize() {
  console.log("provenance coverage (warn-mode):");
  let grandTotal = 0;
  let grandWith = 0;
  for (const [fileType, { total, withProvenance }] of [...stats.byFile.entries()].sort()) {
    const pct = total === 0 ? 0 : Math.round((withProvenance / total) * 1000) / 10;
    console.log(`  ${fileType.padEnd(14)}  ${String(withProvenance).padStart(5)} / ${String(total).padStart(5)} records  (${pct}%)`);
    grandTotal += total;
    grandWith += withProvenance;
  }
  const grandPct = grandTotal === 0 ? 0 : Math.round((grandWith / grandTotal) * 1000) / 10;
  console.log(`  ${"TOTAL".padEnd(14)}  ${String(grandWith).padStart(5)} / ${String(grandTotal).padStart(5)} records  (${grandPct}%)`);

  if (stats.bySource.size > 0) {
    console.log("by source:");
    for (const [source, count] of [...stats.bySource.entries()].sort()) {
      console.log(`  ${source.padEnd(14)}  ${count}`);
    }
  }

  if (stats.errors.length > 0) {
    console.error(`\n${stats.errors.length} structural error(s) — these always fail the run:`);
    for (const e of stats.errors) console.error(`  error: ${e}`);
    process.exit(1);
  }

  if (STRICT) {
    if (grandPct < THRESHOLD_PCT) {
      console.error(`\n--strict: coverage ${grandPct}% < threshold ${THRESHOLD_PCT}% — failing.`);
      process.exit(1);
    }
    console.log(`\n--strict: coverage ${grandPct}% >= threshold ${THRESHOLD_PCT}% — ok.`);
  } else {
    console.log(`\nwarn-mode: never fails on missing provenance. Use --strict to enforce ${THRESHOLD_PCT}% coverage.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`unhandled: ${err?.stack || err}`);
  process.exit(2);
});
