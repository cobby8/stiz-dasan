"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { publishStaffSessionReport, saveSessionFeedLine, saveSessionMemo } from "@/app/actions/staff-sessions";
import UiIcon from "@/components/common/UiIcon";
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";
import { LessonTextEditor, type LessonTextSaveResult } from "@/components/staff/LessonTextEditor";
import { RosterPersonInfo, useClassPeople } from "@/components/staff/RosterPersonInfo";
import { SessionPhotoUploader } from "@/components/staff/SessionPhotoUploader";
import { SessionVideoUploader, type SessionVideoUploaderState } from "@/components/staff/SessionVideoUploader";
import { StatusPill } from "@/components/staff/StatusChoiceButton";
import { CompletedAttendanceRoster } from "@/components/staff/CompletedAttendanceRoster";
import { WorkspaceSection } from "@/components/staff/WorkspaceSection";
import { attendanceSummaryLine, mediaBlockReason, resolveLessonText } from "@/components/staff/sessionWorkspaceRules";
import type { StaffSessionDetail, StaffSessionStudent } from "@/lib/staff-session-queries";
import { kstLabel } from "@/lib/datetime/kst";
import { staffReloginHref } from "@/lib/staff-session-rules";
import { STAFF_EDIT_EXPIRED_MESSAGE, STAFF_SESSION_EDIT_DAYS, staffSessionEditWindow } from "@/lib/staff/sessionEditWindow";

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

/** 이름을 누르면 그 자리에서 학생 정보가 펼쳐지는 한 줄(출결 버튼 없는 명단용) */
function RosterInfoRow({ rowId, name, photoSrc, trailing, open, onToggle, children }: {
  rowId: string;
  name: string;
  /** 아이 사진 주소(없으면 이름 첫 글자) */
  photoSrc?: string | null;
  trailing?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className="border-b border-[var(--color-academy-line)] py-1 last:border-b-0">
      <button type="button" aria-expanded={open} aria-controls={`roster-info-${rowId}`} onClick={onToggle} className="flex min-h-11 w-full items-center gap-2 text-left">
        <ProfileAvatar decorative name={name} size={28} src={photoSrc ?? null} />
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
            <RosterInfoRow key={person.id} rowId={person.id} name={person.name} photoSrc={profilePhotoUrl({ kind: "student", id: person.id }, people.photoVersions[person.id] ?? null, true)} open={infoRow === person.id} onToggle={() => setInfoRow(infoRow === person.id ? null : person.id)}>
              <RosterPersonInfo person={person} photoVersion={people.photoVersions[person.id]} onOpenBilling={onOpenBilling} />
            </RosterInfoRow>
          ))}
        </ul>
      </WorkspaceSection>

      <WorkspaceLinks onOpenNotice={onOpenNotice} onOpenBilling={onOpenBilling ? () => onOpenBilling() : undefined} />
    </div>
  );
}

/** 서버 기능이 «로그인이 풀렸다»고 돌려줬는가 — 던지지 않고 { ok:false, needsLogin:true } 로 온다 */
function isLoginFailure(result: object): boolean {
  return "needsLogin" in result && (result as { needsLogin?: boolean }).needsLogin === true;
}

/**
 * 끝난 수업 본문 — 출결 요약·학부모 발행 상태 · 수업 내용 · 출석부 · 사진·영상 · 메모.
 * 오늘 수업 홈의 완료한 수업 줄과, 수업 주소(/staff/sessions/[id] — «지난 수업» 목록에서 연다) 양쪽에 끼운다.
 *
 * 2026-11-14 원장 지시 «완료한 수업도 들어가면 내용을 볼 수 있고 수정할 수 있게»:
 *  - 고칠 수 있는 기간은 사진·영상·수업 내용·메모·출결 정정이 모두 같은 판정(staffSessionEditWindow) —
 *    선생님은 수업일 포함 7일, 원장·부원장(editUnlimited)은 제한 없음. 서버도 같은 함수로 다시 막는다.
 *  - 출결 정정은 정규 수강생·특강 좌석만(명단과 정정 흐름은 CompletedAttendanceRoster). 학부모 알림은 나가지 않는다.
 *    보강 온 아이·체험 아이는 원장이 고친다. 같은 버튼을 다시 눌러도 미확인으로 되돌리지 않는다.
 *  - «아직 안 보낸» 수업은 [학부모에게 보내기] — 처음 보낼 때만 앱 알림, 그 뒤 고쳐도 다시 알리지 않는다.
 *  - 기간이 지나면 읽기 전용 + 안내 한 줄.
 */
export function CompletedSessionPanel({ session, students: initialStudents, onLineSaved, onOpenBilling, embedded = true, editUnlimited = false }: {
  session: StaffSessionDetail;
  students: StaffSessionStudent[];
  onLineSaved?: (content: string | null) => void;
  /** 청구 확인 — 원장·부원장만 넘긴다(f3) */
  onOpenBilling?: BillingOpener;
  /** 오늘 수업 홈의 한 줄 안에 끼웠는가 — 아니면 수업 주소 한 화면(머리에 날짜·반 이름을 그린다) */
  embedded?: boolean;
  /** 원장·부원장 — 수정 기간 제한 없음 */
  editUnlimited?: boolean;
}) {
  // 고칠 수 있는가 — 서버 저장과 같은 판정 함수(오늘은 서버가 DB 시계로 구해 준 값)
  const editable = staffSessionEditWindow({ status: session.status, sessionYmd: session.sessionYmd, todayYmd: session.todayYmd, unlimited: editUnlimited }).ok;
  const initial = resolveLessonText({ status: "COMPLETED", content: session.content, plannedContent: session.plannedContent });
  const [text, setText] = useState(initial.value);
  const [prefilled, setPrefilled] = useState(initial.prefilledFromPlan);
  const [open, setOpen] = useState({ lesson: true, roster: false, media: false, memo: false });
  // 2026-11-15 원장 점검: 영상을 올릴 수 없는 이유(기간 지남·목록 읽기 실패)를 «사진·영상» 칸을 펼치지 않아도 머리줄에서 알 수 있게
  const [videoState, setVideoState] = useState<SessionVideoUploaderState | null>(null);
  const videoBlock = videoState && (videoState.loaded || videoState.loadError) ? mediaBlockReason("video", videoState) : null;
  const [rosterWanted, setRosterWanted] = useState(false);
  const [infoRow, setInfoRow] = useState<string | null>(null);
  const people = useClassPeople({ classId: session.classId, sessionId: session.id, sessionDateId: session.sessionDateId, enabled: rosterWanted });
  // 출결 정정이 바로 보이게 명단은 이 부품이 들고 있다
  const [students, setStudents] = useState(initialStudents);
  const [published, setPublished] = useState(session.published === true);
  const [publishing, setPublishing] = useState(false);
  // 보내기·메모 저장 결과 한 줄(ok=잘 됨 / warn=실패·주의)
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  // 메모(수업 특이사항) — 완료한 수업은 자동 저장하지 않는다(고칠 때마다 수정 기록이 남는다). «메모 저장»을 눌러 저장한다.
  const [memo, setMemo] = useState(session.notes || "");
  const [savedMemo, setSavedMemo] = useState(session.notes || "");
  const [memoStatus, setMemoStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const counts = useMemo(() => ({
    PRESENT: students.filter((student) => student.status === "PRESENT").length,
    LATE: students.filter((student) => student.status === "LATE").length,
    ABSENT: students.filter((student) => student.status === "ABSENT").length,
    UNCHECKED: students.filter((student) => !student.status).length,
  }), [students]);

  async function save(value: string): Promise<LessonTextSaveResult> {
    const result = await saveSessionFeedLine({ sessionId: session.id, content: value });
    if (!result.ok) {
      if (isLoginFailure(result)) setNeedsLogin(true);
      return { ok: false, message: result.message };
    }
    setPrefilled(false);
    onLineSaved?.(result.content);
    return { ok: true };
  }

  // «아직 안 보낸» 수업을 학부모에게 보낸다 — 한 번 확인. 처음 보낼 때만 앱 알림이 가고, 뒤에 고쳐도 다시 알리지 않는다.
  async function publishToParents() {
    if (publishing || published || !editable) return;
    if (!window.confirm("이 수업을 학부모에게 보낼까요? 수업 내용·사진·영상이 보이고 앱 알림이 한 번 갑니다.")) return;
    setPublishing(true);
    setNotice(null);
    try {
      const result = await publishStaffSessionReport({ sessionId: session.id });
      if (!result.ok) {
        setNotice({ text: result.message, tone: "warn" });
        if (isLoginFailure(result)) setNeedsLogin(true);
        return;
      }
      setPublished(true);
      setNotice({ text: "학부모에게 보냈습니다.", tone: "ok" });
    } catch {
      setNotice({ text: "보내지 못했습니다. 네트워크 연결을 확인하고 다시 눌러 주세요.", tone: "warn" });
    } finally {
      setPublishing(false);
    }
  }

  async function saveMemo() {
    if (memoStatus === "saving" || !editable) return;
    const sending = memo;
    setMemoStatus("saving");
    try {
      const result = await saveSessionMemo({ sessionId: session.id, notes: sending });
      if (!result.ok) {
        setMemoStatus("error");
        setNotice({ text: result.message, tone: "warn" });
        if (isLoginFailure(result)) setNeedsLogin(true);
        return;
      }
      setSavedMemo(sending);
      setMemoStatus("saved");
    } catch {
      setMemoStatus("error");
      setNotice({ text: "메모를 저장하지 못했습니다. 네트워크 연결을 확인해 주세요.", tone: "warn" });
    }
  }

  const memoDirty = memo !== savedMemo;
  const memoFirstLine = memo.trim().split("\n")[0];
  // 수업 주소에서는 이 부품이 화면 전체(main), 홈에서는 수업 줄 안의 한 칸(div)이다
  const Wrapper = embedded ? "div" : "main";

  return (
    <Wrapper className={embedded ? "space-y-3" : "mx-auto max-w-lg space-y-3 px-4 pb-10 pt-4"} data-session-review>
      {/* 수업 주소(지난 수업에서 연 화면): 머리에 «완료한 수업 · 날짜 시간»과 반 이름. 홈에서는 수업 줄 머리에 이미 있어 되풀이하지 않는다 */}
      {/* 수업 주소에서만: 지난 수업 목록으로 돌아가는 글자 링크(터치 44px) */}
      {!embedded && (
        <Link href="/staff/sessions" className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--color-academy-muted)]">← 지난 수업</Link>
      )}
      {!embedded && (
        <section aria-label="완료한 수업" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] p-4 text-[var(--color-academy-ink)]">
          <p className="text-sm font-medium tabular-nums text-[var(--color-academy-ink)]">완료한 수업 · {kstLabel(session.sessionYmd)} {session.startTime}~{session.endTime}</p>
          <h1 className="academy-heading mt-0.5">{session.className}</h1>
          <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{session.location || "장소 미정"} · 학생 {session.studentCount}명</p>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs tabular-nums text-[var(--color-academy-muted)]">끝난 수업 · {attendanceSummaryLine(counts)}</p>
        <StatusPill tone={published ? "success" : "neutral"}>{published ? "학부모에게 보냄" : "아직 안 보냄"}</StatusPill>
      </div>

      {needsLogin && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
          <span>로그인이 풀렸습니다. 다시 로그인해 주세요.</span>
          <button type="button" onClick={() => window.location.assign(staffReloginHref(`${window.location.pathname}${window.location.search}`))} className="academy-button-primary">다시 로그인</button>
        </div>
      )}

      {/* 수정 기간이 지났으면 읽기 전용 안내 한 줄, 아직 안 보낸 수업이면 «학부모에게 보내기» */}
      {!editable && <p role="status" className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-3 text-sm text-[var(--color-academy-muted)]">{STAFF_EDIT_EXPIRED_MESSAGE}</p>}
      {editable && !published && (
        <button type="button" disabled={publishing} aria-busy={publishing} onClick={() => void publishToParents()} className="academy-button-primary min-h-12! w-full">
          {publishing ? "보내는 중…" : "학부모에게 보내기"}
        </button>
      )}
      {notice && (notice.tone === "ok"
        ? <p aria-live="polite" className="rounded-xl bg-[var(--color-academy-info-soft)] px-3 py-2 text-sm text-[var(--color-academy-info)]">{notice.text}</p>
        : <p role="alert" className="rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">{notice.text}</p>)}

      <WorkspaceSection id={`done-lesson-${session.id}`} title="수업 내용" summary={text.trim() ? text.trim().split("\n")[0] : "아직 쓰지 않았어요"} open={open.lesson} onToggle={() => setOpen((current) => ({ ...current, lesson: !current.lesson }))}>
        <LessonTextEditor inputId={`done-lesson-input-${session.id}`} phase="COMPLETED" value={text} onChange={setText} save={save} prefilledFromPlan={prefilled} disabled={!editable} />
      </WorkspaceSection>

      <WorkspaceSection id={`done-roster-${session.id}`} title="출석부" summary={attendanceSummaryLine(counts)} open={open.roster} onToggle={() => setOpen((current) => ({ ...current, roster: !current.roster }))}>
        <PeopleNotice loading={people.loading} error={people.error} onRetry={people.reload} />
        {/* 출결 명단 — 고칠 수 있는 줄(정규 수강생·특강 좌석)은 출결 버튼, 그 밖은 지금 상태만. 정정 흐름은 CompletedAttendanceRoster 가 맡는다 */}
        <CompletedAttendanceRoster
          session={session}
          students={students}
          onStudentsChange={setStudents}
          editable={editable}
          people={people}
          infoRow={infoRow}
          onToggleInfo={(rowId) => { setRosterWanted(true); setInfoRow(infoRow === rowId ? null : rowId); }}
          onOpenBilling={onOpenBilling}
          onNeedsLogin={() => setNeedsLogin(true)}
        />
      </WorkspaceSection>

      <WorkspaceSection id={`done-media-${session.id}`} title="사진·영상" summary={videoBlock ? `영상: ${videoBlock.text}` : editable ? `수업 뒤 ${STAFF_SESSION_EDIT_DAYS}일 동안 올리고 지울 수 있어요` : "올린 사진·영상"} open={open.media} onToggle={() => setOpen((current) => ({ ...current, media: !current.media }))}>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 사진</h3>
            <SessionPhotoUploader sessionId={session.id} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 영상</h3>
            <SessionVideoUploader sessionId={session.id} onStateChange={setVideoState} />
          </div>
        </div>
      </WorkspaceSection>

      {/* 메모(수업 특이사항) — 선생님·원장만 본다. 저장은 «메모 저장»으로(자동 저장 없음) */}
      <WorkspaceSection
        id={`done-memo-${session.id}`}
        title="메모"
        summary={memoFirstLine || "수업 특이사항"}
        badge={memoStatus === "error" ? <span role="status" className="shrink-0 rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-academy-danger)]">저장 실패</span> : memoDirty ? <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">저장 전</span> : undefined}
        open={open.memo}
        onToggle={() => setOpen((current) => ({ ...current, memo: !current.memo }))}
      >
        <p className="text-xs text-[var(--color-academy-muted)]">수업 특이사항 — 선생님·원장만 봅니다</p>
        <textarea value={memo} disabled={!editable} onChange={(event) => { setMemo(event.target.value); setMemoStatus("idle"); }} aria-label="수업 특이사항" rows={3} className="academy-input mt-2 leading-6" />
        {editable && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span aria-live="polite" className={`min-w-0 text-xs ${memoStatus === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
              {memoStatus === "saving" ? "저장 중…" : memoStatus === "error" ? "저장 실패 · 다시 눌러 주세요" : memoDirty ? "저장하지 않은 변경이 있어요" : memoStatus === "saved" ? "저장됨" : ""}
            </span>
            <button type="button" disabled={memoStatus === "saving" || !memoDirty} onClick={() => void saveMemo()} className="academy-button-secondary academy-button-sm shrink-0">메모 저장</button>
          </div>
        )}
      </WorkspaceSection>

      <WorkspaceLinks onOpenBilling={onOpenBilling ? () => onOpenBilling() : undefined} />
    </Wrapper>
  );
}
