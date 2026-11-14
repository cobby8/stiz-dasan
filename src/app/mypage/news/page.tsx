import Link from "next/link";
import ParentBackLink from "@/components/parent/ParentBackLink";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { getMyPageData } from "@/lib/queries";
import { formatKstDate } from "@/lib/datetime/kst";
import { paginateList } from "@/lib/mypage/parentSchedule";
import { listParentNoticeLines } from "@/lib/mypage/parentNotices";

export const dynamic = "force-dynamic";
export const metadata = { title: "지난 공지 | 스티즈 농구교실" };

// «지난 공지» (2026-11-14 원장 결정표 c10) — 소식 탭은 최근 3개월·10건만 보여 오래된 공지를 다시 볼 길이 없었다.
// 볼 수 있는 공지 전부를 한 줄 행(날짜 · 제목)으로, 20건씩 쪽을 나눈다(?page=). 상세는 앱 안 /mypage/news/[id].
// 보이는 범위는 소식 탭·공지 상세와 같다: 전체 공지 + 우리 아이 반 공지.

const PAGE_SIZE = 20;
const PAGER_LINK = "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]";

export default async function ParentPastNoticesPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    const [{ page: pageParam }, home] = await Promise.all([searchParams, getMyPageData(parent.appUserId)]);
    const classIds = (home?.children ?? []).flatMap((c) =>
        c.enrollments.map((e: { classId: string | null }) => e.classId).filter((v): v is string => typeof v === "string" && v.length > 0),
    );
    // 조회가 실패해도 화면은 열린다(빈 목록 + 소식으로 돌아가는 길)
    const lines = await listParentNoticeLines(classIds).catch(() => []);
    const { items, page, totalPages, total } = paginateList(lines, pageParam, PAGE_SIZE);

    return (
        <div className="mx-auto grid max-w-2xl gap-3">
            <div className="flex items-center gap-2">
                <ParentBackLink fallbackHref="/mypage/reports#news-notices" ariaLabel="소식으로" className="academy-back-link" />
                <h1 className="academy-heading min-w-0 flex-1">지난 공지</h1>
                {total > 0 && <span className="shrink-0 text-sm tabular-nums text-[var(--color-academy-muted)]">{total}건</span>}
            </div>

            {items.length === 0 ? (
                <p className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-3 text-sm text-[var(--color-academy-muted)]">
                    공지가 아직 없어요
                </p>
            ) : (
                <ul className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
                    {items.map((n) => (
                        <li key={n.id}>
                            <Link href={`/mypage/news/${n.id}`} className="flex min-h-12 items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]">
                                {/* 해가 넘어간 공지도 섞이므로 날짜에 연도를 같이 보인다 */}
                                <span className="w-[5.5rem] shrink-0 text-sm tabular-nums text-[var(--color-academy-muted)]">
                                    {formatKstDate(n.createdAt, { year: "2-digit", month: "numeric", day: "numeric" })}
                                </span>
                                <span className="min-w-0 flex-1 break-keep text-sm font-medium text-[var(--color-academy-ink)]">
                                    {n.isPinned && <span className="mr-1 font-semibold text-[var(--color-academy-warning)]">중요</span>}
                                    {n.title}
                                </span>
                                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}

            {/* 쪽 이동 — 첫 쪽엔 «이전», 끝 쪽엔 «다음»을 그리지 않는다(눌러도 갈 곳 없는 버튼 금지) */}
            {totalPages > 1 && (
                <nav aria-label="쪽 이동" className="flex items-center justify-between">
                    {page > 1 ? <Link href={`/mypage/news?page=${page - 1}`} className={PAGER_LINK}>‹ 이전</Link> : <span className="min-w-16" />}
                    <span className="text-sm tabular-nums text-[var(--color-academy-muted)]">{page} / {totalPages}</span>
                    {page < totalPages ? <Link href={`/mypage/news?page=${page + 1}`} className={PAGER_LINK}>다음 ›</Link> : <span className="min-w-16" />}
                </nav>
            )}
        </div>
    );
}
