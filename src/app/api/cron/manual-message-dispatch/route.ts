import { NextRequest, NextResponse } from "next/server";
import { sendSmsBulkDetailed } from "@/lib/sms";
import { claimManualMessageQueue, finalizeMessageDelivery, finalizeMessageDeliveryBatch, markManualMessageAccepted, markManualMessageUncertain } from "@/lib/message-ledger";

export const dynamic = "force-dynamic";
const MAX_DISPATCH_PER_RUN = 500;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const claim = await claimManualMessageQueue(MAX_DISPATCH_PER_RUN);
  const claimed = claim.items;
  const touched = new Set(claim.finalizeBatchIds);
  for (const item of claimed) touched.add(item.batchId);
  if (claimed.length === 0) {
    for (const batchId of touched) await finalizeMessageDeliveryBatch(batchId);
    return NextResponse.json({ success: true, processed: 0, accepted: 0, sent: 0, failed: 0, uncertain: 0 });
  }
  const commonBody = claimed[0].body;
  if (claimed.some((item) => item.body !== commonBody)) {
    await markManualMessageUncertain(claimed.map((item) => item.id), "BATCH_BODY_MISMATCH");
    for (const batchId of touched) await finalizeMessageDeliveryBatch(batchId);
    return NextResponse.json({ success: false, processed: claimed.length, accepted: 0, sent: 0, failed: 0, uncertain: claimed.length });
  }

  let accepted = 0, sent = 0, failed = 0, uncertain = 0;
  try {
    const result = await sendSmsBulkDetailed(claimed.map((item) => ({ deliveryId: item.id, to: item.recipient })), commonBody);
    const byId = new Map(result.deliveries.map((delivery) => [delivery.deliveryId, delivery]));
    for (const item of claimed) {
      const delivery = byId.get(item.id);
      if (!delivery || delivery.status === "UNCERTAIN") {
        await markManualMessageUncertain([item.id], delivery?.reason || "PROVIDER_RESPONSE_MISSING"); uncertain++;
      } else if (delivery.status === "FAILED") {
        await finalizeMessageDelivery({ deliveryId: item.id, ok: false, provider: delivery.provider, requestedChannel: "SMS", actualChannel: "SMS", providerGroupId: delivery.groupId ?? result.groupId, providerMessageId: delivery.messageId, providerStatus: "FAILED", errorCode: delivery.reason }); failed++;
      } else if (delivery.provider === "SOLAPI") {
        const groupId = delivery.groupId ?? result.groupId;
        if (!groupId) { await markManualMessageUncertain([item.id], "SOLAPI_GROUP_ID_MISSING"); uncertain++; }
        else { await markManualMessageAccepted({ deliveryId: item.id, providerGroupId: groupId, providerMessageId: delivery.messageId }); accepted++; }
      } else {
        // Bizppurio는 기존 단건 호환 경로이며 접수 성공을 기존 정책대로 SENT로 확정합니다.
        await finalizeMessageDelivery({ deliveryId: item.id, ok: true, provider: delivery.provider, requestedChannel: "SMS", actualChannel: "SMS", providerMessageId: delivery.messageId, providerStatus: "ACCEPTED" }); sent++;
      }
    }
  } catch (error) {
    // HTTP 타임아웃은 공급자 도달 여부를 모르므로 자동 재시도하지 않습니다.
    console.error("[manual-message-dispatch] bulk provider state uncertain", error);
    await markManualMessageUncertain(claimed.map((item) => item.id), "BULK_PROVIDER_STATE_UNCERTAIN"); uncertain = claimed.length;
  }
  for (const batchId of touched) {
    try { await finalizeMessageDeliveryBatch(batchId); } catch (error) { console.error(`[manual-message-dispatch] batch finalize failed id=${batchId}`, error); }
  }
  return NextResponse.json({ success: failed === 0 && uncertain === 0, processed: claimed.length, accepted, sent, failed, uncertain });
}
