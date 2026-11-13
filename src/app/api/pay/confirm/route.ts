import { NextRequest, NextResponse } from "next/server";
import { confirmTossPayment } from "@/lib/payment-ledger";
import { GUEST_PAY_INVALID_MESSAGE, toGuestVirtualAccountView } from "@/lib/payments/guestPayLinkRules";
import {
    guestPayClientIp,
    guestPayFailDelay,
    guestPayRateLimitOk,
    resolveGuestPayLink,
} from "@/lib/payments/guestPayLinkService";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 비회원 결제창 복귀 → 토스 승인. 토큰을 다시 확인하고, 그 토큰의 청구서 «한 장짜리» 주문만 승인한다
 * (남의 주문번호·다른 청구서·바꾼 금액은 confirmTossPayment 가 거부 — 로그인 결제와 같은 함수·같은 잠금).
 * 납부 완료(PAID) 상태의 토큰도 통과시킨다 — 성공 화면 새로고침이 «이미 승인됨»을 받아야 하므로.
 */
export async function POST(req: NextRequest) {
    try {
        if (!guestPayRateLimitOk(guestPayClientIp(req.headers), "api")) {
            return NextResponse.json({ ok: false, error: "잠시 후 다시 확인해 주세요.", retryable: true }, { status: 429, headers: NO_STORE });
        }
        const body = await req.json().catch(() => null);
        const token = typeof body?.token === "string" ? body.token : "";
        // 승인 재시도(자동 4번)마다 사용 횟수가 늘지 않게 touch: false
        const link = await resolveGuestPayLink(token, { touch: false });
        if (link.state === "INVALID") {
            await guestPayFailDelay();
            return NextResponse.json({ ok: false, error: GUEST_PAY_INVALID_MESSAGE }, { status: 404, headers: NO_STORE });
        }

        const paymentKey = String(body?.paymentKey || "");
        const orderId = String(body?.orderId || "");
        const amount = Number(body?.amount || 0);
        if (!paymentKey || !orderId || !Number.isFinite(amount) || amount <= 0) {
            return NextResponse.json({ ok: false, error: "결제 승인 정보가 부족합니다." }, { status: 400, headers: NO_STORE });
        }

        const result = await confirmTossPayment({
            paymentKey,
            orderId,
            amount,
            // 청구서 id 는 화면 값이 아니라 토큰에서 — 주문의 청구서와 SQL 로 다시 맞춘다
            invoiceId: link.invoiceId,
            owner: { kind: "GUEST_INVOICE", invoiceId: link.invoiceId, token },
        });
        if (!result.ok) {
            const retryable = "retryable" in result && result.retryable;
            return NextResponse.json(result, { status: retryable ? 202 : 400, headers: NO_STORE });
        }
        // 무통장입금 계좌 발급 결과도 개인정보 칸(예금주 이름)은 뺀다
        if ("virtualAccount" in result && result.virtualAccount) {
            return NextResponse.json({ ...result, virtualAccount: toGuestVirtualAccountView(result.virtualAccount) }, { headers: NO_STORE });
        }
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        console.error("[pay/confirm] failed:", error);
        return NextResponse.json({ ok: false, error: "결제 승인 중 오류가 발생했어요. 잠시 후 다시 확인해 주세요.", retryable: true }, { status: 500, headers: NO_STORE });
    }
}
