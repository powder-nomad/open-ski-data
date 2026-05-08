/**
 * GitHub client — fork-and-PR helpers for the open-ski-data editor.
 *
 * Replaces the ski-platform server-side `/api/dev/write-resort-patch`
 * route, which depended on a local clone + git CLI on the Snowple VM.
 * In the CF Pages deployment we run entirely in the browser plus
 * Pages Functions; the user authorizes via GitHub OAuth (`public_repo`
 * scope) and we use their token to:
 *
 *   1. Ensure they have a fork of `powder-nomad/open-ski-data`
 *      (POST /repos/{owner}/{repo}/forks — idempotent).
 *   2. Get the upstream main SHA (the base for the contribution branch).
 *   3. Create branch `editor/<slug>-<ts>` on the user's fork from that SHA.
 *   4. Atomic multi-file commit via the Git Data API (blobs → tree →
 *      commit → ref update). Single-file Contents API would force one
 *      commit per file and produce noisier history.
 *   5. Open a PR back to powder-nomad/open-ski-data:main.
 *
 * No bot identity — commits are authored by the OAuth user, so PRs
 * carry their GitHub username for review attribution.
 */
import { Octokit } from "@octokit/rest";

export const UPSTREAM_OWNER = "powder-nomad";
export const UPSTREAM_REPO = "open-ski-data";
export const UPSTREAM_BRANCH = "main";

export type CommitFile = {
  /** Repo-relative path, e.g. "registry/kr/gangwon/yongpyong/slopes.json". */
  path: string;
  /** UTF-8 file content; trailing newline added by `contribute()`. */
  content: string;
};

export type ContributionResult = {
  branchName: string;
  commitSha: string;
  forkOwner: string;
  forkBranchUrl: string;
  prNumber: number;
  prUrl: string;
};

/**
 * Build a deterministic, sortable, collision-resistant branch name.
 * Same shape as the legacy `snowple-bot/<slug>-<ts>` but without the
 * bot prefix since the branch lives on the user's fork.
 */
export function makeBranchName(slug: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `editor/${slug}-${ts}`;
}

/**
 * Idempotent fork. POST /repos/{owner}/{repo}/forks returns 202 even
 * when the fork already exists; we then poll until GitHub finishes
 * propagating the new fork's git data (typically <2s, but the API is
 * eventually-consistent on first-time forks).
 */
export async function ensureFork(
  octokit: Octokit,
  forkOwner: string,
): Promise<{ owner: string; repo: string }> {
  await octokit.rest.repos.createFork({
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
  });

  const deadline = Date.now() + 30_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await octokit.rest.repos.get({ owner: forkOwner, repo: UPSTREAM_REPO });
      return { owner: forkOwner, repo: UPSTREAM_REPO };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(
    `fork did not become readable within 30s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Fetch the latest commit SHA of upstream main so the contribution
 * branch starts from a known-good tip. We don't sync the user's fork
 * before committing — instead we pin the branch's parent commit at
 * the upstream tip and let GitHub track it as a cross-fork branch.
 */
export async function getUpstreamMainSha(octokit: Octokit): Promise<string> {
  const { data } = await octokit.rest.repos.getBranch({
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
    branch: UPSTREAM_BRANCH,
  });
  return data.commit.sha;
}

/**
 * Atomic multi-file commit on the user's fork.
 *
 * Workflow uses the Git Data API:
 *   1. Create a blob for each file
 *   2. Create a tree pointing at all blobs (with `base_tree` = parent
 *      commit's tree, so unchanged files are preserved)
 *   3. Create a commit object with the new tree
 *   4. Either create or update the branch ref to point at the commit
 *
 * Returns the new commit SHA + the resolved branch name.
 */
export async function commitFiles(args: {
  octokit: Octokit;
  forkOwner: string;
  branchName: string;
  parentSha: string;
  files: CommitFile[];
  message: string;
}): Promise<{ commitSha: string }> {
  const { octokit, forkOwner, branchName, parentSha, files, message } = args;
  const repo = UPSTREAM_REPO;

  const blobs = await Promise.all(
    files.map(async (f) => {
      const { data } = await octokit.rest.git.createBlob({
        owner: forkOwner,
        repo,
        content: f.content,
        encoding: "utf-8",
      });
      return { path: f.path, sha: data.sha };
    }),
  );

  const { data: parentCommit } = await octokit.rest.git.getCommit({
    owner: forkOwner,
    repo,
    commit_sha: parentSha,
  });

  const { data: tree } = await octokit.rest.git.createTree({
    owner: forkOwner,
    repo,
    base_tree: parentCommit.tree.sha,
    tree: blobs.map((b) => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    })),
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner: forkOwner,
    repo,
    message,
    tree: tree.sha,
    parents: [parentSha],
  });

  const ref = `heads/${branchName}`;
  try {
    await octokit.rest.git.createRef({
      owner: forkOwner,
      repo,
      ref: `refs/${ref}`,
      sha: commit.sha,
    });
  } catch {
    await octokit.rest.git.updateRef({
      owner: forkOwner,
      repo,
      ref,
      sha: commit.sha,
      force: true,
    });
  }

  return { commitSha: commit.sha };
}

/**
 * Open a PR from forkOwner:branchName → upstream:main. If a PR
 * already exists for that head ref we return it instead of failing.
 */
export async function openPullRequest(args: {
  octokit: Octokit;
  forkOwner: string;
  branchName: string;
  title: string;
  body: string;
}): Promise<{ prNumber: number; prUrl: string }> {
  const { octokit, forkOwner, branchName, title, body } = args;

  const head = `${forkOwner}:${branchName}`;
  const existing = await octokit.rest.pulls.list({
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
    head,
    state: "open",
  });
  if (existing.data.length > 0) {
    const pr = existing.data[0];
    return { prNumber: pr.number, prUrl: pr.html_url };
  }

  const { data: pr } = await octokit.rest.pulls.create({
    owner: UPSTREAM_OWNER,
    repo: UPSTREAM_REPO,
    title,
    body,
    head,
    base: UPSTREAM_BRANCH,
    maintainer_can_modify: true,
  });
  return { prNumber: pr.number, prUrl: pr.html_url };
}

/**
 * High-level convenience: takes an authenticated octokit + the
 * authenticated user's login + a contribution payload (slug + files),
 * runs the full ensureFork → commit → PR sequence, and returns the
 * resulting URLs the editor should display to the user.
 */
export async function contribute(args: {
  octokit: Octokit;
  user: { login: string };
  slug: string;
  countryCode: string;
  regionSlug: string;
  files: Record<string, string>;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
}): Promise<ContributionResult> {
  const { octokit, user, slug, countryCode, regionSlug, files } = args;

  const commitPayload: CommitFile[] = Object.entries(files).map(
    ([name, content]) => ({
      path: `registry/${countryCode}/${regionSlug}/${slug}/${name}`,
      content: content.endsWith("\n") ? content : `${content}\n`,
    }),
  );

  await ensureFork(octokit, user.login);
  const parentSha = await getUpstreamMainSha(octokit);
  const branchName = makeBranchName(slug);

  const { commitSha } = await commitFiles({
    octokit,
    forkOwner: user.login,
    branchName,
    parentSha,
    files: commitPayload,
    message: args.commitMessage ?? `Edit ${slug} via open-ski-data editor`,
  });

  const { prNumber, prUrl } = await openPullRequest({
    octokit,
    forkOwner: user.login,
    branchName,
    title: args.prTitle ?? `Edit ${countryCode}/${regionSlug}/${slug}`,
    body:
      args.prBody ??
      `Submitted via the open-ski-data web editor.\n\nSlug: \`${slug}\`\nFiles: ${commitPayload
        .map((f) => `\`${f.path}\``)
        .join(", ")}`,
  });

  return {
    branchName,
    commitSha,
    forkOwner: user.login,
    forkBranchUrl: `https://github.com/${user.login}/${UPSTREAM_REPO}/tree/${branchName}`,
    prNumber,
    prUrl,
  };
}
