import Link from "next/link";
import { redirect } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { todayKst } from "@/lib/datetime/kst";
// 연간일정 원본 — 공개 /annual·청구·«일정» 탭 달력과 같은 함수(구글 캘린더 + 관리자 등록 일정)
import { loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { buildParentYear, parseYearParam, shortDay } from "@/lib/mypage/parentSchedule";

export const dynamic = "force-dynamic";
export const metadata = { title: "연간 일정 | 스티즈 농구교실" };

// «연간 일정» 한눈에 보기 (2026-11-14 원장 결정표 c10) — 학부모 앱 안 화면.
// 공개 /annual 은 설치 앱의 범위(/mypage) 밖이라, 누르면 주소창이 뜨고 돌아올 길이 없다 → 같은 원본을 앱 안에서 보인다.
// 한 해 = 달마다 한 칸, 칸 안은 한 줄 행(날짜 · 제목 · 휴무). 일정이 없는 달은 그리지 않는다.
// 달력·출결은 «일정» 탭(/mypage/history)이 맡는다 — 달 제목을 누르면 그 달 달력으로 간다.

const YEAR_LINK = "inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]";

export default async function ParentAnnualPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) redirect("/mypage/continue?bounced=1");

    const todayYmd = todayKst();
    const year = parseYearParam((await searchParams).year, todayYmd);
    // 조회가 실패해도 화면은 열린다(빈 해)
    const events = await loadAnnualPlanEvents().catch(() => []);
    const months = buildParentYear(events, year).filter((m) => m.events.length > 0);
    const thisMonth = todayYmd.slice(0, 7);

    return (
        <div className="mx-auto grid max-w-2xl gap-3">
            <div className="flex items-center gap-2">
                <Link href="/mypage/history" aria-label="일정으로" className="academy-back-link">
                    <span aria-hidden="true">←</span>
                </Link>
                <h1 className="academy-heading min-w-0 flex-1">연간 일정</h1>
                <nav aria-label="해 이동" className="flex shrink-0 items-center">
                    <Link href={`/mypage/annual?year=${year - 1}`} aria-label="이전 해" className={YEAR_LINK}>
                        <span aria-hidden="true" className="text-2xl leading-none">‹</span>
                    </Link>
                    <span className="whitespace-nowrap px-1 text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{year}년</span>
                    <Link href={`/mypage/annual?year=${year + 1}`} aria-label="다음 해" className={YEAR_LINK}>
                        <span aria-hidden="true" className="text-2xl leading-none">›</span>
                    </Link>
                </nav>
            </div>

            {months.length === 0 ? (
                <p className="rounded-xl border border-[var(--color-academy-line)] bg-white px-3 py-3 text-sm text-[var(--color-academy-muted)]">
                    {year}년에 등록된 일정이 아직 없어요
                </p>
            ) : (
                months.map((m) => {
                    const monthNumber = Number(m.month.slice(5, 7));
                    return (
                        <section key={m.month} aria-label={`${monthNumber}월 일정`} className="academy-panel overflow-hidden">
                            {/* 달 제목 = 그 달 달력(«일정» 탭)으로 가는 링크. 이번 달은 글자로 알린다(색만으로 구분하지 않게) */}
                            <h2 className="border-b border-[var(--color-academy-line)]">
                                <Link href={`/mypage/history?month=${m.month}`} className="academy-section-title flex min-h-11 items-center justify-between gap-2 px-3 hover:bg-[var(--color-academy-soft)]">
                                    <span>
                                        {monthNumber}월
                                        {m.month === thisMonth && <span className="ml-1.5 text-xs font-semibold text-[var(--color-academy-secondary-ink)]">이번 달</span>}
                                    </span>
                                    <span className="text-sm font-normal text-[var(--color-academy-muted)]">달력 ›</span>
                                </Link>
                            </h2>
                            <ul className="divide-y divide-[var(--color-academy-line)]">
                                {m.events.map((ev) => (
                                    <li key={`${ev.startYmd}-${ev.title}`} className="flex min-h-11 items-center gap-2 px-3 py-2">
                                        <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--color-academy-muted)]">
                                            {shortDay(ev.startYmd)}{ev.endYmd !== ev.startYmd && `~${shortDay(ev.endYmd)}`}
                                        </span>
                                        <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{ev.title}</span>
                                        {/* 휴무 꼬리표 — «일정» 탭 달력의 «휴» 칸과 같은 회색 */}
                                        {ev.closed && <span className="shrink-0 rounded-full bg-[var(--color-academy-cal-closed-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-cal-closed)]">휴무</span>}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })
            )}
        </div>
    );
}
