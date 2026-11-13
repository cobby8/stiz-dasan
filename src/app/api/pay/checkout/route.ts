import { NextRequest, NextResponse } from "next/server";
import { createCheckoutSession } from "@/lib/payment-ledger";
import { GUEST_PAY_INVALID_MESSAGE, toGuestVirtualAccountView } from "@/lib/payments/guestPayLinkRules";
import {
    guestPayClientIp,
    guestPayFailDelay,
    guestPayRateLimitOk,
    resolveGuestPayLink,
} from "@/lib/payments/guestPayLinkService";

export const dynamic = "force-dynamic";

// 응답은 저장(캐시)하지 않는다 — 결제 주문 번호·고객 키가 실린다
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 비회원 결제 시작 — 로그인 없이 «청구서 한 장 전용 링크(토큰)»로만.
 * 권한 = 본문 token 이 가리키는 청구서. 화면이 보낸 청구서 id 는 받지 않는다(토큰의 청구서만 결제된다).
 * 금액·주문번호·면세는 서버(createCheckoutSession — 로그인 결제와 같은 함수)가 정한다.
 */
export async function POST(req: NextRequest) {
    try {
        if (!guestPayRateLimitOk(guestPayClientIp(req.headers), "api")) {
            return NextResponse.json({ ok: false, error: "잠시 후 다시 시도해 주세요." }, { status: 429, headers: NO_STORE });
        }
        const body = await req.json().catch(() => null);
        const token = typeof body?.token === "string" ? body.token : "";
        const link = await resolveGuestPayLink(token);
        if (link.state === "INVALID") {
            await guestPayFailDelay();
            return NextResponse.json({ ok: false, error: GUEST_PAY_INVALID_MESSAGE }, { status: 404, headers: NO_STORE });
        }
        if (link.state === "PAID") {
            return NextResponse.json({ ok: false, error: "이미 납부가 완료된 청구서입니다.", alreadyPaid: true }, { status: 409, headers: NO_STORE });
        }

        const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
        const origin = configuredOrigin && /^https?:\/\//i.test(configuredOrigin)
            ? new URL(configuredOrigin).origin
            : new URL(req.url).origin;
        const result = await createCheckoutSession({
            invoiceId: link.invoiceId,
            owner: { kind: "GUEST_INVOICE", invoiceId: link.invoiceId, token },
            origin,
            method: typeof body?.method === "string" ? body.method : null,
            closeOpenVirtualAccount: body?.closeOpenVirtualAccount === true,
        });

        if (!result.ok) {
            const status = result.alreadyPaid
                ? 409
                : "providerError" in result && result.providerError
                    ? result.retryable ? 503 : 502
                    : "configurationMissing" in result && result.configurationMissing
                        ? 503
                        : 400;
            return NextResponse.json(result, { status, headers: NO_STORE });
        }
        // 이미 열린 입금 계좌를 돌려줄 때도 개인정보 칸은 뺀다
        if ("openVirtualAccount" in result && result.openVirtualAccount) {
            return NextResponse.json({ ...result, openVirtualAccount: toGuestVirtualAccountView(result.openVirtualAccount) }, { headers: NO_STORE });
        }
        return NextResponse.json(result, { headers: NO_STORE });
    } catch (error) {
        console.error("[pay/checkout] failed:", error);
        return NextResponse.json({ ok: false, error: "결제 준비 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요." }, { status: 500, headers: NO_STORE });
    }
}
