import { createClient } from "@/lib/supabase/server";
import { getMyPageHistory } from "@/lib/queries";
import { requireVerifiedParent } from "@/lib/auth-guard";
import Link from "next/link";
import HistoryClient from "./HistoryClient";

// 출결·수납 전체 히스토리는 실시간 데이터 필요 (자녀 보안 체크)
export const dynamic = "force-dynamic";

export default async function MyPageHistoryPage({
    searchParams,
}: {
    // ?child=<studentId> 로 진입 자녀를 선택 (Next 16: searchParams는 Promise)
    searchParams: Promise<{ child?: string }>;
}) {
    // 로그인 확인
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">로그인이 필요합니다</h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">출결·수납 히스토리는 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold px-6 py-3 rounded-xl hover:bg-orange-600 transition"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // 인증 게이트가 검증한 부모 User.id(appUserId)를 조회 기준으로 사용 (이메일 매칭 없음)
    const parentAuth = await requireVerifiedParent();
    const data = await getMyPageHistory(parentAuth.appUserId);

    if (!data || data.children.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">👋</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">등록된 자녀가 없습니다</h2>
                <p className="text-gray-400 text-sm">학원에 자녀를 등록하시면 출결·수납 기록을 확인할 수 있습니다.</p>
            </div>
        );
    }

    const { child } = await searchParams;

    return <HistoryClient initialChildId={child}>{data.children}</HistoryClient>;
}
