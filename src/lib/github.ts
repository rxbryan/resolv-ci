import { App } from "octokit";
import type { Octokit } from "octokit";

function normalizeKey(k?: string) {
  // Vercel/ENV usually stores \n; GitHub expects real newlines
  return (k ?? "").replace(/\\n/g, "\n");
}

export const app = new App({
  appId: Number(process.env.GITHUB_APP_ID),
  privateKey: normalizeKey(process.env.GITHUB_PRIVATE_KEY),
  webhooks: { secret: normalizeKey(process.env.GITHUB_WEBHOOK_SECRET ?? "")},
});


/** Direct installation-Octokit (use when you already have installation_id). */
export async function getOctokitForInstallation(installationId: number) {
  return app.getInstallationOctokit(installationId);
}

/** Resolve installation for a repo, then return an installation-Octokit. */
export async function getOctokitForRepo(owner: string, repo: string) {
  const { data } = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo }
  );
  return app.getInstallationOctokit(data.id);
}

/**
 * Best-effort: try the provided installation_id; if it’s missing/stale, resolve by repo.
 */
export async function getOctokitForContext(
  owner: string,
  repo: string,
  installationId?: number | null
) {
  if (installationId) {
    try {
      return await app.getInstallationOctokit(installationId);
    } catch {
      // fall back if stale/invalid
    }
  }
  const { data } = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo }
  );
  return app.getInstallationOctokit(data.id);
}

// Find the newest workflow run for the specific PR + head_sha
export async function findLatestRunForPR(
  octo: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
) {
  const events: Array<"pull_request" | "pull_request_target"> = [
    "pull_request",
    "pull_request_target",
  ];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const candidates: any[] = [];

  for (const ev of events) {
    const { data } = await octo.rest.actions.listWorkflowRunsForRepo({
      owner, repo, event: ev, per_page: 100,
    });

    for (const r of data.workflow_runs ?? []) {
      if (
        r.head_sha === headSha &&
        Array.isArray(r.pull_requests) &&
        r.pull_requests.some((pr: any) => pr.number === prNumber)
      ) {
        candidates.push(r);
      }
    }
  }

  candidates.sort((a, b) =>
    Date.parse(b.run_started_at ?? b.created_at) -
    Date.parse(a.run_started_at ?? a.created_at)
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return candidates[0]; // undefined if none
}

