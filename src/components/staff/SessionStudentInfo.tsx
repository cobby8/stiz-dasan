"use client";

import { ContactLink } from "@/components/staff/ClassPeopleSheet";
import { RosterPersonInfo } from "@/components/staff/RosterPersonInfo";
import { monthlyFeeLabel } from "@/components/staff/StaffMonthlyFeeSummary";
import { REASON_LABEL as ABSENCE_REASON_LABEL } from "@/lib/regular/regularAbsenceRules";
import type { StaffClassPerson } from "@/lib/staff-class-people";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import type { StaffSessionStudent } from "@/lib/staff-session-queries";

/**
 * 수업 중 출석부 줄의 이름을 누르면 «그 자리에서» 펼쳐지는 학생 정보(2026-11-15 접이식 구조와 병합).
 *
 * 내용은 학생 상세 시트(SessionStudentSheet — 2026-11-14 수업 화면 간결화)가 보여 주던 것과 같다:
 * 학부모 결석 알림(사유·확정) · 연락처 · 수강료·청구 확인 · 메모·오늘 출결 메모 · 최근 출결 · 보호자.
 * 시트를 띄우지 않고 줄 아래에 펼치는 점만 다르다(원장 지시 — 한 화면에서 접었다 편다).
 *
 * 수강료 줄은 원장·부원장만(showFees) — 선생님에게는 서버가 값을 주지 않고 화면도 그리지 않는다(f3).
 * 부원장에게는 납부 완료 금액이 null 로 온다(2026-11-14 금액 가림) → «—».
 */
export function SessionStudentInfo({
  student,
  person,
  photoVersion,
  peopleState,
  onReloadPeople,
  showFees,
  feeLoading,
  feeError,
  feeMonth,
  fee,
  onReloadFees,
  onOpenBilling,
}: {
  student: StaffSessionStudent;
  /** 연락처·학교·메모·최근 출결(반 학생 정보 조회 결과). 보강·체험·미전환 특강 신청자는 없을 수 있다. */
  person: StaffClassPerson | null;
  photoVersion?: string | null;
  peopleState: "loading" | "ready" | "error";
  onReloadPeople: () => void;
  showFees: boolean;
  feeLoading: boolean;
  feeError: string;
  feeMonth: string | null;
  fee: StaffMonthlyFeeSummary | undefined;
  onReloadFees: () => void;
  onOpenBilling: (student: StaffSessionStudent) => void;
}) {
  return (
    <div className="pb-1">
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

      {/* 연락·메모·최근 출결·보호자 — 체험 아이는 선생님에게 연락처를 내려보내지 않는다(이름·학년만) */}
      {person ? (
        // 미납 «건수» 표시는 원장·부원장만(showFees). 학생별 청구는 아래 수강료 줄 하나로 연다(출결 맥락 포함).
        <RosterPersonInfo person={person} photoVersion={photoVersion} todayStatus={student.status} showUnpaidCount={showFees} />
      ) : student.phone ? (
        // 명단이 이미 준 전화가 있으면 학생 정보 조회(늦거나 실패할 수 있다)를 기다리지 않고 바로 보인다
        <div className="mt-2 grid grid-cols-2 gap-2">
          <ContactLink phone={student.phone} label="전화" accent />
          <ContactLink phone={student.phone} label="문자" sms />
        </div>
      ) : peopleState === "loading" ? (
        <p aria-live="polite" className="mt-2 text-sm text-[var(--color-academy-muted)]">연락처를 불러오는 중입니다.</p>
      ) : peopleState === "error" ? (
        <div role="alert" className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-muted)]">
          <span>연락처를 불러오지 못했습니다.</span>
          <button type="button" onClick={onReloadPeople} className="academy-button-secondary academy-button-sm min-h-11! shrink-0">다시 불러오기</button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">
          {student.trial ? `체험 학생은 이름·학년만 보입니다.${student.grade ? ` ${student.grade}` : ""}` : student.makeup ? "다른 반에서 보강 온 학생입니다. 연락처는 원래 반에서 확인해 주세요." : "등록된 연락처가 없습니다."}
        </p>
      )}

      {/* 보강 온 아이·체험 아이는 이 반 수강생이 아니라 수강료를 보여주지 않는다.
          선생님 화면(showFees=false)은 수강료·미납 줄 자체를 숨긴다(f3). */}
      {showFees && !student.makeup && !student.trial && <button type="button" aria-label={`${student.name} 수강료·청구 확인`} onClick={() => onOpenBilling(student)} className="mt-2 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-[var(--color-academy-primary-soft)] px-3 py-2 text-left">
        <span className="text-sm tabular-nums text-[var(--color-academy-ink)]">
          {feeLoading ? "수강료 조회 중…" : feeError ? "수강료 확인 필요" : <>
            <span className="text-[var(--color-academy-muted)]">{feeMonth ? monthlyFeeLabel(feeMonth, fee?.period, fee?.sourceLabel) : "수강료"} </span>
            {/* 부원장에게는 납부 완료 금액이 null 로 온다(2026-11-14) → «—» */}
            {fee?.amount != null ? `${fee.amount.toLocaleString("ko-KR")}원` : fee?.status === "PAID" ? "—" : "금액 확인 필요"}
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

      {/* 오늘 출결 메모(관리자가 미리 적어 둔 사유 등) — 학생 메모는 위 학생 정보 안에 있다 */}
      {student.attendanceNote && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">오늘 출결 메모: {student.attendanceNote}</p>}
    </div>
  );
}
