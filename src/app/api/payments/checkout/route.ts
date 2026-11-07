import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { createCheckoutSession } from "@/lib/payment-ledger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    try {
        const user = await requireVerifiedParent();
        if (!user.email) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }

        const body = await req.json();
        const invoiceId = String(body?.invoiceId || "");
        if (!invoiceId) {
            return NextResponse.json({ error: "청구서 ID가 필요합니다." }, { status: 400 });
        }

        const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
        const origin = configuredOrigin && /^https?:\/\//i.test(configuredOrigin)
            ? new URL(configuredOrigin).origin
            : new URL(req.url).origin;
        const result = await createCheckoutSession({
            invoiceId,
            owner: { authUserId: user.id, email: user.email ?? null },
            origin,
            // 고른 결제 수단과 «열린 입금 계좌를 닫고 다른 수단으로» 확인 여부(확인창을 거친 경우만 true)
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
            return NextResponse.json(result, { status });
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error("[payments/checkout] failed:", error);
        return NextResponse.json({ error: "결제 준비 중 오류가 발생했습니다." }, { status: 500 });
    }
}
