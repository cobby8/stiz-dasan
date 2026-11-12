import { NextRequest, NextResponse } from "next/server";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { confirmTossPayment, getBundleOrderForParent } from "@/lib/payment-ledger";

export const dynamic = "force-dynamic";

// 학부모 «묶음 결제» 완료 — 화면 /mypage/payments/done 이 쓴다(토스가 successUrl 로 paymentKey·orderId·amount 를 붙여 보낸다).
//  POST { paymentKey, orderId, amount } → 토스 승인(단건과 같은 confirmTossPayment) + 묶음 주문 요약
//  GET  ?orderId=…                       → 묶음 주문 요약만(완료 화면 새로고침·무통장 계좌 다시 보기)
// 주문 소유권: confirm 은 거래의 학부모 계정, 요약은 PaymentTransaction.parentId = 내 앱 계정만(남의 주문 번호면 404).

async function verifiedParent() {
    try {
        return await requireVerifiedParent();
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest) {
    const parent = await verifiedParent();
    if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const orderId = new URL(req.url).searchParams.get("orderId")?.trim() || "";
    if (!orderId) return NextResponse.json({ error: "주문 번호가 필요합니다." }, { status: 400 });
    try {
        const order = await getBundleOrderForParent(orderId, parent.appUserId);
        if (!order) return NextResponse.json({ error: "결제 주문을 찾을 수 없습니다." }, { status: 404 });
        return NextResponse.json({ ok: true, order });
    } catch (error) {
        console.error("[mypage/payments/confirm] GET failed:", error);
        return NextResponse.json({ error: "결제 내역을 불러오지 못했습니다." }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    // 이메일 없는 계정(카카오·휴대폰 가입)도 묶음 결제를 승인할 수 있어야 한다 — 소유 확인은 authUserId 로 한다(2026-11-13)
    const parent = await verifiedParent();
    if (!parent) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const paymentKey = String(body?.paymentKey || "");
    const orderId = String(body?.orderId || "");
    const amount = Number(body?.amount || 0);
    if (!paymentKey || !orderId || !Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "결제 승인 정보가 부족합니다." }, { status: 400 });
    }

    try {
        const result = await confirmTossPayment({
            paymentKey,
            orderId,
            amount,
            invoiceId: null,
            owner: { authUserId: parent.id, email: parent.email ?? null },
        });
        // 승인 결과와 상관없이 지금 장부 상태(묶인 청구별 납부 여부·무통장 계좌)를 같이 돌려준다
        const order = await getBundleOrderForParent(orderId, parent.appUserId).catch(() => null);
        if (!result.ok) {
            const retryable = "retryable" in result && result.retryable;
            return NextResponse.json({ ...result, order }, { status: retryable ? 202 : 400 });
        }
        return NextResponse.json({ ...result, order });
    } catch (error) {
        console.error("[mypage/payments/confirm] POST failed:", error);
        return NextResponse.json({ error: "결제 승인 중 오류가 발생했습니다." }, { status: 500 });
    }
}
