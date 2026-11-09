import { Suspense } from "react";
import PaymentSuccessClient from "./PaymentSuccessClient";

export const dynamic = "force-dynamic";

export default function PaymentSuccessPage() {
    return (
        <main className="min-h-screen bg-[var(--color-academy-soft)] px-4 py-12 text-[var(--color-academy-ink)]">
            <Suspense fallback={<PaymentSuccessFallback />}>
                <PaymentSuccessClient />
            </Suspense>
        </main>
    );
}

function PaymentSuccessFallback() {
    return (
        <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
            <p className="font-bold">결제 승인 확인 중...</p>
        </div>
    );
}
