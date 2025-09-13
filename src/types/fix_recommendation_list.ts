export type RiskLevel = "low" | "medium" | "high";

export type ToolInvocation = {
  name: string;
  /** JSON-encoded tool args recorded at runtime (may be empty). */
  args_json?: string;
  ms: number;
  ok: boolean;
};

export type FixChange = {
  path: string;
  hunk: { after: string };
  anchor?: { line: number };
  language?: string | null;
  validation?: { appliesCleanly: boolean; isNoop?: boolean };
};
export type FixChangesJson = FixChange[];

/** Shape returned directly from Sequelize raw SELECT (JSON columns may be string/unknown). */
export interface FixRecommendationListRowRaw {
  id: number;
  failure_id: number | null;
  pr_number: number | null;
  head_sha: string | null;
  created_at: string | Date;

  summary_json: unknown | null;
  changes_json: unknown | null;
  policy_json: unknown | null;
  tool_inv_json: unknown | null;

  summary_md: string | null;
  summary_one_liner: string | null;
  rationale: string | null;
}

/** Parsed/typed view for app use. */
export interface FixRecommendationListItem {
  id: number;
  failure_id: number | null;
  pr_number: number | null;
  head_sha: string | null;
  created_at: string | Date;

  summary: {
    one_liner: string;
    rationale: string;
    risk: RiskLevel;
    confidence: number; // 0..1
    references: string[];
  } | null;

  changes: FixChangesJson | null;

  policy: {
    autoSuggestionEligible: boolean;
    reason: string;
  } | null;

  tool_invocations: ToolInvocation[] | null;

  /** Render-ready Markdown body (may be null if not stored). */
  summary_md: string | null;

  /** Convenience duplicates (if you also store denormalized columns). */
  summary_one_liner: string | null;
  rationale: string | null;
}

/* ------------------------ Helpers to coerce JSON ------------------------ */

export function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  if (typeof v === "object") return v as T;
  return null;
}

/** Convert a raw row into a fully-typed item. */
export function toFixRecommendationListItem(row: FixRecommendationListRowRaw): FixRecommendationListItem {
  return {
    id: row.id,
    failure_id: row.failure_id,
    pr_number: row.pr_number,
    head_sha: row.head_sha,
    created_at: row.created_at,

    summary: parseJson<FixRecommendationListItem["summary"]>(row.summary_json),
    changes: parseJson<FixChangesJson>(row.changes_json),
    policy: parseJson<FixRecommendationListItem["policy"]>(row.policy_json),
    tool_invocations: parseJson<ToolInvocation[]>(row.tool_inv_json),

    summary_md: row.summary_md,
    summary_one_liner: row.summary_one_liner,
    rationale: row.rationale,
  };
}
