import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

import { analyzeFailure, AnalysisOutput } from "@/agents/analysis";
import { solveFailure, type SolutionsOutput } from "@/agents/solutions";
import { stageReviewOutboxFromSolution } from "@/agents/actuator";
import { recordSolutionArtifacts } from "@/agents/knowledge";

const TAU = Number(process.env.SOLUTIONS_CONFIDENCE_TAU ?? "0.80");
const MAX_LOOPS = Number(process.env.SOLUTIONS_MAX_LOOPS ?? "3");

export type GraphInit = {
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  head_sha: string;
  log_content: string;
  failure_id?: number;
  installation_id?: number | null;
  insight_loops: number;
  messages: BaseMessage[];
  // optional channels:
  analysis?: AnalysisOutput;
  solution?: SolutionsOutput;
  confidence?: number;
};

/**
 * Graph channels (state schema).
 * Note: we keep this minimal and skip reducers/defaults to avoid
 * version-specific typing differences. Nodes return complete updates.
 */
const GraphState = Annotation.Root({
  // Required inputs
  repo_owner: Annotation<string>(),
  repo_name: Annotation<string>(),
  pr_number: Annotation<number>(),
  head_sha: Annotation<string>(),
  log_content: Annotation<string>(),

  // Optional / derived along the run
  failure_id: Annotation<number | undefined>(),
  installation_id: Annotation<number | null | undefined>(),

  messages: Annotation<BaseMessage[]>(),
  analysis: Annotation<AnalysisOutput>(),
  solution: Annotation<SolutionsOutput>(),
  confidence: Annotation<number | undefined>(),
  insight_loops: Annotation<number>(),
});

// 👉 derive the TS state type from the annotation
export type GState = typeof GraphState.State;

/** Build the graph with chaining so TS learns node names for addEdge(). */
const builder = new StateGraph(GraphState)
  // Pass-through start (could do some post processing here)
  .addNode("ingestion", async () => ({}))

  // Analysis: LLM structuring + similar failures + TiDB vector prior fixes
  .addNode("diagnose", async (s) => {
    const out = await analyzeFailure({
      repo_owner: s.repo_owner,
      repo_name: s.repo_name,
      pr_number: s.pr_number,
      commit_sha: s.head_sha,
      log_content: s.log_content,
      messages: s.messages,
    });

    console.log(`[Graph:diagnose]: completes with: ${out}, ${out.messages}`)
    // We return both the analysis object and the updated messages trail
    return {
      analysis: out,
      messages: out.messages,
    };
  })
  // Solutions: tool-enabled reasoning (list_pr_files, fetch_slice, code_search)
  // Produces minimal diffs + summary + confidence; increments loop counter.
  .addNode("solutions", async (s) => {
    const res = await solveFailure(
      {
        repo_owner: s.repo_owner,
        repo_name: s.repo_name,
        pr_number: s.pr_number,
        commit_sha: s.head_sha,              // head_sha/commit_sha
        log_content: s.log_content,          // log_tail; pass the actual log content
        installation_id: s.installation_id ?? null,
      },
      // pass the prior analysis block (shape matches Solutions’ expectations)
      s.analysis
    );

    return {
      ...s,
      solution: res,                         // whole SolutionsReturn
      confidence: res.summary?.confidence ?? 0.6,
      insight_loops: (s.insight_loops ?? 0) + 1,
      // messages unchanged; SolutionsReturn doesn’t include messages
    };
  })

// Actuator: stage a PR review via outbox (exactly-once). No direct writes here.
  .addNode("actuator", async (s) => {
    await stageReviewOutboxFromSolution({
      owner: s.repo_owner,
      repo: s.repo_name,
      pull_number: s.pr_number,
      head_sha: s.head_sha,
      solution: s.solution,                 // this is SolutionsReturn
      installation_id: s.installation_id ?? null,
    });
    return {};
  })
  // Knowledge: persist the solution in TiDB; auto-embedding handles vectors.
  .addNode("knowledge", async (s) => {
    await recordSolutionArtifacts({
      failure_id: s.failure_id!,
      repo_owner: s.repo_owner,
      repo_name: s.repo_name,
      pr_number: s.pr_number,
      head_sha: s.head_sha,
      solution: s.solution, // SolutionsReturn
    });
    return {};
  })
  // Edges
  .addEdge(START, "ingestion")
  .addEdge("ingestion", "diagnose")

  .addEdge("diagnose", "solutions")
  .addConditionalEdges(
    "solutions",
    (s) => {
      if ((s.confidence ?? 0) >= TAU) return "actuator";
      if ((s.insight_loops ?? 0) >= MAX_LOOPS) return "actuator";
      return "diagnose";
    },
    { diagnose: "diagnose", actuator: "actuator" }
  )
  .addEdge("actuator", "knowledge")
  .addEdge("knowledge", END);

// Compiled app
export const ResolvGraphApp = builder.compile();
