import { createClient } from "@/lib/supabase/server";
import { getStudentReports, getMyPageData, getNoticesByClassIds, getChildrenFeedbacks, getGalleryByClassIds } from "@/lib/queries";
import { requireVerifiedParent } from "@/lib/auth-guard";
import Link from "next/link";
import { kstLabel, formatKstDate, todayKst } from "@/lib/datetime/kst";
// 공지 3개월 기준 — 일정 탭과 같은 순수 함수 모듈(KST 달력 날짜로 비교)
import { recentNotices } from "@/lib/mypage/parentSchedule";
// 설치된 학부모 앱은 /mypage 밖으로 나가면 돌아올 길이 없다 — 공개 홈페이지 길잡이는 감추고(HideInInstalledApp),
// 사진처럼 링크가 곧 내용인 자리는 이동만 막는다(AppSafeLink).
import HideInInstalledApp from "@/components/pwa/HideInInstalledApp";
import AppSafeLink from "@/components/pwa/AppSafeLink";
// 달별 묶음 — 서버(UTC)에서 toLocaleDateString 을 쓰면 한국 자정 수업이 전날로 찍혀서 KST 모듈 기반 공용 함수를 쓴다
import { groupByKstMonth } from "@/components/admin/list/monthDateGroups";

// 학부모 리포트 목록은 실시간 데이터 필요 (자녀 보안 체크)
export const dynamic = "force-dynamic";

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 학습 피드백 종류 라벨(홈에 있던 것과 같은 값)
const FB_CATEGORIES: Record<string, string> = {
    SKILL: "기술", ATTITUDE: "태도", PHYSICAL: "체력", GENERAL: "종합",
};

// «소식» 탭 (2026-11-09 원장 결정 D7) — 공지·수업 리포트·학습 피드백·수업 사진을 한 화면에 모은다.
// 예전엔 리포트만 이 화면에 있고, 공지·피드백·사진은 홈 아래쪽에 흩어져 있었다(피드백은 접힌 칸).
// 주소 /mypage/reports 는 그대로(문자로 나간 링크·앱 바로가기 보호), 리포트 상세 링크도 그대로다.

export default async function ParentReportsPage() {
    // 로그인 확인
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="text-5xl mb-4">🔒</div>
                <h2 className="text-xl font-bold text-[var(--color-academy-ink)] mb-2">로그인이 필요합니다</h2>
                <p className="text-[var(--color-academy-muted)] mb-6">수업 리포트는 학부모 계정으로 로그인 후 확인할 수 있습니다.</p>
                <Link
                    href="/login"
                    className="bg-[var(--color-academy-primary)] text-white font-bold px-6 py-3 rounded-xl hover:bg-[var(--color-academy-primary-hover)] transition"
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
                <h2 className="text-xl font-bold text-[var(--color-academy-ink)] mb-2">등록된 정보가 없습니다</h2>
                <p className="text-[var(--color-academy-faint)] text-sm">학원에 등록 후 이용할 수 있습니다.</p>
            </div>
        );
    }

    // 내 자녀의 발행된 리포트만 조회 (보안: parentId 필터링)
    // 공지·사진은 우리 아이 반 기준, 피드백은 우리 아이 기준(홈과 같은 조회 함수·같은 범위).
    const [reports, home] = await Promise.all([getStudentReports(parentId), getMyPageData(parentId)]);
    const childList = home?.children ?? [];
    const classIds = childList.flatMap((c) =>
        c.enrollments.map((e: { classId: string | null }) => e.classId).filter((v): v is string => typeof v === "string" && v.length > 0),
    );
    const studentIds = childList.map((c) => c.id);
    const [allNotices, feedbacks, gallery] = await Promise.all([
        getNoticesByClassIds(classIds, 10),
        getChildrenFeedbacks(studentIds),
        getGalleryByClassIds(classIds, 12),
    ]);
    // 공지(2026-11-09 원장 지시): 3개월 넘은 공지는 숨기고, 처음엔 3개만 — 나머지는 «더보기»로 펼친다
    const notices = recentNotices(allNotices, todayKst());
    const NOTICE_FIRST = 3;
    // 사진 묶음마다 첫 장만 타일로(홈에서 쓰던 방식 그대로)
    const photos = gallery.flatMap((g: { id: string; title: string | null; mediaJSON: string }) => {
        let media: { url: string; type: string }[] = [];
        try { media = JSON.parse(g.mediaJSON); } catch {}
        return media[0] ? [{ id: g.id, title: g.title, first: media[0] }] : [];
    });

    // 맨 위 칩 = 같은 화면 안의 칸으로 이동(접힌 칸 없음). 건수가 0 인 칸은 칩도 칸도 숨긴다.
    // 칩 이름은 짧게 — 좁은 휴대폰(360px)에서도 칩 4개가 한 줄에 들어가게(칸 제목은 그대로)
    const sections = [
        { id: "news-notices", label: "공지", count: notices.length },
        { id: "news-reports", label: "리포트", count: reports.length },
        { id: "news-feedback", label: "피드백", count: feedbacks.length },
        { id: "news-photos", label: "사진", count: photos.length },
    ].filter((s) => s.count > 0 || s.id === "news-reports");

    // 공지 한 줄 행 — 처음 3개와 «더보기» 안의 나머지가 같은 모양
    const noticeRow = (n: (typeof notices)[number]) => (
        <li key={n.id}>
            <Link href={`/mypage/news/${n.id}`} className="flex min-h-14 items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]">
                <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">
                            {n.isPinned && <span className="mr-1 font-bold text-[var(--color-academy-warning)]">중요</span>}
                            {n.title}
                        </p>
                        <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-muted)]">{formatKstDate(n.createdAt, { month: "numeric", day: "numeric" })}</span>
                    </div>
                </div>
                <span className="material-symbols-outlined shrink-0 text-[var(--color-academy-faint)]" aria-hidden="true">chevron_right</span>
            </Link>
        </li>
    );

    return (
        <div className="space-y-4">
            <div>
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">소식</h1>
                <nav aria-label="소식 종류" className="mt-2 flex flex-wrap gap-1.5">
                    {sections.map((s) => (
                        <a key={s.id} href={`#${s.id}`}
                            className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-full border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2.5 text-sm font-bold text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]">
                            {s.label}<span className="tabular-nums text-[var(--color-academy-muted)]">{s.count}</span>
                        </a>
                    ))}
                </nav>
            </div>

            {/* 공지 — 한 줄 행. 상세는 앱 안(/mypage/news/[id])에서 연다(공개 /notices 는 앱 범위 밖) */}
            {notices.length > 0 && (
                <section id="news-notices" aria-labelledby="news-notices-heading" className="scroll-mt-24 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
                    <h2 id="news-notices-heading" className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)]">
                        <span>학원 공지</span>
                        <HideInInstalledApp>
                            <Link href="/notices" className="inline-flex min-h-11 items-center px-1 text-xs font-bold text-[var(--color-academy-ink)] underline">전체보기</Link>
                        </HideInInstalledApp>
                    </h2>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {notices.slice(0, NOTICE_FIRST).map((n) => noticeRow(n))}
                    </ul>
                    {/* 나머지 공지 — «더보기»를 누르면 같은 자리에서 펼친다(서버 화면이라 details 사용) */}
                    {notices.length > NOTICE_FIRST && (
                        <details className="group border-t border-[var(--color-academy-line)]">
                            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center gap-1 text-sm font-bold text-[var(--color-academy-ink)] group-open:hidden">
                                더보기 <span className="tabular-nums">{notices.length - NOTICE_FIRST}</span>
                                <span className="material-symbols-outlined leading-none" style={{ fontSize: "18px" }} aria-hidden="true">expand_more</span>
                            </summary>
                            <ul className="divide-y divide-[var(--color-academy-line)]">
                                {notices.slice(NOTICE_FIRST).map((n) => noticeRow(n))}
                            </ul>
                        </details>
                    )}
                </section>
            )}

            <h2 id="news-reports" className="scroll-mt-24 px-1 text-base font-bold text-[var(--color-academy-ink)]">수업 리포트</h2>
            {reports.length === 0 ? (
                <div className="bg-white rounded-xl border border-[var(--color-academy-line)] p-12 text-center text-[var(--color-academy-faint)]">
                    아직 발행된 수업 리포트가 없습니다.
                </div>
            ) : (
                <div className="space-y-3">
                    {groupByKstMonth(reports, (r) => r.date).map((group) => (
                        // 달별 묶음 — 제목 오른쪽에 그 달 리포트 수
                        <section key={group.month} aria-label={group.label} className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
                            <h2 className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)]">
                                <span>{group.label}</span>
                                <span className="tabular-nums text-[var(--color-academy-muted)]">{group.items.length}</span>
                            </h2>
                            <ul className="divide-y divide-[var(--color-academy-line)]">
                                {group.items.map(({ item: r, ymd }) => (
                                    <li key={r.sessionId}>
                                        {/* 행 전체가 상세 리포트로 가는 링크(기존과 같은 주소). 터치 44px 이상 */}
                                        <Link
                                            href={`/mypage/reports/${r.sessionId}`}
                                            className="flex min-h-14 items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]"
                                        >
                                            <div className="min-w-0 flex-1">
                                                {/* 1줄: 주제(줄바꿈 허용, 말줄임 없음) · 날짜(오른쪽, 숫자 폭 고정) */}
                                                <div className="flex items-start gap-2">
                                                    <p className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">{r.topic || "수업 리포트"}</p>
                                                    <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-muted)]">{kstLabel(ymd)}</span>
                                                </div>
                                                {/* 2줄: 반 · 요일 시간 · 담당 — «|»·괄호로 잇던 글을 요소로 나눔 */}
                                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-academy-muted)]">
                                                    <span className="break-keep">{r.className}</span>
                                                    <span className="tabular-nums">{DAY_LABELS[r.dayOfWeek] || r.dayOfWeek} {r.startTime}~{r.endTime}</span>
                                                    {r.coachName && <span>담당: {r.coachName}</span>}
                                                </div>
                                            </div>
                                            <span className="material-symbols-outlined shrink-0 text-[var(--color-academy-faint)]" aria-hidden="true">chevron_right</span>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            {/* 학습 피드백 — 한 줄 행, 누르면 그 행만 펼쳐 내용을 본다(행 단위 펼침 — 칸 전체를 접지 않는다) */}
            {feedbacks.length > 0 && (
                <section id="news-feedback" aria-labelledby="news-feedback-heading" className="scroll-mt-24 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-white">
                    <h2 id="news-feedback-heading" className="flex items-center justify-between bg-[var(--color-academy-soft)] px-3 py-1.5 text-sm font-bold text-[var(--color-academy-ink)]">
                        <span>학습 피드백</span>
                        <span className="tabular-nums text-[var(--color-academy-muted)]">{feedbacks.length}</span>
                    </h2>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {feedbacks.map((fb) => (
                            <li key={fb.id}>
                                <details className="group">
                                    <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-[var(--color-academy-soft)]">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-start gap-2">
                                                <p className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">{fb.title}</p>
                                                <span className="shrink-0 text-right text-sm tabular-nums text-[var(--color-academy-muted)]">{kstLabel(fb.sessionDate ?? fb.createdAt)}</span>
                                            </div>
                                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-academy-muted)]">
                                                <span>{fb.studentName}</span>
                                                <span>{FB_CATEGORIES[fb.category] || "종합"}</span>
                                                {fb.coachName && <span>{fb.coachName} 코치</span>}
                                                {fb.rating != null && fb.rating > 0 && (
                                                    <span className="text-[var(--color-academy-ink)]" aria-label={`별점 ${fb.rating}점`}>{"★".repeat(fb.rating)}{"☆".repeat(Math.max(0, 5 - fb.rating))}</span>
                                                )}
                                            </div>
                                        </div>
                                        <span className="material-symbols-outlined shrink-0 text-[var(--color-academy-faint)] transition-transform group-open:rotate-90" aria-hidden="true">chevron_right</span>
                                    </summary>
                                    <p className="whitespace-pre-wrap border-t border-[var(--color-academy-line)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">{fb.content}</p>
                                </details>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* 수업 사진 — 묶음마다 첫 장. 설치 앱에서는 공개 갤러리로 나가지 않게 이동만 막는다 */}
            {photos.length > 0 && (
                <section id="news-photos" aria-labelledby="news-photos-heading" className="scroll-mt-24">
                    <div className="mb-2 flex items-center justify-between px-1">
                        <h2 id="news-photos-heading" className="text-base font-bold text-[var(--color-academy-ink)]">수업 사진</h2>
                        <HideInInstalledApp>
                            <Link href="/gallery" className="inline-flex min-h-11 items-center px-1 text-xs font-bold text-[var(--color-academy-ink)] underline">전체보기</Link>
                        </HideInInstalledApp>
                    </div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {photos.map((g) => (
                            <AppSafeLink key={g.id} href="/gallery"
                                className="relative aspect-square overflow-hidden rounded-xl bg-[var(--color-academy-soft)]">
                                {g.first.type === "image" ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={g.first.url} alt={g.title || "수업 사진"} loading="lazy" className="h-full w-full object-cover" />
                                ) : (
                                    <video src={g.first.url} className="h-full w-full object-cover" muted />
                                )}
                            </AppSafeLink>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}
