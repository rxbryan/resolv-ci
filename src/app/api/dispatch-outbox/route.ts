export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { OutboundAction } from "@/lib/tidb";
import { dispatchOneOutboundAction, OutboundRow } from "@/agents/actuator";

const DEBUG = process.env.DEBUG_DISPATCH === "1";
const DEFAULT_BATCH = Number(process.env.DISPATCH_BATCH_SIZE ?? "5");

function authorized(req: NextRequest) {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  return token && token === process.env.CRON_SECRET;
}

/**
 * POST /api/dispatch-outbox
 * Body: optional { limit?: number }
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let limit = DEFAULT_BATCH;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.limit === "number" && body.limit > 0 && body.limit <= 50) {
      limit = body.limit;
    }
  } catch {
    /* noop */
  }

  try {
    // Fetch a small batch of staged actions; we rely on idempotent action_hash +
    // row status transitions inside dispatchOneOutboundAction to avoid duplicates
    const rows = await OutboundAction.findAll({
      where: { status: "staged" },
      order: [["id", "ASC"]],
      limit,
    });

    if (!rows.length) {
      if (DEBUG) console.log("[Dispatch] no staged actions");
      return NextResponse.json({ ok: true, dispatched: 0, empty: true });
    }

    if (DEBUG) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log("[Dispatch] picked", rows.length, "staged actions (ids):", rows.map((r: any) => r.id));
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const results = [];
    for (const row of rows) {
      try {
        // Pass a plain object to the dispatcher; it updates status in DB
        const r = await dispatchOneOutboundAction(row.toJSON() as OutboundRow);
        results.push({ id: (row as any).id, ok: !!r.ok, error: (r as any)?.error });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        console.error("[Dispatch] unexpected error for id", (row as any).id, msg);
        // Best-effort mark the row as error + increment attempts
        try {
          await OutboundAction.update(
            {
              status: "error",
              attempt_count: ((row as any).attempt_count ?? 0) + 1,
              last_error: msg.slice(0, 1000),
            },
            { where: { id: (row as any).id } }
          );
        } catch {
          /* noop */
        }
        results.push({ id: (row as any).id, ok: false, error: msg });
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const okCount = results.filter((r) => r.ok).length;
    if (DEBUG) console.log("[Dispatch] results:", results);

    return NextResponse.json({
      ok: true,
      dispatched: okCount,
      attempted: results.length,
      results,
    });
  } catch (err: unknown) {
    let message: string = String(err)
    if (err instanceof Error)
      message = err?.message
    console.error("[Dispatch] fatal:", err);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
