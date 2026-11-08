import { NextRequest, NextResponse } from "next/server";
import { getSmsMessageType, getSmsProviderName, sendPerMessageBulkDetailed, sendSmsBulkDetailed, type PerMessageBulkItem, type SmsBulkSendResult } from "@/lib/sms";
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
  // 학부모 공지(받는 사람마다 본문·카카오 옵션이 다른 묶음)는 따로 보낸다. 예전 문자 묶음은 아래 그대로.
  if (claimed.some((item) => item.perItem)) {
    const outcome = await dispatchPerItemNotice(claimed);
    for (const batchId of touched) {
      try { await finalizeMessageDeliveryBatch(batchId); } catch (error) { console.error(`[manual-message-dispatch] batch finalize failed id=${batchId}`, error); }
    }
    return NextResponse.json({ success: outcome.failed === 0 && outcome.uncertain === 0, processed: claimed.length, ...outcome });
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

// ═════════════════════ 학부모 공지 묶음(2026-11-09) ═════════════════════
//
// 받는 사람마다 본문(학생명)과 종류가 다르다: 알림톡(카톡 틀) / 브랜드 메시지(자유 공지) / 문자(틀 id 없음).
//  - 브랜드 메시지는 광고성이라 마감(20:50 KST)이 지난 항목은 보내지 않고 «실패(BMS_SEND_WINDOW_CLOSED)»로 남긴다.
//  - 알림톡·브랜드 메시지가 «명시적으로 거절»되면(템플릿 불일치·채널 권한 등) 같은 내용을 문자로 한 번 대신 보낸다.
//    접수 뒤 전달 실패(카톡 미설치·채널 차단)는 솔라피 대체 발송(disableSms:false)이 맡는다.
//  - 공급자 응답이 불확실하면(시간 초과) 자동 재시도하지 않는다(중복 발송 방지 — 기존 원칙 그대로).
type ClaimedItem = Awaited<ReturnType<typeof claimManualMessageQueue>>["items"][number];

function requestedChannelOf(item: ClaimedItem) {
  return item.kakao?.kind === "ALIMTALK" ? "ALIMTALK" : item.kakao?.kind === "BMS_FREE" ? "BMS" : "SMS";
}

async function sendSafely(items: PerMessageBulkItem[]): Promise<SmsBulkSendResult | null> {
  try {
    return await sendPerMessageBulkDetailed(items);
  } catch (error) {
    console.error("[manual-message-dispatch] notice bulk provider state uncertain", error);
    return null;
  }
}

async function dispatchPerItemNotice(claimed: ClaimedItem[]) {
  let accepted = 0, sent = 0, failed = 0, uncertain = 0;
  const now = Date.now();
  const solapi = getSmsProviderName() === "SOLAPI";
  const sendable: ClaimedItem[] = [];
  for (const item of claimed) {
    if (item.kakao?.kind === "BMS_FREE" && !(now < Date.parse(item.kakao.notAfter))) {
      await finalizeMessageDelivery({
        deliveryId: item.id, ok: false, requestedChannel: "BMS", messageType: "BMS",
        providerStatus: "NOT_SENT", errorCode: "BMS_SEND_WINDOW_CLOSED",
      });
      failed++;
      continue;
    }
    sendable.push(item);
  }

  /** 공급자 결과 한 건을 장부에 남긴다 */
  async function record(item: ClaimedItem, result: SmsBulkSendResult | null, messageType: string, fallbackUsed: boolean) {
    const delivery = result?.deliveries.find((entry) => entry.deliveryId === item.id);
    if (!result || !delivery || delivery.status === "UNCERTAIN") {
      await markManualMessageUncertain([item.id], delivery?.reason || (result ? "PROVIDER_RESPONSE_MISSING" : "BULK_PROVIDER_STATE_UNCERTAIN")); uncertain++;
      return;
    }
    if (delivery.status === "FAILED") {
      await finalizeMessageDelivery({
        deliveryId: item.id, ok: false, provider: delivery.provider, requestedChannel: requestedChannelOf(item),
        actualChannel: messageType === "ALIMTALK" ? "ALIMTALK" : messageType === "BMS" ? null : "SMS", messageType,
        providerGroupId: delivery.groupId ?? result.groupId, providerMessageId: delivery.messageId,
        providerStatus: "FAILED", fallbackUsed, errorCode: delivery.reason,
      }); failed++;
      return;
    }
    if (delivery.provider === "SOLAPI") {
      const groupId = delivery.groupId ?? result.groupId;
      if (!groupId) { await markManualMessageUncertain([item.id], "SOLAPI_GROUP_ID_MISSING"); uncertain++; return; }
      await markManualMessageAccepted({ deliveryId: item.id, providerGroupId: groupId, providerMessageId: delivery.messageId, messageType }); accepted++;
      return;
    }
    await finalizeMessageDelivery({
      deliveryId: item.id, ok: true, provider: delivery.provider, requestedChannel: requestedChannelOf(item),
      actualChannel: "SMS", messageType, providerMessageId: delivery.messageId, providerStatus: "ACCEPTED", fallbackUsed,
    }); sent++;
  }

  if (sendable.length > 0) {
    // 솔라피가 아니면(비즈뿌리오) 카카오를 못 보내므로 처음부터 문자 본문으로
    const first = await sendSafely(sendable.map((item) => ({
      deliveryId: item.id,
      to: item.recipient,
      body: !solapi && item.kakao?.kind === "ALIMTALK" ? item.kakao.smsBody : item.body,
      kakao: solapi ? item.kakao : undefined,
    })));
    const retry: ClaimedItem[] = [];
    for (const item of sendable) {
      const delivery = first?.deliveries.find((entry) => entry.deliveryId === item.id);
      // 카카오(알림톡·브랜드 메시지)가 «명시적으로 거절»된 사람만 문자로 한 번 더(응답 불확실은 재시도 금지)
      if (solapi && item.kakao && delivery?.status === "FAILED") { retry.push(item); continue; }
      const type = solapi && item.kakao ? (item.kakao.kind === "ALIMTALK" ? "ALIMTALK" : "BMS")
        : getSmsMessageType(item.kakao?.kind === "ALIMTALK" ? item.kakao.smsBody : item.body);
      await record(item, first, type, false);
    }
    if (retry.length > 0) {
      // 같은 내용을 문자로 — 알림톡은 버튼 링크를 본문에 붙인 smsBody, 브랜드 메시지는 (광고)·수신거부가 든 본문 그대로
      const second = await sendSafely(retry.map((item) => ({
        deliveryId: item.id,
        to: item.recipient,
        body: item.kakao?.kind === "ALIMTALK" ? item.kakao.smsBody : item.body,
      })));
      for (const item of retry) {
        const body = item.kakao?.kind === "ALIMTALK" ? item.kakao.smsBody : item.body;
        await record(item, second, getSmsMessageType(body), true);
      }
    }
  }
  return { accepted, sent, failed, uncertain };
}
