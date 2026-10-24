import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function Cafe24PaymentSuccessPage({
    searchParams,
}: {
    searchParams: Promise<{ invoiceId?: string }>;
}) {
    const params = await searchParams;
    const invoiceId = typeof params.invoiceId === "string" && params.invoiceId.trim()
        ? params.invoiceId.trim()
        : null;
    const invoiceHref = invoiceId ? `/payments/${encodeURIComponent(invoiceId)}` : "/mypage";

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-12 text-gray-900 dark:bg-gray-950 dark:text-white">
            <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-200">
                    <span className="material-symbols-outlined text-2xl" aria-hidden="true">check_circle</span>
                </div>
                <h1 className="text-xl font-extrabold">본사 카페24 결제가 접수되었습니다.</h1>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    결제 완료 정보가 본사에서 도착하면 청구서가 자동으로 납부 완료 처리됩니다.
                    잠시 후 청구서를 다시 확인해 주세요.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Link
                        href={invoiceHref}
                        className="inline-flex rounded-xl bg-brand-orange-500 px-5 py-3 text-sm font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                    >
                        청구서 확인
                    </Link>
                    <Link
                        href="/mypage"
                        className="inline-flex rounded-xl border border-gray-200 px-5 py-3 text-sm font-bold text-gray-700 dark:border-gray-700 dark:text-gray-200"
                    >
                        마이페이지
                    </Link>
                </div>
            </div>
        </main>
    );
}
