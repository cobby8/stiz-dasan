import { after, NextRequest, NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack/signature";
import { respondEphemeral } from "@/lib/slack/client";
import { handleSlackNoticeAction } from "@/lib/pos/paymentNoticeActions";
import { parseActionValue } from "@/lib/pos/payment-notice.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 슬랙 버튼(Interactivity) 수신 — 토스POS 결제 알림에 원장이 누른 답.
 *
 * ■ 순서가 곧 안전장치
 *   ① 본문 **원문**을 먼저 읽는다(req.text()). 파싱부터 하면 서명이 절대 맞지 않는다.
 *   ② 슬랙 서명 검증(SLACK_SIGNING_SECRET). 없거나 틀리면 401 — 아무것도 하지 않는다.
 *   ③ 누른 사람이 원장(SLACK_OWNER_USER_ID)인지 확인. 아니면 "권한이 없습니다"만 보여 주고 끝.
 *   ④ 버튼 값 해석(모양이 틀리면 무시).
 *   ⑤ 슬랙은 3초 안에 답을 받아야 한다 → **먼저 200 으로 답하고**, 실제 처리는 after() 로 이어서 한다.
 *      (납부 반영은 청구서·감사로그까지 쓰느라 3초를 넘길 수 있다)
 *
 * 자유 입력 해석은 하지 않는다. 버튼만 받는다.
 */
export async function POST(req: NextRequest) {
    // ① 원문 먼저
    const rawBody = await req.text();

    // ② 서명 검증
    const verdict = verifySlackSignature({
        // 앞뒤 공백·줄바꿈을 뗀다. PowerShell 로 `값 | vercel env add` 하면 끝에 \r\n 이 붙어 저장된다
        // (2026-09-30 실측). 떼지 않으면 서명이 영원히 안 맞아 모든 버튼 요청이 조용히 거부된다.
        secret: (process.env.SLACK_SIGNING_SECRET ?? "").trim(),
        signatureHeader: req.headers.get("x-slack-signature"),
        timestampHeader: req.headers.get("x-slack-request-timestamp"),
        rawBody,
    });
    if (!verdict.ok) {
        console.warn("[slack-interactions] 거부:", verdict.reason);
        return NextResponse.json({ ok: false }, { status: 401 });
    }

    // 슬랙은 application/x-www-form-urlencoded 로 payload=<JSON> 을 보낸다.
    let payload: any = null;
    try {
        payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "null");
    } catch {
        payload = null;
    }
    if (!payload || payload.type !== "block_actions") return new NextResponse(null, { status: 200 });

    const userId = String(payload.user?.id ?? "");
    const responseUrl = String(payload.response_url ?? "");

    // ③ 원장만 누를 수 있다
    const owner = (process.env.SLACK_OWNER_USER_ID ?? "").trim();
    if (!owner || userId !== owner) {
        after(() => respondEphemeral(responseUrl, "권한이 없습니다"));
        return new NextResponse(null, { status: 200 });
    }

    // ④ 버튼 값 해석
    const first = Array.isArray(payload.actions) ? payload.actions[0] : null;
    const action = parseActionValue(first?.action_id, first?.value) as
        | Parameters<typeof handleSlackNoticeAction>[0]
        | null;
    if (!action) return new NextResponse(null, { status: 200 });

    // ⑤ 먼저 답하고 이어서 처리
    after(async () => {
        try {
            await handleSlackNoticeAction(action, {
                userId,
                responseUrl,
                channel: payload.container?.channel_id ?? payload.channel?.id ?? null,
                ts: payload.container?.message_ts ?? payload.message?.ts ?? null,
            });
        } catch (error) {
            console.error("[slack-interactions] 처리 실패:", (error as Error).message);
            await respondEphemeral(responseUrl, "처리 중 오류가 났습니다. 잠시 후 다시 눌러 주세요.");
        }
    });
    return new NextResponse(null, { status: 200 });
}
