"use client";

import { useRef } from "react";
import { ContactLink } from "@/components/staff/ClassPeopleSheet";
import { StatusPill, type StatusTone } from "@/components/staff/StatusChoiceButton";
import { monthlyFeeLabel } from "@/components/staff/StaffMonthlyFeeSummary";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import { REASON_LABEL as ABSENCE_REASON_LABEL } from "@/lib/regular/regularAbsenceRules";
import type { StaffClassPerson } from "@/lib/staff-class-people";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import type { StaffSessionStudent } from "@/lib/staff-session-queries";
import { ATTENDANCE_TONE, PAYMENT_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";

const STATUS_LABEL = { PRESENT: "출석", LATE: "지각", ABSENT: "결석" } as const;
const STATUS_TONE: Record<keyof typeof STATUS_LABEL, StatusTone> = { PRESENT: "success", LATE: "warning", ABSENT: "danger" };

/**
 * 수업 진행 화면 «학생 상세» 시트(2026-11-14 원장 지시) — 명단의 학생 한 줄을 누르면 열린다.
 * 예전에는 출석부·학생 정보 시트·수강료 줄에 흩어져 같은 학생이 여러 번 나왔다. 상세는 여기 한 곳에 모은다.
 * (휴대폰 = 아래에서 올라오는 시트, 넓은 화면 = 가운데 창 — 선생님 화면의 다른 시트와 같은 모양)
 *
 * 출결 버튼은 명단 줄에 있다(여기서는 «지금 상태»만 보인다).
 * 수강료 줄은 원장·부원장만(showFees) — 선생님에게는 서버가 값을 주지 않고 화면도 그리지 않는다(f3).
 */
export function SessionStudentSheet({
  className,
  student,
  person,
  peopleState,
  onReloadPeople,
  showFees,
  feeLoading,
  feeError,
  feeMonth,
  fee,
  onReloadFees,
  onOpenBilling,
  onClose,
}: {
  className: string;
  student: StaffSessionStudent;
  /** 연락처·학교·메모·최근 출결(반 학생 정보 조회 결과). 보강·체험·미전환 특강 신청자는 없을 수 있다. */
  person: StaffClassPerson | null;
  peopleState: "loading" | "ready" | "error";
  onReloadPeople: () => void;
  showFees: boolean;
  feeLoading: boolean;
  feeError: string;
  feeMonth: string | null;
  fee: StaffMonthlyFeeSummary | undefined;
  onReloadFees: () => void;
  onOpenBilling: (student: StaffSessionStudent) => void;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  useStaffDialog(true, sheetRef, onClose);

  const guardian = person?.guardians.find((item) => item.isPrimary) ?? person?.guardians[0];
  const schoolLine = [person?.school, person?.grade ?? student.grade].filter(Boolean).join(" · ");
  const unpaid = showFees && person?.billing && person.billing.unpaidCount > 0 ? person.billing : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-black/55 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="session-student-title">
      <button type="button" aria-label="학생 상세 닫기" className="absolute inset-0 cursor-default" onClick={onClose} />
      <section ref={sheetRef} className="relative max-h-[92dvh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-3xl bg-white px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl sm:rounded-3xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--color-academy-line-input)]" />
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-[var(--color-academy-muted)]">{className}</p>
            <h2 id="session-student-title" className="mt-0.5 text-xl font-bold">{student.name}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">{schoolLine || "학교·학년 미등록"}</p>
          </div>
          <button type="button" data-dialog-initial-focus onClick={onClose} className="academy-button-text academy-button-sm min-h-11! shrink-0">닫기</button>
        </header>

        {/* 오늘 상태 한 줄 — 출결 + 보강·체험·미납 표시 */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {student.status
            ? <StatusPill tone={STATUS_TONE[student.status]}>{STATUS_LABEL[student.status]}</StatusPill>
            : <StatusPill tone="neutral">미확인</StatusPill>}
          {student.makeup && <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[ATTENDANCE_TONE.MAKEUP]}`}>보강</span>}
          {student.trial && <span className="rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-0.5 text-xs text-[var(--brand-accent)]">체험</span>}
          {unpaid && <span className={`rounded px-1.5 py-0.5 text-xs tabular-nums ${TONE_BADGE_CLASS[PAYMENT_TONE.UNPAID]}`}>미납 {unpaid.unpaidCount}건</span>}
        </div>

        {/* 학부모가 미리 넣은 결석 신고. 확정건은 원장이 확인한 것이라 따로 표시한다. */}
        {student.absenceReport?.source === "PARENT" && (
          <p className="mt-2 rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">
            학부모 결석 알림
            {ABSENCE_REASON_LABEL[student.absenceReport.reason]
              ? ` · ${ABSENCE_REASON_LABEL[student.absenceReport.reason]}`
              : ""}
            {student.absenceReport.status === "CONFIRMED" ? " · 확정" : ""}
          </p>
        )}

        {/* 연락 — 체험 아이는 선생님에게 연락처를 내려보내지 않는다(이름·학년만) */}
        {person ? (
          <div className="mt-4 grid grid-cols-3 gap-2">
            <ContactLink phone={person.studentPhone} label="학생 전화" />
            <ContactLink phone={guardian?.phone ?? null} label="학부모 전화" accent />
            <ContactLink phone={guardian?.phone ?? null} label="문자" sms />
          </div>
        ) : student.phone ? (
          // 명단이 이미 준 전화가 있으면 학생 정보 조회(늦거나 실패할 수 있다)를 기다리지 않고 바로 보인다
          <div className="mt-4 grid grid-cols-2 gap-2">
            <ContactLink phone={student.phone} label="전화" accent />
            <ContactLink phone={student.phone} label="문자" sms />
          </div>
        ) : peopleState === "loading" ? (
          <p aria-live="polite" className="mt-4 text-sm text-[var(--color-academy-muted)]">연락처를 불러오는 중입니다.</p>
        ) : peopleState === "error" ? (
          <div role="alert" className="mt-4 flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">
            <span>연락처를 불러오지 못했습니다.</span>
            <button type="button" onClick={onReloadPeople} className="academy-button-secondary academy-button-sm min-h-11! shrink-0">다시 불러오기</button>
          </div>
        ) : (
          <p className="mt-4 text-sm text-[var(--color-academy-muted)]">
            {student.trial ? "체험 학생은 이름·학년만 보입니다." : student.makeup ? "다른 반에서 보강 온 학생입니다. 연락처는 원래 반에서 확인해 주세요." : "등록된 연락처가 없습니다."}
          </p>
        )}

        {/* 보강 온 아이·체험 아이는 이 반 수강생이 아니라 수강료를 보여주지 않는다.
            선생님 화면(showFees=false)은 수강료·미납 줄 자체를 숨긴다(f3). */}
        {showFees && !student.makeup && !student.trial && <button type="button" aria-label={`${student.name} 수강료·청구 확인`} onClick={() => onOpenBilling(student)} className="mt-3 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-[var(--color-academy-primary-soft)] px-3 py-2 text-left">
          <span className="text-sm tabular-nums text-[var(--color-academy-ink)]">
            {feeLoading ? "수강료 조회 중…" : feeError ? "수강료 확인 필요" : <>
              <span className="text-[var(--color-academy-muted)]">{feeMonth ? monthlyFeeLabel(feeMonth, fee?.period, fee?.sourceLabel) : "수강료"} </span>
              {fee?.amount != null ? `${fee.amount.toLocaleString("ko-KR")}원` : "금액 확인 필요"}
            </>}
          </span>
          <span className="text-sm font-medium text-[var(--brand-accent)]">
            {!feeLoading && !feeError ? `${fee?.statusLabel || "확인 필요"} · ` : ""}청구 확인
          </span>
        </button>}
        {showFees && feeError && (
          <div role="alert" className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--color-academy-muted)]">
            <span>{feeError}</span>
            <button type="button" onClick={onReloadFees} className="academy-button-tonal academy-button-sm shrink-0">수강료 다시 불러오기</button>
          </div>
        )}

        {/* 메모·최근 출결·보호자 — 값이 있는 것만 보인다 */}
        {(person?.memo || student.attendanceNote) && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">메모·특이사항</h3>
            {person?.memo && <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">{person.memo}</p>}
            {student.attendanceNote && <p className="mt-1.5 whitespace-pre-wrap rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">오늘 출결 메모: {student.attendanceNote}</p>}
          </div>
        )}
        {person && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">최근 출결</h3>
            <p className="mt-1.5 text-sm tabular-nums text-[var(--color-academy-muted)]">
              {person.recentAttendance.total > 0
                ? `최근 ${person.recentAttendance.total}회: 출석 ${person.recentAttendance.present} · 지각 ${person.recentAttendance.late} · 결석 ${person.recentAttendance.absent}`
                : "아직 출결 기록이 없습니다."}
            </p>
          </div>
        )}
        {person && person.guardians.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-[var(--color-academy-ink)]">보호자 {person.guardians.length}명</h3>
            <ul className="mt-1.5 space-y-1.5 text-sm">
              {person.guardians.map((item, index) => (
                <li key={item.id ?? `${item.name}-${index}`} className="flex items-center justify-between gap-2">
                  <span>{item.name} · {item.relation}</span>
                  <span className="tabular-nums text-[var(--color-academy-muted)]">{item.phone || "연락처 없음"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
