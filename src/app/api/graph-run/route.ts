export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import yauzl from "yauzl";
import type { BaseMessage } from "@langchain/core/messages";
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
      const run = await findLatestRunForPR(
        octo,
        failure.repo_owner,
        failure.repo_name,
        failure.pr_number,
        failure.commit_sha
      );
      if (!run) throw new Error(`No PR workflow run found for head_sha=${failure.commit_sha}`);

      const { data } = await octo.rest.actions.downloadWorkflowRunLogs({
        owner: failure.repo_owner,
        repo: failure.repo_name,
        run_id: run.id,
      });
      
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const zipBuf =
        Buffer.isBuffer(data)
          ? (data as Buffer)
          : (data as any)?.pipe
          ? await (async () => {
              const chunks: Buffer[] = [];
              for await (const chunk of (data as any)) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              return Buffer.concat(chunks);
            })()
          : (data as any)?.byteLength
          ? Buffer.from(data as ArrayBuffer)
          : Buffer.from(String(data ?? ""), "utf8");
      /* eslint-enable @typescript-eslint/no-explicit-any */
      

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
      console.warn("log download/unzip skipped:", e);
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
