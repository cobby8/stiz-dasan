import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import PaymentSuccessClient from "@/app/payments/success/PaymentSuccessClient";
import {
    guestPayClientIp,
    guestPayContactPhone,
    guestPayFailDelay,
    guestPayRateLimitOk,
    resolveGuestPayLink,
} from "@/lib/payments/guestPayLinkService";
import GuestPayInvalid from "../../GuestPayInvalid";

// 비회원 결제창 복귀 화면 — 로그인 없이 결과(승인·입금 계좌)를 본다. 승인은 화면이 토큰 승인 API 를 부른다.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: "결제 확인 | STIZ 농구교실",
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
};

export default async function GuestPaySuccessPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    if (!guestPayRateLimitOk(guestPayClientIp(await headers()), "page")) {
        return <GuestPayInvalid contactPhone={await guestPayContactPhone()} />;
    }
    // 잘못된 링크면 승인 화면을 그리지 않는다(사용 횟수는 늘리지 않는다 — 결제 화면에서 이미 셌다)
    const link = await resolveGuestPayLink(token, { touch: false });
    if (link.state === "INVALID") {
        await guestPayFailDelay();
        return <GuestPayInvalid contactPhone={await guestPayContactPhone()} />;
    }

    return (
        <main className="min-h-screen bg-[var(--color-academy-soft)] px-4 py-12 text-[var(--color-academy-ink)]">
            <Suspense fallback={(
                <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-8 text-center shadow-sm">
                    <p className="font-medium">결제 승인 확인 중...</p>
                </div>
            )}>
                <PaymentSuccessClient guestToken={token} />
            </Suspense>
        </main>
    );
}
