import { sequelize, BuildFailure } from "@/lib/tidb";
import type { SolutionsReturn, SolutionsOutput } from "@/agents/solutions";
import { jsonClamp } from "@/lib/text";
import { normalizeSolution } from "@/lib/solution-utils";

import {
  FixChangesJson,
  FixRecommendationListItem,
  parseJson,
  ToolInvocation,
  FixRecommendationListRowRaw
} from "@/types/fix_recommendation_list";


const DEBUG = process.env.DEBUG_KNOWLEDGE === "1";

/* ============================== Utils ============================== */

/** Redact obvious secrets and keep lines reasonable. */
function redact(s: string): string {
  if (!s) return s;
  return s
    .replace(/(ghp_[A-Za-z0-9]{20,})/g, "ghp_***")
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*=\s*['"][^'"]+['"])/gi, "***=REDACTED***")
    .split("\n")
    .map((ln) => (ln.length > 4000 ? ln.slice(0, 4000) + " …" : ln))
    .join("\n");
}

/* ============================ Write API ============================ */

type PersistParams = {
  failure_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number | null;
  head_sha: string;
  solution: SolutionsReturn | SolutionsOutput; // accept both
};

/**
 * Persist solution artifacts & mark the failure as 'proposed'.
 * Idempotent on (failure_id, head_sha) via unique key in DDL.
 *
 * also sets `summary_one_liner` and `rationale` columns to
 * improve the auto-embedded vector quality.
 */
export async function recordSolutionArtifacts(p: PersistParams) {
  const { failure_id, repo_owner, repo_name, pr_number, head_sha } = p;
  const sol = normalizeSolution(p.solution);

  // Prepare payloads
  const summary_json = jsonClamp({
    one_liner: sol.summary.one_liner,
    rationale: sol.summary.rationale,
    risk: sol.summary.risk,
    confidence: sol.summary.confidence,
    references: sol.summary.references,
  });
  const changes_json = jsonClamp(sol.changes);
  const policy_json = jsonClamp(sol.policy);
  const tool_inv_json = jsonClamp(sol.tool_invocations);
  const summary_md = redact(sol.summaryMarkdown || "");

  const summary_one_liner = sol.summary.one_liner;
  const rationale = sol.summary.rationale;

  const t = await sequelize.transaction();
  try {
    // 1) Update the failure row if present
    await BuildFailure.update(
      { status: "proposed" },
      { where: { failure_id }, transaction: t }
    );

    // 2) Insert recommendation idempotently (no-op on duplicate)
    const q = `
      INSERT INTO fix_recommendations
        (failure_id, repo_owner, repo_name, pr_number, head_sha,
         summary_json, changes_json, policy_json, tool_inv_json, summary_md,
         summary_one_liner, rationale)
      VALUES
        (:failure_id, :repo_owner, :repo_name, :pr_number, :head_sha,
         :summary_json, :changes_json, :policy_json, :tool_inv_json, :summary_md,
         :summary_one_liner, :rationale)
      ON DUPLICATE KEY UPDATE
        head_sha = head_sha
    `;
    await sequelize.query(q, {
      transaction: t,
      replacements: {
        failure_id,
        repo_owner,
        repo_name,
        pr_number,
        head_sha,
        summary_json,
        changes_json,
        policy_json,
        tool_inv_json,
        summary_md,
        summary_one_liner,
        rationale,
      },
    });

    await t.commit();
    if (DEBUG) {
      console.log("[Knowledge] persisted recommendation:", {
        failure_id,
        repo: `${repo_owner}/${repo_name}`,
        pr: pr_number,
        head_sha,
      });
    }
    return { ok: true as const };
  } catch (e: unknown) {
    let message: string = String(e)
    if (e instanceof Error)
      message=e?.message

    await t.rollback();
    console.error("[Knowledge] persist error:", e);
    return { ok: false as const, error: message };
  }
}

/* ============================= Read API ============================= */

/** Most recent recommendations for a repo (JSON parsed for convenience). */
export async function getRecentRecommendations(opts: {
  repo_owner: string;
  repo_name: string;
  limit?: number;
}) {
  const { repo_owner, repo_name, limit = 10 } = opts;
  const q = `
    SELECT id, failure_id, pr_number, head_sha, created_at,
           summary_json, changes_json, policy_json, tool_inv_json, summary_md,
           summary_one_liner, rationale
    FROM fix_recommendations
    WHERE repo_owner = :repo_owner AND repo_name = :repo_name
    ORDER BY created_at DESC
    LIMIT :limit
  `;
  const [rows] = await sequelize.query(q, {
    replacements: { repo_owner, repo_name, limit },
  });

  const items: FixRecommendationListItem[] = (rows as FixRecommendationListRowRaw[])
  .map((r): FixRecommendationListItem => ({
    id: r.id,
    failure_id: r.failure_id,
    pr_number: r.pr_number,
    head_sha: r.head_sha,
    created_at: r.created_at,
    summary: parseJson<FixRecommendationListItem["summary"]>(r.summary_json),
    changes: parseJson<FixChangesJson>(r.changes_json),
    policy: parseJson<FixRecommendationListItem["policy"]>(r.policy_json),
    tool_invocations: parseJson<ToolInvocation[]>(r.tool_inv_json),
    summary_md: r.summary_md,
    summary_one_liner: r.summary_one_liner,
    rationale: r.rationale,
  }));

  return items;
}

/**
 * Semantic search over recommendations using TiDB auto-embedding.
 * If repo_owner/repo_name provided, it narrows to that repo.
 */
export async function searchRecommendationsSemantic(opts: {
  query: string;
  repo_owner?: string;
  repo_name?: string;
  limit?: number;
}) {
  const { query, repo_owner, repo_name, limit = 5 } = opts;

  const scoped = Boolean(repo_owner && repo_name);
  const q = scoped
    ? `
      SELECT id, failure_id, pr_number, head_sha, created_at,
             summary_one_liner, rationale, summary_md,
             summary_json, changes_json, policy_json, tool_inv_json,
             VEC_EMBED_COSINE_DISTANCE(content_vector, :q) AS _distance
      FROM fix_recommendations
      WHERE repo_owner = :owner AND repo_name = :repo
      ORDER BY _distance
      LIMIT :limit
    `
    : `
      SELECT id, failure_id, pr_number, head_sha, created_at,
             summary_one_liner, rationale, summary_md,
             summary_json, changes_json, policy_json, tool_inv_json,
             VEC_EMBED_COSINE_DISTANCE(content_vector, :q) AS _distance
      FROM fix_recommendations
      ORDER BY _distance
      LIMIT :limit
    `;

  const [rows] = await sequelize.query(q, {
    replacements: scoped
      ? { q: query, owner: repo_owner, repo: repo_name, limit }
      : { q: query, limit },
  });

  const items: FixRecommendationListItem[] = (rows as FixRecommendationListRowRaw[])
  .map((r): FixRecommendationListItem => ({
    id: r.id,
    failure_id: r.failure_id,
    pr_number: r.pr_number,
    head_sha: r.head_sha,
    created_at: r.created_at,
    summary: parseJson<FixRecommendationListItem["summary"]>(r.summary_json),
    changes: parseJson<FixChangesJson>(r.changes_json),
    policy: parseJson<FixRecommendationListItem["policy"]>(r.policy_json),
    tool_invocations: parseJson<ToolInvocation[]>(r.tool_inv_json),
    summary_md: r.summary_md,
    summary_one_liner: r.summary_one_liner,
    rationale: r.rationale,
  }));

  return items;
}

/** Optional: mark build failure as applied (after human confirms) */
export async function markApplied(failure_id: number) {
  await BuildFailure.update({ status: "applied" }, { where: { failure_id } });
}

