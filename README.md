# ResolvCI

ResolvCI automatically analyzes failed GitHub Actions runs for your pull requests, ingests failure logs, searches your repo/history for context, and proposes **review-only** fixes directly on the PR.
Built with **TypeScript · Next.js · TiDB Serverless (HTAP + Vectors) · LangGraph**.

---

## ✨ What it does

* **GitHub App (Ingestion Agent)**
  Verifies HMAC, dedupes deliveries, pulls workflow logs, computes stable **error signatures** and a normalized tail, and upserts a row in TiDB.

* **Analysis Agent (grounded retrieval)**
  Uses an LLM to **structure** the failure (error class, hints, keywords), then runs **hybrid retrieval** in TiDB:

  * **Exact**: persisted signatures `error_signature_v1/v2`
  * **Semantic**: auto-embedded vectors on `norm_tail_vec` and past **fix\_recommendations** (Amazon Titan v2 via TiDB Cloud)

* **Solutions Agent (autonomous + tools, read-only)**
  Reasons over logs/history and uses repo tools to get missing context:

  * `list_pr_files` · `fetch_slice` · `code_search`
    Validates / dry-runs patches, classifies outputs, and returns a strict JSON contract (summary, changes, policy).

* **Actuator Agent (Reviewer, exactly-once)**
  Converts results into a single **PR Review**:

  * **💡 Suggested fix**: inline `suggestion` blocks (only for valid, low-risk patches)
  * **🔎 Source of error**: **diagnostic anchors** (no code change) with snippet + permalink
    Uses an **outbox** table for exactly-once delivery and retries.

* **Non-linear loops (Insight Loop)**
  Solutions may request more context (fetch slices, search symbols), loop back to Analysis, and continue until **τ** (confidence) or budget limits are met.

---

## 🧠 How ResolvCI thinks

```mermaid
flowchart TD
  GI[GitHub App webhook]
  AN[Analysis - LLM + TiDB]
  SO[Solutions - LLM + tools]
  DEC{"Ready?\nconfidence >= tau\nor loops >= N"}
  AC[Actuator - PR review]
  MR[Manual review]
  DLQ[Dead Letter Queue]
  DONE((Done))

  GI --> AN
  AN --> SO
  SO --> DEC
  DEC -- "No -> need more context" --> AN
  DEC -- "Yes -> post review" --> AC

  AC --> DONE
  AC -->|retryable error| AC
  AC -->|anchor invalid| MR

  GI -.-> DLQ
  AN -.-> DLQ
  SO -.-> DLQ
```

**Guardrails**

* **τ (tau):** default **0.80** confidence
* **Budgets:** ≤ **3** tool calls · ≤ **5s** total tool time · ≤ **3** loop iterations
* **Safety:** Solutions never write; **Actuator** posts reviews via an **outbox** (exactly-once)

---

## 🧰 Solutions Agent tools

* **`list_pr_files`** – enumerate changed files **with unified diff hunks** to anchor suggestions exactly where the developer edited code.
* **`fetch_slice` / `fetch_file`** – fetch a precise range at the PR **head SHA**; keep payloads small.
* **`code_search`** – locate symbols/config keys quickly; always fetch slices to validate before proposing edits.

**Validation & Classification**

* Patches are **dry-run applied** to fetched content; **YAML/JSON parsed** to prevent broken suggestions.
* If a proposed change equals the current content (ignoring whitespace), it’s labeled **🔎 diagnostic** (no `suggestion` block).
* Invalid anchors or risky edits degrade to “summary-only” or comment-only hints.

**Output contract (simplified)**

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
    validation: { appliesCleanly: boolean; isNoop?: boolean };
    type?: "fix" | "diagnosis";
  }>;
  tool_invocations?: any[];
  policy: { autoSuggestionEligible: boolean; reason: string };
}
```

---

## 📝 Actuator Agent (Reviewer)

Posts **one PR review** containing:

* **Top note (review body):** brief error summary + rationale + a **legend**
  *Legend: **🔎 diagnostic anchor** (source of error) • **💡 inline code suggestion***
* **Inline items:**

  * **💡 Suggested fix:** a minimal `suggestion` block (only if low risk, valid patch, confidence ≥ τ)
  * **🔎 Source of error:** a labeled diagnostic comment with a snippet and a **permalink**
    `https://github.com/<owner>/<repo>/blob/<HEAD_SHA>/<path>#L<line>`

**Exactly-once outbox**

* All reviews are **staged** in `outbound_actions` with deterministic `action_hash` (payload + head SHA).
* `/api/dispatch-outbox` posts staged actions; failures degrade to summary-only or fewer suggestions.

---

## ⚙️ Architecture

**API routes (Next.js serverless):**

* `POST /api/github-webhook` — verify, dedupe, ingest, download logs (zip), unzip (`yauzl`), compute **signatures** and **norm\_tail**, upsert **build\_failures**, then **fire-and-forget** `/api/graph-run`.
* `POST /api/graph-run` — claim oldest `status="new"` build failures, backfill logs/tails if needed, run LangGraph loop, **stage** PR review in outbox, then trigger `/api/dispatch-outbox`.
* `POST /api/dispatch-outbox` — batch-dispatch staged reviews to GitHub (exactly-once), update statuses.


---

## 🗄️ TiDB schema (key tables)

* **`build_failures`**
  `installation_id`, `run_id?`, `repo_owner`, `repo_name`, `pr_number?`, `commit_sha`, `log_content?`,
  **`error_signature_v1`** (sha1 of normalized tail), **`error_signature_v2`** (sha1 of templated normalized tail),
  **`norm_tail`**, **`norm_tail_vec`** = `EMBED_TEXT('tidbcloud_free/amazon/titan-embed-text-v2', norm_tail)`,
  vector index created with `ADD_COLUMNAR_REPLICA_ON_DEMAND`.

* **`fix_recommendations`** 
  JSON blobs + **`summary_one_liner`**, **`rationale`**, generated **`content`** (summary + top hunks),
  **`content_vector`** = `EMBED_TEXT('...titan-embed-text-v2', content)`, vector index with `ADD_COLUMNAR_REPLICA_ON_DEMAND`.
  Idempotent on `(failure_id, head_sha)`.

* **`outbound_actions`** (outbox)
  `action_hash` (unique), `payload_json`, `status` (`staged`|`dispatched`|`error`), `attempt_count`, `dispatched_at`, `last_error`, indices on `(status,id)`.

---

## 🔐 Permissions & security

* **GitHub App scopes:** Pull requests (Read/Write – reviews), Contents (Read), Checks (Read)
* **Webhook verification:** `X-Hub-Signature-256` HMAC before any DB writes
* **No secrets in tools:** block `.env*`, keys, and oversized files
* **Review-only:** No commits; humans apply suggestions

---

## 📦 Project structure

```
app/
  api/github-webhook/route.ts   # verify, dedupe, ingest, download logs, upsert failure, trigger graph-run
  api/graph-run/route.ts        # claim + run LangGraph; stage review; trigger dispatch
  api/dispatch-outbox/route.ts  # post staged reviews to GitHub (exactly-once)
agents/
  analysis.ts                    # LLM structuring + exact/vector neighbors + prior fixes
  solutions.ts                   # Reasoning + tools (list_pr_files/fetch_slice/code_search) + validation
  actuator.ts                    # Stage PR review (summary + inline items) into outbox
  knowledge.ts                   # Persist recommendations (summary_one_liner + rationale for better vectors)
  graph.ts                       # LangGraph state machine with confidence/budget loop
lib/
  tidb.ts                        # Sequelize models, helpers (normalize/templateize), DB utils
  github.ts                      # Octokit helpers (installation-aware)
  text.ts                        # sha1, redact/redactSecrets, normalize, templateize, jsonClamp
  solution-utils.ts              # normalizeSolution (shared formatting/policy)
```

---

## 🚀 Getting started

### Prerequisites

* Node.js **20+**
* TiDB Cloud **Serverless** (Starter)
* GitHub App (App ID, private key, webhook secret)

### Environment

```bash
# TiDB
TIDB_HOST=...
TIDB_PORT=
TIDB_USER=...
TIDB_PASSWORD=...
TIDB_DATABASE=

# GitHub App
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=...

# LLM
LLM_API_KEY=...               # e.g., OpenAI-compatible
LLM_MODEL_CHAT=    # OpenAI models

# App
CRON_SECRET=
NEXT_PUBLIC_BASE_URL=https://your-deploy-url   #  derived in code for dev
```

### Install & run

```bash
npm install
npm run dev
```

Expose your local webhook with **ngrok** or deploy to **Vercel**.


## ❓ FAQ

**Why diagnostic anchors?**
Sometimes the best help is to point precisely at the failing spot (logs/config/test) with context—**no edits** required.

**Why hybrid retrieval (not LLM-only)?**
LLM structures the failure; TiDB retrieval **grounds** the diagnosis in prior reality (deterministic, auditable).

**What if anchors fail?**
We degrade to summary-only or fewer suggestions and re-anchor on the new head SHA.

---

## 📜 License

Apache License Version 2.0
