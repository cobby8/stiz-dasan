import { NextRequest, NextResponse } from "next/server";
import { getSolapiBatchResults } from "@/lib/sms";
// 브랜드 메시지 못 받음 사유 앞머리 — src/lib/messaging/parent-notice.ts 의 BMS_NOT_DELIVERED_PREFIX 와 같은 값
// (이 크론은 실행 검사 테스트가 import 를 제한해 상수만 복사한다. tests/parent-notice.test.mjs 가 두 값이 같은지 본다)
const BMS_NOT_DELIVERED_PREFIX = "BMS_NOT_DELIVERED:";
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
          providerStatus: result.statusCode || result.status,
          // 브랜드 메시지(학부모 자유 공지)는 문자 대체를 끄고 보낸다 — 못 받은 건(채널 친구 아님 등)을 따로 세어
          // 원장이 «정보성 문자로 다시 보내기»를 고를 수 있게 사유 앞머리를 붙인다
          errorCode: delivery.messageType === "BMS" && result.status !== "SUCCESS"
            ? `${BMS_NOT_DELIVERED_PREFIX}${result.reason ?? result.statusCode ?? ""}`
            : result.reason,
        });
        if (result.status === "SUCCESS") sent++; else failed++;
      }
      // 같은 공급자 묶음에 들어간 모든 내부 발송 묶음의 최종 상태를 갱신한다.
      for (const batchId of new Set(deliveries.map(item => item.batchId).filter(Boolean))) await finalizeMessageDeliveryBatch(batchId);
    } catch (error) {
      // 조회 실패는 발송 실패가 아닙니다. 다음 cron에서 조회만 다시 시도합니다.
      console.error(`[manual-message-reconcile] lookup failed group=${group.providerGroupId}`, error);
      pending++;
    }
  }
  return NextResponse.json({ success: failed === 0 && uncertain === 0, groups: groups.length, sent, failed, pending, uncertain });
}
