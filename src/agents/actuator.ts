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

type DraftComment = { path: string; line: number; body: string; side?: "RIGHT" | "LEFT" };

function parseUnifiedDiffMaxRightLine(patch: string): number | null {
  // Very light-weight: scan hunks like @@ -a,b +c,d @@ and track max right line
  // This doesn’t validate every line, but prevents obviously out-of-range anchors.
  let max = 0;
  const re = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) {
    const start = Number(m[1] || 0);
    const len = Number(m[2] || 1);
    const end = start + Math.max(0, len) - 1;
    if (end > max) max = end;
  }
  return max || null;
}

async function validateReviewComments(
  octo: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  comments: DraftComment[]
): Promise<{ valid: DraftComment[]; diagnostics: DraftComment[] }> {
  if (!comments?.length) return { valid: [], diagnostics: [] };

  const { data: files } = await octo.rest.pulls.listFiles({ owner, repo, pull_number, per_page: 300 });
  const byPath = new Map<string, { patch: string | null }>();
  for (const f of files) byPath.set(f.filename, { patch: f.patch ?? null });

  const valid: DraftComment[] = [];
  const diagnostics: DraftComment[] = [];

  for (const c of comments) {
    const meta = byPath.get(c.path);
    if (!meta) { diagnostics.push(c); continue; }           // path not in diff → diag
    if (!meta.patch) { diagnostics.push(c); continue; }     // no patch (large/binary) → diag

    const maxRight = parseUnifiedDiffMaxRightLine(meta.patch);
    if (!maxRight || c.line < 1 || c.line > maxRight) {
      diagnostics.push(c);                                  // out of range → diag
      continue;
    }
    // Looks anchorable; ensure RIGHT side
    valid.push({ ...c, side: c.side ?? "RIGHT" });
  }
  return { valid, diagnostics };
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

  const rawComments = (solution as SolutionsReturn).reviewComments
  const comments = rawComments.slice(0, MAX_REVIEW_COMMENTS).map((c)=>{return c});  // noop
  
  const body = clampLen(solution.summaryMarkdown , BODY_MAX_CHARS);

  const payload = {
    type: "pr_review" as const,
    owner,
    repo,
    pull_number,
    head_sha,          
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
  const { valid, diagnostics } = await validateReviewComments(
    octo, payload.owner, payload.repo, payload.pull_number, payload.comments || []
  );

  // Fold un-anchorable items into the top body as diagnostics
  let body = String(payload.body || "");

  if (diagnostics.length) {
    console.log("[Actuator] diagnostics:", diagnostics[0], valid)
    const bullets = diagnostics.map(d => {
      const link = makePermalink(payload.owner, payload.repo, payload.head_sha, d.path, d.line);
      return `- 🔎 **Source of error** at [\`${d.path}:${d.line}\`](${link})\n${d.body}`;
    }).join("\n");  
    body += `\n\n---\n**Diagnostics:**\n${bullets}`;
  }

  try {
    if (DEBUG) {
      console.log("[Actuator] posting review:", {
        owner: payload.owner,
        repo: payload.repo,
        pull_number: payload.pull_number,
        comments: (payload.comments || []).length,
        body_len: (payload.body || "").length,
        body
      });
    }

    //console.log("[Actuator] posting review:", payload.comments[0].body)
    await octo.rest.pulls.createReview({
      owner: payload.owner,
      repo: payload.repo,
      pull_number: payload.pull_number,
      commit_id: payload.head_sha,
      event: payload.event || "COMMENT",
      body,
      comments: valid.map((c: GitHubComment) => ({
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
