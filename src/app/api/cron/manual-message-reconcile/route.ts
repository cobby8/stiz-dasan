import { NextRequest, NextResponse } from "next/server";
import { getSolapiBatchResults } from "@/lib/sms";
import { finalizeManualSolapiResult, finalizeMessageDeliveryBatch, getPendingManualSolapiDeliveries, getPendingManualSolapiGroups, markManualMessageUncertain } from "@/lib/message-ledger";

export const dynamic = "force-dynamic";
const MAX_GROUPS_PER_RUN = 5;
const MISSING_RESULT_GRACE_MS = 10 * 60 * 1000;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups = await getPendingManualSolapiGroups(MAX_GROUPS_PER_RUN);
  let sent = 0, failed = 0, pending = 0, uncertain = 0;
  for (const group of groups) {
    try {
      const [deliveries, results] = await Promise.all([
        getPendingManualSolapiDeliveries(group.providerGroupId),
        getSolapiBatchResults(group.providerGroupId),
      ]);
      const byDeliveryId = new Map(results.flatMap((result) => result.deliveryId ? [[result.deliveryId, result] as const] : []));
      const byMessageId = new Map(results.flatMap((result) => result.messageId ? [[result.messageId, result] as const] : []));
      for (const delivery of deliveries) {
        const result = byDeliveryId.get(delivery.id) ?? (delivery.providerMessageId ? byMessageId.get(delivery.providerMessageId) : undefined);
        if (!result) {
          // Solapi 목록은 접수 직후 잠시 비어 있을 수 있습니다. 충분한 유예 뒤에도 없을 때만 격리합니다.
          if (Date.now() - new Date(delivery.acceptedAt).getTime() < MISSING_RESULT_GRACE_MS) { pending++; continue; }
          await markManualMessageUncertain([delivery.id], "SOLAPI_RESULT_MISSING_AFTER_GRACE"); uncertain++; continue;
        }
        if (result.status === "PENDING") { pending++; continue; }
        await finalizeManualSolapiResult({
          deliveryId: delivery.id, ok: result.status === "SUCCESS",
          providerStatus: result.statusCode || result.status, errorCode: result.reason,
        });
        if (result.status === "SUCCESS") sent++; else failed++;
      }
      await finalizeMessageDeliveryBatch(group.batchId);
    } catch (error) {
      // 조회 실패는 발송 실패가 아닙니다. 다음 cron에서 조회만 다시 시도합니다.
      console.error(`[manual-message-reconcile] lookup failed group=${group.providerGroupId}`, error);
      pending++;
    }
  }
  return NextResponse.json({ success: failed === 0 && uncertain === 0, groups: groups.length, sent, failed, pending, uncertain });
}
