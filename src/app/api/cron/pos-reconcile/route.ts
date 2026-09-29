import { NextRequest, NextResponse } from "next/server";
import { currentMonthKst, runPosReconcile } from "@/lib/pos/reconcileService";

export const dynamic = "force-dynamic";

/**
 * 토스POS 결제 ↔ 사이트 결제 자동 대조 (매일 KST 05:30 = UTC 20:30).
 *
 * 왜 매일 도는가: 어긋난 결제를 월말에 한꺼번에 찾으면 원인을 되짚기 어렵다.
 * 매일 같은 달을 다시 맞춰 보면 "어제까지는 맞았다"는 기준선이 생긴다.
 *
 * 왜 새벽인가: POS 마감 후라 그날 매출이 모두 확정돼 있고, 학원이 열기 전이라
 * 조회가 사용자 화면과 겹치지 않는다.
 *
 * 이 크론은 **조회 + 기록 한 줄**만 한다. 결제·청구서는 건드리지 않는다.
 * 여러 번 돌아도 기록이 한 줄씩 늘 뿐 데이터가 망가지지 않는다.
 */
export async function GET(req: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (
        process.env.NODE_ENV !== "development" &&
        (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)
    ) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 이번 달(KST). 서버는 UTC 라 new Date().getMonth() 를 쓰면 매월 1일 새벽에 지난달이 나온다.
    const month = currentMonthKst();
    const { runId, summary } = await runPosReconcile({ month, source: "CRON" });
    return NextResponse.json({ ok: summary.status === "OK", runId, summary });
}
