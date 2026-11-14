"use client";

import { useState } from "react";
import { previewStaffAttendanceCorrection, saveStaffAttendance } from "@/app/actions/staff-sessions";
import UiIcon from "@/components/common/UiIcon";
import { RosterPersonInfo, type useClassPeople } from "@/components/staff/RosterPersonInfo";
import { StatusChoiceButton, StatusPill, type StatusTone } from "@/components/staff/StatusChoiceButton";
import { findRosterPerson } from "@/components/staff/sessionWorkspaceRules";
import type { StaffSessionDetail, StaffSessionStudent } from "@/lib/staff-session-queries";
import { canCorrectAfterCompletion, correctionConfirmMessage, type ReviewRosterKind } from "@/lib/staff/sessionEditWindow";
import { ATTENDANCE_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";

const STATUS_LABEL = { PRESENT: "출석", LATE: "지각", ABSENT: "결석" } as const;
type AttendanceStatus = keyof typeof STATUS_LABEL;
const STATUS_TONE: Record<AttendanceStatus, StatusTone> = { PRESENT: "success", LATE: "warning", ABSENT: "danger" };
const ATTENDANCE_STATUSES: AttendanceStatus[] = ["PRESENT", "LATE", "ABSENT"];

/** 서버 기능이 «로그인이 풀렸다»고 돌려줬는가 — 던지지 않고 { ok:false, needsLogin:true } 로 온다 */
function isLoginFailure(result: object): boolean {
  return "needsLogin" in result && (result as { needsLogin?: boolean }).needsLogin === true;
}

/** 출석부 한 줄의 종류 — 완료한 수업에서 선생님이 고칠 수 있는 줄(정규 수강생·특강 좌석)을 가르는 데 쓴다 */
function rosterKindOf(student: StaffSessionStudent, seasonal: boolean): ReviewRosterKind {
  return student.trial ? "TRIAL" : student.makeup ? "MAKEUP" : seasonal ? "SEASONAL" : "REGULAR";
}

/**
 * 완료한 수업의 출결 명단(2026-11-14 원장 지시 «완료한 수업도 … 수정할 수 있게») — CompletedSessionPanel 의 «출석부» 칸.
 *
 * - 고칠 수 있는 줄 = 수정 기간 안(editable) + 정규 수강생·특강 좌석 → 출결 버튼 3개.
 *   그 밖(수정 기간 지남 · 보강 온 아이 · 체험 아이)은 지금 상태만 보이고, 고칠 일은 «원장님께 요청».
 * - 정정: 서버에 먼저 물어(아무것도 바꾸지 않는 미리 보기) 실제 결과에 맞는 한 줄로 한 번 확인한 뒤 저장한다.
 *   저장은 진행 중 수업과 같은 서버 기능(saveStaffAttendance → 결석 사유·보강권 규칙 함수)이다. 학부모 알림은 나가지 않는다.
 * - 같은 버튼을 다시 눌러도 미확인으로 되돌리지 않는다(완료한 수업에 미확인이 생기면 안 된다).
 * - 질병·부상 표시는 바꾸지 않고 보여 주기만 한다(이월 검토가 걸려 있어 원장이 고친다).
 */
export function CompletedAttendanceRoster({ session, students, onStudentsChange, editable, people, infoRow, onToggleInfo, onOpenBilling, onNeedsLogin }: {
  session: StaffSessionDetail;
  students: StaffSessionStudent[];
  onStudentsChange: (update: (current: StaffSessionStudent[]) => StaffSessionStudent[]) => void;
  /** 수정 기간 안인가(서버와 같은 판정 — 부모가 계산해 넘긴다) */
  editable: boolean;
  people: ReturnType<typeof useClassPeople>;
  /** 학생 정보를 펼친 줄(한 번에 하나) */
  infoRow: string | null;
  onToggleInfo: (rowId: string) => void;
  /** 청구 확인 — 원장·부원장만 넘긴다(f3) */
  onOpenBilling?: (student?: { id: string; name: string }) => void;
  onNeedsLogin: () => void;
}) {
  // 확인·저장 중인 줄만 잠근다
  const [savingRows, setSavingRows] = useState<Record<string, true>>({});
  const [rowNotices, setRowNotices] = useState<Record<string, { text: string; tone: "error" | "notice" }>>({});

  function setRowNotice(rowId: string, value: string, tone: "error" | "notice" = "error") {
    setRowNotices((current) => {
      const next = { ...current };
      if (value) next[rowId] = { text: value, tone }; else delete next[rowId];
      return next;
    });
  }

  async function correctAttendance(target: StaffSessionStudent, status: AttendanceStatus) {
    const rowId = target.id;
    // 같은 버튼을 다시 눌러도 미확인으로 되돌리지 않는다
    if (!editable || savingRows[rowId] || target.status === status) return;
    setRowNotice(rowId, "");
    setSavingRows((current) => ({ ...current, [rowId]: true }));
    try {
      const preview = await previewStaffAttendanceCorrection({ sessionId: session.id, attendanceKey: target.attendanceKey, status });
      if (!preview.ok) {
        setRowNotice(rowId, preview.message);
        if (isLoginFailure(preview)) onNeedsLogin();
        return;
      }
      // 다른 기기에서 이미 같은 값으로 고쳤으면 화면만 맞춘다
      if (preview.previousStatus === status) {
        onStudentsChange((current) => current.map((student) => (student.id === rowId ? { ...student, status } : student)));
        return;
      }
      const question = correctionConfirmMessage({ name: target.name, previousStatus: preview.previousStatus, nextStatus: status, effect: preview.effect });
      if (!window.confirm(question)) return;
      const result = await saveStaffAttendance({ sessionId: session.id, attendanceKey: target.attendanceKey, status });
      if (!result.ok) {
        setRowNotice(rowId, result.message);
        if (isLoginFailure(result)) onNeedsLogin();
        return;
      }
      if ("skipped" in result) {
        setRowNotice(rowId, result.message ?? "", "notice");
        return;
      }
      const report = (result as { absenceReport?: StaffSessionStudent["absenceReport"] }).absenceReport;
      onStudentsChange((current) => current.map((student) => (
        student.id === rowId
          ? { ...student, status, arrivedAt: status === "LATE" ? student.arrivedAt || new Date().toISOString() : null, ...(report === undefined ? {} : { absenceReport: report }) }
          : student
      )));
      const recordWarning = "recordWarning" in result ? String((result as { recordWarning?: string }).recordWarning || "") : "";
      const absenceMessage = (result as { absenceMessage?: string | null }).absenceMessage;
      if (recordWarning) setRowNotice(rowId, recordWarning, "error");
      else setRowNotice(rowId, absenceMessage || "고쳤습니다.", "notice");
    } catch {
      setRowNotice(rowId, "저장하지 못했습니다. 연결을 확인하고 다시 눌러 주세요.");
    } finally {
      setSavingRows((current) => {
        const next = { ...current };
        delete next[rowId];
        return next;
      });
    }
  }

  return (
    <ul aria-label="학생 출결 명단">
      {students.map((student) => {
        const person = findRosterPerson(student, people.people);
        const infoOpen = infoRow === student.id;
        const correctable = editable && canCorrectAfterCompletion(rosterKindOf(student, Boolean(session.sessionDateId)));
        return (
          <li key={student.id} data-review-row className="border-b border-[var(--color-academy-line)] py-1 last:border-b-0">
            <div className="flex items-center gap-2">
              {/* 이름 쪽을 누르면 이 줄 아래에 학생 정보가 펼쳐진다 */}
              <button type="button" aria-expanded={infoOpen} aria-controls={`roster-info-${student.id}`} aria-label={`${student.name} 상세 정보`} onClick={() => onToggleInfo(student.id)} className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-left">
                <span className="break-keep font-semibold text-[var(--color-academy-ink)]">{student.name}</span>
                {student.makeup && <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[ATTENDANCE_TONE.MAKEUP]}`}>보강</span>}
                {student.trial && <span className="rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-0.5 text-xs text-[var(--brand-accent)]">체험</span>}
                {student.status === "ABSENT" && student.absenceReport?.reason === "ILLNESS_INJURY" && <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS.neutral}`}>질병·부상</span>}
                <span className="flex shrink-0 text-[var(--color-academy-muted)]">
                  <UiIcon name={infoOpen ? "expand_less" : "expand_more"} />
                </span>
              </button>
              {correctable ? (
                <div className="grid shrink-0 grid-cols-3 gap-2">
                  {ATTENDANCE_STATUSES.map((status) => (
                    <StatusChoiceButton key={status} tone={STATUS_TONE[status]} ariaLabel={`${student.name} ${STATUS_LABEL[status]}`} active={student.status === status} disabled={Boolean(savingRows[student.id])} onClick={() => void correctAttendance(student, status)} className="min-w-12">
                      {STATUS_LABEL[status]}
                    </StatusChoiceButton>
                  ))}
                </div>
              ) : (
                // 읽기 전용 줄(수정 기간 지남 · 보강 온 아이 · 체험 아이) — 버튼 대신 지금 상태만
                <div className="flex shrink-0 flex-col items-end gap-0.5" data-review-readonly>
                  {student.status ? <StatusPill tone={STATUS_TONE[student.status]}>{STATUS_LABEL[student.status]}</StatusPill> : <StatusPill tone="neutral">미확인</StatusPill>}
                  {editable && <span className="text-xs text-[var(--color-academy-muted)]">원장님께 요청</span>}
                </div>
              )}
            </div>
            {savingRows[student.id] && <p aria-live="polite" className="mt-1 text-xs text-[var(--color-academy-muted)]">확인 중…</p>}
            {rowNotices[student.id] && (rowNotices[student.id].tone === "error"
              ? <p role="alert" className="mt-1 text-xs font-semibold text-[var(--color-academy-danger)]">{rowNotices[student.id].text}</p>
              : <p role="status" className="mt-1 text-xs text-[var(--color-academy-muted)]">{rowNotices[student.id].text}</p>)}
            {infoOpen && (
              <div id={`roster-info-${student.id}`}>
                {person
                  ? <RosterPersonInfo person={person} photoVersion={people.photoVersions[person.id]} todayStatus={student.status} onOpenBilling={onOpenBilling} />
                  : !people.loaded ? !people.error && <p role="status" className="py-2 text-xs text-[var(--color-academy-muted)]">학생 정보를 불러오는 중입니다.</p>
                  : <p className="py-2 text-xs text-[var(--color-academy-muted)]">이 반 학생 정보에 없는 학생입니다{student.makeup ? "(보강)" : student.trial ? "(체험)" : ""}.{student.grade ? ` ${student.grade}` : ""}</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
