import Link from "next/link";
import PublicSiteTheme from "@/components/PublicSiteTheme";

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
        <PublicSiteTheme publicScope>
        <main className="min-h-screen bg-[var(--color-public-tint)] px-4 py-12 text-[var(--color-public-ink)]">
            <div className="mx-auto max-w-lg rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-8 text-center shadow-sm">
                <h1 className="text-xl font-bold">결제가 완료되지 않았습니다</h1>
                <p className="mt-4 break-keep text-sm text-[var(--color-public-muted)]">{message}</p>
                <Link
                    href="/programs"
                    className="public-btn-primary mt-6 text-sm"
                >
                    프로그램 안내로 돌아가기
                </Link>
            </div>
        </main>
        </PublicSiteTheme>
    );
}
