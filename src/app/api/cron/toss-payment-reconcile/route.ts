import { NextRequest, NextResponse } from "next/server";
import { reconcileTossPayments } from "@/lib/payment-ledger";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";
// 토스 조회가 건마다 최대 10초 — 점검 함수는 45초 예산 안에서 멈추고, 함수 자체는 60초까지 허용
export const maxDuration = 60;

/**
 * 토스 결제 «승인됐는데 장부에 안 들어간 건» 점검 — 10분마다(vercel.json `*\/10 * * * *`).
 *
 * 왜 필요한가(점검표 c5, 2026-11-13): 학부모가 카드로 결제한 직후 서버가 멈추거나 응답이 끊기면
 * 토스에서는 돈이 나갔는데 청구는 미납으로 남는다. 웹훅이 오면 고쳐지지만 웹훅도 놓칠 수 있다.
 * 승인 진행 중인 채 10분 넘게 멈춘 거래를 토스에 다시 물어, 승인된 건은 같은 멱등 함수로 반영하고
 * 금액이 다르거나 하루 넘게 결론이 안 나면 원장에게 «결제 확인 필요»를 보낸다(같은 사유는 한 번만).
 * 여러 번 돌아도 결과가 같다 — 이미 반영된 거래는 대상에서 빠지고, 반영 함수가 이중 기록을 막는다.
 */
async function handleGet(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
        const result = await reconcileTossPayments();
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        console.error("[cron/toss-payment-reconcile] failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ ok: false, error: "결제 반영 점검에 실패했습니다." }, { status: 500 });
    }
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("toss-payment-reconcile", handleGet);
