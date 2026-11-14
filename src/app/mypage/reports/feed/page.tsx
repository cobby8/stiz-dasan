import Link from "next/link";
import { requireVerifiedParent } from "@/lib/auth-guard";
// 학부모 화면 공용 «←» — 방금 있던 화면으로(기록이 없으면 고정 주소)
import ParentBackLink from "@/components/parent/ParentBackLink";
import { loadReportFeedFromStart, loadReportFeedPage, type ReportFeedPage } from "@/lib/feed/reportFeedServer";
import { REPORT_FEED_PAGE_SIZE, parseSessionIdParam, reportFeedHref } from "@/lib/feed/reportFeedRules";
import ReportFeedClient from "./ReportFeedClient";

// 학부모 리포트 피드는 실시간 데이터 필요(자녀 보안 체크)
export const dynamic = "force-dynamic";

/**
 * 수업 리포트 피드(2026-11-14 원장 요청) — 홈 «최신 수업 피드»·소식 탭의 리포트 줄을 누르면 오는 화면.
 * 수업 1회 = 게시물 하나를 세로로 이어 본다(인스타그램식). 최신이 위, 날짜가 바뀌는 곳에 구분줄.
 * ?start=<수업 id> 면 그 게시물 자리에서 시작한다(볼 수 없는 수업이면 그냥 맨 위부터).
 *
 * 볼 수 있는 범위는 소식 목록·상세와 같은 공개 기준(@/lib/feed/reportFeedServer → @/lib/feed/rules).
 */
export default async function ParentReportFeedPage({
    searchParams,
}: {
    searchParams: Promise<{ start?: string | string[] }>;
}) {
    // ── 1. 보호자 확인 — 레이아웃이 이미 한 확인을 그대로 쓴다(요청 단위 기억) ──
    const parentAuth = await requireVerifiedParent().catch(() => null);
    if (!parentAuth?.appUserId) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <h2 className="academy-heading mb-2">로그인이 필요합니다</h2>
                <p className="mb-6 text-[var(--color-academy-muted)]">수업 리포트는 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link href="/login" className="academy-button-primary">로그인하기</Link>
            </div>
        );
    }
    const parentId = parentAuth.appUserId;

    // ── 2. 시작 위치 — 주소 값은 모양부터 본다(틀리면 무시하고 맨 위부터) ──
    const { start } = await searchParams;
    const startId = parseSessionIdParam(Array.isArray(start) ? start[0] : start);

    // ── 3. 처음 장 — 실패하면 화면 전체를 깨뜨리지 않고 «다시 불러오기» 안내 ──
    let page: ReportFeedPage | null = null;
    let startFound = false;
    try {
        if (startId) {
            // 그 수업부터 보는 장 — 볼 수 없는 수업이면 null → 맨 위부터
            const fromStart = await loadReportFeedFromStart(parentId, startId, REPORT_FEED_PAGE_SIZE).catch((error) => {
                console.error("[mypage/reports/feed] 시작 위치 조회 실패 — 맨 위부터 보여 줌:", error);
                return null;
            });
            if (fromStart) {
                page = fromStart;
                startFound = true;
            }
        }
        if (!page) page = await loadReportFeedPage(parentId, null, REPORT_FEED_PAGE_SIZE);
    } catch (error) {
        console.error("[mypage/reports/feed] 처음 장 조회 실패:", error);
        page = null;
    }

    return (
        <div className="space-y-2">
            {/* 맨 위 «←» + 제목 한 줄 — 들어온 화면(홈·소식)으로 돌아간다. 기록이 없으면 소식 탭으로 */}
            <div className="flex items-center gap-2">
                <ParentBackLink fallbackHref="/mypage/reports" ariaLabel="뒤로" />
                <h1 className="academy-heading min-w-0 flex-1">수업 리포트</h1>
            </div>

            {page ? (
                <ReportFeedClient
                    initialPosts={page.posts}
                    initialCursor={page.nextCursor}
                    startId={startFound ? startId : null}
                />
            ) : (
                // 목록 본체를 못 받았을 때 — 같은 주소를 다시 연다
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-4 text-center">
                    <p className="text-sm text-[var(--color-academy-muted)]">수업 리포트를 불러오지 못했어요.</p>
                    <Link
                        href={reportFeedHref(startId)}
                        className="academy-button-secondary mt-2 inline-flex min-h-11 items-center"
                    >
                        다시 불러오기
                    </Link>
                </div>
            )}
        </div>
    );
}
