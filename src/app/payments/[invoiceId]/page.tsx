import Link from "next/link";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getInvoiceForParent, getPaymentProviderConfig } from "@/lib/payment-ledger";
import PaymentCheckoutClient from "./PaymentCheckoutClient";

export const dynamic = "force-dynamic";

function formatAmount(amount: number) {
    return `${amount.toLocaleString("ko-KR")}원`;
}

function formatDate(value: Date | string | null) {
    if (!value) return "-";
    return new Date(value).toLocaleDateString("ko-KR");
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
            <main className="min-h-screen bg-gray-50 px-4 py-12 text-gray-900 dark:bg-gray-950 dark:text-white">
                <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
                    <p className="text-lg font-bold">청구서를 찾을 수 없습니다.</p>
                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                        로그인 계정에 연결된 청구서만 확인할 수 있습니다.
                    </p>
                    <Link
                        href="/mypage"
                        className="mt-6 inline-flex rounded-xl bg-brand-orange-500 px-5 py-3 text-sm font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                    >
                        마이페이지로 돌아가기
                    </Link>
                </div>
            </main>
        );
    }

    const isPaid = invoice.paymentStatus === "PAID" || invoice.invoiceStatus === "PAID";
    const isClosed = ["REFUNDED", "CANCELED"].includes(invoice.paymentStatus) || invoice.invoiceStatus === "CANCELED";
    const receiptHref = invoice.receiptUrl || invoice.transactionReceiptUrl || undefined;
    const isOverdue = !isPaid && !isClosed && invoice.paymentStatus === "OVERDUE";
    const statusLabel = isPaid ? "납부 완료" : isClosed ? "청구 취소" : isOverdue ? "연체" : "미납";
    const statusClass = isPaid
        ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-200"
        : isClosed
            ? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            : isOverdue
                ? "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200"
                : "bg-yellow-100 text-yellow-800 dark:bg-brand-neon-lime/15 dark:text-brand-neon-lime";

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-8 text-gray-900 dark:bg-gray-950 dark:text-white">
            <div className="mx-auto max-w-2xl">
                <Link href="/mypage" className="mb-5 inline-flex text-sm font-bold text-brand-orange-500 dark:text-brand-neon-lime">
                    마이페이지
                </Link>

                <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
                    <div className="bg-brand-navy-900 px-6 py-6 text-white dark:bg-gray-950">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs font-bold uppercase tracking-wide text-brand-orange-300 dark:text-brand-neon-lime">
                                    STIZ Invoice
                                </p>
                                <h1 className="mt-2 text-xl font-extrabold leading-snug sm:text-2xl">{invoice.title}</h1>
                                <p className="mt-2 text-sm text-white/70">
                                    {invoice.studentName} 학생 · {invoice.invoiceNo}
                                </p>
                            </div>
                            <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${statusClass}`}>
                                {statusLabel}
                            </span>
                        </div>
                    </div>

                    <div className="p-6">
                        <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 dark:border-gray-800 dark:bg-gray-800">
                            <p className="text-sm font-bold text-gray-500 dark:text-gray-400">청구 금액</p>
                            <p className="mt-2 text-3xl font-black text-gray-900 dark:text-white">
                                {formatAmount(Number(invoice.amount))}
                            </p>
                            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                납부 기한 {formatDate(invoice.dueDate)}
                            </p>
                        </div>

                        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
                            <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
                                <dt className="text-gray-500 dark:text-gray-400">학생</dt>
                                <dd className="mt-1 font-bold text-gray-900 dark:text-white">{invoice.studentName}</dd>
                            </div>
                            <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
                                <dt className="text-gray-500 dark:text-gray-400">청구서 번호</dt>
                                <dd className="mt-1 break-all font-bold text-gray-900 dark:text-white">{invoice.invoiceNo}</dd>
                            </div>
                            <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
                                <dt className="text-gray-500 dark:text-gray-400">발행일</dt>
                                <dd className="mt-1 font-bold text-gray-900 dark:text-white">{formatDate(invoice.issuedAt)}</dd>
                            </div>
                            <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-800">
                                <dt className="text-gray-500 dark:text-gray-400">납부 상태</dt>
                                <dd className="mt-1 font-bold text-gray-900 dark:text-white">{statusLabel}</dd>
                            </div>
                        </dl>

                        {invoice.description && (
                            <div className="mt-5 rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-800 dark:text-gray-300">
                                <p className="mb-1 font-bold text-gray-900 dark:text-white">청구 내용</p>
                                <p>{invoice.description}</p>
                            </div>
                        )}

                        {isPaid ? (
                            <div className="mt-6 rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-100">
                                <p className="font-bold">납부가 완료되었습니다.</p>
                                <p className="mt-1">납부일 {formatDate(invoice.paidDate || invoice.paidAt)}</p>
                                {receiptHref && (
                                    <a
                                        href={receiptHref}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="mt-3 inline-flex rounded-lg bg-green-600 px-4 py-2 font-bold text-white dark:bg-green-400 dark:text-gray-950"
                                    >
                                        영수증 보기
                                    </a>
                                )}
                            </div>
                        ) : isClosed ? (
                            <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200">
                                <p className="font-bold">결제할 수 없는 청구서입니다.</p>
                                <p className="mt-1">휴원, 퇴원, 이월 등으로 청구가 취소된 항목입니다.</p>
                            </div>
                        ) : (
                            <div className="mt-6 rounded-2xl border border-gray-100 p-4 dark:border-gray-800">
                                <div className="mb-4">
                                    <p className="font-extrabold text-gray-900 dark:text-white">온라인 납부</p>
                                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                        결제 완료 후 자동으로 납부 완료 상태로 반영됩니다.
                                    </p>
                                </div>
                                <PaymentCheckoutClient
                                    invoiceId={invoice.invoiceId}
                                    providerReady={providerConfig.providerReady}
                                    provider={providerConfig.provider}
                                    providerLabel={providerConfig.providerLabel}
                                    amount={Number(invoice.amount)}
                                />
                            </div>
                        )}

                        <div className="mt-5 flex flex-wrap justify-center gap-2">
                            <Link
                                href="/mypage"
                                className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                            >
                                마이페이지로 돌아가기
                            </Link>
                        </div>
                    </div>
                </section>
            </div>
        </main>
    );
}
