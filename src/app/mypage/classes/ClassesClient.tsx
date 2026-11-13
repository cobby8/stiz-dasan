"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ParentClassCard, ParentClassesOverview } from "@/lib/parent/classes-overview";
import { ATTENDANCE_CELL_LABEL, dayKo, type AttendanceCell, type ClassCardAction } from "@/lib/parent/classCards";
import { kstLabel } from "@/lib/datetime/kst";
import { TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import type { ParentTimelineView } from "@/lib/requests/parent-timeline-rules";
import RequestTimeline from "./RequestTimeline";
import { MonthCalendar } from "../history/ScheduleHub";
import { shiftMonth } from "@/lib/mypage/parentSchedule";
import type { ChildMonthView } from "@/lib/mypage/parentMonthViews";
import { useRememberedChild } from "../useRememberedChild";

// 학부모 «수업» 탭 화면 (2026-11-10 설계 B). 계산은 lib/parent/classCards.ts, 여기는 그리기만.
// 컴팩트 규칙: 카드 안쪽 여백 작게·정보는 적은 줄로·터치 44px·글자 12px 이상·색은 토큰만.

function Icon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  return <span className={`material-symbols-outlined leading-none ${className}`} style={{ fontSize: `${size}px` }} aria-hidden="true">{name}</span>;
}

/** 출결 한 칸의 모양 — 색만으로 구분하지 않는다(일정 탭 달력과 같은 모양: 출석 채운 점·지각 빈 고리·결석 ×) */
function AttendanceMark({ status }: { status: AttendanceCell["status"] }) {
  if (status === "PRESENT") return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full bg-[var(--color-academy-cal-present)]" />;
  if (status === "LATE") return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full border-2 border-[var(--color-academy-cal-late)]" />;
  if (status === "ABSENT" || status === "EXCUSED") {
    return <span aria-hidden="true" className="material-symbols-outlined shrink-0 font-bold leading-none text-[var(--color-academy-cal-absent)]" style={{ fontSize: "14px", fontVariationSettings: "'wght' 700" }}>close</span>;
  }
  return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full border border-[var(--color-academy-line-input)]" />;
}

/** «변경 ▾» 펼침 메뉴(반 변경·휴원·퇴원) — 바깥 누름·Esc 로 닫힌다(학부모 «⋯» 메뉴와 같은 방식) */
function ChangeMenu({ action }: { action: Extract<ClassCardAction, { key: "change" }> }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="academy-button-secondary w-full !gap-0.5 !px-1 text-sm leading-tight"
      >
        <span className="whitespace-nowrap">{action.label}</span>
        <Icon name="expand_more" size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-12 z-30 w-36 overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] py-1 shadow-lg">
          {action.items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex min-h-11 items-center px-3 text-sm font-medium text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
            >
              {item.label} 신청
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** 반 카드 한 장 — 제목+상태 / 시간·프로그램·코치·지점 / 다음 수업 / 최근 출결 / 셔틀 / 버튼 */
function ClassCard({ card }: { card: ParentClassCard }) {
  const meta = [`${dayKo(card.dayOfWeek)} ${card.startTime}~${card.endTime}`, card.programName, card.coachName ? `${card.coachName} 코치` : null, card.location]
    .filter(Boolean)
    .join(" · ");
  const next = card.paused
    ? null
    : card.startsOn
      ? `${kstLabel(card.startsOn)} 첫 수업`
      : card.nextClass
        ? `${kstLabel(card.nextClass)} ${card.startTime}`
        : card.planMissing
          ? "연간일정 확정 후 보여요"
          : "예정 없음";
  return (
    <article className="academy-panel !shadow-none p-3" aria-label={`${card.className} 반`}>
      <div className="flex items-start gap-2">
        <h3 className="academy-section-title min-w-0 flex-1 break-keep">{card.className}</h3>
        {/* 상태 칩 — 홈 «반 상태 한 줄»과 같은 함수·같은 말. 상태 표시는 모서리 4px(rounded) */}
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[card.chip.tone]}`}>{card.chip.text}</span>
      </div>
      <p className="mt-0.5 break-keep text-xs tabular-nums text-[var(--color-academy-muted)]">{meta}</p>

      {/* 다음 수업 · 최근 출결 4칸 — 한 줄(좁으면 두 줄) */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        {next && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="text-[var(--color-academy-muted)]">다음</span>
            <span className="font-semibold tabular-nums text-[var(--color-academy-ink)]">{next}</span>
          </span>
        )}
        {/* 이번 달 출석 n/m회(2026-11-14 w4) — 기록이 없으면 줄을 빼고 최근 출결 칸만 */}
        {card.monthAttendance && (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <span className="text-[var(--color-academy-muted)]">이번 달 출석</span>
            <span className="font-semibold tabular-nums text-[var(--color-academy-ink)]">{card.monthAttendance.ok}/{card.monthAttendance.total}회</span>
          </span>
        )}
        {card.attendance.length > 0 && (
          <span className="inline-flex items-center gap-2" aria-label="최근 출결">
            {card.attendance.map((cell) => (
              <span key={cell.ymd} className="inline-flex items-center gap-0.5 whitespace-nowrap text-xs tabular-nums text-[var(--color-academy-muted)]">
                <AttendanceMark status={cell.status} />
                <span>{cell.label}</span>
                <span className="sr-only">{ATTENDANCE_CELL_LABEL[cell.status]}</span>
              </span>
            ))}
          </span>
        )}
      </div>

      {/* 셔틀 — 이 반의 정규 셔틀만(정류장·시각 KST) */}
      {card.shuttle.length > 0 && (
        <p className="mt-1 flex items-start gap-1 text-xs text-[var(--color-academy-ink)]">
          <span className="shrink-0 text-[var(--color-academy-muted)]">셔틀</span>
          <span className="break-keep">{card.shuttle.map((s) => s.text).join("  ·  ")}</span>
        </p>
      )}

      {/* 신청 버튼 한 줄 [결석][보강][셔틀][변경 ▾] — 기존 신청 화면으로(그 아이·그 반을 미리 고른 채). 휴원 중이면 [복귀 신청] 하나 */}
      <div className={`mt-2 grid gap-1.5 ${card.actions.length > 1 ? "grid-cols-4" : "grid-cols-1"}`}>
        {card.actions.map((action) =>
          action.key === "change" ? (
            <ChangeMenu key={action.key} action={action} />
          ) : (
            <Link
              key={action.key}
              href={action.href}
              className={`${action.key === "resume" ? "academy-button-primary" : "academy-button-secondary"} !px-1 text-sm leading-tight`}
            >
              <span className="whitespace-nowrap">{action.label}</span>
            </Link>
          ),
        )}
      </div>
    </article>
  );
}

export default function ClassesClient({
  overview,
  initialChildId,
  timeline = [],
  calendar = null,
}: {
  overview: ParentClassesOverview;
  initialChildId: string;
  /** 신청 내역(최근 3개월, 모든 자녀) — 고른 아이 것만 보인다 */
  timeline?: ParentTimelineView[];
  /** 한 달 달력(자녀마다) — 조회 실패면 null(달력 칸만 빠진다) */
  calendar?: { month: string; byChild: Record<string, ChildMonthView> } | null;
}) {
  // 아이 선택 — 주소(?child=)·기기 기억으로 마지막 선택 유지(신청 화면 갔다 뒤로 와도 그 아이)
  const [childId, setChildId] = useRememberedChild(overview.children.map((c) => c.id), initialChildId);
  const child = overview.children.find((c) => c.id === childId) ?? overview.children[0];

  if (!child) {
    return (
      <div className="py-16 text-center">
        <h1 className="academy-heading">등록된 자녀가 없습니다</h1>
        <p className="mt-1 text-sm text-[var(--color-academy-muted)]">학원에 자녀를 등록하시면 수업을 확인할 수 있어요.</p>
      </div>
    );
  }

  const calendarView = calendar?.byChild[child.id] ?? null;
  const monthHref = (month: string) => `/mypage/classes?child=${encodeURIComponent(child.id)}&month=${month}`;

  return (
    <div className="space-y-3">
      {/* 제목(설명 문구 없음) — 달력은 아래 같은 화면에 붙는다 */}
      <h1 className="academy-heading">수업</h1>

      {/* 아이 칩 — 둘 이상일 때만 */}
      {overview.children.length > 1 && (
        <div role="group" aria-label="자녀 선택" className="flex flex-wrap gap-2">
          {overview.children.map((c) => (
            <button key={c.id} type="button" aria-pressed={c.id === child.id} onClick={() => setChildId(c.id)} className="academy-choice">
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* 반 카드 */}
      <section aria-label={`${child.name} 수강 반`} className="space-y-2">
        {child.classes.length === 0 ? (
          <p className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-3 text-sm text-[var(--color-academy-muted)]">
            다니는 정규 반이 없어요.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {child.classes.map((card) => <ClassCard key={card.enrollmentId} card={card} />)}
          </div>
        )}
        {/* 반 카드 아래 «전체 기록» — 다닌 기간·출석·청구·반 이력을 한 장에(2026-11-14 w1) */}
        <Link
          href={`/mypage/record?child=${encodeURIComponent(child.id)}`}
          className="flex min-h-11 items-center justify-between gap-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-medium text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
        >
          <span>전체 기록</span>
          <span aria-hidden="true" className="text-[var(--color-academy-faint)]">▸</span>
        </Link>
      </section>

      {/* 한 달 달력 — 일정 탭과 같은 부품. 달 이동은 주소(?child=&month=)로 서버가 다시 그린다 */}
      {calendarView && calendar && (
        <MonthCalendar
          view={calendarView.view}
          planReady={calendarView.planReady}
          hasEnrollments={calendarView.hasEnrollments}
          monthNav={{ prevHref: monthHref(shiftMonth(calendar.month, -1)), nextHref: monthHref(shiftMonth(calendar.month, 1)) }}
        />
      )}

      {/* 신청 내역 타임라인 — 고른 아이 것만(최근 3개월, 한 줄 행 → 하단 시트) */}
      <RequestTimeline rows={timeline.filter((r) => r.studentId === child.id)} />
    </div>
  );
}
