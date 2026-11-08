import { NextRequest, NextResponse } from "next/server";
import { sendSmsDetailed } from "@/lib/sms";
import { claimDue, markSent, markFailed } from "@/lib/scheduled-message";
import { withParentPrefix } from "@/lib/messaging/parent-alimtalk-templates";
import {
  reserveMessageDeliveryBatch, reserveMessageDelivery,
  claimMessageDelivery, finalizeMessageDelivery,
} from "@/lib/message-ledger";

export const dynamic = "force-dynamic";

// 예약 발송 크론 — 보낼 때가 된 문자를 **얼려 둔 그대로** 내보낸다.
//
// ⚠️ 실제 학부모에게 나가는 문자다. 다음을 지킨다.
//   · 본문을 여기서 다시 만들지 않는다. 예약 시점에 원장이 검토한 본문을 그대로 보낸다.
//   · claimDue가 PENDING → SENDING 으로 선점하므로, 크론이 겹쳐 돌아도 한 번만 나간다.
//   · 발송 장부(MessageDelivery)에도 남겨 즉시 발송분과 같은 중복 방지·이력을 공유한다.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const due = await claimDue(50);
  if (due.length === 0) return NextResponse.json({ success: true, processed: 0 });

  let sent = 0, failed = 0, skipped = 0;
  for (const item of due) {
    try {
      // 머리말 통일(2026-11-09): 이미 머리말이 있으면 그대로, 옛 등원 안내 제목은 겹치지 않게 정리(withParentPrefix)
      const body = withParentPrefix(item.body);
      const stableEventKey = `scheduled:${item.requestId}`;

      const batchId = await reserveMessageDeliveryBatch({
        source: "MANUAL", stableEventKey, audienceScope: "EXTERNAL",
        trigger: "MANUAL_MESSAGE", actorUserId: item.createdBy ?? null, actorName: "예약 발송",
        purpose: item.purpose ?? "예약 발송", reason: "관리자가 예약한 문자 자동 발송",
        body, requestedChannel: "SMS",
      });
      if (!batchId) { await markFailed(item.id, item.attempts, "발송 장부를 만들지 못했습니다."); failed++; continue; }

      const reserved = await reserveMessageDelivery({
        batchId, source: "MANUAL", stableEventKey, eventType: "MANUAL_MESSAGE",
        trigger: "MANUAL_MESSAGE", audienceScope: "EXTERNAL",
        recipientPhone: item.recipient, body, requestedChannel: "SMS",
      });
      // 이미 같은 키로 나간 적이 있으면(즉시 발송 버튼 등) 다시 보내지 않는다.
      if (!reserved.deliveryId) { await markSent(item.id); skipped++; continue; }

      const claimed = await claimMessageDelivery(reserved.deliveryId);
      if (!claimed) { await markSent(item.id); skipped++; continue; }

      const res = await sendSmsDetailed(item.recipient, body);

      // ★ 발송 성공 여부는 **공급자 응답만으로** 판정하고 먼저 확정한다.
      //   장부 기록이 실패했다고 재시도하면 이미 나간 문자를 또 보내게 된다
      //   (2026-08-03 실제 사고: 학부모 13명이 같은 안내를 두 번 받았다).
      if (res.ok) { await markSent(item.id); sent++; }
      else { await markFailed(item.id, item.attempts, res.reason ?? "발송 실패"); failed++; }

      // 장부 기록은 실패해도 발송 판정을 흔들지 않는다. 로그만 남기고 넘어간다.
      try {
        await finalizeMessageDelivery({
          deliveryId: reserved.deliveryId,
          ok: res.ok,
          provider: res.provider,
          requestedChannel: "SMS",
          actualChannel: "SMS",
          messageType: res.messageType || "SMS",
          providerGroupId: res.groupId,
          providerMessageId: res.messageId,
          providerStatus: res.ok ? "ACCEPTED" : "FAILED",
          errorCode: res.ok ? null : res.reason?.slice(0, 500),
        });
      } catch (ledgerError) {
        console.error(`[cron/scheduled-messages] 장부 기록 실패(발송은 완료됨) id=${item.id}:`, ledgerError);
      }
    } catch (e) {
      // ⚠️ 반드시 로그를 남긴다. 예전엔 조용히 삼켜서 08:00 발송이 왜 실패했는지
      //    로그만으로는 끝내 알 수 없었다(2026-08-03).
      console.error(`[cron/scheduled-messages] 처리 실패 id=${item.id} label=${item.label}:`, e);
      await markFailed(item.id, item.attempts, e instanceof Error ? e.message : "알 수 없는 오류");
      failed++;
    }
  }

  console.log(`[cron/scheduled-messages] due=${due.length} sent=${sent} skipped=${skipped} failed=${failed}`);
  return NextResponse.json({ success: failed === 0, processed: due.length, sent, skipped, failed });
}
