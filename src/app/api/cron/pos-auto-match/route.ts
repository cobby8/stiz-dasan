import { NextRequest, NextResponse } from "next/server";
import { runPosAutoMatchCron } from "@/lib/pos/paymentNoticeService";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

/**
 * 토스POS 결제 자동 매칭 재시도 (매시간 7분).
 *
 * 왜 필요한가: 웹훅을 받는 순간 자동 매칭을 해 보지만, 그때 청구가 아직 없었거나(늦게 발행)
 * 웹훅 처리가 중간에 실패했으면 결제가 슬랙 보류로 남는다. 7일 안의 열린 알림을 토스에 다시
 * 조회(GET)해서 같은 규칙(lib/pos/auto-match.mjs)으로 다시 맞춘다. 1회 상한 10건·200만원.
 *
 * 여러 번 돌아도 안전하다: 토스 결제 ID 잠금 + 이미 반영 확인 + 조건부 UPDATE(부분 반영 없음).
 * 보류된 결제에는 DM 을 다시 보내지 않는다.
 */
async function handleGet(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await runPosAutoMatchCron();
    return NextResponse.json({ ok: true, ...result });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("pos-auto-match", handleGet);
