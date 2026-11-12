import { NextRequest, NextResponse } from "next/server";
import { markOverduePayments } from "@/lib/payment-ledger";

export const dynamic = "force-dynamic";

/**
 * 연체 자동 표시 — 매일 KST 00:10 (UTC 15:10, vercel.json).
 *
 * 왜 필요한가: 예전에는 관리자가 재무 화면에서 «상태 새로고침»·«미납 알림»을 눌러야 연체(OVERDUE)로 바뀌었다.
 * 이제 납부기한이 한국 날짜로 지난 미납(PENDING)을 매일 자정 직후 연체로 표시한다(판정: src/lib/payments/overdueRule.ts).
 * 학부모에게는 아무것도 보내지 않는다(표시만). 미납 안내는 관리자가 재무 화면에서 따로 보낸다.
 * 여러 번 돌아도 결과가 같다(PENDING 만 바꾼다).
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
        const result = await markOverduePayments();
        return NextResponse.json({ ok: true, overdue: result.updated });
    } catch (error) {
        console.error("[cron/payment-overdue] failed:", error instanceof Error ? error.message : error);
        return NextResponse.json({ ok: false, error: "연체 표시에 실패했습니다." }, { status: 500 });
    }
}
