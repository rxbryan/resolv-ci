import { Op, QueryTypes } from "sequelize";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import {
  BaseMessage,
  SystemMessage,
  HumanMessage,
  AIMessage,
} from "@langchain/core/messages";

import { sequelize, BuildFailure } from "@/lib/tidb";
import { sha1, normalize, redactSecrets, templateize } from "@/lib/text";
/* ====================== Config & small helpers ====================== */

const CHAT_MODEL = process.env.LLM_MODEL_CHAT || "gpt-4o-mini";
const TAIL_LINES = Number(process.env.ANALYSIS_TAIL_LINES ?? "300");
const VECTOR_SIM_THRESHOLD = Number(process.env.VECTOR_SIM_THRESHOLD ?? "0");


/** Keep only last N lines */
const lastLines = (s: string, n: number) => (s || "").split("\n").slice(-n).join("\n");

/* ====================== Structured output schema ====================== */

const AnalysisSchema = z.object({
  error_class: z.string().optional().default(""),
  message: z.string().optional().default(""),
  file_hint: z.string().optional().default(""),
  failing_test: z.string().optional().default(""),
  keywords: z.array(z.string()).optional().default([]),
});

export type StructuredAnalysis = {
  error_signature: string;
  error_class: string;
  message: string;
  file_hint: string;
  failing_test: string;
  keywords: string[];
};

export type AnalysisOutput = {
  window: string; // original tail (unredacted; used by later agents—safe to keep internal)
  structured: StructuredAnalysis;

  // Exact neighbors by persisted signatures
  similar_failures: Array<{
    failure_id: number;
    pr_number: number | null;
    commit_sha: string;
    failure_timestamp: string | Date;
    error_signature_v1?: string | null;
    error_signature_v2?: string | null;
    match_on: "v1" | "v2";
  }>;

  // Semantic neighbors by normalized tail vector
  similar_by_tail: Array<{
    failure_id: number;
    pr_number: number | null;
    commit_sha: string;
    failure_timestamp: string | Date;
    similarity: number; // 0..1
  }>;

  // Prior solutions (vector over fix_recommendations)
  similar_solutions: Array<{
    id: number;
    failure_id: number | null;
    pr_number: number | null;
    head_sha: string | null;
    summary_one_liner: string | null;
    rationale: string | null;
    changes_json?: unknown;
    created_at: string | Date;
    similarity: number; // 0..1
  }>;

  messages: BaseMessage[]; // keep stateless (empty) to avoid duplication across loops
};

function logAnalysisDebug(
  failureId: number | null | undefined,
  out: {
    window: string;
    structured: any;
    similar_failures: any[];
    similar_by_tail: any[];
    similar_solutions: any[];
  }
) {
  const safeTail = out.window.split("\n").slice(-120).join("\n"); // cap to last 120 lines
  const summary = {
    failure_id: failureId ?? null,
    structured: out.structured,
    similar_failures: out.similar_failures,
    similar_by_tail: out.similar_by_tail,
    similar_solutions: out.similar_solutions.map(s => ({
      id: s.id, similarity: s.similarity, summary_one_liner: s.summary_one_liner
    })),
  };
  // pretty print (avoid huge arrays)
  console.log("\n=== ANALYSIS DEBUG ===");
  console.log("\n-- tail(window) --\n" + safeTail + "\n");
  console.dir(summary, { depth: null, maxArrayLength: 50 });
  console.log("=== END ANALYSIS DEBUG ===\n");
}

/* =============================== Main API =============================== */

export async function analyzeFailure(f: {
  repo_owner: string;
  repo_name: string;
  pr_number?: number | null;
  commit_sha: string;
  log_content?: string | null;
  failure_id?: number | null;
  messages?: BaseMessage[];
}): Promise<AnalysisOutput> {
  // Prepare windows: original tail for downstream; redacted & normalized for LLM/search
  const window = lastLines(f.log_content ?? "", TAIL_LINES);
  /**
   * Because there are multiple ways a secret can be transformed, 
   * automatic redation is not guarranteed
   * */ 
  const redacted = redactSecrets(window);  

  // Load persisted signatures/norm_tail if available
  let sigV1: string | null | undefined;
  let sigV2: string | null | undefined;
  let normTail: string | null | undefined;

  if (f.failure_id) {
    const row = await BuildFailure.findByPk(f.failure_id);
    const j = row?.toJSON() as any;
    sigV1 = j?.error_signature_v1 ?? null;
    sigV2 = j?.error_signature_v2 ?? null;
    normTail = j?.norm_tail ?? null;
  }

  // Backfill ephemeral values (without writing) if needed
  if (!normTail) normTail = normalize(redacted);
  if (!sigV1) sigV1 = sha1(normTail);
  if (!sigV2) sigV2 = sha1(templateize(normTail));

  // 1) Run LLM extraction with timeouts/retries
  const llm = new ChatOpenAI({
    model: CHAT_MODEL,
    temperature: 0,
    maxRetries: 2,
    timeout: 12_000, // ms
  });

  const sys = new SystemMessage(
    'You are a CI log analyst. Return ONLY JSON with keys: {"error_class":string,"message":string,"file_hint":string,"failing_test":string,"keywords":string[]}'
  );
  const user = new HumanMessage(`<log>\n${redacted}\n</log>\nReturn the strict JSON object only.`);

  let structured: StructuredAnalysis = {
    error_signature: sigV1 || "",
    error_class: "",
    message: "",
    file_hint: "",
    failing_test: "",
    keywords: [],
  };

  if (redacted.trim()) {
    try {
      const parsed = await llm.withStructuredOutput(AnalysisSchema).invoke([sys, user]);
      structured = toStructured(sigV1 || "", parsed);
    } catch {
      // keep defaults on LLM failure
    }
  }

  // 2) Exact signature neighbors (precision, no blob hashing)
  const exactV1 = await BuildFailure.findAll({
    attributes: [
      "failure_id",
      "pr_number",
      "commit_sha",
      "failure_timestamp",
      "error_signature_v1",
      "error_signature_v2",
    ],
    where: {
      repo_owner: f.repo_owner,
      repo_name: f.repo_name,
      error_signature_v1: sigV1,
    },
    order: [["failure_timestamp", "DESC"]],
    limit: 5,
  });

  const exactV2 = await BuildFailure.findAll({
    attributes: [
      "failure_id",
      "pr_number",
      "commit_sha",
      "failure_timestamp",
      "error_signature_v1",
      "error_signature_v2",
    ],
    where: {
      repo_owner: f.repo_owner,
      repo_name: f.repo_name,
      error_signature_v2: sigV2,
    },
    order: [["failure_timestamp", "DESC"]],
    limit: 5,
  });

  const similar_failures = [
    ...exactV1.map((r: any) => {
      const j = r.toJSON();
      return {
        failure_id: j.failure_id,
        pr_number: j.pr_number ?? null,
        commit_sha: j.commit_sha,
        failure_timestamp: j.failure_timestamp,
        error_signature_v1: j.error_signature_v1,
        error_signature_v2: j.error_signature_v2,
        match_on: "v1" as const,
      };
    }),
    ...exactV2.map((r: any) => {
      const j = r.toJSON();
      return {
        failure_id: j.failure_id,
        pr_number: j.pr_number ?? null,
        commit_sha: j.commit_sha,
        failure_timestamp: j.failure_timestamp,
        error_signature_v1: j.error_signature_v1,
        error_signature_v2: j.error_signature_v2,
        match_on: "v2" as const,
      };
    }),
  ]
    .filter((v, i, a) => a.findIndex((x) => x.failure_id === v.failure_id) === i)
    .slice(0, 5);

  // 3) Semantic neighbors by normalized tail vector (recall)
  // Uses TiDB auto-embedding on build_failures.norm_tail_vec
  let similar_by_tail: AnalysisOutput["similar_by_tail"] = [];
  try {
    const rows = (await sequelize.query(
      `
      SELECT failure_id, pr_number, commit_sha, failure_timestamp,
             VEC_EMBED_COSINE_DISTANCE(norm_tail_vec, :q) AS _distance
      FROM build_failures
      WHERE repo_owner = :owner AND repo_name = :repo AND norm_tail IS NOT NULL
      ORDER BY _distance ASC
      LIMIT 5
      `,
      {
        replacements: { q: normTail || "", owner: f.repo_owner, repo: f.repo_name },
        type: QueryTypes.SELECT,
      }
    )) as Array<{
      failure_id: number;
      pr_number: number | null;
      commit_sha: string;
      failure_timestamp: string | Date;
      _distance: number | string | null;
    }>;

    similar_by_tail = rows
      .map((r) => {
        const dist = Number(r._distance ?? 1);
        // clamp to [0,1] just in case; similarity = 1 - distance
        const sim = Math.max(0, Math.min(1, 1 - Math.max(0, Math.min(dist, 1))));
        return {
          failure_id: r.failure_id,
          pr_number: r.pr_number,
          commit_sha: r.commit_sha,
          failure_timestamp: r.failure_timestamp,
          similarity: sim,
        };
      })
      .filter((x) => x.similarity >= VECTOR_SIM_THRESHOLD);
  } catch {
    similar_by_tail = [];
  }

  // 4) Prior solutions via TiDB auto-embedding on fix_recommendations.content_vector
  const solQuery = [
    redacted,
    structured.error_class && `error_class: ${structured.error_class}`,
    structured.message && `message: ${structured.message}`,
    structured.file_hint && `file_hint: ${structured.file_hint}`,
    structured.failing_test && `failing_test: ${structured.failing_test}`,
    structured.keywords.length ? `keywords: ${structured.keywords.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  type FixRow = {
    id: number;
    failure_id: number | null;
    repo_owner: string;
    repo_name: string;
    pr_number: number | null;
    head_sha: string | null;
    summary_one_liner: string | null;
    rationale: string | null;
    changes_json?: unknown;
    created_at: string | Date;
    _distance?: number | string | null;
  };

  let similar_solutions: AnalysisOutput["similar_solutions"] = [];
  try {
    const rows = (await sequelize.query(
      `
      SELECT
        id, failure_id, repo_owner, repo_name, pr_number, head_sha,
        summary_one_liner, rationale, changes_json, created_at,
        VEC_EMBED_COSINE_DISTANCE(content_vector, :q) AS _distance
      FROM fix_recommendations
      WHERE repo_owner = :owner AND repo_name = :repo
      ORDER BY _distance ASC
      LIMIT 5
      `,
      {
        replacements: { q: solQuery, owner: f.repo_owner, repo: f.repo_name },
        type: QueryTypes.SELECT,
      }
    )) as FixRow[];

    similar_solutions = rows.map((r) => {
      const dist = Number(r._distance ?? 1);
      const sim = Math.max(0, Math.min(1, 1 - Math.max(0, Math.min(dist, 1))));
      return {
        id: r.id,
        failure_id: r.failure_id,
        pr_number: r.pr_number,
        head_sha: r.head_sha,
        summary_one_liner: r.summary_one_liner,
        rationale: r.rationale,
        changes_json: r.changes_json,
        created_at: r.created_at,
        similarity: sim,
      };
    });
  } catch {
    similar_solutions = [];
  }

  // We keep analysis stateless for loops to avoid message bloat.
  const messages: BaseMessage[] = [
    sys,
    user,
    new AIMessage(JSON.stringify(structured)),
  ];

  if (process.env.DEBUG_ANALYSIS === "1") {
    logAnalysisDebug(f.failure_id, {
      window,
      structured,
      similar_failures,
      similar_by_tail,
      similar_solutions,
    });
  }

  return {
    window, // unredacted tail (internal)
    structured,
    similar_failures,
    similar_by_tail,
    similar_solutions,
    messages: [], // keep empty so Solutions owns the convo
  };
}

/* ============================== tiny helper ============================== */

function toStructured(sig: string, p: unknown): StructuredAnalysis {
  const v = AnalysisSchema.parse(p);
  return {
    error_signature: sig,
    error_class: v.error_class ?? "",
    message: v.message ?? "",
    file_hint: v.file_hint ?? "",
    failing_test: v.failing_test ?? "",
    keywords: Array.isArray(v.keywords) ? v.keywords : [],
  };
}
