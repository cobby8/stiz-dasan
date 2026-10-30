import { createClient } from "@/lib/supabase/server";
import { getStudentReports } from "@/lib/queries";
import { requireVerifiedParent } from "@/lib/auth-guard";
import Link from "next/link";
import { kstLabel } from "@/lib/datetime/kst";
// 달별 묶음 — 서버(UTC)에서 toLocaleDateString 을 쓰면 한국 자정 수업이 전날로 찍혀서 KST 모듈 기반 공용 함수를 쓴다
import { groupByKstMonth } from "@/components/admin/list/monthDateGroups";

// 학부모 리포트 목록은 실시간 데이터 필요 (자녀 보안 체크)
export const dynamic = "force-dynamic";

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

export default async function ParentReportsPage() {
    // 로그인 확인
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">로그인이 필요합니다</h2>
                <p className="text-gray-500 dark:text-gray-400 mb-6">수업 리포트는 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold px-6 py-3 rounded-xl hover:bg-orange-600 transition"
                >
                    로그인하기
                </Link>
            </div>
        );
    }

    // 인증 게이트가 검증한 부모 User.id(appUserId)를 조회 기준으로 사용
    // (이메일 매칭 제거 — 소셜/이메일 불일치 시 자녀를 못 찾던 버그 수정)
    const parentAuth = await requireVerifiedParent();
    const parentId = parentAuth.appUserId;
    if (!parentId) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">👋</div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">등록된 정보가 없습니다</h2>
                <p className="text-gray-400 text-sm">학원에 등록 후 이용할 수 있습니다.</p>
            </div>
        );
    }

    // 내 자녀의 발행된 리포트만 조회 (보안: parentId 필터링)
    const reports = await getStudentReports(parentId);

    return (
        <div>
            <div className="mb-6">
                <Link
                    href="/mypage"
                    className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-200 flex items-center gap-1 mb-2"
                >
                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                    마이페이지
                </Link>
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">수업 리포트</h1>
                <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">코치가 작성한 수업 리포트를 확인하세요.</p>
            </div>

            {reports.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
                    아직 발행된 수업 리포트가 없습니다.
                </div>
            ) : (
                <div className="space-y-3">
                    {groupByKstMonth(reports, (r) => r.date).map((group) => (
                        // 달별 묶음 — 제목 오른쪽에 그 달 리포트 수
                        <section key={group.month} aria-label={group.label} className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white dark:border-gray-700 dark:bg-gray-800">
                            <h2 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)] dark:bg-gray-900 dark:text-gray-100">
                                <span>{group.label}</span>
                                <span className="tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                            </h2>
                            <ul className="divide-y divide-[var(--color-academy-line)] dark:divide-gray-700">
                                {group.items.map(({ item: r, ymd }) => (
                                    <li key={r.sessionId}>
                                        {/* 행 전체가 상세 리포트로 가는 링크(기존과 같은 주소). 터치 44px 이상 */}
                                        <Link
                                            href={`/mypage/reports/${r.sessionId}`}
                                            className="flex min-h-14 items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)] dark:hover:bg-gray-700/40"
                                        >
                                            <div className="min-w-0 flex-1">
                                                {/* 1줄: 주제(줄바꿈 허용, 말줄임 없음) · 날짜(오른쪽, 숫자 폭 고정) */}
                                                <div className="flex items-start gap-2">
                                                    <p className="min-w-0 flex-1 break-keep text-sm font-bold text-gray-900 dark:text-white">{r.topic || "수업 리포트"}</p>
                                                    <span className="shrink-0 text-right text-sm tabular-nums text-gray-700 dark:text-gray-200">{kstLabel(ymd)}</span>
                                                </div>
                                                {/* 2줄: 반 · 요일 시간 · 담당 — «|»·괄호로 잇던 글을 요소로 나눔 */}
                                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-500 dark:text-gray-400">
                                                    <span className="break-keep">{r.className}</span>
                                                    <span className="tabular-nums">{DAY_LABELS[r.dayOfWeek] || r.dayOfWeek} {r.startTime}~{r.endTime}</span>
                                                    {r.coachName && <span>담당: {r.coachName}</span>}
                                                </div>
                                            </div>
                                            <span className="material-symbols-outlined shrink-0 text-gray-300" aria-hidden="true">chevron_right</span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </div>
    );
}
