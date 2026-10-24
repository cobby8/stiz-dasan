import Link from "next/link";

export const dynamic = "force-dynamic";

/** 가맹 심사용 테스트 결제 — 결제창에서 취소·실패하고 돌아온 화면. */
export default async function ReviewPaymentFailPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const params = await searchParams;
    const message = typeof params.message === "string" && params.message ? params.message.slice(0, 200) : "결제가 취소되었습니다.";

    return (
        <main className="min-h-screen bg-gray-50 px-4 py-12 text-gray-900 dark:bg-gray-950 dark:text-white">
            <div className="mx-auto max-w-lg rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <h1 className="text-xl font-black">결제가 완료되지 않았습니다</h1>
                <p className="mt-4 break-keep text-sm text-gray-600 dark:text-gray-300">{message}</p>
                <Link
                    href="/programs"
                    className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-orange-500 px-5 text-sm font-black text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    프로그램 안내로 돌아가기
                </Link>
            </div>
        </main>
    );
}
