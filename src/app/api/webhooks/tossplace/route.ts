import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SIGNATURE_REASON_LABEL, verifyWebhookSignature } from "@/lib/pos/webhookSignature";
import { processPosWebhookEvent } from "@/lib/pos/paymentNoticeService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 알림 처리(토스 재조회 + 슬랙 DM)에 쓰는 최대 시간. 넘기면 응답부터 하고 나머지는 10분 스윕이 줍는다. */
const PROCESS_TIMEOUT_MS = 4000;

/**
 * 새로 저장된 알림을 바로 처리해 본다(원장에게 DM). **응답 내용은 절대 바꾸지 않는다.**
 * 실패·시간초과여도 조용히 넘어간다 — 저장은 이미 끝났고 스윕(/api/cron/pos-notice-sweep)이 다시 시도한다.
 */
async function tryProcessNow(eventRowId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<"TIMEOUT">((resolve) => {
            timer = setTimeout(() => resolve("TIMEOUT"), PROCESS_TIMEOUT_MS);
        });
        const result = await Promise.race([processPosWebhookEvent(eventRowId), timeout]);
        if (result === "TIMEOUT") console.warn("[tossplace-webhook] 알림 처리 시간 초과 — 스윕이 이어서 처리", { eventRowId });
    } catch (processError) {
        console.error("[tossplace-webhook] 알림 처리 실패(스윕이 다시 시도):", (processError as Error).message, { eventRowId });
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 토스플레이스 웹훅 수신 — **기록 + 원장에게 슬랙 DM.** 이 라우트는 청구서를 건드리지 않는다.
 *
 * ■ 청구서를 여기서 바꾸지 않는 이유
 *   청구서의 원본은 랠리즈다. 사이트 납부 반영은 원장이 슬랙 DM 의 버튼
 *   [랠리즈 처리함 · 사이트 납부 반영]을 눌렀을 때만 한다(/api/slack/interactions).
 *   여기서는 저장 후 알림 처리(토스 재조회 → DM)만 시도한다. 실패해도 응답은 그대로다.
 *
 * ■ 같은 알림이 두 번 와도 한 번만 남는다
 *   토스는 2xx 응답을 못 받으면 재시도한다. 재시도마다 x-toss-delivery-id 는 바뀌지만
 *   x-toss-webhook-id 는 그대로다. 그 값에 유일 제약이 걸려 있어 **DB 가** 중복을 막는다.
 *   코드로 "이미 있나 확인 후 INSERT" 하면 동시에 두 건이 들어올 때 뚫린다.
 *
 * ■ 실패해도 재시도 폭풍을 만들지 않는다
 *   서명이 틀린 요청만 401 로 막고, 우리 쪽 사정(저장 실패 등)은 200 으로 답한다.
 *   여기서 5xx 를 주면 토스가 계속 재시도하고, 결국 엔드포인트가 정지될 수 있다.
 */
export async function POST(req: NextRequest) {
  // ⚠️ 서명은 본문 '원문'으로 계산한다. 먼저 json() 으로 파싱하면 원문을 잃는다.
  const rawBody = await req.text();

  const verdict = verifyWebhookSignature({
    // 앞뒤 공백·줄바꿈을 뗀다. PowerShell 로 `값 | vercel env add` 하면 끝에 \r\n 이 붙어 저장된다
    // (2026-09-30 실측). 떼지 않으면 서명이 영원히 안 맞아 실제 결제 알림이 전부 조용히 거부된다.
    secret: (process.env.TOSS_PLACE_WEBHOOK_SECRET ?? "").trim(),
    signatureHeader: req.headers.get("x-toss-signature"),
    timestampHeader: req.headers.get("x-toss-timestamp"),
    rawBody,
  });

  if (!verdict.ok) {
    // 가짜·재전송 요청은 저장하지 않는다. 저장하면 아무나 기록을 채워 넣을 수 있다.
    console.warn("[tossplace-webhook] 거부:", SIGNATURE_REASON_LABEL[verdict.reason], {
      eventId: req.headers.get("x-toss-event-id"),
      webhookId: req.headers.get("x-toss-webhook-id"),
    });
    return NextResponse.json({ ok: false, reason: verdict.reason }, { status: 401 });
  }

  const webhookId = req.headers.get("x-toss-webhook-id");
  if (!webhookId) {
    // 중복을 막을 열쇠가 없으면 저장하지 않는다. 같은 알림이 여러 줄로 쌓인다.
    return NextResponse.json({ ok: false, reason: "NO_WEBHOOK_ID" }, { status: 400 });
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // 서명은 맞는데 본문이 JSON 이 아니면 원문 그대로 보관해 나중에 확인한다.
    parsed = { _unparsed: rawBody.slice(0, 4000) };
  }

  try {
    // ON CONFLICT DO NOTHING: 재시도로 같은 사건이 또 와도 두 번째는 조용히 무시된다.
    // RETURNING id: 새로 들어간 경우에만 id 가 돌아온다(중복이면 빈 배열) → 새 알림만 바로 처리한다.
    const insertedRows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "PosWebhookEvent"
         ("webhookId", "deliveryId", "eventId", "eventType", "merchantId", "payload", "status")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'RECEIVED')
       ON CONFLICT ("webhookId") DO NOTHING
       RETURNING id`,
      webhookId,
      req.headers.get("x-toss-delivery-id"),
      typeof parsed.id === "string" ? parsed.id : null,
      typeof parsed.type === "string" ? parsed.type : null,
      parsed.merchantId == null ? null : String(parsed.merchantId),
      rawBody.length > 900_000 ? JSON.stringify({ _truncated: true }) : rawBody,
    );
    const inserted = insertedRows.length;
    if (insertedRows[0]) await tryProcessNow(insertedRows[0].id);
    return NextResponse.json({ ok: true, stored: Number(inserted) === 1, duplicate: Number(inserted) === 0 });
  } catch (error) {
    // 저장이 실패해도 2xx 로 답한다(재시도 폭풍 방지). 대신 로그로 남겨 사람이 본다.
    console.error("[tossplace-webhook] 저장 실패:", (error as Error).message, { webhookId });
    return NextResponse.json({ ok: true, stored: false, note: "기록 실패 — 로그 확인 필요" });
  }
}
