import type { Octokit } from "octokit";
import { getOctokitForInstallation, getOctokitForRepo } from "@/lib/github";
import { sequelize, OutboundAction } from "@/lib/tidb";
import type { SolutionsReturn, SolutionsOutput, Change } from "@/agents/solutions";
import { sha1 } from "@/lib/text";
import { normalizeSolution } from "@/lib/solution-utils";

const DEBUG = process.env.DEBUG_ACTUATOR === "1";
const MAX_REVIEW_COMMENTS = Number(process.env.ACTUATOR_MAX_COMMENTS ?? "12");
const BODY_MAX_CHARS = Number(process.env.ACTUATOR_BODY_MAX ?? "18000"); // keep margin under GH hard limit

/* ============================== Helpers ============================== */

function clampLen(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + "\n\n… _truncated_" : s;
}

function buildSummaryMarkdown(sol: SolutionsReturn | SolutionsOutput) {
  const one = sol.summary?.one_liner || "ResolvCI review";
  const rat = sol.summary?.rationale || "";
  const conf = typeof sol.summary?.confidence === "number"
    ? `${Math.round((sol.summary.confidence ?? 0) * 100)}%`
    : "—";
  const risk = sol.summary?.risk || "low";
  return [
    `**ResolvCI** — ${one}`,
    ``,
    rat ? `**Rationale:** ${rat}` : "",
    `**Confidence:** ${conf} • **Risk:** ${risk}`,
    ``,
    `**Legend:** 🔎 diagnostic anchor (source of error) • 💡 inline code suggestion`,
  ].filter(Boolean).join("\n");
}

/** Fallback: synthesize review comments from changes using isNoop/appliesCleanly */
function synthesizeCommentsFromChanges(
  sol: SolutionsReturn | SolutionsOutput,
  allowInlineSuggestions: boolean,
  owner: string,
  repo: string,
  headSha: string
) {
  const changes = Array.isArray(sol.changes) ? sol.changes : [];
  return changes.slice(0, MAX_REVIEW_COMMENTS).map((chg: Change) => {
    const line = chg?.anchor?.line ?? 1;
    const lang = chg?.language || null;
    const code = (chg?.hunk?.after ?? "").toString();

    const isNoop = !!chg?.validation?.isNoop;
    const clean  = !!chg?.validation?.appliesCleanly;

    const link = makePermalink(owner, repo, headSha, chg.path, line);

    if (isNoop) {
      const body = [
        `🔎 **Source of error** — This is a diagnostic anchor (no code change).`,
        ``,
        lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
        ``,
        `[🔗 Permalink](${link})`
      ].join("\n");
      return { path: chg.path, line, body };
    }

    if (allowInlineSuggestions && clean) {
      const body = [
        `💡 **Suggested fix**`,
        ``,
        "```suggestion",
        code,
        "```",
        ``,
        `[🔗 Permalink](${link})`
      ].join("\n");
      return { path: chg.path, line, body };
    }

    const body = [
      "💡 **Suggested fix (comment-only; please review)**",
      "",
      lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``,
      ``,
      `[🔗 Permalink](${link})`
    ].join("\n");
    return { path: chg.path, line, body };
  });
}


function makePermalink(
  owner: string,
  repo: string,
  sha: string,
  path: string,
  startLine: number,
  endLine?: number
) {
  const base = `https://github.com/${owner}/${repo}/blob/${sha}/${encodeURI(path)}`;
  const anchor =
    endLine && endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return `${base}${anchor}`;
}


/* ============================== Types ============================== */

type StageFromSolutionParams = {
  owner: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  solution: SolutionsReturn | SolutionsOutput; // ← Option A: accept both
  installation_id?: number | null;
};

export type OutboundRow = {
  id: number;
  action_hash: string;
  action_type: string;
  payload_json: string;
  head_sha: string | null;
  installation_id: number | null;
  status?: string;
  attempt_count?: number;
};

type GitHubComment = {
  path: string;
  position?: number;
  body: string;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
}

/* ============================ Staging API ============================ */

/** Stage a PR review (exactly-once) from a Solutions output */
export async function stageReviewOutboxFromSolution(p: StageFromSolutionParams) {
  const { owner, repo, pull_number, head_sha, installation_id } = p;
  const solution = normalizeSolution(p.solution);

  // Policy guard (eligibility for inline suggestion blocks)
  const tau = Number(process.env.SOLUTIONS_CONFIDENCE_TAU ?? "0.80");
  const conf = Number(solution?.summary?.confidence ?? 0);
  const lowRisk = (solution?.summary?.risk ?? "low") === "low";
  const validAll = (solution?.changes ?? []).every((c: Change) => !!c?.validation?.appliesCleanly);
  const hasRealFix = (solution?.changes ?? []).some((c: Change) => !c?.validation?.isNoop && !!c?.validation?.appliesCleanly);
  const allowInlineSuggestions = conf >= tau && lowRisk && validAll && hasRealFix;

  // Body: prefer provided, else synthesize
  const rawBody =
    solution.summaryMarkdown && solution.summaryMarkdown.trim().length
      ? solution.summaryMarkdown
      : buildSummaryMarkdown(solution);

  // Comments: prefer provided, else synthesize from changes w/ diagnostic labeling
  const rawComments =
  Array.isArray((solution as SolutionsReturn).reviewComments) && (solution as SolutionsReturn).reviewComments.length
    ? (solution as SolutionsReturn).reviewComments
    : synthesizeCommentsFromChanges(solution, allowInlineSuggestions, owner, repo, head_sha);


  /**
   * Enforce caps/truncation
   * Ensure we have permalinks (even when reviewComments came from Solutions)
   */
  const ensurePermalink = (c: { path: string; line: number; body: string }) => {
    if (/github\.com\/.+\/blob\/.+#L\d+/.test(c.body)) return c; // already has one
    const link = makePermalink(owner, repo, head_sha, c.path, c.line);
    return { ...c, body: `${c.body}\n\n[🔗 Permalink](${link})` };
  };
  
  const comments = rawComments.slice(0, MAX_REVIEW_COMMENTS).map(ensurePermalink);
  
  const body = clampLen(rawBody, BODY_MAX_CHARS);

  const payload = {
    type: "pr_review" as const,
    owner,
    repo,
    pull_number,
    event: "COMMENT",
    body,
    comments,
  };

  // Deterministic idempotency key: content + head_sha
  const action_hash = sha1(
    JSON.stringify({
      t: payload.type,
      owner,
      repo,
      pull_number,
      head_sha,
      body,
      comments,
    })
  );

  if (DEBUG) {
    console.log("[Actuator] staging review payload:", {
      owner,
      repo,
      pull_number,
      head_sha,
      comments: comments.length,
      body_len: body.length,
      hash: action_hash,
    });
  }

  try {
    if (OutboundAction) {
      await OutboundAction.create({
        action_hash,
        action_type: "pr_review",
        head_sha,
        installation_id: installation_id ?? null,
        payload_json: JSON.stringify(payload),
        status: "staged",
        attempt_count: 0,
      });
    } else {
      const q = `
        INSERT INTO outbound_actions
          (action_hash, action_type, head_sha, installation_id, payload_json, status, attempt_count)
        VALUES
          (:action_hash, 'pr_review', :head_sha, :installation_id, :payload_json, 'staged', 0)
        ON DUPLICATE KEY UPDATE action_hash = action_hash
      `;
      await sequelize.query(q, {
        replacements: {
          action_hash,
          head_sha,
          installation_id: installation_id ?? null,
          payload_json: JSON.stringify(payload),
        },
      });
    }

    if (DEBUG) console.log("[Actuator] staged OK:", action_hash);
    return { ok: true as const, action_hash };
  } catch (e: unknown) {
    // Unique → already staged → treat as success
    if (e instanceof Error) {  
      const name = String(e?.name ?? "");
      if (name.includes("UniqueConstraint") || /duplicate/i.test(String(e?.message ?? ""))) {
        if (DEBUG) console.log("[Actuator] already staged:", action_hash);
        return { ok: true as const, action_hash, already: true };
      }
    }
    console.error("[Actuator] stage error:", e);
    return { ok: false as const, error: String(e) };
  }
}

/** Back-compat: stage with explicit body/comments (older callers) */
export async function stageReviewOutbox(p: {
  owner: string;
  repo: string;
  pull_number: number;
  head_sha: string;
  reviewBody: string;
  comments: Array<{ path: string; line: number; body: string }>;
  installation_id?: number | null;
}) {
  const solutionLike: SolutionsReturn = {
    summary: {
      one_liner: "",
      rationale: "",
      risk: "low",
      confidence: 0.7,
      references: [],
    },
    changes: [],
    tool_invocations: [],
    policy: { autoSuggestionEligible: true, reason: "explicit" },
    reviewComments: p.comments,
    summaryMarkdown: p.reviewBody,
  };
  return stageReviewOutboxFromSolution({
    owner: p.owner,
    repo: p.repo,
    pull_number: p.pull_number,
    head_sha: p.head_sha,
    solution: solutionLike,
    installation_id: p.installation_id ?? null,
  });
}

/* =========================== Dispatching API ========================== */

async function getOctoForAction(a: OutboundRow): Promise<Octokit> {
  try {
    if (a.installation_id != null) {
      return await getOctokitForInstallation(Number(a.installation_id));
    }
  } catch {
    // fallthrough to repo-based token
  }
  const payload = JSON.parse(a.payload_json);
  return await getOctokitForRepo(payload.owner, payload.repo);
}

/** Post a single staged review; idempotent & safe to retry */
export async function dispatchOneOutboundAction(a: OutboundRow) {
  const payload = JSON.parse(a.payload_json);
  if (payload.type !== "pr_review") {
    if (DEBUG) console.log("[Actuator] skip non-pr_review action:", a.id);
    return { ok: true, skipped: true };
  }

  const octo = await getOctoForAction(a);

  try {
    if (DEBUG) {
      console.log("[Actuator] posting review:", {
        owner: payload.owner,
        repo: payload.repo,
        pull_number: payload.pull_number,
        comments: (payload.comments || []).length,
        body_len: (payload.body || "").length,
      });
    }

    await octo.rest.pulls.createReview({
      owner: payload.owner,
      repo: payload.repo,
      pull_number: payload.pull_number,
      event: payload.event || "COMMENT",
      body: payload.body,
      comments: (payload.comments || []).map((c: GitHubComment) => ({
        path: c.path,
        line: c.line,
        side: c.side || "RIGHT",
        body: c.body,
      })),
    });

    if (OutboundAction) {
      await OutboundAction.update(
        { status: "dispatched", dispatched_at: new Date(), last_error: null },
        { where: { id: (a as OutboundRow).id } }
      );
    } else {
      await sequelize.query(
        `UPDATE outbound_actions
           SET status='dispatched', dispatched_at=NOW(), last_error=NULL
         WHERE id = :id`,
        { replacements: { id: (a as OutboundRow).id } }
      );
    }

    if (DEBUG) console.log("[Actuator] dispatched OK:", a.id);
    return { ok: true, id: (a as OutboundRow).id };
  } catch (err: unknown) {
    let message: string = String(err)
    if (err instanceof Error) {
      message = String(err?.message ?? err);
    }
    console.error("[Actuator] dispatch error:", message);
    if (OutboundAction) {
      await OutboundAction.update(
        {
          status: "error",
          attempt_count: (a.attempt_count ?? 0) + 1,
          last_error: message.slice(0, 1000),
        },
        { where: { id: (a as OutboundRow).id } }
      );
    } else {
      await sequelize.query(
        `UPDATE outbound_actions
           SET status='error',
               attempt_count=COALESCE(attempt_count,0)+1,
               last_error=:err
         WHERE id = :id`,
        { replacements: { id: (a as OutboundRow).id, err: message.slice(0, 1000) } }
      );
    }

    return { ok: false, error: message };
  }
}
