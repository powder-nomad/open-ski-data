#!/usr/bin/env node
/**
 * Slope-graph printer — shows a resort's `<slug>.slope-graph.json` as
 * a readable per-slope tree so authors can eyeball connectivity.
 *
 * Usage:
 *   node scripts/view-slope-graph.mjs yongpyong
 *   node scripts/view-slope-graph.mjs --no-color yongpyong   # for logs
 *   node scripts/view-slope-graph.mjs --json yongpyong       # dumps derived tree
 *
 * The graph file is stored flat (node list + edge list) because the
 * trail-snap algorithm needs a graph. This script derives the
 * "list of consecutive segments, list-of-lists at forks" view that
 * a skier-brain finds obvious — same information, different shape.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const argv = process.argv.slice(2);
const noColor = argv.includes("--no-color") || !process.stdout.isTTY;
const asJson = argv.includes("--json");
const slug = argv.filter((a) => !a.startsWith("--"))[0];

if (!slug) {
  console.error("usage: node scripts/view-slope-graph.mjs [--no-color] [--json] <slug>");
  process.exit(2);
}

// ── helpers ─────────────────────────────────────────────────────────

// ANSI colours for difficulty levels — matches the frontend palette so
// the CLI view lines up with what a skier sees on the map.
const COLOURS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  grey: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

function c(code, s) {
  return noColor ? s : `${COLOURS[code]}${s}${COLOURS.reset}`;
}

// Difficulty → colour. Beginner green, expert red, park orange, etc.
// "advanced" shows as white bold so black-diamonds still stand out
// against the terminal background.
function difficultyColour(diff) {
  switch (diff) {
    case "beginner":
    case "be_in":
      return "green";
    case "intermediate":
    case "in_ad":
      return "blue";
    case "advanced":
      return "bold";
    case "expert":
    case "pro":
      return "red";
    case "park":
      return "yellow";
    default:
      return "grey";
  }
}

function fmtDiff(diff) {
  if (!diff) return c("grey", "—");
  return c(difficultyColour(diff), diff);
}

function fmtLen(m) {
  if (m == null) return "";
  if (m < 1000) return `${Math.round(m)}m`;
  return `${(m / 1000).toFixed(2)}km`;
}

async function tryReadJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// ── load ────────────────────────────────────────────────────────────

function registryRegions(countryCode) {
  // Hardcoded walk of known regions would be fragile. Instead, scan
  // every subdir of registry/<country>/ for the slope-graph file.
  return fs.readdir(path.join(repoRoot, "registry", countryCode), { withFileTypes: true });
}

async function findSlopeGraphFile(slug) {
  const registry = path.join(repoRoot, "registry");
  const countries = await fs.readdir(registry, { withFileTypes: true });
  for (const cDir of countries) {
    if (!cDir.isDirectory() || cDir.name === "live" || cDir.name === "ski-domains") continue;
    const regions = await registryRegions(cDir.name);
    for (const rDir of regions) {
      if (!rDir.isDirectory()) continue;
      const candidate = path.join(registry, cDir.name, rDir.name, `${slug}.slope-graph.json`);
      try {
        await fs.access(candidate);
        return {
          path: candidate,
          country: cDir.name,
          region: rDir.name,
        };
      } catch {}
    }
  }
  return null;
}

// ── derive tree ─────────────────────────────────────────────────────

/**
 * Build a per-slope chain. For a slope with no forks it's a single
 * linear list: [{edge}, {edge}, {edge}]. When a slope branches, the
 * branch set appears as one entry with `branches: [[edge], [edge]]`.
 *
 * Algorithm: Start from the top of each slope (a node with no incoming
 * slope edges of that slope_id). Walk outgoing edges of the same
 * slope_id; when multiple exist from one node they're branches that
 * eventually reconverge at a shared downstream node.
 */
function buildSlopeChains(graph) {
  const edgesBySlope = new Map();
  for (const e of graph.edges) {
    if (e.kind !== "slope" || !e.slope_id) continue;
    if (!edgesBySlope.has(e.slope_id)) edgesBySlope.set(e.slope_id, []);
    edgesBySlope.get(e.slope_id).push(e);
  }

  const chains = new Map();
  for (const [slopeId, edges] of edgesBySlope.entries()) {
    chains.set(slopeId, chainFromEdges(edges));
  }
  return chains;
}

function chainFromEdges(edges) {
  // Adjacency within this slope only — keeps the walker from wandering
  // into other slopes that happen to share junctions.
  const outByNode = new Map();
  const inByNode = new Map();
  for (const e of edges) {
    if (!outByNode.has(e.from)) outByNode.set(e.from, []);
    outByNode.get(e.from).push(e);
    if (!inByNode.has(e.to)) inByNode.set(e.to, []);
    inByNode.get(e.to).push(e);
  }

  // A "top" node has no incoming edges of this slope.
  const tops = [];
  for (const node of outByNode.keys()) {
    if (!inByNode.has(node)) tops.push(node);
  }
  if (tops.length === 0) return []; // shouldn't happen, but degrade gracefully

  const chain = [];
  const visited = new Set();
  let current = tops[0];

  // Linear walk. When we hit a fork, collect the branches and recurse
  // into each until they re-converge at a shared merge node.
  while (current) {
    const outs = outByNode.get(current) || [];
    if (outs.length === 0) break;
    if (outs.length === 1) {
      const e = outs[0];
      if (visited.has(e.id)) break;
      visited.add(e.id);
      chain.push({ kind: "edge", edge: e });
      current = e.to;
      continue;
    }
    // Fork — find the merge node where all branches converge.
    const branches = outs.map((start) => {
      const seg = [];
      let node = start.from;
      let edge = start;
      while (edge) {
        if (visited.has(edge.id)) break;
        visited.add(edge.id);
        seg.push({ kind: "edge", edge });
        node = edge.to;
        // Stop when we reach a node that has multiple incoming edges
        // (the merge point).
        const incomings = inByNode.get(node) || [];
        if (incomings.length >= 2) return { seg, endNode: node };
        const nexts = outByNode.get(node) || [];
        if (nexts.length !== 1) return { seg, endNode: node };
        edge = nexts[0];
      }
      return { seg, endNode: node };
    });
    chain.push({ kind: "branch", branches });
    current = branches[0].endNode;
  }
  return chain;
}

// ── render ──────────────────────────────────────────────────────────

function renderNode(node) {
  const alt = `${Math.round(node.alt_m)}m`;
  const kind = node.kind ? ` — ${c("grey", node.kind)}` : "";
  return `${c("cyan", node.id)} (${alt})${kind}`;
}

function renderEdge(edge, indent) {
  const name = edge.id;
  const diff = fmtDiff(edge.difficulty);
  const len = fmtLen(edge.length_m);
  const slope = edge.slope_id ? c("magenta", edge.slope_id) : c("grey", "—");
  const parts = [diff, len, slope].filter(Boolean).join(" · ");
  return `${indent}${c("grey", "▼")} ${c("bold", name)} · ${parts}`;
}

function renderChain(chain, nodesById) {
  // Walk the chain and emit nodes + edges in order. At a branch, emit
  // the fork node, then each branch with a "├" indent, then the merge
  // node once.
  const lines = [];
  if (chain.length === 0) return lines;
  const firstEdge = firstEdgeOf(chain);
  if (firstEdge) lines.push(`  ${renderNode(nodesById.get(firstEdge.from))}`);
  for (const step of chain) {
    if (step.kind === "edge") {
      lines.push(renderEdge(step.edge, "    "));
      lines.push(`  ${renderNode(nodesById.get(step.edge.to))}`);
    } else {
      // Branches — print each variant with a bullet indent. End node
      // shared across all branches is printed once after the group.
      for (const [i, b] of step.branches.entries()) {
        const label = i === step.branches.length - 1 ? "└─" : "├─";
        lines.push(`    ${c("grey", label)} branch ${i + 1}`);
        for (const sub of b.seg) {
          lines.push(renderEdge(sub.edge, "       "));
        }
      }
      const merge = step.branches[0].endNode;
      lines.push(`  ${renderNode(nodesById.get(merge))} ${c("grey", "← branches converge")}`);
    }
  }
  return lines;
}

function firstEdgeOf(chain) {
  for (const s of chain) {
    if (s.kind === "edge") return s.edge;
    if (s.kind === "branch") return s.branches[0].seg[0].edge;
  }
  return null;
}

function renderLifts(graph) {
  const lifts = graph.edges.filter((e) => e.kind === "lift");
  const lines = [];
  if (lifts.length === 0) return lines;
  lines.push(c("bold", "lifts:"));
  for (const l of lifts) {
    const from = graph.nodesById.get(l.from);
    const to = graph.nodesById.get(l.to);
    const segs = countStations(l, graph);
    const stations = segs > 2 ? c("grey", ` · ${segs - 1} segments`) : "";
    lines.push(`  ${c("yellow", l.id)} · ${renderNode(from)} → ${renderNode(to)} · ${fmtLen(l.length_m)}${stations}`);
  }
  return lines;
}

function countStations(edge, graph) {
  // If this edge is part of a chained lift (bottom → station → top),
  // reflect that with a segment count. Otherwise just "2" (2 endpoints).
  return 2; // placeholder — would walk the lift chain if needed; reserved for future enhancement
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const found = await findSlopeGraphFile(slug);
  if (!found) {
    console.error(`No slope-graph file for '${slug}'. Looked under registry/*/*/`);
    process.exit(1);
  }
  const raw = JSON.parse(await fs.readFile(found.path, "utf8"));
  raw.nodesById = new Map(raw.nodes.map((n) => [n.id, n]));

  // Read the catalog file for localized names (for the header only —
  // authoring time doesn't need i18n on every edge).
  const catalog = await tryReadJson(
    path.join(repoRoot, "registry", found.country, found.region, `${slug}.json`)
  );

  if (asJson) {
    const chains = buildSlopeChains(raw);
    const out = {
      slug,
      country: found.country,
      region: found.region,
      slopes: Object.fromEntries(
        [...chains.entries()].map(([k, v]) => [k, v])
      ),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const displayName = catalog?.name_i18n?.ko
    ? `${catalog.name} (${catalog.name_i18n.ko})`
    : catalog?.name ?? slug;
  console.log(`${c("bold", slug)}  ${c("grey", `${found.country}/${found.region}`)}  ${c("cyan", displayName)}`);
  console.log(c("grey", `  ${raw.nodes.length} nodes · ${raw.edges.length} edges`));
  console.log();

  const chains = buildSlopeChains(raw);
  // Sort slopes by their top node altitude descending so the highest
  // lines print first — matches how a skier reads a trail map.
  const sorted = [...chains.entries()].sort((a, b) => {
    const topA = firstEdgeOf(a[1]);
    const topB = firstEdgeOf(b[1]);
    const altA = topA ? raw.nodesById.get(topA.from).alt_m : 0;
    const altB = topB ? raw.nodesById.get(topB.from).alt_m : 0;
    return altB - altA;
  });

  for (const [slopeId, chain] of sorted) {
    console.log(`${c("magenta", slopeId)}`);
    for (const line of renderChain(chain, raw.nodesById)) {
      console.log(line);
    }
    console.log();
  }

  for (const line of renderLifts(raw)) {
    console.log(line);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
