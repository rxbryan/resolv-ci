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
import {ToolInvocation} from "@/types/fix_recommendation_list"
import { AnalysisOutput } from "./analysis";

/* ============================== Config ============================== */

const MODEL = process.env.LLM_MODEL_CHAT || "gpt-4o-mini";
const MAX_TOOL_CALLS = Number(process.env.SOL_MAX_TOOL_CALLS ?? "6");
const MAX_TOOL_MS = Number(process.env.SOL_MAX_TOOL_MS ?? "10000"); // ~5s cap
const TAU = Number(process.env.SOLUTIONS_CONFIDENCE_TAU ?? "0.80");
// Per-tool budgets (caps each tool individually)
const MAX_PER_TOOL_CALLS = Number(process.env.SOL_MAX_PER_TOOL_CALLS ?? "3");
const MAX_PER_TOOL_MS    = Number(process.env.SOL_MAX_PER_TOOL_MS ?? "5000");

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
    references: string[];                 // required with default []
  };
  changes: Change[];                   // ← uses the nullable fields
  tool_invocations: ToolInvocation[];             // required with default []
  policy: { autoSuggestionEligible: boolean; reason: string };
};

export type SolutionsReturn = SolutionsOutput & {
  reviewComments: Array<{ path: string; line: number; body: string }>;
  summaryMarkdown: string;
};
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

const MatchSchema = z.object({
  kind: z.enum(["exact", "regex", "nearest_changed_hunk"]).default("nearest_changed_hunk"),
  original: z.string().optional().default(""),  // for kind="exact"
  pattern: z.string().optional().default(""),   // for kind="regex"
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
  match: MatchSchema.nullable().default(null),  
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

/* ============================ Tool helpers ============================ */

async function getOcto(owner: string, repo: string, installationId?: number | null): Promise<Octokit> {
  if (installationId != null) {
    return await getOctokitForInstallation(installationId);
  }
  return await getOctokitForRepo(owner, repo);
}

function stripFence(s: string): string {
  let out = s ?? "";
  out = out.replace(/^```(?:suggestion|[a-z0-9_-]+)?\s*\n/i, "");
  out = out.replace(/\n```$/i, "");
  return out;
}

function normalizeBlock(s: string) {
  return (s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

async function getFileContent(octo: Octokit, owner: string, repo: string, ref: string, path: string): Promise<string> {
  const res = await octo.rest.repos.getContent({ owner, repo, path, ref });
  if (!("content" in res.data)) return "";
  return Buffer.from((res.data as any).content, "base64").toString("utf8");
}

function firstChangedHunkStart(patch: string | null): number | null {
  if (!patch) return null;
  const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(patch);
  if (!m) return null;
  const start = Number(m[1] || 1);
  return Math.max(1, start);
}

function toLF(s: string) {
  return (s ?? "").replace(/\r\n/g, "\n");
}

/** 
 * If we have an approximate start, search a small window around it
 * for an exact/fuzzy occurrence of `original`. Returns a 1-based line if found.
 */
function nudgeAnchor(full: string, original: string, start: number, radius = 8): number | null {
  const hay = toLF(full).split("\n");
  if (start < 1) start = 1;
  const lo = Math.max(1, start - radius);
  const hi = Math.min(hay.length, start + radius);

  // Search the window using the same fuzzy logic
  const windowText = hay.slice(lo - 1, hi).join("\n");
  const hit = findLineFuzzy(windowText, original);
  return hit ? lo + hit - 1 : null;
}

function findLineFuzzy(content: string, needle: string): number | null {
  if (!needle) return null;

  const toLF = (s: string) => s.replace(/\r\n/g, "\n");

  // Pass 1: exact match but tolerant to trailing whitespace per line
  const hay1 = toLF(content);
  const pin1 = toLF(needle).replace(/[ \t]+$/gm, ""); // strip trailing ws per line
  const idx = hay1.indexOf(pin1);
  if (idx >= 0) return hay1.slice(0, idx).split("\n").length; // 1-based

  // Pass 2: whitespace-collapsed windowed search (single or multi-line)
  const collapseWS = (s: string) => s.replace(/[ \t]+/g, " ").trim();
  const hayLines = hay1.split("\n");
  const pinLines = toLF(needle).split("\n");

  // Single-line
  if (pinLines.length === 1) {
    const target = collapseWS(pinLines[0]);
    for (let i = 0; i < hayLines.length; i++) {
      if (collapseWS(hayLines[i]) === target) return i + 1;
    }
    return null;
  }

  // Multi-line window
  const n = pinLines.length;
  const target = pinLines.map(collapseWS).join("\n");
  for (let i = 0; i + n <= hayLines.length; i++) {
    const windowNorm = hayLines.slice(i, i + n).map(collapseWS).join("\n");
    if (windowNorm === target) return i + 1;
  }
  return null;
}


function findLineByRegex(content: string, pattern: string): number | null {
  if (!pattern) return null;
  try {
    const re = new RegExp(pattern, "m");
    const m = re.exec(content);
    if (!m) return null;
    return content.slice(0, m.index).split("\n").length;
  } catch {
    return null;
  }
}



// list_pr_files: enumerate changed files (+ unified diff patches)
const listPRFilesTool = tool(
  async (
    input: z.infer<typeof ListPRFilesSchema>,
    config
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    schema: ListPRFilesSchema,
  }
);

// fetch_slice: retrieve a file (or targeted range) at PR HEAD SHA
const fetchSliceTool = tool(
  async (
    input: z.infer<typeof FetchSliceSchema>,
    config
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octo: Octokit = (config?.configurable as any)?.octo;
    const { owner, repo, ref, path, start_line, end_line } = input;
    const res = await octo.rest.repos.getContent({ owner, repo, path, ref });
    if (!("content" in res.data)) {
      return { path, slice: "", note: "Not a file content response." };
    }
    const content = Buffer.from((res.data as {content: string}).content, "base64").toString("utf8");
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
    schema: FetchSliceSchema,
  }
);

// code_search: locate symbols/configs quickly (use slices to validate)
const codeSearchTool = tool(
  async (
    input: z.infer<typeof CodeSearchSchema>,
    config
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const octo: Octokit = (config?.configurable as any)?.octo;
    const { owner, repo } = input;
    const q = `${input.q} repo:${owner}/${repo}`;
    const { data } = await octo.rest.search.code({ q, per_page: Math.min(input.max ?? 10, 50) });
    return (data.items || []).map((it: {
      name: string;
      path: string;
      sha: string;
      url: string;
      git_url: string;
      html_url: string;
      score: number;
    }) => ({
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
    schema: CodeSearchSchema,
  }
);

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
  analysis?: AnalysisOutput
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
      "Only modify files that are part of this PR.",
      `Provide a 'match' hint for anchoring: 
      { kind:"exact", original:"<old lines>"} or { kind:"regex", pattern:"<js regex>"}.
      If uncertain, use { kind:"nearest_changed_hunk" } to target the first changed hunk.`,
      `In "hunk.after", include ONLY the exact replacement lines (no context). 
        The number of lines must equal the intended replacement span.`,
      "If your change wouldn’t alter the code after normalization, return a diagnostic instead of a fix.",
      "Anchor precisely: include 1–2 original lines in `match.original` that appear verbatim in the file near the change.",
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

  const messages: BaseMessage[] = [sys, user];
  
  const toolInvocations: ToolInvocation[] = [];
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
    if (!calls.length) break;

    // Execute each requested tool — ALWAYS reply with a ToolMessage
    for (const tc of calls) {
      const args = typeof tc.args === "string" ? safeParseJson(tc.args) : (tc.args ?? {});
      const callsForTool = toolCounts[tc.name] ?? 0;
      const timeForTool  = toolTimeMs[tc.name] ?? 0;

      let result: unknown;
      let ms = 0;
      let executed = false;

      // Check both global & per-tool budgets
      const globalOver = toolCalls >= MAX_TOOL_CALLS || (Date.now() - started) >= MAX_TOOL_MS;
      const perToolOver = callsForTool >= MAX_PER_TOOL_CALLS || timeForTool >= MAX_PER_TOOL_MS;

      if (globalOver || perToolOver) {
        // Synthesize a “budget exhausted” result but STILL reply with ToolMessage
        result = {
          error: "budget_exhausted",
          used: {
            global_calls: toolCalls,
            global_ms: Date.now() - started,
            tool_calls: callsForTool,
            tool_ms: timeForTool,
          },
          limits: {
            global_calls: MAX_TOOL_CALLS,
            global_ms: MAX_TOOL_MS,
            tool_calls: MAX_PER_TOOL_CALLS,
            tool_ms: MAX_PER_TOOL_MS,
          },
        };
      } else {
        const t0 = Date.now();
        try {
          switch (tc.name) {
            case "list_pr_files":
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = await listPRFilesTool.invoke(args as any, { configurable: { octo } } as any);
              break;
            case "fetch_slice":
              // inject repo defaults
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = await fetchSliceTool.invoke(
                { owner: repo_owner, repo: repo_name, ref: commit_sha, ...args } as any,
                { configurable: { octo } } as any
              );
              break;
            case "code_search":
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = await codeSearchTool.invoke(
                { owner: repo_owner, repo: repo_name, ...args } as any,
                { configurable: { octo } } as any
              );
              break;
            default:
              result = { error: `Unknown tool ${tc.name}` };
          }
          ms = Date.now() - t0;
          executed = true;
        } catch (e) {
          ms = Date.now() - t0;
          result = { error: String((e as Error)?.message ?? e) };
        }
      }

      // Record usage
      toolInvocations.push({
        name: tc.name,
        args_json: safePreview(args, 2000),
        ms,
        ok: !(result as any)?.error,
      });
      toolCounts[tc.name] = (toolCounts[tc.name] ?? 0) + 1;   // count even if budget_exhausted
      toolTimeMs[tc.name]  = (toolTimeMs[tc.name] ?? 0) + ms;
      toolCalls++;

      if (DEBUG_SOL) {
        console.log(`[Solutions] tool=${tc.name} ms=${ms} ok=${!(result as any)?.error}`);
      }

      // ALWAYS reply to the tool call (satisfy the API invariant)
      if (tc.id) {
        messages.push(
          new ToolMessage({
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          })
        );
      } else if (DEBUG_SOL) {
        console.warn("[Solutions] tool_call had no id; replied skipped but id was missing:", tc.name);
      }
    }
    // end-for (we answered ALL tool_calls for this assistant message)

    // Now it is safe to continue the while loop; the next model turn will see our ToolMessages
    // loop continues: the model will see the tool results we just appended

    /* eslint-enable @typescript-eslint/no-explicit-any */
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
  
  // Safety net: ensure no assistant tool_calls remain unanswered
  const last = messages[messages.length - 1];
  if (last instanceof AIMessage) {
    const toolCalls = last.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (tc?.id) {
          messages.push(
            new ToolMessage({
              tool_call_id: tc.id,
              content: JSON.stringify({ error: "unanswered_tool_call_safety_net" }),
            })
          );
        }
      }
    }
  }



  const result = await finalModel.invoke([...messages, policyHint]);
  console.log(`final model out: ${result}`)

  // Build outbound review artifacts
  const sol = SolutionsSchema.parse(result);
  const confidence = clamp01(sol.summary.confidence ?? 0);
  const lowRisk = sol.summary.risk === "low";
  
  const prFiles = await octo.rest.pulls.listFiles({ owner: repo_owner, repo: repo_name, pull_number: pr_number, per_page: 300 });
  const filesByPath = new Map(prFiles.data.map(f => [f.filename, { patch: f.patch ?? null }]));

  const validatedChanges: Change[] = [];
  for (const ch of sol.changes) {
    // File must belong to PR; else turn into diagnostic
    const meta = filesByPath.get(ch.path);
    if (!meta) {
      validatedChanges.push({ ...ch, validation: { ...ch.validation, isNoop: true }, type: "diagnosis" });
      continue;
    }
  
    // Get file content once
    const full = await getFileContent(octo, repo_owner, repo_name, commit_sha, ch.path);
  
    // Resolve anchor line (always try match hints; treat line=1 as “needs refinement”)
    let line = ch.anchor?.line ?? null;
    const match = ch.match;

    if (match?.kind === "exact" && match.original) {
      // Prefer a true content hit
      const found = findLineFuzzy(full, match.original);
      if (found) {
        line = found;
      } else if (line != null) {
        // If model gave a guess (often 1), try nudging nearby
        const nudged = nudgeAnchor(full, match.original, line, 12);
        if (nudged) line = nudged;
      }
      // If still no luck, fall back to first changed hunk
      if (!line || line < 1) line = firstChangedHunkStart(meta.patch);
    } else if (match?.kind === "regex" && match.pattern) {
      const found = findLineByRegex(full, match.pattern);
      if (found) line = found;
      if (!line || line < 1) line = firstChangedHunkStart(meta.patch);
    } else {
      // No hint at all → use changed hunk; if model gave 1, still prefer a real hunk start
      if (!line || line <= 1) line = firstChangedHunkStart(meta.patch);
    }

    if (DEBUG_SOL) {
      console.log(`[anchor] path=${ch.path} rawLine=${ch.anchor?.line ?? null} resolved=${line} matchKind=${match?.kind} hasOriginal=${!!match?.original}`);
    }
    

    // Final snap: if proposed is single-line, and an identical current line exists within ±2 lines, snap to it.
    if (line && ch.hunk?.after && !ch.hunk.after.includes("\n")) {
      const lines = toLF(full).split("\n");
      const target = normalizeBlock(ch.hunk.after);
      const l0 = Math.max(1, line - 2);
      const l1 = Math.min(lines.length, line + 2);
      for (let i = l0; i <= l1; i++) {
        if (normalizeBlock(lines[i - 1]) === target) {
          line = i;
          break;
        }
      }
    }

    if (!line || line < 1) {
      // Anchor unresolved → diagnostic, but not a "no-op".
      validatedChanges.push({ ...ch, validation: { ...ch.validation, isNoop: false }, type: "diagnosis" });
      continue;
    }

    
  
    // Compute exact window size = proposed lines
    const proposedRaw = String(ch.hunk?.after ?? "");
    const proposed = stripFence(proposedRaw);
    const nLines = Math.max(1, proposed.split("\n").length);
    const start = line;
    const end = start + nLines - 1;
  
    // Extract current lines
    const lines = full.split("\n");
    const current = lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
    const noop = normalizeBlock(current) === normalizeBlock(proposed);
  
    // derive type (fix only if not noop and appliesCleanly)
    const applies = !!ch.validation?.appliesCleanly;
    const typ: "fix" | "diagnosis" = !noop && applies ? "fix" : "diagnosis";
  
    validatedChanges.push({
      ...ch,
      anchor: { line: start },
      hunk: { after: proposed },
      validation: { ...ch.validation, isNoop: noop },
      type: typ,
    });
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

function safePreview(v: unknown, max = 2000) {
  let s: string;
  try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  catch { s = String(v); }
  if (s.length > max) return s.slice(0, max) + `… (truncated, ${s.length - max} more chars)`;
  return s;
}
