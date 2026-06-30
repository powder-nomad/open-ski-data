"use client";

/**
 * Hook: query string → fully-resolved diff payload.
 *
 * Accepts ?pr=N (resolves to base/head SHAs via GitHub API) or
 * ?base=<sha>&head=<sha> (zero API calls). Parallel-fetches both
 * sides from raw.githubusercontent.com for every registry file that
 * changed, computes the diff client-side, groups by resort slug.
 *
 * This is intentionally unauthenticated for public reads — the repo
 * is public so raw URLs need no token and have no rate-limit headache
 * at typical PR sizes (60 req/hr unauth per IP, well above the
 * ~10 files per resort PR).
 */

import { useEffect, useState } from "react";
import { diffGraph, type GraphDiff } from "@/lib/diff-graph";
import { diffSidecar, type SidecarDiff } from "@/lib/diff-sidecar";
import type {
  SlopeGraphRecord,
  SlopeRecord,
  LiftRecord,
  WebcamRecord,
  PlaceRecord,
} from "@/lib/resort-loader";

const RAW = "https://raw.githubusercontent.com/powder-nomad/open-ski-data";
const API = "https://api.github.com/repos/powder-nomad/open-ski-data";

export type DiffStatus =
  | "idle"
  | "resolving"
  | "fetching"
  | "diffing"
  | "done"
  | "error";

export type ResortDiff = {
  slug: string;
  /** "kr/gangwon/alpensia" */
  path: string;
  graphDiff: GraphDiff;
  sidecarDiff: SidecarDiff;
};

export type PrDiffResult = {
  status: DiffStatus;
  error?: string;
  prNumber?: number;
  prTitle?: string;
  prUrl?: string;
  base?: string;
  head?: string;
  resorts: ResortDiff[];
  /** Which resort is currently shown on the map (slug). */
  selectedResort: string | null;
  setSelectedResort: (slug: string) => void;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function fetchRaw<T>(sha: string, path: string): Promise<T | null> {
  return fetchJson<T>(`${RAW}/${sha}/${path}`);
}

/** Parse "registry/kr/gangwon/alpensia/slope-graph.json" → { slug, registryPath } */
function parseRegistryPath(filePath: string) {
  const m = filePath.match(
    /^registry\/([^/]+)\/([^/]+)\/([^/]+)\/(slope-graph|slopes|lifts|webcams|place)\.json$/,
  );
  if (!m) return null;
  return {
    slug: m[3],
    countryCode: m[1],
    regionSlug: m[2],
    registryPath: `registry/${m[1]}/${m[2]}/${m[3]}`,
    fileType: m[4] as "slope-graph" | "slopes" | "lifts" | "webcams" | "place",
  };
}

export function usePrDiff(searchParams: URLSearchParams): PrDiffResult {
  const [status, setStatus] = useState<DiffStatus>("idle");
  const [error, setError] = useState<string | undefined>();
  const [prNumber, setPrNumber] = useState<number | undefined>();
  const [prTitle, setPrTitle] = useState<string | undefined>();
  const [prUrl, setPrUrl] = useState<string | undefined>();
  const [base, setBase] = useState<string | undefined>();
  const [head, setHead] = useState<string | undefined>();
  const [resorts, setResorts] = useState<ResortDiff[]>([]);
  const [selectedResort, setSelectedResort] = useState<string | null>(null);

  useEffect(() => {
    const pr = searchParams.get("pr");
    const baseParam = searchParams.get("base");
    const headParam = searchParams.get("head");

    if (!pr && !baseParam && !headParam) {
      setStatus("idle");
      return;
    }

    let cancelled = false;

    async function run() {
      try {
        setStatus("resolving");
        setError(undefined);
        setResorts([]);

        let resolvedBase: string;
        let resolvedHead: string;
        let resolvedPrNumber: number | undefined;
        let resolvedPrTitle: string | undefined;
        let resolvedPrUrl: string | undefined;

        if (pr) {
          const prData = await fetchJson<{
            number: number;
            title: string;
            html_url: string;
            base: { sha: string };
            head: { sha: string };
          }>(`${API}/pulls/${pr}`);
          if (!prData) throw new Error(`PR #${pr} not found`);
          resolvedBase = prData.base.sha;
          resolvedHead = prData.head.sha;
          resolvedPrNumber = prData.number;
          resolvedPrTitle = prData.title;
          resolvedPrUrl = prData.html_url;
        } else {
          resolvedBase = baseParam!;
          resolvedHead = headParam!;
        }

        if (cancelled) return;
        setBase(resolvedBase);
        setHead(resolvedHead);
        if (resolvedPrNumber !== undefined) setPrNumber(resolvedPrNumber);
        if (resolvedPrTitle !== undefined) setPrTitle(resolvedPrTitle);
        if (resolvedPrUrl !== undefined) setPrUrl(resolvedPrUrl);

        setStatus("fetching");

        // Get the list of changed files
        const compareData = await fetchJson<{ files: { filename: string }[] }>(
          `${API}/compare/${resolvedBase}...${resolvedHead}`,
        );
        if (!compareData) throw new Error("Could not fetch compare data");

        if (cancelled) return;

        // Group changed files by resort slug
        const resortMap = new Map<
          string,
          {
            slug: string;
            registryPath: string;
            files: Set<"slope-graph" | "slopes" | "lifts" | "webcams" | "place">;
          }
        >();

        for (const { filename } of compareData.files) {
          const parsed = parseRegistryPath(filename);
          if (!parsed) continue;
          const key = parsed.slug;
          if (!resortMap.has(key)) {
            resortMap.set(key, {
              slug: parsed.slug,
              registryPath: parsed.registryPath,
              files: new Set(),
            });
          }
          resortMap.get(key)!.files.add(parsed.fileType);
        }

        if (resortMap.size === 0) {
          setResorts([]);
          setStatus("done");
          return;
        }

        setStatus("diffing");

        // Fetch both sides in parallel for each resort
        const resortDiffs: ResortDiff[] = [];

        for (const { slug, registryPath, files } of resortMap.values()) {
          if (cancelled) return;

          const toFetch = (fileType: "slope-graph" | "slopes" | "lifts" | "webcams" | "place") => {
            const ext = fileType === "slope-graph" ? "slope-graph.json" : `${fileType}.json`;
            return `${registryPath}/${ext}`;
          };

          // Fetch all changed files for this resort from both sides in parallel
          const [
            baseGraph, headGraph,
            baseSlopes, headSlopes,
            baseLifts, headLifts,
            baseWebcams, headWebcams,
            basePlace, headPlace,
          ] = await Promise.all([
            files.has("slope-graph")
              ? fetchRaw<SlopeGraphRecord>(resolvedBase, toFetch("slope-graph"))
              : fetchRaw<SlopeGraphRecord>(resolvedBase, toFetch("slope-graph")),
            files.has("slope-graph")
              ? fetchRaw<SlopeGraphRecord>(resolvedHead, toFetch("slope-graph"))
              : fetchRaw<SlopeGraphRecord>(resolvedHead, toFetch("slope-graph")),
            fetchRaw<{ slopes: SlopeRecord[] }>(resolvedBase, toFetch("slopes")),
            fetchRaw<{ slopes: SlopeRecord[] }>(resolvedHead, toFetch("slopes")),
            fetchRaw<{ lifts: LiftRecord[] }>(resolvedBase, toFetch("lifts")),
            fetchRaw<{ lifts: LiftRecord[] }>(resolvedHead, toFetch("lifts")),
            fetchRaw<{ webcams: WebcamRecord[] }>(resolvedBase, toFetch("webcams")),
            fetchRaw<{ webcams: WebcamRecord[] }>(resolvedHead, toFetch("webcams")),
            fetchRaw<PlaceRecord>(resolvedBase, toFetch("place")),
            fetchRaw<PlaceRecord>(resolvedHead, toFetch("place")),
          ]);

          if (cancelled) return;

          const graphDiff = diffGraph(baseGraph, headGraph);
          const sidecarDiff = diffSidecar(
            {
              slopes: baseSlopes?.slopes ?? [],
              lifts: baseLifts?.lifts ?? [],
              webcams: baseWebcams?.webcams ?? [],
              place: basePlace,
            },
            {
              slopes: headSlopes?.slopes ?? [],
              lifts: headLifts?.lifts ?? [],
              webcams: headWebcams?.webcams ?? [],
              place: headPlace,
            },
          );

          resortDiffs.push({ slug, path: registryPath, graphDiff, sidecarDiff });
        }

        if (cancelled) return;

        setResorts(resortDiffs);
        if (resortDiffs.length > 0) setSelectedResort(resortDiffs[0].slug);
        setStatus("done");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  return {
    status,
    error,
    prNumber,
    prTitle,
    prUrl,
    base,
    head,
    resorts,
    selectedResort,
    setSelectedResort,
  };
}
