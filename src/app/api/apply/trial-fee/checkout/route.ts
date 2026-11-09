import { NextRequest, NextResponse } from "next/server";
import { startTrialFeeCheckout } from "@/lib/trial-fee/trialFeePaymentService";

export const dynamic = "force-dynamic";

// 체험비 결제 시작 — 로그인 없는 신청자용. 권한 = 신청 건에 묶인 결제 링크 토큰(본문 token).
// 금액·면세·주문번호는 서버가 정한다(본문에 금액을 받지 않는다).
export async function POST(req: NextRequest) {
    try {
        const body = await req.json().catch(() => null);
        const token = typeof body?.token === "string" ? body.token : "";
        const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
        const origin = configuredOrigin && /^https?:\/\//i.test(configuredOrigin)
            ? new URL(configuredOrigin).origin
            : new URL(req.url).origin;
        const result = await startTrialFeeCheckout({ token, origin });
        if (!result.ok) {
            const status = result.block === "NOT_FOUND" ? 404 : result.block === "ALREADY_PAID" ? 409 : result.block === "PAYMENT_OFF" ? 503 : 400;
            return NextResponse.json(result, { status });
        }
        return NextResponse.json(result);
    } catch (error) {
        console.error("[apply/trial-fee/checkout] failed:", error);
        return NextResponse.json({ ok: false, error: "결제 준비 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
    }
}
