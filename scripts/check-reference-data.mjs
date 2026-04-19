import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve("/home/ubuntu/workspaces/ski-reference-data");
const dataRoot = repoRoot;
const registryRoot = path.join(dataRoot, "registry");

const errors = [];

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${rel(filePath)}: invalid JSON (${error.message})`);
    return null;
  }
}

function rel(filePath) {
  return path.relative(repoRoot, filePath);
}

function expect(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function expectString(value, message) {
  expect(typeof value === "string" && value.length > 0, message);
}

function expectArray(value, message) {
  expect(Array.isArray(value), message);
}

function expectedPlacePath(place) {
  return path.join(
    registryRoot,
    place.country_code,
    place.region_slug,
    `${place.place_slug}.json`,
  );
}

async function collectPlaceFiles() {
  const countryDirs = await fs.readdir(registryRoot, { withFileTypes: true });
  const results = [];
  for (const countryDir of countryDirs) {
    if (!countryDir.isDirectory()) {
      continue;
    }
    if (["live", "ski-domains", "slopes", "webcams"].includes(countryDir.name)) {
      continue;
    }
    const countryPath = path.join(registryRoot, countryDir.name);
    const regionDirs = await fs.readdir(countryPath, { withFileTypes: true });
    for (const regionDir of regionDirs) {
      if (!regionDir.isDirectory()) {
        continue;
      }
      const regionPath = path.join(countryPath, regionDir.name);
      const files = await fs.readdir(regionPath, { withFileTypes: true });
      for (const file of files) {
        if (
          file.isFile() &&
          file.name.endsWith(".json") &&
          file.name !== "index.json" &&
          !file.name.endsWith(".slopes.json") &&
          !file.name.endsWith(".webcams.json") &&
          !file.name.endsWith(".lifts.json")
        ) {
          results.push(path.join(regionPath, file.name));
        }
      }
    }
  }
  return results.sort();
}

async function validatePlaceFile(filePath, seenSlugs) {
  const place = await readJson(filePath);
  if (!place) return null;

  expectString(place.country_code, `${rel(filePath)}: missing country_code`);
  expectString(place.region_slug, `${rel(filePath)}: missing region_slug`);
  expectString(place.place_slug, `${rel(filePath)}: missing place_slug`);
  expectString(place.name, `${rel(filePath)}: missing name`);
  expect(isObject(place.coordinates), `${rel(filePath)}: missing coordinates object`);
  expect(
    typeof place.coordinates?.latitude === "number" &&
      typeof place.coordinates?.longitude === "number",
    `${rel(filePath)}: coordinates must include numeric latitude and longitude`,
  );

  if (place.place_slug) {
    expect(
      !seenSlugs.has(place.place_slug),
      `${rel(filePath)}: duplicate place_slug '${place.place_slug}'`,
    );
    seenSlugs.add(place.place_slug);
  }

  const expectedPath = expectedPlacePath(place);
  expect(
    path.resolve(filePath) === path.resolve(expectedPath),
    `${rel(filePath)}: file path does not match country_code/region_slug/place_slug`,
  );

  return place;
}

async function validateGlobalIndex() {
  const filePath = path.join(registryRoot, "index.json");
  const data = await readJson(filePath);
  if (!data) return;

  expect(data.version === 1, `${rel(filePath)}: version must be 1`);
  expectArray(data.countries, `${rel(filePath)}: countries must be an array`);
  for (const country of data.countries ?? []) {
    expectString(country.country_code, `${rel(filePath)}: country missing country_code`);
    expectString(country.name, `${rel(filePath)}: country missing name`);
    expectString(country.path, `${rel(filePath)}: country missing path`);
    const target = path.join(dataRoot, country.path);
    expect(await exists(target), `${rel(filePath)}: missing country index at ${country.path}`);
  }

  if (data.ski_domains_path) {
    const skiDomainsPath = path.join(dataRoot, data.ski_domains_path);
    expect(
      await exists(skiDomainsPath),
      `${rel(filePath)}: missing ski domain index at ${data.ski_domains_path}`,
    );
  }
}

async function collectIndexFiles(depth) {
  const results = [];
  async function walk(dir, currentDepth) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(resolved, currentDepth + 1);
      } else if (entry.isFile() && entry.name === "index.json" && currentDepth === depth) {
        results.push(resolved);
      }
    }
  }
  await walk(registryRoot, 0);
  return results.sort();
}

async function validateCountryIndexes() {
  const files = await collectIndexFiles(1);
  for (const filePath of files) {
    const data = await readJson(filePath);
    if (!data || !data.country || !data.regions) {
      continue;
    }
    expectString(data.country.country_code, `${rel(filePath)}: country.country_code required`);
    expectString(data.country.name, `${rel(filePath)}: country.name required`);
    expectArray(data.regions, `${rel(filePath)}: regions must be an array`);
    for (const region of data.regions) {
      expectString(region.region_slug, `${rel(filePath)}: region_slug required`);
      expectString(region.name, `${rel(filePath)}: region name required`);
      expectString(region.path, `${rel(filePath)}: region path required`);
      const target = path.join(dataRoot, region.path);
      expect(await exists(target), `${rel(filePath)}: missing region index at ${region.path}`);
    }
  }
}

async function validateRegionIndexes(placeMap) {
  const files = await collectIndexFiles(2);
  for (const filePath of files) {
    const data = await readJson(filePath);
    if (!data || !data.country || !data.region || !data.places) {
      continue;
    }
    expectString(data.country.country_code, `${rel(filePath)}: country.country_code required`);
    expectString(data.region.region_slug, `${rel(filePath)}: region.region_slug required`);
    expectArray(data.places, `${rel(filePath)}: places must be an array`);

    for (const placeRef of data.places) {
      expectString(placeRef.place_slug, `${rel(filePath)}: place_slug required`);
      expectString(placeRef.path, `${rel(filePath)}: place path required`);
      const target = path.join(dataRoot, placeRef.path);
      expect(await exists(target), `${rel(filePath)}: missing place file at ${placeRef.path}`);
      const place = placeMap.get(placeRef.place_slug);
      expect(
        !!place,
        `${rel(filePath)}: place '${placeRef.place_slug}' not found in canonical place files`,
      );
      if (place) {
        expect(
          place.country_code === data.country.country_code,
          `${rel(filePath)}: ${placeRef.place_slug} has mismatched country_code`,
        );
        expect(
          place.region_slug === data.region.region_slug,
          `${rel(filePath)}: ${placeRef.place_slug} has mismatched region_slug`,
        );
        expect(
          placeRef.path === `registry/${place.country_code}/${place.region_slug}/${place.place_slug}.json`,
          `${rel(filePath)}: ${placeRef.place_slug} path does not match canonical place location`,
        );
      }
    }

    for (const domainRef of data.ski_domains ?? []) {
      expectString(domainRef.slug, `${rel(filePath)}: ski domain slug required`);
      expectString(domainRef.path, `${rel(filePath)}: ski domain path required`);
      const target = path.join(dataRoot, domainRef.path);
      expect(await exists(target), `${rel(filePath)}: missing ski domain file at ${domainRef.path}`);
    }
  }
}

async function validateSkiDomains(placeMap) {
  const indexPath = path.join(registryRoot, "ski-domains", "index.json");
  const indexData = await readJson(indexPath);
  if (indexData) {
    expectArray(indexData.ski_domains, `${rel(indexPath)}: ski_domains must be an array`);
  }

  const domainsDir = path.join(registryRoot, "ski-domains");
  const entries = await fs.readdir(domainsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "index.json") {
      continue;
    }
    const filePath = path.join(domainsDir, entry.name);
    const data = await readJson(filePath);
    if (!data) continue;
    expectString(data.country_code, `${rel(filePath)}: country_code required`);
    expectString(data.region_slug, `${rel(filePath)}: region_slug required`);
    expectString(data.slug, `${rel(filePath)}: slug required`);
    expectString(data.name, `${rel(filePath)}: name required`);
    expectArray(data.member_place_slugs, `${rel(filePath)}: member_place_slugs must be an array`);
    for (const slug of data.member_place_slugs ?? []) {
      expect(placeMap.has(slug), `${rel(filePath)}: member place '${slug}' does not exist`);
    }
  }
}

async function validateStructuredAssets(placeMap) {
  for (const place of placeMap.values()) {
    const baseDir = path.join(registryRoot, place.country_code, place.region_slug);
    for (const suffix of ["slopes", "webcams", "lifts"]) {
      const filePath = path.join(baseDir, `${place.place_slug}.${suffix}.json`);
      if (!(await exists(filePath))) {
        continue;
      }
      const data = await readJson(filePath);
      if (!data) {
        continue;
      }
      expect(
        data.country_code === place.country_code,
        `${rel(filePath)}: country_code does not match place '${place.place_slug}'`,
      );
      expect(
        data.region_slug === place.region_slug,
        `${rel(filePath)}: region_slug does not match place '${place.place_slug}'`,
      );
      expect(
        data.place_slug === place.place_slug,
        `${rel(filePath)}: place_slug does not match file name`,
      );
    }
  }
}

async function validateLiveData(placeMap) {
  const liveDir = path.join(registryRoot, "live");
  if (!(await exists(liveDir))) {
    return;
  }

  const entries = await fs.readdir(liveDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(liveDir, entry.name);
    const data = await readJson(filePath);
    if (!data) {
      continue;
    }
    if (typeof data.place_slug === "string") {
      expect(
        placeMap.has(data.place_slug),
        `${rel(filePath)}: live record references unknown place '${data.place_slug}'`,
      );
    }
  }
}

async function main() {
  const placeFiles = await collectPlaceFiles();
  const seenSlugs = new Set();
  const placeMap = new Map();

  for (const filePath of placeFiles) {
    const place = await validatePlaceFile(filePath, seenSlugs);
    if (place?.place_slug) {
      placeMap.set(place.place_slug, place);
    }
  }

  await validateGlobalIndex();
  await validateCountryIndexes();
  await validateRegionIndexes(placeMap);
  await validateSkiDomains(placeMap);
  await validateStructuredAssets(placeMap);
  await validateLiveData(placeMap);

  if (errors.length > 0) {
    console.error("Reference-data validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Reference-data validation passed: ${placeMap.size} places, ${placeFiles.length} place files checked.`,
  );
}

await main();
