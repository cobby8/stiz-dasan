import Link from "next/link";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getInvoiceForParent, getPaymentProviderConfig, getVirtualAccountState } from "@/lib/payment-ledger";
import { formatKstDate } from "@/lib/datetime/kst";
import { readPreferredPaymentMethod } from "@/lib/payments/preferredMethodStore";
import PaymentCheckoutClient from "./PaymentCheckoutClient";

export const dynamic = "force-dynamic";

function formatAmount(amount: number) {
    return `${amount.toLocaleString("ko-KR")}원`;
}

// 날짜는 한국 달력 기준(서버는 UTC — toLocaleDateString 은 배포 서버에서 하루 밀릴 수 있었다)
function formatDate(value: Date | string | null) {
    return formatKstDate(value, undefined, "-");
}

export default async function PaymentPage({ params }: { params: Promise<{ invoiceId: string }> }) {
    const { invoiceId } = await params;
    const paymentPath = `/payments/${encodeURIComponent(invoiceId)}`;
    const user = await requireVerifiedParent().catch(() => null);
    if (!user) {
        redirect(`/login?redirect=${encodeURIComponent(paymentPath)}`);
    }
    const invoice = await getInvoiceForParent(invoiceId, { authUserId: user.id, email: user.email ?? null });
    const providerConfig = getPaymentProviderConfig();

    if (!invoice) {
        return (
            <main className="mx-auto max-w-lg px-4 py-8">
                <div className="academy-panel p-4 text-center">
                    <p className="font-bold text-[var(--color-academy-ink)]">청구서를 찾을 수 없어요</p>
                    <p className="mt-1 text-xs text-[var(--color-academy-muted)]">이 계정에 연결된 청구서만 볼 수 있어요.</p>
                    <Link href="/mypage" className="academy-button-primary mt-3 min-h-11 px-5 text-sm">
                        마이페이지
                    </Link>
                </div>
            </main>
        );
    }

    const isPaid = invoice.paymentStatus === "PAID" || invoice.invoiceStatus === "PAID";
    const isClosed = ["REFUNDED", "CANCELED"].includes(invoice.paymentStatus) || invoice.invoiceStatus === "CANCELED";
    const receiptHref = invoice.receiptUrl || invoice.transactionReceiptUrl || undefined;
    const isOverdue = !isPaid && !isClosed && invoice.paymentStatus === "OVERDUE";
    // 무통장입금 계좌(입금 대기·만료) — 소유권 확인(getInvoiceForParent) 뒤에만 읽는다. 학부모 화면용 칸만 온다.
    const virtualAccount = !isPaid && !isClosed ? await getVirtualAccountState(invoice.invoiceId) : null;
    // 지난번 결제 방법(본인 계정만, 못 읽으면 null — 결제 화면은 그대로 열린다)
    const preferredMethod = !isPaid && !isClosed ? await readPreferredPaymentMethod(user.appUserId) : null;
    const waitingDeposit = Boolean(virtualAccount && !virtualAccount.expired);
    // 묶음 결제(«한 번에 결제»)로 받은 계좌면 금액이 이 청구보다 크다 — 합계를 입금해야 한다고 알린다
    const bundledAccount = Boolean(virtualAccount && virtualAccount.amount !== Number(invoice.amount));
    const statusLabel = isPaid ? "납부 완료" : isClosed ? "청구 취소" : waitingDeposit ? "입금 대기" : isOverdue ? "연체" : "미납";
    // 상태 칩 색 — 학원 앱 토큰만 쓴다(하드코딩 색 금지)
    const statusClass = isPaid
        ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
        : isClosed
            ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
            : isOverdue && !waitingDeposit
                ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]";

    return (
        <main className="mx-auto max-w-lg space-y-3 px-4 py-4">
            <Link href="/mypage" className="academy-button-text min-h-11 text-sm">
                <span className="material-symbols-outlined text-lg leading-none" aria-hidden="true">chevron_left</span>
                마이페이지
            </Link>

            {/* 청구 정보 한 덩어리: 항목·상태 / 아이·납기 / 금액(주인공 숫자) / 청구 내용 / 번호·발행일(작게) */}
            <section className="academy-panel p-4">
                <div className="flex items-start justify-between gap-2">
                    <h1 className="min-w-0 break-keep text-base font-black text-[var(--color-academy-ink)]">{invoice.title}</h1>
                    <span className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-bold ${statusClass}`}>
                        {statusLabel}
                    </span>
                </div>
                <p className="mt-0.5 text-sm text-[var(--color-academy-muted)]">
                    {invoice.studentName} · 납기 {formatDate(invoice.dueDate)}
                </p>
                <p className="mt-2 text-2xl font-black tabular-nums text-[var(--color-academy-ink)]">
                    {formatAmount(Number(invoice.amount))}
                </p>
                {invoice.description && (
                    <p className="mt-1 text-sm text-[var(--color-academy-ink)]">{invoice.description}</p>
                )}
                <p className="mt-2 break-all text-xs text-[var(--color-academy-muted)]">
                    {invoice.invoiceNo} · 발행 {formatDate(invoice.issuedAt)}
                </p>
            </section>

            {isPaid ? (
                // 납부 완료 — 한 줄 + 영수증 버튼
                <section className="academy-panel flex items-center justify-between gap-2 p-3">
                    <p className="text-sm font-bold text-[var(--color-academy-success)]">
                        납부 완료 · {formatDate(invoice.paidDate || invoice.paidAt)}
                    </p>
                    {receiptHref && (
                        <a href={receiptHref} target="_blank" rel="noreferrer" className="academy-button-secondary min-h-11 shrink-0 px-4 text-sm">
                            영수증 보기
                        </a>
                    )}
                </section>
            ) : isClosed ? (
                <p className="academy-panel p-3 text-sm text-[var(--color-academy-muted)]">
                    취소된 청구라 결제할 수 없어요.
                </p>
            ) : (
                <section aria-label="결제" className="academy-panel p-3">
                    {bundledAccount && virtualAccount && (
                        // 묶음 결제로 받은 계좌 — 이 청구만이 아니라 합계를 입금해야 한다
                        <p className="mb-3 rounded-lg bg-[var(--color-academy-warning-soft)] p-2 text-sm font-bold text-[var(--color-academy-ink)]">
                            여러 청구를 묶은 계좌 · 합계 {formatAmount(virtualAccount.amount)}
                            <span className="block text-xs font-normal text-[var(--color-academy-muted)]">
                                합계를 한 번에 입금해 주세요.{" "}
                                <Link href="/mypage/payments" className="font-bold underline">청구 목록</Link>
                            </span>
                        </p>
                    )}
                    <PaymentCheckoutClient
                        invoiceId={invoice.invoiceId}
                        providerReady={providerConfig.providerReady}
                        provider={providerConfig.provider}
                        providerLabel={providerConfig.providerLabel}
                        amount={Number(invoice.amount)}
                        virtualAccount={virtualAccount}
                        preferredMethod={preferredMethod}
                    />
                </section>
            )}
        </main>
    );
}
