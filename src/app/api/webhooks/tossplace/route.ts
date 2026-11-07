import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { SIGNATURE_REASON_LABEL, verifyWebhookSignature } from "@/lib/pos/webhookSignature";
import { processPosWebhookEvent } from "@/lib/pos/paymentNoticeService";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 알림 처리(토스 재조회 + 슬랙 DM)를 응답 전에 기다리는 최대 시간. 넘기면 응답부터 하고 처리는 after() 로 이어 간다. */
const PROCESS_TIMEOUT_MS = 4000;

/**
 * 새로 저장된 알림을 바로 처리해 본다(원장에게 DM). **응답 내용은 절대 바꾸지 않는다.**
 * 4초를 넘기면 토스에 먼저 답하되, 처리 자체는 끊지 않는다 — Next 16 after() 가 응답 뒤에도 함수를 살려 둬
 * «요청 PAID → 청구서 납부 기록» 같은 돈 경로가 중간에 멈추지 않게 한다(2026-11-08 검수 건의).
 * 그래도 멈추면(함수 강제 종료) 알림이 «처리 완료»가 아니라서 10분 스윕이 다시 부르고,
 * 매칭은 ALREADY_DONE 이어도 청구서가 미납이면 납부 기록을 다시 시도한다(chargeRequestService 의 repairLedgerPaid).
 */
async function tryProcessNow(eventRowId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 처리 약속(promise)은 한 번만 만든다 — 시간 초과 뒤에도 같은 처리가 이어지게(두 번 돌리지 않는다)
    const work = processPosWebhookEvent(eventRowId).then(
        () => "DONE" as const,
        (processError) => {
            console.error("[tossplace-webhook] 알림 처리 실패(스윕이 다시 시도):", (processError as Error).message, { eventRowId });
            return "FAILED" as const;
        },
    );
    try {
        const timeout = new Promise<"TIMEOUT">((resolve) => {
            timer = setTimeout(() => resolve("TIMEOUT"), PROCESS_TIMEOUT_MS);
        });
        const result = await Promise.race([work, timeout]);
        if (result === "TIMEOUT") {
            console.warn("[tossplace-webhook] 알림 처리 4초 초과 — 응답 뒤에도 이어서 처리(after)", { eventRowId });
            after(() => work.then(() => undefined));
        }
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 토스플레이스 웹훅 수신 — **기록 + 원장에게 슬랙 DM.** 이 라우트는 청구서를 직접 건드리지 않는다.
 *
 * ■ 청구서를 여기서 바꾸지 않는 이유
 *   청구서의 원본은 랠리즈다. 사이트 납부 반영은 원장이 슬랙 DM 의 버튼
 *   [사이트 납부 반영]을 눌렀을 때만 한다(/api/slack/interactions).
 *   예외 하나(원장 결정 D1, 2026-11-07): 관리자가 미리 만든 «현장 결제» 요청의 번호(STIZ:S-482193)가
 *   주문 메모에 있고, 토스 재조회로 금액·상태가 맞으면 processPosWebhookEvent 안에서 자동 납부한다
 *   (src/lib/pos/chargeRequestService.ts). 근거는 이 라우트의 서명 검증 + 재조회 두 겹뿐이다.
 *   여기서는 저장 후 알림 처리(토스 재조회 → 매칭·DM)만 시도한다. 실패해도 응답은 그대로다.
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
