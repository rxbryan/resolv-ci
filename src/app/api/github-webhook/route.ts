export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordWebhookDelivery, logBuildFailure } from "@/lib/tidb";

async function raw(req: NextRequest): Promise<Buffer> {
  const ab = await req.arrayBuffer();
  return Buffer.from(ab);
}
function tEq(a: string, b: string) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

export async function POST(req: NextRequest) {
  try {
    const sig = req.headers.get("x-hub-signature-256");
    if (!sig) return NextResponse.json({ error: "signature missing" }, { status: 401 });

    const body = await raw(req);
    const digest = "sha256=" + crypto.createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET ?? "").update(body).digest("hex");
    if (!tEq(digest, sig)) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

    const payload = JSON.parse(body.toString("utf-8"));
    const eventType = req.headers.get("x-github-event") ?? "";
    const deliveryId = req.headers.get("x-github-delivery") ?? "";

    const event = req.headers.get("x-github-event");
    if (event === "check_run") {
      const action = payload.action;               // expect "completed"
      const conclusion = payload.check_run?.conclusion; // expect "failure"
      if (action !== "completed" || conclusion !== "failure") {
        return NextResponse.json({ ok: true, ignored: "check_run not completed failure" });
      }
    } else if (event === "workflow_run") {
      const action = payload.action;               // expect "completed"
      const conclusion = payload.workflow_run?.conclusion; // expect "failure"
      if (action !== "completed" || conclusion !== "failure") {
        return NextResponse.json({ ok: true, ignored: "workflow_run not completed failure" });
      }
    }

    const first = await recordWebhookDelivery(deliveryId, eventType, payload);
    if (!first) return NextResponse.json({ ok: true, deduped: true });

    const repoOwner = payload.repository?.owner?.login ?? payload.org?.login ?? "unknown";
    const repoName  = payload.repository?.name ?? "unknown";
    const prNumber  =
      payload.check_run?.pull_requests?.[0]?.number ??
      payload.workflow_run?.pull_requests?.[0]?.number ??
      payload.pull_request?.number ??
      (payload.issue?.pull_request ? payload.issue?.number : null) ??
      null;

    const headSha   =
      payload.check_run?.head_sha ??
      payload.workflow_run?.head_sha ??
      payload.pull_request?.head?.sha ??
      payload.after ??
      "unknown";

    const runId     =
      (payload.check_run?.id && String(payload.check_run.id)) ||
      (payload.workflow_run?.id && String(payload.workflow_run.id)) ||
      null;

    let logExcerpt = `event=${eventType} delivery=${deliveryId}`;
    if (eventType === "check_run") {
      logExcerpt = payload.check_run?.output?.summary ?? payload.check_run?.output?.text ?? logExcerpt;
    } else if (eventType === "workflow_run") {
      logExcerpt = payload.workflow_run?.display_title ? `workflow_run: ${payload.workflow_run.display_title}` : logExcerpt;
    } else if (eventType === "pull_request_review_comment") {
      logExcerpt = `PR review comment by ${payload.comment?.user?.login}:
${payload.comment?.body ?? ""}`;
    } else if (eventType === "issue_comment" && payload.issue?.pull_request) {
      logExcerpt = `PR comment by ${payload.comment?.user?.login}:
${payload.comment?.body ?? ""}`;
    }

    // Github sometimes makes multiple calls to this endpoint: 
    console.log(`[webhook] delivery=${deliveryId} runId=${runId} action=${payload.action} ev=${eventType}`);

    await logBuildFailure({
      repoOwner, repoName, prNumber, commitSha: headSha, logContent: logExcerpt, runId
    });

    const base = process.env.NEXT_PUBLIC_BASE_URL;
    const secret = process.env.CRON_SECRET;
    if (base && secret) {
      fetch(`${base}/api/graph-run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        // @ts-expect-error keepalive ok in Node 18+
        keepalive: true,
      }).catch(() => {});
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("webhook error:", err);
    return NextResponse.json({ error: "internal", detail: String(err?.message ?? err) }, { status: 500 });
  }
}
