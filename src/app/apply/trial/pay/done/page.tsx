import type { Metadata } from "next";
import { Suspense } from "react";
import PublicPageLayout from "@/components/PublicPageLayout";
import TrialFeeDoneClient from "./TrialFeeDoneClient";

// 토스 결제창 성공 복귀 주소 — 여기서 서버 승인(/api/apply/trial-fee/confirm)을 부른다. 검색 제외.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: "체험수업비 결제 확인 | STIZ 농구교실",
    robots: { index: false, follow: false },
};

export default function TrialFeeDonePage() {
    return (
        <PublicPageLayout>
            <section className="public-content-section bg-[var(--color-public-tint)] py-6 md:py-10">
                <div className="mx-auto max-w-md px-4">
                    <Suspense fallback={<p className="text-sm font-bold text-[var(--color-public-ink)]">결제 확인 중...</p>}>
                        <TrialFeeDoneClient />
                    </Suspense>
                </div>
            </section>
        </PublicPageLayout>
    );
}
