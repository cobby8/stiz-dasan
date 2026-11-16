import Link from "next/link";
import { todayKst } from "@/lib/datetime/kst";
// 연간일정 원본 — 공개 /annual·학부모 «연간 일정»·청구·휴무 판정과 같은 함수(구글 캘린더 + 관리자 등록 일정)
import { loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { buildParentYear, parseYearParam, shortDay } from "@/lib/mypage/parentSchedule";

export const dynamic = "force-dynamic";
export const metadata = { title: "학원 일정 | 스티즈 선생님" };

// 선생님·기사님 «학원 일정»(2026-11-16 원장 지시) — 메뉴에서 연다. 로그인 확인은 /staff 레이아웃(requireStaff)이 한다.
// 공개 /annual 은 설치 앱의 범위(/staff) 밖이라 누르면 앱을 벗어난다 → 같은 원본을 앱 안에서 보인다.
// 학부모 «연간 일정»(/mypage/annual)과 같은 함수(buildParentYear)로 뽑아 같은 줄이 보인다.
// 한 해 = 달마다 한 칸, 칸 안은 한 줄 행(날짜 · 제목 · 휴무). 일정이 없는 달은 그리지 않는다.

const YEAR_LINK = "inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]";

export default async function StaffAnnualPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const todayYmd = todayKst();
  const year = parseYearParam((await searchParams).year, todayYmd);
  // 조회가 실패해도 화면은 열린다(빈 해)
  const events = await loadAnnualPlanEvents().catch(() => []);
  const months = buildParentYear(events, year).filter((month) => month.events.length > 0);
  const thisMonth = todayYmd.slice(0, 7);

  return (
    <main className="mx-auto max-w-lg space-y-3 px-4 pb-8 pt-5">
      <header className="flex items-center justify-between gap-2">
        <h1 className="academy-heading min-w-0 flex-1">학원 일정</h1>
        <nav aria-label="해 이동" className="flex shrink-0 items-center">
          <Link href={`/staff/annual?year=${year - 1}`} aria-label="이전 해" className={YEAR_LINK}>
            <span aria-hidden="true" className="text-2xl leading-none">‹</span>
          </Link>
          <span className="whitespace-nowrap px-1 text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{year}년</span>
          <Link href={`/staff/annual?year=${year + 1}`} aria-label="다음 해" className={YEAR_LINK}>
            <span aria-hidden="true" className="text-2xl leading-none">›</span>
          </Link>
        </nav>
      </header>

      {/* 한 해가 길어 이번 달이 아래에 있다 — 한 번에 내려가는 바로가기(이번 달에 일정이 있을 때만) */}
      {months.some((month) => month.month === thisMonth) && (
        <a href={`#month-${thisMonth}`} className="academy-button-tonal academy-button-sm">이번 달로</a>
      )}

      {months.length === 0 ? (
        <p role="status" className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-3 text-sm text-[var(--color-academy-muted)]">
          {year}년에 등록된 일정이 아직 없습니다.
        </p>
      ) : (
        months.map((month) => {
          const monthNumber = Number(month.month.slice(5, 7));
          return (
            <section key={month.month} id={`month-${month.month}`} aria-label={`${monthNumber}월 일정`} className="scroll-mt-24 overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
              {/* 이번 달은 글자로 알린다(색만으로 구분하지 않게) */}
              <h2 className="academy-section-title flex min-h-11 items-center gap-1.5 border-b border-[var(--color-academy-line)] px-3">
                {monthNumber}월
                {month.month === thisMonth && <span className="text-xs font-semibold text-[var(--color-academy-secondary-ink)]">이번 달</span>}
              </h2>
              <ul className="divide-y divide-[var(--color-academy-line)]">
                {month.events.map((event) => (
                  <li key={`${event.startYmd}-${event.title}`} className="flex min-h-11 items-center gap-2 px-3 py-2">
                    <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--color-academy-muted)]">
                      {shortDay(event.startYmd)}{event.endYmd !== event.startYmd && `~${shortDay(event.endYmd)}`}
                    </span>
                    <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{event.title}</span>
                    {/* 휴무 꼬리표 — 학부모 «연간 일정»과 같은 회색 */}
                    {event.closed && <span className="shrink-0 rounded-full bg-[var(--color-academy-cal-closed-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-cal-closed)]">휴무</span>}
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </main>
  );
}
