import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { getInvoiceForGuest, getPaymentProviderConfig, getVirtualAccountState } from "@/lib/payment-ledger";
import { formatKstDate } from "@/lib/datetime/kst";
import { maskNameInText, maskStudentName, toGuestVirtualAccountView } from "@/lib/payments/guestPayLinkRules";
import { BUNDLE_BLOCK_MESSAGE } from "@/lib/payments/checkoutBundle";
import { tossFailMessage } from "@/lib/payments/tossFailMessage";
import {
    guestPayClientIp,
    guestPayContactPhone,
    guestPayFailDelay,
    guestPayRateLimitOk,
    resolveGuestPayLink,
} from "@/lib/payments/guestPayLinkService";
import PaymentCheckoutClient from "@/app/payments/[invoiceId]/PaymentCheckoutClient";
import GuestPayInvalid from "../GuestPayInvalid";

// 비회원 결제 링크 — 청구 안내 문자·알림톡 또는 원장이 보낸 링크(토큰)로만 들어온다.
// 로그인 없이 «그 청구서 한 장»만 보인다. 검색·캐시·리퍼러 금지(next.config 의 /pay 머리글과 짝).
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
    title: "수강료 결제 | STIZ 농구교실",
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
};

function formatAmount(amount: number) {
    return `${amount.toLocaleString("ko-KR")}원`;
}

// 날짜는 한국 달력 기준(서버는 UTC)
function formatDate(value: Date | string | null) {
    return formatKstDate(value, undefined, "-");
}

export default async function GuestPayPage({
    params,
    searchParams,
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ failed?: string; code?: string }>;
}) {
    const { token } = await params;
    const query = await searchParams;

    // 같은 주소(IP)에서 너무 자주 열면 막는다(잘못된 링크와 같은 화면 — 이유를 구분하지 않는다)
    if (!guestPayRateLimitOk(guestPayClientIp(await headers()), "page")) {
        return <GuestPayInvalid contactPhone={await guestPayContactPhone()} />;
    }
    const link = await resolveGuestPayLink(token);
    const invoice = link.state === "INVALID" ? null : await getInvoiceForGuest(link.invoiceId);
    if (link.state === "INVALID" || !invoice) {
        await guestPayFailDelay();
        return <GuestPayInvalid contactPhone={await guestPayContactPhone()} />;
    }

    // 아이 이름은 가운데를 가린다(권민호 → 권○호). 제목·설명에 이름이 적혀 있어도 같이 가린다.
    const maskedName = maskStudentName(invoice.studentName);
    const title = maskNameInText(invoice.title, invoice.studentName);
    const description = maskNameInText(invoice.description, invoice.studentName);

    const isPaid = link.state === "PAID";
    // 랠리즈 사본 청구는 랠리즈에서 결제한다(사이트 결제 막음 — 원장 결정 D4)
    const rallyzMirror = invoice.rallyzMirror === true;
    // 입금 계좌는 필요한 칸만(예금주 이름 등 개인정보 칸 제외 — 검수 권장 3)
    const virtualAccount = !isPaid && !rallyzMirror ? toGuestVirtualAccountView(await getVirtualAccountState(invoice.invoiceId)) : null;
    const waitingDeposit = Boolean(virtualAccount && !virtualAccount.expired);
    // 묶음 결제로 받은 계좌면 금액이 이 청구보다 크다 — 합계를 입금해야 한다고 알린다
    const bundledAccount = Boolean(virtualAccount && virtualAccount.amount !== Number(invoice.amount));
    const isOverdue = !isPaid && invoice.paymentStatus === "OVERDUE";
    const statusLabel = isPaid ? "납부 완료" : waitingDeposit ? "입금 대기" : isOverdue ? "연체" : "미납";
    // 상태 칩 색 — 학원 앱 토큰만
    const statusClass = isPaid
        ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
        : isOverdue && !waitingDeposit
            ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
            : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]";
    // 결제창 실패·취소로 돌아왔을 때 — 주소의 message 는 쓰지 않고 코드별 정해진 문장만
    const failNotice = query.failed && !isPaid ? tossFailMessage(query.code) : null;
    const providerConfig = getPaymentProviderConfig();

    return (
        <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
            {/* 청구 정보 한 덩어리: 항목·상태 / 아이·납기 / 금액(주인공 숫자) / 청구 내용 / 번호 */}
            <section className="academy-panel p-4">
                <div className="flex items-start justify-between gap-2">
                    <h1 className="min-w-0 break-keep text-base font-bold text-[var(--color-academy-ink)]">{title || "수강료"}</h1>
                    <span className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClass}`}>
                        {statusLabel}
                    </span>
                </div>
                <p className="mt-0.5 text-sm text-[var(--color-academy-muted)]">
                    {maskedName} · 납기 {formatDate(invoice.dueDate)}
                </p>
                <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--color-academy-ink)]">
                    {formatAmount(Number(invoice.amount))}
                </p>
                {description && description !== title && (
                    <p className="mt-1 text-sm text-[var(--color-academy-ink)]">{description}</p>
                )}
                <p className="mt-2 break-all text-xs text-[var(--color-academy-muted)]">청구 번호 {invoice.invoiceNo}</p>
            </section>

            {isPaid ? (
                // 납부 완료 — 표시만(영수증 링크는 두지 않는다: 링크를 받은 다른 사람에게 카드 영수증 노출 방지)
                <p className="academy-panel p-3 text-sm font-semibold text-[var(--color-academy-success)]">
                    납부 완료 · {formatDate(invoice.paidDate || invoice.paidAt)}
                </p>
            ) : rallyzMirror ? (
                <p className="academy-panel p-3 text-sm text-[var(--color-academy-ink)]">{BUNDLE_BLOCK_MESSAGE.RALLYZ_MIRROR}</p>
            ) : (
                <section aria-label="결제" className="academy-panel p-3">
                    {failNotice && (
                        <p role="alert" className="mb-3 rounded-lg bg-[var(--color-academy-danger-soft)] p-2 text-sm font-medium text-[var(--color-academy-danger)]">
                            {failNotice}
                        </p>
                    )}
                    {bundledAccount && virtualAccount && (
                        <p className="mb-3 rounded-lg bg-[var(--color-academy-warning-soft)] p-2 text-sm font-medium text-[var(--color-academy-ink)]">
                            여러 청구를 묶은 계좌 · 합계 {formatAmount(virtualAccount.amount)}
                            <span className="block text-xs font-normal text-[var(--color-academy-muted)]">합계를 한 번에 입금해 주세요.</span>
                        </p>
                    )}
                    <PaymentCheckoutClient
                        invoiceId={invoice.invoiceId}
                        providerReady={providerConfig.providerReady && providerConfig.provider === "TOSS"}
                        provider={providerConfig.provider}
                        providerLabel={providerConfig.providerLabel}
                        amount={Number(invoice.amount)}
                        virtualAccount={virtualAccount}
                        guestToken={token}
                    />
                </section>
            )}

            {/* 가입 안내 한 줄 — 결제는 가입 없이 되고, 가입하면 더 볼 수 있다는 것만 */}
            <p className="flex min-h-11 flex-wrap items-center justify-center gap-x-2 text-xs text-[var(--color-academy-muted)]">
                앱에 가입하면 출결·셔틀도 볼 수 있어요
                <Link href="/signup/parent" prefetch={false} className="inline-flex min-h-11 items-center font-medium text-[var(--color-academy-ink)] underline">
                    가입하기
                </Link>
            </p>
        </main>
    );
}
