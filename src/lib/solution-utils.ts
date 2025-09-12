import type { SolutionsReturn, SolutionsOutput, Change } from "@/agents/solutions";

const TAU = Number(process.env.SOLUTIONS_CONFIDENCE_TAU ?? "0.80");
const clamp01 = (x?: number) => (typeof x === "number" && !Number.isNaN(x) ? Math.max(0, Math.min(1, x)) : 0);

/** Coerce SolutionsOutput | SolutionsReturn into a full SolutionsReturn */
export function normalizeSolution(sol: SolutionsOutput | SolutionsReturn): SolutionsReturn {
  const anySol = sol as any;
  const hasExtras = Array.isArray(anySol.reviewComments) && typeof anySol.summaryMarkdown === "string";

  const confidence = clamp01(sol.summary.confidence);
  const validAll = (sol.changes ?? []).every((c: Change) => !!c.validation?.appliesCleanly);
  const lowRisk = sol.summary.risk === "low";
  const autoEligible = confidence >= TAU && lowRisk && validAll;

  const policy =
    anySol.policy && typeof anySol.policy.autoSuggestionEligible === "boolean"
      ? anySol.policy
      : {
          autoSuggestionEligible: autoEligible,
          reason: autoEligible
            ? "High confidence & low risk with clean patches."
            : "Confidence below threshold and/or higher risk or invalid anchors.",
        };

  if (hasExtras) {
    return {
      summary: {
        one_liner: sol.summary.one_liner,
        rationale: sol.summary.rationale,
        risk: sol.summary.risk,
        confidence,
        references: sol.summary.references ?? [],
      },
      changes: sol.changes ?? [],
      tool_invocations: (anySol.tool_invocations ?? []),
      policy,
      reviewComments: anySol.reviewComments,
      summaryMarkdown: anySol.summaryMarkdown,
    };
  }

  const summaryMarkdown = [
    `**ResolvCI** — ${sol.summary.one_liner}`,
    ``,
    `**Rationale:** ${sol.summary.rationale}`,
    `**Confidence:** ${(confidence * 100).toFixed(0)}% • **Risk:** ${sol.summary.risk}`,
  ].join("\n");

  const reviewComments = (sol.changes ?? []).map((chg: Change) => {
    const line = chg.anchor?.line ?? 1;
    const parts = [
      chg.language ? `Language: ${chg.language}` : "",
      policy.autoSuggestionEligible && validAll
        ? `\n\`\`\`suggestion\n${chg.hunk.after}\n\`\`\`\n`
        : `\n**Suggested change:**\n\n\`\`\`\n${chg.hunk.after}\n\`\`\`\n`,
    ].filter(Boolean);
    return { path: chg.path, line, body: parts.join("\n") };
  });

  return {
    summary: {
      one_liner: sol.summary.one_liner,
      rationale: sol.summary.rationale,
      risk: sol.summary.risk,
      confidence,
      references: sol.summary.references ?? [],
    },
    changes: sol.changes ?? [],
    tool_invocations: (anySol.tool_invocations ?? []),
    policy,
    reviewComments,
    summaryMarkdown,
  };
}
