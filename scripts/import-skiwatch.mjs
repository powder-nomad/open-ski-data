import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "/home/ubuntu/workspaces/ski-platform/node_modules/typescript/lib/typescript.js";

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const skiwatchRoot = path.resolve(
  process.argv[3] ?? "/home/ubuntu/workspaces/_seed_skiwatch",
);
const dataRoot = path.join(skiwatchRoot, "src", "data");
const outputRoot = path.join(repoRoot, "registry");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skiwatch-ts-"));

const difficultyMap = {
  BEGINNER: "beginner",
  BE_IN: "beginner",
  INTERMEDIATE: "intermediate",
  IN_AD: "intermediate",
  ADVANCED: "advanced",
  EXPERT: "expert",
  PARK: "park",
};

const slugAliases = {
  alpensia: "alpensia",
  edenvalley: "eden-valley",
  elysiangangchon: "elysian-gangchon",
  gangchon: "elysian-gangchon",
  high1: "high1",
  jisan: "jisan",
  konjiam: "konjiam",
  muju: "muju",
  oakvalley: "oak-valley",
  o2: "o2",
  phoenix: "phoenix-park",
  phoenixpark: "phoenix-park",
  vivaldi: "vivaldi-park",
  vivaldipark: "vivaldi-park",
  wellihilli: "wellihilli-park",
  wellihillipark: "wellihilli-park",
  yongpyong: "yongpyong",
};

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(resolved);
      }
      return resolved;
    }),
  );
  return files.flat();
}

function rewriteImports(code) {
  return code.replace(
    /from\s+["'](\.\.?\/[^"']+)["']/g,
    (_, specifier) => `from "${specifier}.mjs"`,
  );
}

function cleanSource(sourcePath, code) {
  if (sourcePath.endsWith(path.join("src", "data", "Util.ts"))) {
    return code.replace(/^import .*LocalizedText.*\n/m, "");
  }
  return code;
}

async function transpileDataModules() {
  const files = (await listFiles(dataRoot)).filter((file) => file.endsWith(".ts"));
  await Promise.all(
    files.map(async (file) => {
      const relative = path.relative(dataRoot, file);
      const target = path.join(tempRoot, relative).replace(/\.ts$/, ".mjs");
      const source = cleanSource(file, await fs.readFile(file, "utf8"));
      const result = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ES2022,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: file,
      });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, rewriteImports(result.outputText), "utf8");
    }),
  );
}

function asNullableNumber(value) {
  return typeof value === "number" ? value : null;
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

async function loadSkiwatchModules() {
  await transpileDataModules();
  const [dataModule, utilModule] = await Promise.all([
    import(pathToFileURL(path.join(tempRoot, "data.mjs")).href),
    import(pathToFileURL(path.join(tempRoot, "Util.mjs")).href),
  ]);
  return {
    resorts: dataModule.default,
    Difficulty: utilModule.Difficulty,
    StreamType: utilModule.StreamType,
  };
}

async function loadPlaceMap() {
  const placesDir = path.join(outputRoot, "places");
  const files = (await fs.readdir(placesDir)).filter((file) => file.endsWith(".json"));
  const entries = await Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(placesDir, file);
      const value = JSON.parse(await fs.readFile(fullPath, "utf8"));
      return [value.slug, value];
    }),
  );
  return new Map(entries);
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function localizedName(value) {
  return value ?? {};
}

function slopeTypeFromDifficulty(value) {
  return value === "PARK" ? "terrain_park" : "run";
}

const { resorts, Difficulty, StreamType } = await loadSkiwatchModules();
const placeMap = await loadPlaceMap();

for (const resort of resorts) {
  const normalizedName = normalizeKey(resort.name.en ?? resort.name.ko);
  const slug =
    slugAliases[normalizedName] ??
    [...placeMap.keys()].find((candidate) => normalizeKey(candidate) === normalizedName) ??
    null;

  if (!slug) {
    continue;
  }

  const existingPlace = placeMap.get(slug);
  if (!existingPlace) {
    continue;
  }

  const enrichedPlace = {
    ...existingPlace,
    links: {
      homepage: resort.homepage,
      weather: resort.weather,
    },
    names: localizedName(resort.name),
    stats: {
      run_count: resort.slopes.length,
      lift_count: resort.lifts.length,
      webcam_count: resort.streams.length,
    },
    source: {
      seed: "paulkim-xr/SkiWatch",
    },
  };

  const slopes = {
    $schema: "../../schemas/slope.schema.json",
    resort_slug: slug,
    slopes: [],
  };

  slopes.slopes = resort.slopes.map((slope) => {
    const difficultyKey = Difficulty[slope.difficulty];
    return {
      id: `slope-${slope.id}`,
      name: slope.name.en ?? slope.name.ko ?? `Slope ${slope.id}`,
      localized_name: localizedName(slope.name),
      type: slopeTypeFromDifficulty(difficultyKey),
      difficulty: difficultyMap[difficultyKey] ?? "intermediate",
      length_m: asNullableNumber(slope.length),
      width_m: asNullableNumber(slope.width),
      area_m2: asNullableNumber(slope.area),
      elevation_drop_m: asNullableNumber(slope.elevation),
      min_angle_deg: asNullableNumber(slope.minAngle),
      avg_angle_deg: asNullableNumber(slope.avgAngle),
      max_angle_deg: asNullableNumber(slope.maxAngle),
      connected_slope_ids: (slope.connectedSlopeIds ?? []).map((id) => `slope-${id}`),
      connected_lift_ids: (slope.connectedLiftIds ?? []).map((id) => `lift-${id}`),
    };
  });

  const lifts = {
    $schema: "../../schemas/lift.schema.json",
    resort_slug: slug,
    lifts: resort.lifts.map((lift) => ({
      id: `lift-${lift.id}`,
      name: lift.name.en ?? lift.name.ko ?? `Lift ${lift.id}`,
      localized_name: localizedName(lift.name),
      length_m: asNullableNumber(lift.length),
      elevation_gain_m: asNullableNumber(lift.elevation),
      seats: Number.isInteger(lift.seats) ? lift.seats : null,
      cabin_count: Number.isInteger(lift.cabinNum) ? lift.cabinNum : null,
      speed_mps: asNullableNumber(lift.speed),
      ride_time_s: asNullableNumber(lift.rideTime),
      capacity_pph: Number.isInteger(lift.capacity) ? lift.capacity : null,
      connected_slope_ids: (lift.connectedSlopeIds ?? []).map((id) => `slope-${id}`),
      connected_lift_ids: (lift.connectedLiftIds ?? []).map((id) => `lift-${id}`),
    })),
  };

  const webcams = {
    $schema: "../../schemas/webcam.schema.json",
    resort_slug: slug,
    webcams: resort.streams.map((stream) => ({
      label: stream.name.en ?? stream.name.ko ?? "Webcam",
      localized_label: localizedName(stream.name),
      url: stream.url,
      type: "stream",
      source_type: StreamType[stream.type] ?? String(stream.type),
      refresh_interval_ms: 60000,
      metadata: stream.metadata ?? null,
    })),
  };

  await writeJson(path.join(outputRoot, "places", `${slug}.json`), enrichedPlace);
  await writeJson(path.join(outputRoot, "slopes", `${slug}.json`), slopes);
  await writeJson(path.join(outputRoot, "lifts", `${slug}.json`), lifts);
  await writeJson(path.join(outputRoot, "webcams", `${slug}.json`), webcams);

}

const categoryDirs = ["places", "slopes", "lifts", "webcams", "live"];
const index = [];

for (const [slug, place] of placeMap.entries()) {
  const paths = {};
  for (const category of categoryDirs) {
    const candidate = path.join(outputRoot, category, `${slug}.json`);
    try {
      await fs.access(candidate);
      paths[category === "places" ? "place" : category] = `registry/${category}/${slug}.json`;
    } catch {}
  }
  index.push({
    slug,
    name: place.name,
    country: place.country ?? null,
    paths,
  });
}

index.sort((a, b) => a.slug.localeCompare(b.slug));
await writeJson(path.join(outputRoot, "index.json"), { resorts: index });
await fs.rm(tempRoot, { recursive: true, force: true });
