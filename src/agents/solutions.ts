import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import {
  BaseMessage,
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { Octokit } from "octokit";
import {
  getOctokitForInstallation,
  getOctokitForRepo,
} from "@/lib/github";
import { tailLines } from "@/lib/text";

/* ============================== Config ============================== */

const MODEL = process.env.LLM_MODEL_CHAT || "gpt-4o-mini";
const MAX_TOOL_CALLS = Number(process.env.SOL_MAX_TOOL_CALLS ?? "3");
const MAX_TOOL_MS = Number(process.env.SOL_MAX_TOOL_MS ?? "5000"); // ~5s cap
const TAU = Number(process.env.SOLUTIONS_CONFIDENCE_TAU ?? "0.80");

/* 🔎 enable logs with DEBUG_SOLUTIONS=1 */
const DEBUG_SOL = process.env.DEBUG_SOLUTIONS === "1";

export type Change = {
  path: string;
  anchor: { line: number } | null;     // ← allow null
  hunk: { after: string };
  language: string | null;             // ← allow null
  validation: {
    appliesCleanly: boolean;
    isNoop?: boolean;
  };
  type?: "fix" | "diagnosis";
};

export type SolutionsOutput = {
  summary: {
    one_liner: string;
    rationale: string;
    risk: "low" | "medium" | "high";
    confidence: number;
    references: any[];                 // required with default []
  };
  changes: Change[];                   // ← uses the nullable fields
  tool_invocations: any[];             // required with default []
  policy: { autoSuggestionEligible: boolean; reason: string };
};

export type SolutionsReturn = SolutionsOutput & {
  reviewComments: Array<{ path: string; line: number; body: string }>;
  summaryMarkdown: string;
};

/* ============================ Tool helpers ============================ */

async function getOcto(owner: string, repo: string, installationId?: number | null): Promise<Octokit> {
  if (installationId != null) {
    return await getOctokitForInstallation(installationId);
  }
  return await getOctokitForRepo(owner, repo);
}

function normalizeWS(s: string) {
  return (s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function isNoopChange(original: string, proposed: string) {
  return normalizeWS(original) === normalizeWS(proposed);
}

// list_pr_files: enumerate changed files (+ unified diff patches)
const listPRFilesTool = tool(
  async (
    input: z.infer<typeof ListPRFilesSchema>,
    config
  ) => {
    const octo: Octokit = (config?.configurable as any)?.octo;
    const { owner, repo, pull_number, max_files } = input;
    const { data } = await octo.rest.pulls.listFiles({
      owner,
      repo,
      pull_number,
      per_page: Math.min(max_files ?? 100, 300),
    });
    // Keep small payload: path + patch (unified diff) + stats
    return data.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch ?? null, // may be null for large files
    }));
  },
  {
    name: "list_pr_files",
    description:
      "List files changed in a pull request with unified diff patches to anchor suggestions.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      pull_number: z.number().int(),
      max_files: z.number().int().optional().default(100),
    }),
  }
);

// fetch_slice: retrieve a file (or targeted range) at PR HEAD SHA
const fetchSliceTool = tool(
  async (
    input: z.infer<typeof FetchSliceSchema>,
    config
  ) => {
    const octo: Octokit = (config?.configurable as any)?.octo;
    const { owner, repo, ref, path, start_line, end_line } = input;
    const res = await octo.rest.repos.getContent({ owner, repo, path, ref });
    if (!("content" in res.data)) {
      return { path, slice: "", note: "Not a file content response." };
    }
    const content = Buffer.from((res.data as any).content, "base64").toString("utf8");
    const lines = content.split("\n");
    const s = Math.max(1, start_line);
    const e = Math.min(lines.length, end_line ?? start_line + 80);
    const slice = lines.slice(s - 1, e).join("\n");
    return { path, start_line: s, end_line: e, slice };
  },
  {
    name: "fetch_slice",
    description:
      "Fetch a specific line range from a file at a given ref (HEAD SHA). Keep payloads small.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      ref: z.string(), // HEAD SHA
      path: z.string(),
      start_line: z.number().int().min(1),
      end_line: z.number().int().nullable().default(null),
    }),
  }
);

// code_search: locate symbols/configs quickly (use slices to validate)
const codeSearchTool = tool(
  async (
    input: z.infer<typeof CodeSearchSchema>,
    config
  ) => {
    const octo: Octokit = (config?.configurable as any)?.octo;
    const { owner, repo } = input;
    const q = `${input.q} repo:${owner}/${repo}`;
    const { data } = await octo.rest.search.code({ q, per_page: Math.min(input.max ?? 10, 50) });
    return (data.items || []).map((it: any) => ({
      path: it.path,
      sha: it.sha,
      score: it.score,
      url: it.html_url,
    }));
  },
  {
    name: "code_search",
    description:
      "GitHub code search within the repo (symbols, keys, workflows). Use fetch_slice afterwards for validation.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      q: z.string(), // GitHub search syntax
      max: z.number().int().optional().default(10),
    }),
  }
);

/* ============================= Zod schemas ============================= */

const ListPRFilesSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  pull_number: z.number().int(),
  max_files: z.number().int().optional().default(100),
});

const FetchSliceSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(), // HEAD SHA
  path: z.string(),
  start_line: z.number().int().min(1),
  end_line: z.number().int().nullable().default(null),
});

const CodeSearchSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  q: z.string(),
  max: z.number().int().optional().default(10),
});

const ChangeSchema = z.object({
  path: z.string(),
  anchor: z.object({ line: z.number().int().min(1) }).nullable().default(null),
  hunk: z.object({ after: z.string() }),
  language: z.string().nullable().default(null),
  validation: z.object({
    appliesCleanly: z.boolean(),
    isNoop: z.boolean().optional().default(false),
  }),
});

const SolutionsSchema = z.object({
  summary: z.object({
    one_liner: z.string(),
    rationale: z.string(),
    risk: z.enum(["low", "medium", "high"]),
    confidence: z.number().min(0).max(1),
    references: z.array(z.string()).default([]), // concrete item type
  }),
  changes: z.array(ChangeSchema).default([]),
  tool_invocations: z.array(
    z.object({
      name: z.string(),
      // Store tool args as JSON string to satisfy the schema requirement
      args_json: z.string().default(""),
      ms: z.number().nonnegative(),
      ok: z.boolean(),
    })
  ).default([]),
  policy: z.object({
    autoSuggestionEligible: z.boolean(),
    reason: z.string(),
  }),
});
/* ============================= Main solver ============================= */

export async function solveFailure(
  input: {
    repo_owner: string;
    repo_name: string;
    pr_number: number;
    commit_sha: string; // HEAD SHA
    log_content: string;
    installation_id?: number | null;
  },
  analysis?: {
    window?: string;
    structured?: any;
    similar_failures?: any[];
    similar_by_tail?: any[];
    similar_solutions?: any[];
    messages?: BaseMessage[];
  }
): Promise<SolutionsReturn> {
  const { repo_owner, repo_name, pr_number, commit_sha, installation_id } = input;

  const octo = await getOcto(repo_owner, repo_name, installation_id);

  const llm = new ChatOpenAI({
    model: MODEL,
    temperature: 0,
    timeout: 20_000,
    maxRetries: 2,
  }).bindTools([listPRFilesTool, fetchSliceTool, codeSearchTool]);

  const sys = new SystemMessage(
    [
      "You are the ResolvCI Solutions Agent.",
      "Goal: diagnose build failure, propose minimal, safe fixes.",
      "Use tools sparingly and validate anchors (focus on changed files).",
      `Budgets: max ${MAX_TOOL_CALLS} tool calls, ≤ ${Math.round(MAX_TOOL_MS / 1000)}s total tool time.`,
      "Output MUST conform to the SolutionsOutput JSON contract.",
      "If not confident, return diagnosis-only (no suggestions).",
    ].join("\n")
  );

  const contextParts = [
    analysis?.structured && `STRUCTURED: ${JSON.stringify(analysis.structured)}`,
    analysis?.similar_failures?.length && `SIMILAR_FAILS: ${JSON.stringify(analysis.similar_failures.slice(0, 3))}`,
    analysis?.similar_solutions?.length && `SIMILAR_SOLNS: ${JSON.stringify(analysis.similar_solutions.slice(0, 2))}`,
    "LOG_TAIL:\n" + tailLines(input.log_content || analysis?.window || "", 150),
  ].filter(Boolean);

  const user = new HumanMessage(
    [
      `Repo: ${repo_owner}/${repo_name}`,
      `PR: #${pr_number} @ ${commit_sha}`,
      ...contextParts,
      "",
      "Decide whether more context is required (files, slices, or search).",
      "If so, call the appropriate tool(s) up to the budget.",
      "Then produce final JSON (SolutionsOutput).",
    ].join("\n")
  );

  let messages: BaseMessage[] = [sys, user];
  
  const toolInvocations: any[] = [];
  const toolCounts: Record<string, number> = {};
  const toolTimeMs: Record<string, number> = {};

  let toolCalls = 0;
  const started = Date.now();
  
  while (toolCalls < MAX_TOOL_CALLS && Date.now() - started < MAX_TOOL_MS) {
    // Ask the model what to do next
    const ai = await llm.invoke(messages, { configurable: { octo } });
  
    // Always append the AI message BEFORE any ToolMessage
    messages.push(ai);
  
    const calls = (ai as AIMessage).tool_calls ?? [];
    if (!calls.length) {
      // Model produced a final answer (no tools) → exit loop
      break;
    }
  
    // Execute each requested tool
    for (const tc of calls) {
      const args = typeof tc.args === "string" ? safeParseJson(tc.args) : (tc.args ?? {});
      let result: any;
      const t0 = Date.now();
  
      try {
        switch (tc.name) {
          case "list_pr_files":
            result = await listPRFilesTool.invoke(args as any, { configurable: { octo } } as any);
            break;
          case "fetch_slice":
            // inject repo defaults
            result = await fetchSliceTool.invoke(
              { owner: repo_owner, repo: repo_name, ref: commit_sha, ...args } as any,
              { configurable: { octo } } as any
            );
            break;
          case "code_search":
            result = await codeSearchTool.invoke(
              { owner: repo_owner, repo: repo_name, ...args } as any,
              { configurable: { octo } } as any
            );
            break;
          default:
            result = { error: `Unknown tool ${tc.name}` };
        }
      } catch (e: any) {
        result = { error: String(e?.message ?? e) };
      }
  
      const ms = Date.now() - t0;
  
      // record + log
      toolInvocations.push({
        name: tc.name,
        args_json: safePreview(args, 2000),  // keep it small; schema wants a string
        ms,
        ok: !result?.error,
      });
      toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;
      toolTimeMs[tc.name] = (toolTimeMs[tc.name] ?? 0) + ms;
  
      if (DEBUG_SOL) {
        console.log(`[Solutions] tool=${tc.name} ms=${ms} ok=${!result?.error}`);
        console.log(`[Solutions] args: ${safePreview(args)}`);
        console.log(`[Solutions] result: ${safePreview(result)}`);
      }
  
      // IMPORTANT: respond with a ToolMessage that references THIS tool call
      if (!tc.id) {
        if (DEBUG_SOL) console.warn("[Solutions] missing tool_call_id; skipping ToolMessage for:", tc.name);
      } else {
        messages.push(
          new ToolMessage({
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          })
        );
      }
  
      toolCalls++;
      if (toolCalls >= MAX_TOOL_CALLS || Date.now() - started >= MAX_TOOL_MS) break;
    }
  
    // loop continues: the model will see the tool results we just appended
  }
  

  // Force final JSON using the schema
  const finalModel = new ChatOpenAI({
    model: MODEL,
    temperature: 0,
    timeout: 15_000,
    maxRetries: 1,
  }).withStructuredOutput(SolutionsSchema);

  // Give the model explicit policy mapping rules
  const policyHint = new SystemMessage(
    [
      `Confidence policy:`,
      `- >= ${TAU.toFixed(2)} & low risk & valid → inline suggestions allowed`,
      `- 0.60–${(TAU - 0.01).toFixed(2)} or medium risk → comment-only hints`,
      `- < 0.60 or invalid anchors → summary-only`,
    ].join("\n")
  );

  const result = await finalModel.invoke([...messages, policyHint]);

  // Build outbound review artifacts
  const sol = SolutionsSchema.parse(result);
  const confidence = clamp01(sol.summary.confidence ?? 0);
  const lowRisk = sol.summary.risk === "low";
  
  /**
   * Validate each proposed change by fetching a nearby slice and
   * marking isNoop if the proposed content matches the current content (ignoring whitespace).
   */
  const validatedChanges: Change[] = [];
  for (const ch of sol.changes) {
    try {
      const slice = await fetchSliceTool.invoke(
        {
          owner: repo_owner,
          repo: repo_name,
          ref: commit_sha,
          path: ch.path,
          start_line: ch.anchor?.line ? Math.max(1, ch.anchor.line - 5) : 1,
          end_line: ch.anchor?.line ? ch.anchor.line + 5 : null,
        } as any,
        { configurable: { octo } } as any
      );
  
      const current = String((slice as any)?.slice ?? "");
      const proposed = ch.hunk?.after ?? "";
      const noop = isNoopChange(current, proposed);
  
      // ← derive type here; don't read ch.type
      const typ: "fix" | "diagnosis" =
        !noop && ch.validation?.appliesCleanly ? "fix" : "diagnosis";
  
      validatedChanges.push({
        ...ch,
        validation: { ...ch.validation, isNoop: noop },
        type: typ,
      });
    } catch {
      validatedChanges.push({
        ...ch,
        validation: { ...ch.validation, isNoop: true },
        type: "diagnosis",
      });
    }
  }
  
  
  // For policy: “real fixes” are clean & non-noop
  const realFixes = validatedChanges.filter(c => !c.validation.isNoop && c.validation.appliesCleanly);
  
  const autoSuggestionEligible = confidence >= TAU && lowRisk && realFixes.length > 0;
  const policy =
    sol.policy?.autoSuggestionEligible !== undefined
      ? sol.policy
      : {
          autoSuggestionEligible,
          reason: autoSuggestionEligible
            ? "High confidence & low risk with clean patches."
            : "Either confidence below threshold, medium/high risk, or only diagnostics present.",
        };
  

  // Top review body (add a small legend for clarity)
  const summaryMarkdown = [
    `**ResolvCI** — ${sol.summary.one_liner}`,
    ``,
    `**Rationale:** ${sol.summary.rationale}`,
    `**Confidence:** ${(confidence * 100).toFixed(0)}% • **Risk:** ${sol.summary.risk}`,
    ``,
    `**Legend:** 🔎 diagnostic anchor (source of error) • 💡 inline code suggestion`,
  ].join("\n");

  // Inline comments: diagnostics (no-op) vs suggestions (real fixes)
  const reviewComments = validatedChanges.map((chg) => {
    const line = chg.anchor?.line ?? 1;

    // Diagnostic anchor: no code change, show the helpful snippet
    if (chg.validation?.isNoop || chg.type === "diagnosis") {
      const body = [
        `🔎 **Source of error** — This is a diagnostic anchor (no code change).`,
        ``,
        chg.language
          ? `\`\`\`${chg.language}\n${chg.hunk.after}\n\`\`\``
          : `\`\`\`\n${chg.hunk.after}\n\`\`\``,
      ].join("\n");
      return { path: chg.path, line, body };
    }

    // Real fix: suggestion block only when eligible; otherwise comment-only hint
    if (policy.autoSuggestionEligible && chg.validation?.appliesCleanly) {
      const body = ["💡 **Suggested fix**", "", "```suggestion", chg.hunk.after, "```"].join("\n");
      return { path: chg.path, line, body };
    } else {
      const body = [
        "💡 **Suggested fix (comment-only; please review)**",
        "",
        chg.language ? `\`\`\`${chg.language}\n${chg.hunk.after}\n\`\`\`` : `\`\`\`\n${chg.hunk.after}\n\`\`\``,
      ].join("\n");
      return { path: chg.path, line, body };
    }
  });

  const final: SolutionsReturn = {
    summary: {
      one_liner: sol.summary.one_liner,
      rationale: sol.summary.rationale,
      risk: sol.summary.risk,
      confidence,
      references: sol.summary.references,
    },
    changes: validatedChanges,   // ← use validated+typed changes
    tool_invocations: [
      ...sol.tool_invocations,
      ...toolInvocations,        // already in {name,args_json,ms,ok} shape after Patch 2
    ],
    policy,
    reviewComments,
    summaryMarkdown,
  };
  

    /* 🔎 summary logs */
  if (DEBUG_SOL) {
    console.log("[Solutions] ---- tool usage summary ----");
    const names = Object.keys(toolCounts);
    if (names.length) {
      console.table(
        names.map((n) => ({
          tool: n,
          calls: toolCounts[n],
          total_ms: toolTimeMs[n] ?? 0,
          avg_ms: Math.round((toolTimeMs[n] ?? 0) / toolCounts[n]),
        }))
      );
    } else {
      console.log("(no tools were called)");
    }
    console.log("[Solutions] tool_invocations:", safePreview(final.tool_invocations));
    console.log("[Solutions] final SolutionsReturn:", safePreview(final, 4000)); // print the whole object (truncated)
  }

  return final;
}

/* ============================== Utilities ============================== */

function safeParseJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function safePreview(v: any, max = 2000) {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  catch { s = String(v); }
  if (s.length > max) return s.slice(0, max) + `… (truncated, ${s.length - max} more chars)`;
  return s;
}
