import type { Metadata } from "next";
import Link from "next/link";
import PublicPageLayout from "@/components/PublicPageLayout";
import { getTrialPaymentPageData } from "@/lib/trial-fee/trialFeePaymentService";
import { tossFailMessage } from "@/lib/payments/tossFailMessage";
import TrialVisitGuide from "../../TrialVisitGuide";
import TrialFeeCheckoutClient, { TrialVirtualAccountBox } from "../TrialFeeCheckoutClient";

// 체험비 결제 화면 — 신청 완료 화면의 «체험비 결제하기» 링크(토큰)로만 들어온다. 검색에 걸리면 안 된다.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: "체험수업비 결제 | STIZ 농구교실",
    robots: { index: false, follow: false },
};

export default async function TrialFeePayPage({
    params,
    searchParams,
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ failed?: string; code?: string }>;
}) {
    const { token } = await params;
    const query = await searchParams;
    const data = await getTrialPaymentPageData(token);
    // 결제창 실패·취소로 돌아왔을 때 — 주소의 message 는 쓰지 않고 코드별 정해진 문장만(tossFailMessage)
    const failNotice = query.failed ? tossFailMessage(query.code) : null;

    return (
        <PublicPageLayout>
            <section className="public-content-section bg-[var(--color-public-tint)] py-6 md:py-10">
                <div className="mx-auto max-w-md space-y-3 px-4">
                    <h1 className="text-2xl font-black text-[var(--color-public-ink)]">체험수업비 결제</h1>
                    {data.state === "NOT_FOUND" ? (
                        <div className="rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-5 text-sm text-[var(--color-public-ink)]">
                            <p className="font-bold">결제 링크를 찾을 수 없어요.</p>
                            <p className="mt-1 text-[var(--color-public-muted)]">같은 아이 이름·연락처로 체험수업 신청서를 다시 내면 새 결제 링크가 나와요.</p>
                            <Link href="/apply/trial" className="mt-3 inline-flex min-h-11 items-center font-bold underline">체험수업 신청하기</Link>
                        </div>
                    ) : (
                        <div className="space-y-3 rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-4">
                            {/* 핵심 정보 한 줄: 아이 · 희망 일정 · 금액 */}
                            <p className="text-sm text-[var(--color-public-muted)]">
                                <span className="font-bold text-[var(--color-public-ink)]">{data.childName}</span>
                                {data.preferredSchedule ? ` · ${data.preferredSchedule}` : ""} · {data.amountLabel}
                            </p>
                            {failNotice && data.state === "READY" && (
                                <p role="alert" className="rounded-lg border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-2 text-sm font-bold text-[var(--color-public-ink)]">{failNotice}</p>
                            )}
                            {data.state === "PAID" && (
                                <p className="rounded-lg bg-[var(--color-public-tint)] p-3 text-sm font-bold text-[var(--color-public-ink)]">체험수업비 결제가 완료됐어요. 체험수업이 확정됐어요.</p>
                            )}
                            {data.state === "CLOSED" && (
                                <p className="text-sm text-[var(--color-public-ink)]">이 신청은 지금 결제할 수 없어요. 학원에 문의해 주세요.</p>
                            )}
                            {data.state === "PAYMENT_OFF" && (
                                <p className="text-sm text-[var(--color-public-ink)]">지금은 온라인 결제를 쓸 수 없어요. 학원에 문의해 주세요.</p>
                            )}
                            {data.state === "WAITING_DEPOSIT" && data.virtualAccount && <TrialVirtualAccountBox account={data.virtualAccount} />}
                            {data.state === "READY" && (
                                <>
                                    {data.virtualAccount?.expired && <TrialVirtualAccountBox account={data.virtualAccount} />}
                                    <TrialFeeCheckoutClient token={token} amountLabel={data.amountLabel} />
                                </>
                            )}
                            <TrialVisitGuide feeLabel={data.amountLabel} onlinePayment />
                            {data.contactPhone && (
                                <p className="text-xs text-[var(--color-public-muted)]">
                                    문의 <a href={`tel:${data.contactPhone.replace(/-/g, "")}`} className="font-bold underline">{data.contactPhone}</a>
                                </p>
                            )}
                        </div>
                    )}
                </div>
            </section>
        </PublicPageLayout>
    );
}
