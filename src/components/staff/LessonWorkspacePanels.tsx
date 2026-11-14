"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { saveSessionFeedLine } from "@/app/actions/staff-sessions";
import UiIcon from "@/components/common/UiIcon";
import { LessonTextEditor, type LessonTextSaveResult } from "@/components/staff/LessonTextEditor";
import { RosterPersonInfo, useClassPeople } from "@/components/staff/RosterPersonInfo";
import { SessionPhotoUploader } from "@/components/staff/SessionPhotoUploader";
import { SessionVideoUploader } from "@/components/staff/SessionVideoUploader";
import { StatusPill, type StatusTone } from "@/components/staff/StatusChoiceButton";
import { WorkspaceSection } from "@/components/staff/WorkspaceSection";
import { attendanceSummaryLine, findRosterPerson, resolveLessonText } from "@/components/staff/sessionWorkspaceRules";
import type { StaffSessionDetail, StaffSessionStudent } from "@/lib/staff-session-queries";

type BillingOpener = (student?: { id: string; name: string }) => void;

/** 시작 전 수업(기록이 아직 없을 수도 있다) — 오늘 수업 홈의 한 줄에서 넘겨받는다 */
export type PlannedLesson = {
  classId: string;
  className: string;
  /** 수업 기록 id — 수업 내용을 한 번도 저장하지 않았으면 null */
  sessionId: string | null;
  /** 특강 회차(정규 수업이면 null) */
  sessionDateId: string | null;
  plannedContent: string | null;
  content: string | null;
  studentCount: number;
};

export type PlannedLessonProps = {
  lesson: PlannedLesson;
  /** 진행 중인 다른 수업이 있어 시작할 수 없다 */
  startLocked: boolean;
  /** 이 화면의 주 버튼인가(오늘의 «다음 수업» 카드만 true — 남은 수업 줄은 보조 버튼) */
  startPrimary: boolean;
  onStart: () => void;
  /** 미리 쓴 내용 저장(수업 전 전용 서버 기능은 홈이 부른다 — 날짜·특강 회차를 홈이 안다) */
  savePlanned: (text: string) => Promise<LessonTextSaveResult>;
  /** 수업 공지 — 대타로만 보이는 반은 넘기지 않는다(f4) */
  onOpenNotice?: () => void;
  /** 청구 확인 — 원장·부원장만 넘긴다(f3) */
  onOpenBilling?: BillingOpener;
};

const STATUS_LABEL = { PRESENT: "출석", LATE: "지각", ABSENT: "결석" } as const;
const STATUS_TONE: Record<keyof typeof STATUS_LABEL, StatusTone> = { PRESENT: "success", LATE: "warning", ABSENT: "danger" };

/** 이름을 누르면 그 자리에서 학생 정보가 펼쳐지는 한 줄(출결 버튼 없는 명단용) */
function RosterInfoRow({ rowId, name, trailing, open, onToggle, children }: {
  rowId: string;
  name: string;
  trailing?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className="border-b border-[var(--color-academy-line)] py-1 last:border-b-0">
      <button type="button" aria-expanded={open} aria-controls={`roster-info-${rowId}`} onClick={onToggle} className="flex min-h-11 w-full items-center gap-2 text-left">
        <span className="min-w-0 flex-1 break-keep font-semibold text-[var(--color-academy-ink)]">{name}</span>
        {trailing}
        <span className="flex shrink-0 text-[var(--color-academy-muted)]">
          <UiIcon name={open ? "expand_less" : "expand_more"} />
        </span>
      </button>
      {open && <div id={`roster-info-${rowId}`}>{children}</div>}
    </li>
  );
}

function PeopleNotice({ loading, error, onRetry }: { loading: boolean; error: string; onRetry: () => void }) {
  if (error) return (
    <div role="alert" className="rounded-xl bg-[var(--color-academy-soft)] p-3 text-xs text-[var(--color-academy-muted)]">
      <p>{error}</p>
      <button type="button" onClick={onRetry} className="academy-button-tonal academy-button-sm mt-1">학생 정보 다시 불러오기</button>
    </div>
  );
  if (loading) return <p role="status" className="py-2 text-xs text-[var(--color-academy-muted)]">학생 정보를 불러오는 중입니다.</p>;
  return null;
}

/** 칸 아래 작은 글자 버튼 줄 — 수업 공지·청구 확인처럼 예전 «수업 준비·관리» 메뉴에 있던 진입 */
export function WorkspaceLinks({ onOpenNotice, onOpenBilling }: { onOpenNotice?: () => void; onOpenBilling?: () => void }) {
  if (!onOpenNotice && !onOpenBilling) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label="수업 관리">
      {onOpenNotice && <button type="button" onClick={onOpenNotice} className="academy-button-text academy-button-sm underline underline-offset-2">수업 공지</button>}
      {onOpenBilling && <button type="button" onClick={onOpenBilling} className="academy-button-text academy-button-sm underline underline-offset-2">청구 확인</button>}
    </div>
  );
}

/**
 * 수업 전 본문 — [수업 시작] → 수업 내용(미리 쓰기) → 출석부(명단·학생 정보만, 출결 버튼 없음) → 수업 공지·청구 확인.
 */
export function PlannedLessonPanel({ lesson, startLocked, startPrimary, onStart, savePlanned, onOpenNotice, onOpenBilling }: PlannedLessonProps) {
  const initial = resolveLessonText({ status: "PLANNED", content: lesson.content, plannedContent: lesson.plannedContent });
  const [text, setText] = useState(initial.value);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [open, setOpen] = useState({ lesson: true, roster: false });
  const [rosterWanted, setRosterWanted] = useState(false);
  const [infoRow, setInfoRow] = useState<string | null>(null);
  const people = useClassPeople({ classId: lesson.classId, sessionId: lesson.sessionId, sessionDateId: lesson.sessionDateId, enabled: rosterWanted });

  // 마지막으로 저장한 글 — 쓰다 만 글이 «수업 시작»·줄 접기로 사라지지 않게 그때 한 번 더 저장한다
  const savedRef = useRef(initial.value);
  const textRef = useRef(text);
  const saveRef = useRef(savePlanned);
  useEffect(() => { textRef.current = text; saveRef.current = savePlanned; });

  async function save(value: string): Promise<LessonTextSaveResult> {
    const result = await savePlanned(value);
    if (result.ok) savedRef.current = value;
    return result;
  }

  useEffect(() => () => {
    // 줄을 접거나 다른 줄을 펼쳐 이 칸이 닫힐 때 — 저장하지 않은 글이 있으면 저장한다
    if (textRef.current !== savedRef.current) void saveRef.current(textRef.current);
  }, []);

  async function start() {
    if (starting || startLocked) return;
    setStartError("");
    if (textRef.current !== savedRef.current) {
      // 쓰던 수업 내용을 먼저 저장하고 시작한다(시작 뒤에는 미리 쓴 내용을 고칠 수 없다)
      setStarting(true);
      const result = await save(textRef.current).catch(() => ({ ok: false as const, message: "수업 내용을 저장하지 못했습니다. 네트워크를 확인해 주세요." }));
      setStarting(false);
      if (!result.ok) { setStartError(result.message); return; }
    }
    onStart();
  }

  function toggleRoster() {
    setRosterWanted(true);
    setOpen((current) => ({ ...current, roster: !current.roster }));
  }

  return (
    <div className="space-y-3">
      <div>
        <button
          type="button"
          disabled={startLocked || starting}
          title={startLocked ? "진행 중인 수업을 먼저 종료해 주세요." : undefined}
          onClick={() => void start()}
          className={`${startPrimary ? "academy-button-primary" : "academy-button-secondary"} min-h-12! w-full text-base!`}
        >
          {startLocked ? "현재 수업 종료 후 시작" : starting ? "수업 내용 저장 중…" : "수업 시작"}
        </button>
        {startLocked && <p role="status" className="mt-1 text-xs text-[var(--color-academy-muted)]">현재 수업을 종료한 뒤 다음 수업을 시작할 수 있습니다.</p>}
        {startError && <p role="alert" className="mt-1 text-xs text-[var(--color-academy-danger)]">{startError}</p>}
      </div>

      <WorkspaceSection id={`lesson-text-${lesson.classId}`} title="수업 내용" summary={text.trim() ? text.trim().split("\n")[0] : "아직 쓰지 않았어요"} open={open.lesson} onToggle={() => setOpen((current) => ({ ...current, lesson: !current.lesson }))}>
        <LessonTextEditor inputId={`lesson-text-input-${lesson.classId}`} phase="PLANNED" value={text} onChange={setText} save={save} />
      </WorkspaceSection>

      <WorkspaceSection id={`lesson-roster-${lesson.classId}`} title="출석부" summary={`학생 ${lesson.studentCount}명 · 출결은 수업을 시작한 뒤에 찍어요`} open={open.roster} onToggle={toggleRoster}>
        <PeopleNotice loading={people.loading} error={people.error} onRetry={people.reload} />
        {people.loaded && people.people.length === 0 && <p className="py-2 text-xs text-[var(--color-academy-muted)]">표시할 학생이 없습니다.</p>}
        <ul aria-label="학생 명단">
          {people.people.map((person) => (
            <RosterInfoRow key={person.id} rowId={person.id} name={person.name} open={infoRow === person.id} onToggle={() => setInfoRow(infoRow === person.id ? null : person.id)}>
              <RosterPersonInfo person={person} photoVersion={people.photoVersions[person.id]} onOpenBilling={onOpenBilling} />
            </RosterInfoRow>
          ))}
        </ul>
      </WorkspaceSection>

      <WorkspaceLinks onOpenNotice={onOpenNotice} onOpenBilling={onOpenBilling ? () => onOpenBilling() : undefined} />
    </div>
  );
}

/**
 * 끝난 수업 본문 — 출결 요약 · 수업 내용 · 출석부(읽기) · 사진·영상.
 * 수업 내용·사진·영상은 기존 허용 시간(수업 당일 자정까지) 그대로 — 판정은 서버가 한다. 추가해도 학부모 알림은 다시 보내지 않는다.
 */
export function CompletedSessionPanel({ session, students, onLineSaved, onOpenBilling }: {
  session: StaffSessionDetail;
  students: StaffSessionStudent[];
  onLineSaved?: (content: string | null) => void;
  /** 청구 확인 — 원장·부원장만 넘긴다(f3) */
  onOpenBilling?: BillingOpener;
}) {
  const initial = resolveLessonText({ status: "COMPLETED", content: session.content, plannedContent: session.plannedContent });
  const [text, setText] = useState(initial.value);
  const [prefilled, setPrefilled] = useState(initial.prefilledFromPlan);
  const [open, setOpen] = useState({ lesson: true, roster: false, media: false });
  const [rosterWanted, setRosterWanted] = useState(false);
  const [infoRow, setInfoRow] = useState<string | null>(null);
  const people = useClassPeople({ classId: session.classId, sessionId: session.id, sessionDateId: session.sessionDateId, enabled: rosterWanted });

  const counts = useMemo(() => ({
    PRESENT: students.filter((student) => student.status === "PRESENT").length,
    LATE: students.filter((student) => student.status === "LATE").length,
    ABSENT: students.filter((student) => student.status === "ABSENT").length,
    UNCHECKED: students.filter((student) => !student.status).length,
  }), [students]);

  async function save(value: string): Promise<LessonTextSaveResult> {
    const result = await saveSessionFeedLine({ sessionId: session.id, content: value });
    if (!result.ok) return { ok: false, message: result.message };
    setPrefilled(false);
    onLineSaved?.(result.content);
    return { ok: true };
  }

  return (
    <div className="space-y-3">
      <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">끝난 수업 · {attendanceSummaryLine(counts)}</p>

      <WorkspaceSection id={`done-lesson-${session.id}`} title="수업 내용" summary={text.trim() ? text.trim().split("\n")[0] : "아직 쓰지 않았어요"} open={open.lesson} onToggle={() => setOpen((current) => ({ ...current, lesson: !current.lesson }))}>
        <LessonTextEditor inputId={`done-lesson-input-${session.id}`} phase="COMPLETED" value={text} onChange={setText} save={save} prefilledFromPlan={prefilled} />
      </WorkspaceSection>

      <WorkspaceSection id={`done-roster-${session.id}`} title="출석부" summary={attendanceSummaryLine(counts)} open={open.roster} onToggle={() => setOpen((current) => ({ ...current, roster: !current.roster }))}>
        <PeopleNotice loading={people.loading} error={people.error} onRetry={people.reload} />
        <ul aria-label="학생 출결 명단">
          {students.map((student) => {
            const person = findRosterPerson(student, people.people);
            return (
              <RosterInfoRow
                key={student.id}
                rowId={student.id}
                name={student.name}
                open={infoRow === student.id}
                onToggle={() => { setRosterWanted(true); setInfoRow(infoRow === student.id ? null : student.id); }}
                trailing={student.status ? <StatusPill tone={STATUS_TONE[student.status]}>{STATUS_LABEL[student.status]}</StatusPill> : <StatusPill tone="neutral">미확인</StatusPill>}
              >
                {person
                  ? <RosterPersonInfo person={person} photoVersion={people.photoVersions[person.id]} todayStatus={student.status} onOpenBilling={onOpenBilling} />
                  : !people.loaded ? !people.error && <p role="status" className="py-2 text-xs text-[var(--color-academy-muted)]">학생 정보를 불러오는 중입니다.</p>
                  : <p className="py-2 text-xs text-[var(--color-academy-muted)]">이 반 학생 정보에 없는 학생입니다{student.makeup ? "(보강)" : student.trial ? "(체험)" : ""}.{student.grade ? ` ${student.grade}` : ""}</p>}
              </RosterInfoRow>
            );
          })}
        </ul>
      </WorkspaceSection>

      <WorkspaceSection id={`done-media-${session.id}`} title="사진·영상" summary="수업 당일 자정까지 올리고 지울 수 있어요" open={open.media} onToggle={() => setOpen((current) => ({ ...current, media: !current.media }))}>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 사진</h3>
            <SessionPhotoUploader sessionId={session.id} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 영상</h3>
            <SessionVideoUploader sessionId={session.id} />
          </div>
        </div>
      </WorkspaceSection>

      <WorkspaceLinks onOpenBilling={onOpenBilling ? () => onOpenBilling() : undefined} />
    </div>
  );
}
