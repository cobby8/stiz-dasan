import { NextRequest, NextResponse } from "next/server";
import { confirmTossPayment } from "@/lib/payment-ledger";
import { requireVerifiedParent } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
    try {
        const user = await requireVerifiedParent();
        if (!user.email) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }

        const body = await req.json();
        const paymentKey = String(body?.paymentKey || "");
        const orderId = String(body?.orderId || "");
        const amount = Number(body?.amount || 0);
        const invoiceId = typeof body?.invoiceId === "string" && body.invoiceId.trim()
            ? body.invoiceId.trim()
            : null;

        if (!paymentKey || !orderId || !Number.isFinite(amount) || amount <= 0) {
            return NextResponse.json({ error: "결제 승인 정보가 부족합니다." }, { status: 400 });
        }

        const result = await confirmTossPayment({
            paymentKey,
            orderId,
            amount,
            invoiceId,
            owner: { authUserId: user.id, email: user.email ?? null },
        });
        if (!result.ok) {
            const retryable = "retryable" in result && result.retryable;
            return NextResponse.json(result, { status: retryable ? 202 : 400 });
        }

        return NextResponse.json(result);
    } catch (error) {
        console.error("[payments/toss/confirm] failed:", error);
        if (error instanceof Error && error.message.includes("인증")) {
            return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
        }
        return NextResponse.json({ error: "결제 승인 중 오류가 발생했습니다." }, { status: 500 });
    }
}
