import { NextRequest, NextResponse } from "next/server";
import { sweepWaitingVirtualAccounts } from "@/lib/payment-ledger";
import { sweepTrialVirtualAccounts } from "@/lib/trial-fee/trialFeePaymentService";

export const dynamic = "force-dynamic";
// 토스 조회가 건마다 최대 10초 — 점검 함수는 45초 예산 안에서 멈추고, 함수 자체는 60초까지 허용
export const maxDuration = 60;

/**
 * 무통장입금(가상계좌) 매일 점검 — 매일 KST 09:00 (UTC 00:00).
 *
 * 왜 필요한가: 입금 알림(DEPOSIT_CALLBACK)은 토스가 재전송하지만, 끝내 못 받거나 토스 조회가 늦으면
 * 입금된 돈이 «미납»으로 남는다. 입금 대기 거래를 토스에 다시 물어 입금(DONE)은 납부 완료로,
 * 만료·취소는 «입금 대기 해제»로 정리한다. 여러 번 돌아도 결과가 같다(같은 판정·반영 함수).
 */
export async function GET(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
        const startedAt = Date.now();
        const result = await sweepWaitingVirtualAccounts();
        // 체험비 무통장입금(2026-11-10) — 청구 점검 다음에 «남은 시간»만큼(토스 조회 1건 최대 10초라 48초까지만 시작).
        // 시간이 모자라면 건너뛰고 다음 날 다시 본다. 실패해도 청구 점검 결과는 그대로 돌려준다.
        const trialBudgetMs = Math.min(10_000, 48_000 - (Date.now() - startedAt));
        let trial: Awaited<ReturnType<typeof sweepTrialVirtualAccounts>> | { error: string } | { skipped: true };
        try {
            trial = trialBudgetMs >= 1_000 ? await sweepTrialVirtualAccounts(50, trialBudgetMs) : { skipped: true };
        } catch (error) {
            console.error("[cron/virtual-account-sweep] 체험비 점검 실패:", error instanceof Error ? error.message : error);
            trial = { error: "체험비 점검 실패" };
        }
        return NextResponse.json({ ok: true, ...result, trial });
    } catch (error) {
        console.error("[cron/virtual-account-sweep] failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ ok: false, error: "가상계좌 점검에 실패했습니다." }, { status: 500 });
    }
}
