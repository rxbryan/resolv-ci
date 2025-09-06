# ResolvCI
ResolvCI automatically analyzes build failures of your github action workflow, ingests build failures, analyzes logs, gathers missing context from your repo, and proposes **review-only** fixes directly in the PR.  
Built with **TypeScript + Next.js + TiDB Serverless + LangGraph**.

## ✨ What it does

- **GitHub App as Ingestion Agent (ambient)**  
  Listens to `check_run` events, verifies signatures, deduplicates deliveries, fetches logs, and upserts failure records in TiDB.

- **Analysis Agent (grounded retrieval)**  
  LLM **structures** the failure window (error class, file hints, keywords), then runs **hybrid retrieval** (BM25 + vector) in TiDB to pull similar failures and known fixes.

- **Solutions Agent (autonomous, read-only tools)**  
  Reasons over logs + history, **fetches repo files/slices** when confidence is low, synthesizes **minimal** patches, validates them, and outputs a strict JSON contract (summary + changes).

- **Actuator Agent (Reviewer)**  
  Converts patches into **PR Review Suggestions** (GitHub ```suggestion``` blocks) plus a concise **summary** in the review body. Uses an **outbox** for exactly-once posting.

- **PR Conversation Awareness**  
  Reads PR review threads, respects feedback/mentions, can reply in-thread and refine suggestions (still **PR-only**).

- **Dashboard**  
  Shows failures, loop iterations, tool calls, suggestions, and MTTR trends.

---

## 🧠 How ResolvCI thinks

### Non-linear “Insight Loop”
ResolvCI isn’t a one-way pipeline. It loops until it’s confident:

```mermaid
flowchart TD
  GI["GitHub App Ingestion Agent<br/>(Serverless Webhook)"]
  A["Analysis Agent<br/>(LLM structuring + Hybrid Search)"]
  S["Solutions Agent<br/>(LLM Reasoning + Tools)"]
  D{"Decide:<br/>Confidence >= tau"}
  F[["Repo Tools:<br/>list_pr_files / fetch_slice / code_search"]]
  AC["Actuator Agent<br/>(PR Review Suggestions)"]
  MR[(Manual Review)]
  DLQ[(Dead Letter Queue)]
  DONE((Done))

  GI --> A
  A --> S
  S --> D
  D -- "Need More Context" --> F
  F --> A
  D -- "Ready to Act" --> AC
  D -- "Give Up / Budget" --> MR

  AC -->|success| DONE
  AC -->|retryable error| AC
  AC -->|anchor invalid| MR

  GI -. failure .-> DLQ
  A -. failure .-> DLQ
  S -. failure .-> DLQ
  F -. forbidden/oversize .-> MR

````

**Guardrails**

* **τ (tau) confidence threshold:** default **0.80**
* **Budgets:** **≤ 3** tool calls, **≤ 5s** total tool time, **≤ 3** loop iterations
* **Safety:** Solutions Agent never writes; only Actuator posts **reviews** (no commits)

---

## 🧰 Solutions Agent tools

* **`list_pr_files`** – enumerate changed files **plus unified diff patches** (hunk ranges) to anchor suggestions where the developer changed code.
* **`fetch_file` / `fetch_slice`** – fetch a file (or targeted line range) at the PR **head SHA**; keep payloads small.
* **`code_search`** – locate symbols or config keys quickly; still fetch slices to **validate**.

**Validation:** Patches are **dry-run applied** to fetched content; **YAML/JSON are parsed** to prevent broken suggestions. Invalid hunks **degrade to comment-only** guidance.

**Output contract (simplified):**

```ts
interface SolutionsOutput {
  summary: {
    one_liner: string;
    rationale: string;
    risk: "low" | "medium" | "high";
    confidence: number;
    references?: any[];
  };
  changes: Array<{
    path: string;
    anchor?: { line: number };
    hunk: { after: string };
    language?: string;
    validation: { appliesCleanly: boolean };
  }>;
  tool_invocations?: any[];
  policy: { autoSuggestionEligible: boolean; reason: string };
}
```

---

## 📝 Actuator Agent (Reviewer)

**Posts one PR review** with:

* **Top note (review body):** brief error summary + rationale + **permalinked code links** to PR head, e.g.
  `https://github.com/<owner>/<repo>/blob/<HEAD_SHA>/<path>#L<start>-L<end>`
* **Inline comments:** each contains a rationale and a `suggestion` block with the **minimal fix**.

**Confidence policy**

* **≥ 0.80** & **low risk** (lint/yaml/json) & **valid patch** → **inline suggestions**
* **0.60–0.79** or **medium risk** → **summary + comment-only** hints
* **< 0.60** or **invalid anchors** → **summary-only** + (optionally) a clarifying question

**Exactly-once outbox**

* All reviews are **staged** in `outbound_actions` with a deterministic **`action_hash`** (payload + head SHA)
* A **dispatcher** posts once; anchor failures degrade to **summary-only** or fewer suggestions

---

## ⚙️ Tech stack

* **Language:** TypeScript
* **Framework:** Next.js (API routes for webhook + React dashboard)
* **DB:** TiDB Serverless (HTAP + vector search)
* **ORM:** Sequelize + mysql2
* **Orchestration:** LangGraph (TypeScript)
* **LLM:** OpenAI-compatible API (configurable)
* **GitHub:** GitHub App (Octokit)

---

## 📂 Project structure

```
app/
  api/github-webhook/route.ts   # Serverless webhook (verify, dedupe, ingest)
agents/
  analysis.ts                    # LLM structuring + hybrid retrieval
  solutions.ts                   # Reasoning + tools + validation
  actuator.ts                    # PR reviewer (suggestions + summary)
components/
  Dashboard.tsx                  # Failure list, loops, suggestions, MTTR
lib/
  tidb.ts                        # Sequelize models, outbox, artifacts
```

---

## 🔐 Permissions & security

* **GitHub App scopes:** Pull requests: Read/Write (reviews), Contents: Read, Checks: Read
* **Webhook verification:** `X-Hub-Signature-256` HMAC before any DB writes
* **No secrets in tools:** block `.env*`, keys, and oversized files
* **Review-only:** No commits; humans apply suggestions

---

## 🚀 Getting started

### Prerequisites

* Node.js 20+
* TiDB Cloud cluster (Serverless)
* GitHub App (App ID, private key, webhook secret)

### Env vars

```bash
# TiDB
TIDB_HOST=<host>         TIDB_PORT=4000
TIDB_USER=<user>         TIDB_PASSWORD=<pass>
TIDB_DATABASE=agentic_ci

# GitHub App
GITHUB_APP_ID=<id>
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=<secret>

# LLM
LLM_API_KEY=<key>
```

### Install & run

```bash
npm install
npm run dev
```

Expose your local webhook via **ngrok** or deploy to **Vercel**.


## 📊 Observability

* `agent_runs` — per-node status, loop iteration, last\_error
* `fetched_artifacts` — cached files/slices with blob SHAs
* `tool_invocations` — each tool call with inputs/outputs
* `outbound_actions` — staged reviews/comments with dispatch receipts


## ❓ FAQ

**Why no auto-commits?**
To keep trust high and workflows safe. ResolvCI proposes tiny, validated changes as review suggestions; humans choose to apply.

**Why hybrid retrieval (not LLM-only)?**
LLM structures the log; TiDB retrieval **grounds** the diagnosis in prior reality (deterministic, auditable).

**What if anchors fail?**
We degrade to summary-only or fewer suggestions and re-anchor on the new head SHA.


## 📜 License

MIT.


## 🙌 Thanks

PingCAP / TiDB • LangGraph • Next.js • Octokit
