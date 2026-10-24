import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getManualMessageBatchStatus } from "@/lib/message-ledger";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ batchId: string }> }) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const { batchId } = await context.params;
  const batch = await getManualMessageBatchStatus(batchId);
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  return NextResponse.json(batch, { headers: { "Cache-Control": "no-store" } });
}
