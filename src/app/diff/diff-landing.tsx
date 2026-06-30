"use client";

/**
 * Landing / idle state for the diff viewer.
 *
 * Two ways to start a comparison:
 *   1. PR number — resolves to base/head via GitHub API on load.
 *   2. Commit picker — fetches the last 20 commits and lets the user
 *      select base + head from the list (head defaults to latest).
 *
 * On submit either pushes ?pr=N or ?base=<sha>&head=<sha> to the router.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const API = "https://api.github.com/repos/powder-nomad/open-ski-data";

type Commit = {
  sha: string;
  message: string; // first line only
  date: string;    // ISO string from GitHub
};

function sha7(sha: string) {
  return sha.slice(0, 7);
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export function DiffLanding() {
  const router = useRouter();

  // PR input
  const [prInput, setPrInput] = useState("");

  // Commit picker
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [head, setHead] = useState("");
  const [base, setBase] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/commits?per_page=20`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { sha: string; commit: { message: string; author: { date: string } } }[]) => {
        if (cancelled) return;
        const list: Commit[] = data.map((c) => ({
          sha: c.sha,
          message: c.commit.message.split("\n")[0].slice(0, 72),
          date: c.commit.author.date,
        }));
        setCommits(list);
        if (list.length > 0) setHead(list[0].sha);
        if (list.length > 1) setBase(list[1].sha);
      })
      .catch((err) => {
        if (!cancelled) setCommitsError(err.message ?? String(err));
      });
    return () => { cancelled = true; };
  }, []);

  const handlePr = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const n = prInput.trim().replace(/^#/, "");
      if (!n) return;
      router.push(`/diff?pr=${encodeURIComponent(n)}`);
    },
    [prInput, router],
  );

  const handleCommits = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!base || !head || base === head) return;
      router.push(`/diff?base=${base}&head=${head}`);
    },
    [base, head, router],
  );

  return (
    <div className="space-y-5">
      {/* PR input */}
      <div>
        <p className="text-[10px] font-semibold text-[var(--fg-muted)] mb-2">By pull request</p>
        <form onSubmit={handlePr} className="flex gap-2">
          <input
            type="text"
            value={prInput}
            onChange={(e) => setPrInput(e.target.value)}
            placeholder="PR number, e.g. 2"
            className="flex-1 min-w-0 rounded border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--fg)] placeholder:text-[var(--fg-dim)] focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={!prInput.trim()}
            className="rounded border border-[var(--border)] bg-[var(--bg-elev-strong)] px-3 py-1.5 text-xs text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            View
          </button>
        </form>
      </div>

      <div className="border-t border-[var(--border)]" />

      {/* Commit picker */}
      <div>
        <p className="text-[10px] font-semibold text-[var(--fg-muted)] mb-2">By commit range</p>

        {commitsError ? (
          <p className="text-xs text-[#f87171]">Could not load commits: {commitsError}</p>
        ) : commits === null ? (
          <p className="text-xs text-[var(--fg-dim)]">Loading commits…</p>
        ) : (
          <form onSubmit={handleCommits} className="space-y-2">
            <CommitSelect
              label="Base (older)"
              value={base}
              commits={commits}
              exclude={head}
              onChange={setBase}
            />
            <CommitSelect
              label="Head (newer)"
              value={head}
              commits={commits}
              exclude={base}
              onChange={setHead}
            />
            <button
              type="submit"
              disabled={!base || !head || base === head}
              className="w-full rounded border border-[var(--border)] bg-[var(--bg-elev-strong)] px-3 py-1.5 text-xs text-[var(--fg)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Compare commits
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function CommitSelect({
  label,
  value,
  commits,
  exclude,
  onChange,
}: {
  label: string;
  value: string;
  commits: Commit[];
  exclude: string;
  onChange: (sha: string) => void;
}) {
  return (
    <div>
      <p className="text-[10px] text-[var(--fg-dim)] mb-1">{label}</p>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-xs text-[var(--fg)] focus:outline-none focus:border-[var(--accent)]"
      >
        {commits.map((c) => (
          <option key={c.sha} value={c.sha} disabled={c.sha === exclude}>
            {sha7(c.sha)}  {fmtDate(c.date)}  {c.message}
          </option>
        ))}
      </select>
    </div>
  );
}
