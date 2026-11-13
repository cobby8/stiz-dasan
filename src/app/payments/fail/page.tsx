import Link from "next/link";
import { EASY_PAY_UNAVAILABLE_MESSAGE, isEasyPayUnavailableCode } from "@/lib/payments/tossFailMessage";

export const dynamic = "force-dynamic";

export default async function PaymentFailPage({
    searchParams,
}: {
    searchParams: Promise<{ message?: string; code?: string; invoiceId?: string }>;
}) {
    const params = await searchParams;
    const message = params.message || "결제가 완료되지 않았습니다.";
    const retryHref = params.invoiceId ? `/payments/${encodeURIComponent(params.invoiceId)}` : "/mypage";

    return (
        <main className="min-h-screen bg-[var(--color-academy-soft)] px-4 py-12 text-[var(--color-academy-ink)]">
            <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-academy-danger-soft)] text-2xl font-bold text-[var(--color-academy-danger)]">
                    !
                </div>
                <h1 className="text-xl font-extrabold">결제가 완료되지 않았습니다</h1>
                <p className="mt-2 text-sm text-[var(--color-academy-muted)]">{message}</p>
                {/* 간편결제 바로가기를 쓸 수 없어 돌아온 경우 — 정해 둔 문장만(주소 글은 쓰지 않는다) */}
                {isEasyPayUnavailableCode(params.code) && (
                    <p className="mt-2 text-sm font-bold text-[var(--color-academy-ink)]">{EASY_PAY_UNAVAILABLE_MESSAGE}</p>
                )}
                {params.code && (
                    <p className="mt-2 text-xs text-[var(--color-academy-faint)]">오류 코드: {params.code}</p>
                )}
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Link
                        href={retryHref}
                        className="inline-flex rounded-xl bg-[var(--color-academy-primary)] px-5 py-3 text-sm font-bold text-white"
                    >
                        {params.invoiceId ? "청구서로 돌아가기" : "마이페이지로 돌아가기"}
                    </Link>
                    {params.invoiceId && (
                        <Link
                            href="/mypage"
                            className="inline-flex rounded-xl border border-[var(--color-academy-line)] px-5 py-3 text-sm font-bold text-[var(--color-academy-muted)]"
                        >
                            마이페이지
                        </Link>
                    )}
                </div>
            </div>
        </main>
    );
}
