import { NextRequest, NextResponse } from "next/server";
import { confirmTrialFeeOnlinePayment } from "@/lib/trial-fee/trialFeePaymentService";

export const dynamic = "force-dynamic";

// 체험비 결제창 복귀 → 토스 승인. 토큰으로 찾은 신청의 주문만 승인한다(남의 주문번호·바꾼 금액은 거부).
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => null);
        const result = await confirmTrialFeeOnlinePayment({
            token: typeof body?.token === "string" ? body.token : "",
            paymentKey: typeof body?.paymentKey === "string" ? body.paymentKey : "",
            orderId: typeof body?.orderId === "string" ? body.orderId : "",
            amount: Number(body?.amount ?? NaN),
        });
        if (!result.ok) {
            return NextResponse.json(result, { status: result.retryable ? 202 : 400 });
        }
        return NextResponse.json(result);
    } catch (error) {
        console.error("[apply/trial-fee/confirm] failed:", error);
        return NextResponse.json({ ok: false, error: "결제 승인 중 오류가 발생했어요. 잠시 후 다시 확인해 주세요.", retryable: true }, { status: 500 });
    }
}
