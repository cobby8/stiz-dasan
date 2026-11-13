import Link from "next/link";
import PublicSiteTheme from "@/components/PublicSiteTheme";
import { isReviewOrderId, readTossReviewConfig } from "@/lib/payments/tossReview";
import { describeTaxFreeMismatch } from "@/lib/payments/taxFree";

export const dynamic = "force-dynamic";

/**
 * 가맹 심사용 테스트 결제 — 결제창에서 돌아온 뒤 토스에 **승인**을 요청하고 결과를 보여준다.
 * 테스트 키 전용이라 실제 돈은 오가지 않으며, 청구서·납부 기록은 전혀 건드리지 않는다.
 * 금액을 바꿔 보내도 토스가 결제창에서 인증한 금액과 다르면 승인을 거절한다.
 */
export default async function ReviewPaymentSuccessPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const paymentKey = typeof params.paymentKey === "string" ? params.paymentKey : "";
    const orderId = typeof params.orderId === "string" ? params.orderId : "";
    const amount = Number(typeof params.amount === "string" ? params.amount : NaN);

    const result = await confirmReviewPayment({ paymentKey, orderId, amount });

    return (
        <PublicSiteTheme publicScope>
        <main className="min-h-screen bg-[var(--color-public-tint)] px-4 py-12 text-[var(--color-public-ink)]">
            <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-8 text-center shadow-sm">
                <h1 className="text-xl font-bold">{result.ok ? "테스트 결제가 완료되었습니다" : "결제를 완료하지 못했습니다"}</h1>
                {result.ok ? (
                    <div className="mt-4 space-y-1 text-sm text-[var(--color-public-muted)]">
                        <p>{result.orderName}</p>
                        <p className="text-2xl font-bold tabular-nums text-[var(--color-public-ink)]">{result.amount.toLocaleString("ko-KR")}원</p>
                        <p className="break-keep pt-2 text-xs text-[var(--color-public-muted)]">
                            테스트 결제라 실제 금액은 청구되지 않습니다. 수강료 납부는 학원에서 보내드리는 청구서로 진행됩니다.
                        </p>
                    </div>
                ) : (
                    <p className="mt-4 break-keep text-sm text-[var(--color-public-muted)]">{result.message}</p>
                )}
                <Link
                    href="/programs"
                    className="public-btn-primary mt-6 text-sm"
                >
                    프로그램 안내로 돌아가기
                </Link>
            </div>
        </main>
        </PublicSiteTheme>
    );
}

type ConfirmResult =
    | { ok: true; orderName: string; amount: number }
    | { ok: false; message: string };

async function confirmReviewPayment(input: { paymentKey: string; orderId: string; amount: number }): Promise<ConfirmResult> {
    const config = readTossReviewConfig(process.env);
    if (!config) return { ok: false, message: "지금은 온라인 결제를 사용할 수 없습니다." };
    if (!input.paymentKey || !isReviewOrderId(input.orderId) || !Number.isInteger(input.amount) || input.amount <= 0) {
        return { ok: false, message: "결제 정보가 올바르지 않습니다." };
    }

    try {
        const response = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
                "Content-Type": "application/json",
                // 새로고침으로 같은 승인을 두 번 보내도 한 번만 처리되게 한다.
                "Idempotency-Key": input.orderId,
            },
            body: JSON.stringify({ paymentKey: input.paymentKey, orderId: input.orderId, amount: input.amount }),
            cache: "no-store",
        });
        const data = (await response.json().catch(() => ({}))) as { orderName?: string; totalAmount?: number; taxFreeAmount?: number; suppliedAmount?: number; vat?: number; message?: string; code?: string };
        if (response.ok) {
            // 면세 처리 확인 — 아니어도 결제 완료 화면은 그대로, 서버 로그에만 경고를 남긴다.
            const taxFreeWarning = describeTaxFreeMismatch(data);
            if (taxFreeWarning) console.warn(`[toss-tax-free] orderId=${input.orderId} ${taxFreeWarning}`);
            return { ok: true, orderName: data.orderName ?? "수강료", amount: data.totalAmount ?? input.amount };
        }
        if (data.code === "ALREADY_PROCESSED_PAYMENT") {
            return { ok: true, orderName: "수강료", amount: input.amount };
        }
        return { ok: false, message: data.message ?? "결제 승인에 실패했습니다." };
    } catch {
        return { ok: false, message: "결제 승인 확인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." };
    }
}
