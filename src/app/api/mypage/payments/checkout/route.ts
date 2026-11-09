import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { createBundleCheckoutSession, getBundleCheckoutCandidates } from "@/lib/payment-ledger";

export const dynamic = "force-dynamic";

// 학부모 «묶음 결제»(2026-11-09) — 화면 /mypage/payments/checkout 이 쓴다(설치 앱 범위 /mypage 안).
//  GET  → 묶음 결제 후보(내 자녀 미납 청구 + 선택 가능 여부·이유·입금 대기 여부)
//  POST → 고른 청구로 토스 주문 1건 만들기(결제창 인자 돌려줌). 청구 검사는 전부 서버가 다시 한다.

async function verifiedParent() {
    try {
        return await requireVerifiedParent();
    } catch {
        return null;
    }
}

export async function GET() {
    const parent = await verifiedParent();
    if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    try {
        return NextResponse.json(await getBundleCheckoutCandidates(parent.appUserId));
    } catch (error) {
        console.error("[mypage/payments/checkout] GET failed:", error);
        return NextResponse.json({ error: "청구 목록을 불러오지 못했습니다." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const parent = await verifiedParent();
    if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }

    try {
        // 돌아올 주소는 설정된 사이트 주소 우선(단건 /api/payments/checkout 과 같은 규칙)
        const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
        const origin = configuredOrigin && /^https?:\/\//i.test(configuredOrigin)
            ? new URL(configuredOrigin).origin
            : new URL(req.url).origin;
        const result = await createBundleCheckoutSession({
            parentUserId: parent.appUserId,
            paymentIds: body?.paymentIds,
            origin,
            method: typeof body?.method === "string" ? body.method : null,
            closeOpenVirtualAccount: body?.closeOpenVirtualAccount === true,
        });

        if (!result.ok) {
            const status = "alreadyPaid" in result && result.alreadyPaid
                ? 409
                : "openVirtualAccountConflict" in result && result.openVirtualAccountConflict
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
        console.error("[mypage/payments/checkout] POST failed:", error);
        return NextResponse.json({ error: "결제 준비 중 오류가 발생했습니다." }, { status: 500 });
    }
}
