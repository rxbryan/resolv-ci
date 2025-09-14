export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import yauzl from "yauzl";
import type { BaseMessage } from "@langchain/core/messages";
import type { Octokit } from "octokit";
import {
  sequelize,
  BuildFailure,
} from "@/lib/tidb";

import { normalize, tailLines, templateize, sha1 } from "@/lib/text";

import {
  getOctokitForInstallation,
  getOctokitForRepo,
  findLatestRunForPR,
} from "@/lib/github";

import { ResolvGraphApp, type GraphInit } from "@/agents/graph";


// Retry tuning (defaults: 3 attempts, ~1s → ~2s → ~4s)
const LOG_MAX_RETRIES = Number(process.env.LOG_MAX_RETRIES ?? "3");
const LOG_RETRY_BASE_MS = Number(process.env.LOG_RETRY_BASE_MS ?? "1000");

function authorized(req: NextRequest) {
  return req.headers.get("authorization") === `Bearer ${process.env.CRON_SECRET}`;
}


async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}


function tailBytes(buf: Buffer, n: number): Buffer {
  if (buf.length <= n) return buf;
  return buf.subarray(buf.length - n);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isReadableStream(x: unknown): x is NodeJS.ReadableStream {
  return !!x && typeof (x as any).pipe === "function";
}

async function toBufferFromOctokit(data: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data as Buffer;
  if (isReadableStream(data)) return streamToBuffer(data as NodeJS.ReadableStream);
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) return Buffer.from(data as ArrayBuffer);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  // As a final fallback, stringify (rare)
  return Buffer.from(String(data ?? ""), "utf8");
}

function isTransientGitHubError(e: unknown): boolean {
  // Octokit HttpError typically has .status
  const status = typeof (e as any)?.status === "number" ? (e as any).status as number : undefined;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true; // rate limit / server errors
  // 404 for logs can be transient right after a run starts; allow retry
  if (status === 404) return true;
  // network-level: ETIMEDOUT/ECONNRESET often appear as .code on inner error
  const code = (e as any)?.code;
  if (code && /ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(String(code))) return true;
  return false;
}

async function unzipLogArchive(
  zipBuffer: Buffer,
  opts?: { maxFiles?: number; tailPerFileBytes?: number; maxCombinedBytes?: number }
) {
  const maxFiles = opts?.maxFiles ?? 40;
  const tailPerFileBytes = opts?.tailPerFileBytes ?? 200_000;
  const maxCombinedBytes = opts?.maxCombinedBytes ?? 2_000_000;

  const files: Array<{ name: string; text: string }> = [];
  let combinedBytes = 0;

  const zip: yauzl.ZipFile = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err || new Error("Failed to open zip"));
      resolve(zf);
    });
  });

  await new Promise<void>((resolve, reject) => {
    let count = 0;
    zip.readEntry();

    zip.on("entry", (entry: yauzl.Entry) => {
      if (!entry.fileName.endsWith(".txt")) { zip.readEntry(); return; }
      if (count >= maxFiles || combinedBytes >= maxCombinedBytes) { zip.close(); return resolve(); }

      zip.openReadStream(entry, async (err, rs) => {
        if (err || !rs) { zip.close(); return reject(err || new Error("Failed to read entry stream")); }
        try {
          const buf = await streamToBuffer(rs);
          const slice = tailBytes(buf, tailPerFileBytes);
          combinedBytes += slice.length;
          files.push({ name: entry.fileName, text: slice.toString("utf8") });

          count += 1;
          if (count >= maxFiles || combinedBytes >= maxCombinedBytes) { zip.close(); return resolve(); }
          zip.readEntry();
        } catch (e) {
          zip.close();
          reject(e);
        }
      });
    });

    zip.on("end", () => resolve());
    zip.on("close", () => resolve());
    zip.on("error", (e) => reject(e));
  });

  const combined = files.map(f => `===== ${f.name} =====\n${f.text}`).join("\n\n");
  return combined;
}

async function downloadLogsZipWithRetry(
  octo: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): Promise<Buffer> {
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= LOG_MAX_RETRIES; attempt++) {
    try {
      // 1) Resolve the most recent PR run for this head sha
      const run = await findLatestRunForPR(octo, owner, repo, prNumber, headSha);
      if (!run) throw new Error(`No PR workflow run found for head_sha=${headSha}`);

      // 2) Download logs (Octokit may return Buffer, stream, or ArrayBuffer)
      const { data } = await octo.rest.actions.downloadWorkflowRunLogs({
        owner,
        repo,
        run_id: run.id,
      });

      const buf = await toBufferFromOctokit(data);
      if (!buf?.length) throw new Error("Empty logs archive");
      return buf;
    } catch (e) {
      lastErr = e;
      const transient = isTransientGitHubError(e);
      const isLast = attempt === LOG_MAX_RETRIES;
      if (!transient || isLast) {
        // Either not transient, or we used up retries → throw
        throw e;
      }
      const backoff = LOG_RETRY_BASE_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[graph-run] log download retry ${attempt}/${LOG_MAX_RETRIES} after ${backoff}ms`, e);
      await sleep(backoff);
      // and loop to retry
    }
  }

  // Should not reach here; throw last error just in case
  throw lastErr ?? new Error("downloadLogsZipWithRetry: failed with unknown error");
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Claim a row
  const t = await sequelize.transaction();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let f: any | null = null;
  try {
    f = await BuildFailure.findOne({
      where: { status: "new" },
      order: [["failure_timestamp", "ASC"]],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!f) {
      await t.rollback();
      return NextResponse.json({ ok: true, msg: "idle" });
    }
    await f.update({ status: "analyzing" }, { transaction: t });
    await t.commit();
  } catch (err) {
    await t.rollback();
    console.error("graph-run claim error:", err);
    return NextResponse.json({ ok: false, error: "claim_failed" }, { status: 500 });
  }

  try {
    const failure = f.toJSON() as {
      failure_id: number;
      repo_owner: string;
      repo_name: string;
      pr_number: number;
      commit_sha: string;
      log_content?: string | null;
      installation_id?: number | null;
      error_signature_v1?: string | null;
      error_signature_v2?: string | null;
      norm_tail?: string | null;
    };

    const octo =
      failure.installation_id != null
        ? await getOctokitForInstallation(Number(failure.installation_id))
        : await getOctokitForRepo(failure.repo_owner, failure.repo_name);


    // --- Download + unzip logs; then backfill tail + norm + signatures ---
    try {
      const zipBuf = await downloadLogsZipWithRetry(
        octo,
        failure.repo_owner,
        failure.repo_name,
        failure.pr_number,
        failure.commit_sha
      );

      const combined = await unzipLogArchive(zipBuf, {
        maxFiles: 40,
        tailPerFileBytes: 200_000,
        maxCombinedBytes: 2_000_000,
      });

      const tailed = tailLines(combined, 800);
      const norm = normalize(tailLines(combined, 300));

      const sigV1 = failure.error_signature_v1 ?? (norm ? sha1(norm) : null);
      const sigV2 = failure.error_signature_v2 ?? (norm ? sha1(templateize(norm)) : null);

      await f.update({
        log_content: tailed,
        norm_tail: norm || null,
        error_signature_v1: sigV1,
        error_signature_v2: sigV2,
      });
    } catch (e) {
      console.warn("log download/unzip skipped (after retries):", e);
      return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
    }


    const fresh = (await BuildFailure.findByPk(failure.failure_id))?.toJSON() ?? failure;

    // Run the LangGraph app
    const result = await ResolvGraphApp.invoke({
      repo_owner: fresh.repo_owner,
      repo_name: fresh.repo_name,
      pr_number: fresh.pr_number,
      head_sha: fresh.commit_sha,
      log_content: fresh.log_content ?? "",
      failure_id: fresh.failure_id,
      installation_id: fresh.installation_id ?? null,
      insight_loops: 0,
      messages: [] as BaseMessage[],
    } as GraphInit);

    await f.update({ status: "proposed" });

    const base =
      process.env.NEXT_PUBLIC_BASE_URL ||
      `${req.headers.get("x-forwarded-proto") || (process.env.NODE_ENV === "development" ? "http" : "https")}://${req.headers.get("host")}`;

    console.log(`[Graph-run] base url: ${base}`)
    const secret = process.env.CRON_SECRET;
    if (base && secret) {
      fetch(`${base}/api/dispatch-outbox`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        keepalive: true,
      }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      failure_id: fresh.failure_id,
      loops: result?.insight_loops ?? 0,
    });
  } catch (err: unknown) {
    console.error("graph-run execution error:", err);
    try {
      await f.update({ status: "skipped" });
    } catch {}
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
