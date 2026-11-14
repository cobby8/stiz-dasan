"use client";

import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  loadStaffSessionWorkspace,
  savePlannedClassContent,
  startClassSession,
} from "@/app/actions/staff-sessions";
import { createStaffClassNotice, getStaffClassNoticeStatus } from "@/app/actions/staff-notices";
import { deliveryStatusText, type DeliveryStatusSummary } from "@/lib/parent-staff-status";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import { LiveStatusPill } from "@/components/staff/LiveStatusPill";
// 2026-11-15 수업 한 화면: 수업 줄을 누르면 페이지 이동·아래 시트 대신 그 자리에서 수업 부품을 펼친다
import SessionWorkspace from "@/app/staff/sessions/[sessionId]/SessionInProgressClient";
import UiIcon from "@/components/common/UiIcon";
import type { LessonTextSaveResult } from "@/components/staff/LessonTextEditor";
import { retainSessionData } from "@/components/staff/sessionWorkspaceRules";
import { prepareStaffNavigation } from "./staffNavigation";
import type { StaffSessionDetail, StaffSessionStudent, StaffTodayClass } from "@/lib/staff-session-queries";
import { isStaleDateKey, STALE_DATE_MESSAGE, staffReloginHref } from "@/lib/staff-session-rules";

function isSeasonalLesson(lesson: StaffTodayClass) {
  return lesson.kind === "SEASONAL";
}

/** 펼친 수업 줄의 본문(수업 정보·출석부) — 펼칠 때 읽는다 */
type SessionData =
  | { state: "loading" }
  | { state: "ready"; session: StaffSessionDetail; students: StaffSessionStudent[] }
  | { state: "error"; message: string };

function isStarted(lesson: StaffTodayClass) {
  return Boolean(lesson.sessionId) && (lesson.sessionStatus === "IN_PROGRESS" || lesson.sessionStatus === "COMPLETED");
}

/** 펼친 본문의 id — 줄 머리의 aria-controls 가 가리킨다 */
function lessonBodyId(lesson: StaffTodayClass) {
  return `lesson-body-${lesson.scheduleKey}`;
}
const ClassBillingSheet = dynamic(
  () => import("@/components/staff/ClassBillingSheet").then((module) => module.ClassBillingSheet),
  { ssr: false },
);

export default function StaffHomeClient({
  dateKey,
  classes: initialClasses,
  coachLinkMissing = false,
  showFees,
}: {
  dateKey: string;
  classes: StaffTodayClass[];
  /** 선생님 계정에 코치가 연결되지 않아 수업이 안 보이는 상태(b4). 원장·부원장은 항상 false. */
  coachLinkMissing?: boolean;
  /**
   * «청구 확인» 시트·학생 정보의 미납 표시를 보일지 — 원장·부원장만 true(f3 보완).
   * 서버(loadStaffClassBilling·loadStaffClassPeople)도 선생님에게는 금액을 주지 않아, 화면도 진입점을 숨긴다.
   * 선생님의 현장 수납 확인 요청은 하단 «청구» 탭(/staff/billing)에서 그대로 한다.
   */
  showFees: boolean;
}) {
  const router = useRouter();
  // 로그인이 풀렸을 때 «다시 로그인» 버튼(b5)
  const [needsLogin, setNeedsLogin] = useState(false);

  // 밤새 열어 둔 화면을 다음 날 다시 보면 어제 수업이 그대로 보인다(b2).
  // 화면으로 돌아올 때(앱 전환·화면 켜기) 오늘(KST)과 화면 날짜가 다르면 새로 불러온다.
  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState === "visible" && isStaleDateKey(dateKey)) router.refresh();
    };
    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfStale);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [dateKey, router]);
  const [classes, setClasses] = useState(initialClasses);
  const [startTarget, setStartTarget] = useState<StaffTodayClass | null>(null);
  const [noticeTarget, setNoticeTarget] = useState<StaffTodayClass | null>(null);
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeContent, setNoticeContent] = useState("");
  const noticeOperation = useRef<{ classId: string; id: string } | null>(null);
  const [noticeResult, setNoticeResult] = useState("");
  const [noticeSaved, setNoticeSaved] = useState(false);
  const [noticeUncertain, setNoticeUncertain] = useState(false);
  const [noticeResumeNeeded, setNoticeResumeNeeded] = useState(false);
  const [billingTarget, setBillingTarget] = useState<{ lesson: StaffTodayClass; student?: { id: string; name: string } } | null>(null);
  // 펼친 수업 줄(한 번에 하나). 진행 중 수업이 있으면 그 줄을 펼친 채로 연다 — 예전 «수업으로 돌아가기» 한 번을 없앤다.
  const [expandedKey, setExpandedKey] = useState<string | null>(() => initialClasses.find((lesson) => lesson.sessionStatus === "IN_PROGRESS")?.scheduleKey ?? null);
  // 수업 기록 id → 펼친 본문. 진행 중 수업의 본문은 줄을 접어도 버리지 않는다(출석 저장 중·실패 표시를 잃지 않게).
  const [sessionData, setSessionData] = useState<Record<string, SessionData>>({});
  // 방금 시작한 수업 — 출석부 칸을 펼친 채로 연다(예전엔 출석 화면으로 이동했다)
  const [justStartedId, setJustStartedId] = useState<string | null>(null);
  // 진행 중 수업 줄을 접었을 때 머리줄에 보일 출결 요약·저장 상태
  const [liveStatus, setLiveStatus] = useState<{ summary: string; saving: string; failed: string } | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  // 수업 종료 같은 완료 안내 한 줄
  const [flash, setFlash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function describeNotice(result: { ok: false; message: string } | { ok: true; notificationStatus: DeliveryStatusSummary | null; recipientCount?: number | null; deliveryLookupFailed?: boolean; deliveryAttemptFailedCount?: number }) {
    if (!result.ok) { setError(result.message); return false; }
    const targetMismatch = typeof result.recipientCount === "number" && result.notificationStatus != null && result.recipientCount !== result.notificationStatus.recipientCount;
    const attention = Boolean(result.deliveryLookupFailed || result.deliveryAttemptFailedCount || targetMismatch);
    setNoticeSaved(true);
    setNoticeUncertain(false);
    const deliveryText = result.recipientCount === 0 && result.notificationStatus?.recipientCount === 0
      ? "연결된 학부모 수신자 0명 — 알림 대상이 없습니다."
      : deliveryStatusText(result.notificationStatus);
    setNoticeResult(`공지 저장 완료. ${deliveryText}${attention ? " 수신 대상·전달 결과 확인이 필요합니다." : ""}`);
    setNoticeResumeNeeded(Boolean(attention || result.notificationStatus?.unknownCount || (result.recipientCount && !result.notificationStatus?.recipientCount)));
    setError(null);
    return true;
  }

  async function checkNotice() {
    const operation = noticeOperation.current;
    if (!operation) return;
    try {
      const result = await getStaffClassNoticeStatus({ classId: operation.classId, operationId: operation.id });
      if (noticeOperation.current?.id !== operation.id) return;
      if (!result.ok && "code" in result && result.code === "NOT_FOUND") {
        // 조회 성공·기록 없음은 조회 실패와 다르다. 작업 ID를 유지한 재시도만 허용한다.
        setNoticeSaved(false); setNoticeUncertain(false); setError(result.message);
        return;
      }
      if (result.ok) { setNoticeTitle(result.savedTitle); setNoticeContent(result.savedContent); }
      if (!describeNotice(result)) setNoticeUncertain(true);
    } catch {
      if (noticeOperation.current?.id !== operation.id) return;
      setNoticeUncertain(true);
      setError("공지가 저장됐는지 확인하지 못했습니다. 새 공지를 만들지 말고 «저장·전달 결과 다시 확인»을 눌러 주세요.");
    }
  }

  useEffect(() => {
    if (!noticeTarget) return;
    setNoticeResult(""); setNoticeSaved(false); setNoticeUncertain(false); setNoticeResumeNeeded(false); setError(null);
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(`staff-notice-operation:${noticeTarget.id}`); } catch { /* 저장소가 차단되어도 현재 작업 ID는 ref에 남긴다. */ }
    if (stored) {
      noticeOperation.current = { classId: noticeTarget.id, id: stored };
      setNoticeUncertain(true);
      void checkNotice();
    } else if (noticeOperation.current?.classId !== noticeTarget.id) {
      noticeOperation.current = null; setNoticeTitle(""); setNoticeContent("");
    }
    // 모달을 다시 열면 기존 작업을 먼저 조회한다. 새 공지·알림은 만들지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeTarget?.id]);

  const runningClass = classes.find((lesson) => lesson.sessionStatus === "IN_PROGRESS");
  const focusClass = runningClass || classes.find((lesson) => lesson.sessionStatus !== "COMPLETED");
  const otherClasses = classes.filter((lesson) => lesson.sessionStatus !== "COMPLETED" && lesson.scheduleKey !== focusClass?.scheduleKey);
  const completedClasses = classes.filter((lesson) => lesson.sessionStatus === "COMPLETED");
  const completedCount = completedClasses.length;

  // 수업 줄의 값 일부를 고친다(저장한 수업 내용·상태를 목록에도 반영)
  function patchLesson(scheduleKey: string, patch: Partial<StaffTodayClass>) {
    setClasses((current) => current.map((item) => item.scheduleKey === scheduleKey ? { ...item, ...patch } : item));
  }

  function dropSessionData(sessionId: string | null) {
    if (!sessionId) return;
    setSessionData((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  // 수업 전 «수업 내용» 저장 — 통합 글칸이 부른다(미리 쓴 내용은 시작 전에만 저장된다. 선생님만 본다).
  async function savePlanned(lesson: StaffTodayClass, text: string): Promise<LessonTextSaveResult> {
    // 목록의 값을 먼저 고친다 — 줄을 접을 때 하는 저장이 끝나기 전에 다시 펼쳐도 방금 쓴 글로 시작하게(실패하면 되돌린다).
    const previous = lesson.plannedContent;
    patchLesson(lesson.scheduleKey, { plannedContent: text.trim() || null });
    // 특강은 회차(sessionDateId)를 함께 보내야 특강 기록에 저장된다(G11) — 빠지면 정규 수업 기록으로 들어갔다.
    const result = await savePlannedClassContent({
      classId: lesson.id,
      date: dateKey,
      plannedContent: text,
      ...(lesson.sessionDateId ? { sessionDateId: lesson.sessionDateId } : {}),
    });
    if (!result.ok) {
      patchLesson(lesson.scheduleKey, { plannedContent: previous });
      if ("needsLogin" in result && result.needsLogin) setNeedsLogin(true);
      // 날짜가 바뀐 화면이면 오늘 화면으로 새로 불러온다(b2).
      if (result.message === STALE_DATE_MESSAGE) router.refresh();
      return { ok: false, message: result.message };
    }
    patchLesson(lesson.scheduleKey, { sessionId: result.sessionId, sessionStatus: lesson.sessionStatus ?? "PLANNED", plannedContent: text.trim() || null });
    return { ok: true };
  }

  // 펼친 수업의 본문을 읽는다(시작한 수업만 — 시작 전 수업은 목록에 있는 값으로 충분하다)
  const loadSession = useCallback((sessionId: string) => {
    setSessionData((current) => ({ ...current, [sessionId]: { state: "loading" } }));
    void loadStaffSessionWorkspace({ sessionId })
      .then((result) => {
        if (!result.ok) {
          if (result.needsLogin) setNeedsLogin(true);
          setSessionData((current) => ({ ...current, [sessionId]: { state: "error", message: result.message } }));
          return;
        }
        setSessionData((current) => ({ ...current, [sessionId]: { state: "ready", session: result.session, students: result.students } }));
      })
      .catch(() => {
        setSessionData((current) => ({ ...current, [sessionId]: { state: "error", message: "수업 정보를 불러오지 못했습니다. 연결을 확인한 뒤 다시 눌러 주세요." } }));
      });
  }, []);

  const expandedLesson = classes.find((lesson) => lesson.scheduleKey === expandedKey) ?? null;
  const expandedSessionId = expandedLesson && isStarted(expandedLesson) ? expandedLesson.sessionId : null;
  const expandedLoaded = expandedSessionId ? Boolean(sessionData[expandedSessionId]) : true;
  useEffect(() => {
    if (expandedSessionId && !expandedLoaded) loadSession(expandedSessionId);
  }, [expandedLoaded, expandedSessionId, loadSession]);
  // 끝난 수업의 본문은 줄을 접으면 버린다 — 다시 펼칠 때 서버에서 새로 읽어, 접기 전에 저장한 수업 내용·사진·영상이
  // 처음 읽은 옛 값으로 되돌아가 보이지 않게 한다(옛 값 위에 저장하면 학부모에게 보이는 글이 덮인다). 진행 중 수업은 그대로 둔다.
  useEffect(() => {
    setSessionData((current) => retainSessionData(current, classes, expandedKey));
  }, [classes, expandedKey]);

  // 줄을 누르면 그 자리에서 펼친다(한 번에 하나). 다른 줄을 펼치기 전에 진행 중 수업 칸의 메모를 저장한다.
  async function toggleLesson(lesson: StaffTodayClass) {
    setError(null);
    setFlash("");
    // 같은 줄을 다시 누르면 접는다 — 진행 중 수업 칸은 접힐 때 스스로 메모를 저장한다
    if (expandedKey === lesson.scheduleKey) { setExpandedKey(null); return; }
    const ready = await prepareStaffNavigation();
    if (!ready.ok) {
      setError(ready.message || "수업 기록을 저장하지 못했습니다. 잠시 후 다시 눌러 주세요.");
      return;
    }
    setExpandedKey(lesson.scheduleKey);
  }

  // 수업 종료 — 이동하지 않고 그 줄이 «완료»로 바뀐다(완료한 수업 목록으로 내려간다)
  function handleFinished(lesson: StaffTodayClass, content: string | null) {
    patchLesson(lesson.scheduleKey, { sessionStatus: "COMPLETED", content });
    dropSessionData(lesson.sessionId);
    setLiveStatus(null);
    setExpandedKey(null);
    setFlash(`${lesson.name} 수업을 종료했습니다.`);
    router.refresh();
  }

  // 수업 시작 취소 — 그 줄이 «시작 전» 모양으로 돌아간다(기록한 출결·사진·메모는 그대로)
  function handleCancelled(lesson: StaffTodayClass) {
    patchLesson(lesson.scheduleKey, { sessionStatus: "PLANNED", startedAt: null });
    dropSessionData(lesson.sessionId);
    setLiveStatus(null);
    setFlash(`${lesson.name} 수업 시작을 취소했습니다.`);
    router.refresh();
  }

  function startLesson() {
    if (!startTarget) return;
    setError(null);
    startTransition(async () => {
      const result = await startClassSession({
        classId: startTarget.id,
        date: dateKey,
        ...(startTarget.sessionDateId ? { sessionDateId: startTarget.sessionDateId } : {}),
      });
      if (!result.ok) {
        if (result.code === "ACTIVE_SESSION" && result.activeSessionId) {
          // 어제 끝내지 못한 수업일 수 있다(b6) — 말없이 넘기면 선생님이 왜 다른 수업이 열렸는지 모른다.
          // «○○반(○월 ○일) 수업이 아직 진행 중입니다. 먼저 끝내 주세요» 를 먼저 보이고 이동한다.
          setStartTarget(null);
          // 오늘 목록에 있는 수업이면(다른 기기에서 먼저 시작) 이동하지 않고 그 줄을 펼친다
          const here = classes.find((lesson) => lesson.sessionId === result.activeSessionId);
          if (here) {
            patchLesson(here.scheduleKey, { sessionStatus: "IN_PROGRESS" });
            setExpandedKey(here.scheduleKey);
            setError(result.message);
            return;
          }
          if (window.confirm(`${result.message}\n\n그 수업 화면으로 이동할까요?`)) {
            router.push(`/staff/sessions/${result.activeSessionId}`);
          } else {
            setError(result.message);
          }
          return;
        }
        setError(result.message);
        if (result.needsLogin) setNeedsLogin(true);
        // 날짜가 바뀐 화면이면 오늘 화면으로 새로 불러온다(b2).
        if (result.code === "STALE_DATE") {
          setStartTarget(null);
          router.refresh();
        }
        return;
      }
      // 2026-11-15: 출석 화면으로 이동하지 않는다 — 그 줄이 «수업 중» 모양으로 바뀌고 출석부 칸이 펼쳐진다
      const started = startTarget;
      dropSessionData(result.sessionId);
      patchLesson(started.scheduleKey, { sessionId: result.sessionId, sessionStatus: "IN_PROGRESS", startedAt: result.startedAt });
      setJustStartedId(result.sessionId);
      setExpandedKey(started.scheduleKey);
      setStartTarget(null);
    });
  }

  function sendNotice(resumeDelivery = false) {
    if (!noticeTarget) return;
    if (noticeSaved && !resumeDelivery) return;
    if (!window.confirm("이 수업의 학부모에게 공지와 푸시 알림을 보내시겠습니까?")) return;
    const operation = noticeOperation.current?.classId === noticeTarget.id ? noticeOperation.current : { classId: noticeTarget.id, id: crypto.randomUUID() };
    noticeOperation.current = operation;
    try { sessionStorage.setItem(`staff-notice-operation:${noticeTarget.id}`, operation.id); } catch { /* 현재 열린 화면의 ref로 중복을 막는다. */ }
    setError(null);
    startTransition(async () => {
      try {
      const result = await createStaffClassNotice({ classId: noticeTarget.id, title: noticeTitle, content: noticeContent, operationId: operation.id, resumeDelivery });
      if (noticeOperation.current?.id !== operation.id) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      describeNotice(result);
      if (result.deliveryLookupFailed) setError("공지는 저장되었습니다. 수신자·알림 결과 확인이 필요합니다. 같은 공지의 결과를 확인해 주세요.");
      if ("deliveryResumeHeld" in result && result.deliveryResumeHeld) { setNoticeResumeNeeded(false); setError("알림 받을 학부모 목록을 찾지 못해 알림을 다시 보내지 않았습니다. 공지는 저장되어 있으니 학원 관리자에게 확인해 주세요."); }
      if ("deliveryAttemptFailedCount" in result && result.deliveryAttemptFailedCount) setError("공지는 저장되었습니다. 일부 학부모에게 알림을 보내지 못했습니다. «빠진 알림 다시 보내기»로 빠진 분께만 다시 보낼 수 있습니다.");
      } catch {
        setNoticeUncertain(true);
        await checkNotice();
      }
    });
  }

  function openPrimaryAction(lesson: StaffTodayClass) {
    if (lesson.sessionStatus === "IN_PROGRESS" && lesson.sessionId) {
      // 진행 중 수업은 이동하지 않고 그 줄을 펼친다
      setExpandedKey(lesson.scheduleKey);
      return;
    }
    if (runningClass) {
      setError(`${runningClass.name} 수업을 먼저 종료해 주세요.`);
      return;
    }
    setStartTarget(lesson);
  }

  // 수업 줄 아래에 펼쳐지는 본문 — 수업 주소(/staff/sessions/[id])와 같은 수업 부품을 끼운다.
  // 예전 아래 시트(수업 내용·수업 피드·학생 정보·청구 확인·수업 공지·수업 시작)의 기능은 전부 이 본문 안에 있다.
  function renderLessonBody(lesson: StaffTodayClass, startPrimary: boolean, className: string) {
    const expanded = expandedKey === lesson.scheduleKey;
    const openNotice = lesson.substitute ? undefined : () => { setError(null); setNoticeTarget(lesson); };
    // f4: 대타로만 보이는 반은 수업 공지를 숨긴다 — 서버도 대타에게는 공지 권한을 주지 않는다.
    // 청구 확인은 원장·부원장만(f3 보완) — 선생님에게는 진입 자체를 넘기지 않는다.
    const openBilling = showFees ? (student?: { id: string; name: string }) => setBillingTarget({ lesson, student }) : undefined;

    if (!isStarted(lesson)) {
      // 시작 전: 수업 시작 → 수업 내용(미리 쓰기) → 출석부(명단·학생 정보) → 수업 공지·청구 확인
      if (!expanded) return null;
      return (
        <div id={lessonBodyId(lesson)} className={className}>
          <SessionWorkspace
            key={`planned:${lesson.scheduleKey}`}
            planned={{
              lesson: {
                classId: lesson.id,
                className: lesson.name,
                sessionId: lesson.sessionId,
                // 특강은 회차를 넘겨 그 회차의 명단·학생 정보를 읽는다
                sessionDateId: lesson.sessionDateId,
                plannedContent: lesson.plannedContent,
                content: lesson.content,
                studentCount: lesson.studentCount,
              },
              startLocked: Boolean(runningClass),
              startPrimary,
              onStart: () => openPrimaryAction(lesson),
              savePlanned: (text) => savePlanned(lesson, text),
              onOpenNotice: openNotice,
              onOpenBilling: openBilling,
            }}
          />
        </div>
      );
    }

    const sessionId = lesson.sessionId as string;
    const data = sessionData[sessionId];
    const live = lesson.sessionStatus === "IN_PROGRESS";
    // 진행 중 수업 칸은 한 번 읽으면 줄을 접어도 화면에서만 숨긴다(hidden) — 출석 저장 중·실패 표시, 쓰던 메모, 올리던 사진을 잃지 않게.
    if (!expanded && !(live && data?.state === "ready")) return null;
    return (
      <div id={lessonBodyId(lesson)} hidden={!expanded} className={className}>
        {!data || data.state === "loading" ? (
          <p role="status" className="py-3 text-sm text-[var(--color-academy-muted)]">수업 정보를 불러오는 중입니다.</p>
        ) : data.state === "error" ? (
          <div role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
            <p>{data.message}</p>
            <button type="button" onClick={() => loadSession(sessionId)} className="academy-button-secondary academy-button-sm mt-2">다시 불러오기</button>
          </div>
        ) : (
          <SessionWorkspace
            key={sessionId}
            session={data.session}
            initialStudents={data.students}
            initialView={justStartedId === sessionId ? "attendance" : "main"}
            showFees={showFees}
            embedded
            active={expanded}
            onFinished={(content) => handleFinished(lesson, content)}
            onCancelled={() => handleCancelled(lesson)}
            onLineSaved={(content) => patchLesson(lesson.scheduleKey, { content })}
            onOpenNotice={openNotice}
            onOpenBilling={showFees ? (student) => setBillingTarget({ lesson, student }) : undefined}
            onAttendanceStatus={live ? setLiveStatus : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-8 pt-5">
      <header className="flex items-end justify-between gap-3">
        <h1 className="academy-heading">오늘 수업</h1>
        <p className="text-sm tabular-nums text-[var(--color-academy-muted)]">{dateKey}</p>
      </header>

      {classes.length > 0 && (
        <section aria-label="오늘 수업 요약" className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl bg-[var(--color-academy-surface)] px-4 py-3 text-sm">
          <SummaryItem label="전체" value={classes.length} />
          <SummaryItem label="진행 중" value={runningClass ? 1 : 0} accent={Boolean(runningClass)} />
          <SummaryItem label="완료" value={completedCount} />
        </section>
      )}

      {needsLogin && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
          <span>로그인이 풀렸습니다. 다시 로그인해 주세요.</span>
          <button type="button" onClick={() => window.location.assign(staffReloginHref("/staff"))} className="academy-button-primary">다시 로그인</button>
        </div>
      )}

      {flash && <p role="status" className="rounded-xl bg-[var(--color-academy-success-soft)] p-3 text-sm text-[var(--color-academy-success)]">{flash}</p>}
      {/* 창이 열려 있지 않을 때의 안내(다른 수업 시작 잠금·저장 실패 등) — 창이 열려 있으면 창 안에 보인다 */}
      {!startTarget && !noticeTarget && <ErrorMessage error={error} />}

      {classes.length === 0 ? (
        coachLinkMissing ? (
          // 코치 연결이 없으면 수업이 하나도 안 보인다 — «오늘 수업 없음»과 구분해 알려 준다(b4).
          <div role="status" className="rounded-2xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-5 text-center">
            <p className="font-semibold text-[var(--color-academy-ink)]">코치 연결이 필요합니다 — 원장님께 문의해 주세요.</p>
            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">이 계정에 코치 정보가 연결되면 담당 수업이 여기에 나옵니다.</p>
          </div>
        ) : (
          <div className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-6 text-center">
            <p className="text-[var(--color-academy-muted)]">오늘 배정된 수업이 없습니다.</p>
          </div>
        )
      ) : focusClass ? (
        <>
          <section>
            <p className="mb-2 text-sm font-medium text-[var(--color-academy-muted)]">{focusClass.sessionStatus === "IN_PROGRESS" ? "현재 수업" : "다음 수업"}</p>
            {/* 다음 수업을 짧게 읽고 바로 시작할 수 있도록 밝은 카드에 핵심을 모읍니다. */}
            {/* 게슈탈트 T-08: 진행 중 카드는 주황 테두리 2px 로 «지금 이것» 을 구분한다(별도 경고 상자 대신).
                테마의 .academy-focus-class 가 테두리를 1px 로 덮어쓰므로 진행 중일 때만 style 로 지정한다. */}
            <article
              className="academy-focus-class overflow-hidden rounded-3xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-ink)]"
              style={focusClass.sessionStatus === "IN_PROGRESS" ? { border: "2px solid var(--color-academy-secondary-strong)" } : undefined}
            >
              {/* 2026-11-15: 카드 머리를 누르면 페이지 이동 없이 그 자리에서 수업 칸이 펼쳐진다(화살표 = 펼침 표시) */}
              <div
                role="button"
                tabIndex={0}
                aria-expanded={expandedKey === focusClass.scheduleKey}
                aria-controls={lessonBodyId(focusClass)}
                onClick={() => void toggleLesson(focusClass)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void toggleLesson(focusClass); }
                }}
                className="cursor-pointer p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{focusClass.startTime}–{focusClass.endTime}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold">{focusClass.name}</h2>
                      {isSeasonalLesson(focusClass) && <SeasonalBadge />}
                      {focusClass.substitute && <SubstituteBadge />}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 text-[var(--color-academy-muted)]">
                    <StatusBadge status={focusClass.sessionStatus} />
                    <UiIcon name={expandedKey === focusClass.scheduleKey ? "expand_less" : "expand_more"} />
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--color-academy-muted)]">
                  <span>학생 <span className="tabular-nums">{focusClass.studentCount}</span>명</span>
                  <span>{focusClass.location || "장소 미정"}</span>
                </div>
                {/* 접혀 있을 때만 미리 쓴 내용을 두 줄로 보인다(펼치면 «수업 내용» 칸에 전체가 있다) */}
                {expandedKey !== focusClass.scheduleKey && focusClass.plannedContent && <p className="mt-3 line-clamp-2 text-sm leading-5 text-[var(--color-academy-muted)]">{focusClass.plannedContent}</p>}
              </div>
              {/* 접혀 있을 때: 시작 전이면 바로 시작(이 화면의 주 버튼), 진행 중이면 출결 요약·저장 상태 한 줄 */}
              {expandedKey !== focusClass.scheduleKey && focusClass.sessionStatus !== "IN_PROGRESS" && (
                <div className="px-4 pb-4">
                  <button type="button" onClick={() => openPrimaryAction(focusClass)} className="academy-button-primary min-h-12! w-full text-base!">
                    수업 시작
                  </button>
                </div>
              )}
              {expandedKey !== focusClass.scheduleKey && focusClass.sessionStatus === "IN_PROGRESS" && liveStatus && (
                <p role="status" className="px-4 pb-4 text-xs tabular-nums text-[var(--color-academy-muted)]">
                  {liveStatus.summary}
                  {liveStatus.saving && <span className="ml-2 rounded bg-[var(--color-academy-soft)] px-2 py-0.5 font-medium text-[var(--color-academy-muted)]">{liveStatus.saving}</span>}
                  {liveStatus.failed && <span className="ml-2 rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 font-medium text-[var(--color-academy-danger)]">{liveStatus.failed}</span>}
                </p>
              )}
              {renderLessonBody(focusClass, true, "px-4 pb-4")}
            </article>
          </section>

          {otherClasses.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="academy-section-title">남은 수업</h2>
                <span className="text-sm tabular-nums text-[var(--color-academy-muted)]">{otherClasses.length}개</span>
              </div>
              {/* 한 수업 = 한 줄 행(시간 | 반 | 인원 | 시작). 행을 누르면 그 아래에 수업 칸이 펼쳐진다 */}
              <ul aria-label="남은 수업 목록" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {otherClasses.map((lesson) => (
                  <ClassRow key={lesson.scheduleKey} lesson={lesson} expanded={expandedKey === lesson.scheduleKey} startLocked={Boolean(runningClass && lesson.sessionStatus !== "IN_PROGRESS")} onOpen={(target) => void toggleLesson(target)} onStart={openPrimaryAction}>
                    {renderLessonBody(lesson, false, "border-t border-[var(--color-academy-line)] px-3 py-3")}
                  </ClassRow>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <p role="status" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-neutral-soft)] px-4 py-5 font-medium text-[var(--color-academy-ink)]">오늘 수업을 모두 마쳤습니다.</p>
      )}

      {completedClasses.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {/* 2026-11-15: 펼침 표시는 화살표 아이콘(칸 제목이 버튼 이름) */}
          <button type="button" aria-expanded={showCompleted} aria-controls="completed-lessons" onClick={() => setShowCompleted((current) => !current)} className="flex min-h-11 w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium text-[var(--color-academy-muted)]">
            <span>완료한 수업 {completedCount}개</span>
            <UiIcon name={showCompleted ? "expand_less" : "expand_more"} />
          </button>
          {showCompleted && (
            <ul aria-label="완료한 수업 목록" id="completed-lessons" className="border-t border-[var(--color-academy-line)]">
              {completedClasses.map((lesson) => (
                <ClassRow key={lesson.scheduleKey} lesson={lesson} expanded={expandedKey === lesson.scheduleKey} startLocked={false} onOpen={(target) => void toggleLesson(target)} onStart={openPrimaryAction}>
                  {renderLessonBody(lesson, false, "border-t border-[var(--color-academy-line)] px-3 py-3")}
                </ClassRow>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* 진행 중 수업 칸이 펼쳐져 있으면 아래 고정 막대(사진·동영상·갤러리)가 떠 있다 — 막대 높이만큼 페이지 끝을 더 띄워
          마지막 줄(«완료한 수업» 등)이 막대에 가리지 않게 한다. 아래 탭·안전 영역 몫은 레이아웃의 아래 여백이 이미 잡고 있다. */}
      {expandedLesson?.sessionStatus === "IN_PROGRESS" && <div aria-hidden="true" className="h-28" />}

      {showFees && billingTarget && <ClassBillingSheet key={`${billingTarget.lesson.id}:${billingTarget.student?.id || "all"}`} open classId={billingTarget.lesson.id} className={billingTarget.lesson.name} student={billingTarget.student} onClose={() => setBillingTarget(null)} />}

      {noticeTarget && (
        <Modal title="수업 공지 작성" subtitle={`${noticeTarget.name} 학부모에게만 발송합니다.`} onClose={() => setNoticeTarget(null)} labelledBy="notice-title">
          <input disabled={noticeSaved || noticeUncertain || pending} value={noticeTitle} onChange={(event) => setNoticeTitle(event.target.value)} placeholder="공지 제목" className="academy-input mt-4" />
          <textarea disabled={noticeSaved || noticeUncertain || pending} value={noticeContent} onChange={(event) => setNoticeContent(event.target.value)} rows={6} placeholder="공지 내용을 입력해 주세요." className="academy-input mt-3 leading-6" />
          {!noticeSaved && !noticeUncertain && !pending && <VoiceToTextButton onText={(text) => setNoticeContent((current) => current ? `${current}\n${text}` : text)} />}
          <ErrorMessage error={error} />
          {noticeResult && <p role="status" className="mt-3 rounded-xl bg-[var(--color-academy-soft)] p-3 text-sm">{noticeResult}<br />알림이 전달돼도 학부모가 읽었다는 뜻은 아닙니다. 보내지 못했거나 다시 보낼 예정인 알림은 전달 건수에 넣지 않습니다.</p>}
          {(noticeSaved || noticeUncertain) && <button type="button" disabled={pending} onClick={() => startTransition(checkNotice)} className="academy-button-secondary mt-3">저장·전달 결과 다시 확인</button>}
          {noticeSaved && noticeResumeNeeded && <button type="button" disabled={pending} onClick={() => sendNotice(true)} className="academy-button-secondary ml-2 mt-3">빠진 알림 다시 보내기</button>}
          {noticeSaved && <button type="button" disabled={pending} onClick={() => { noticeOperation.current = null; try { sessionStorage.removeItem(`staff-notice-operation:${noticeTarget.id}`); } catch {} setNoticeSaved(false); setNoticeUncertain(false); setNoticeResult(""); setNoticeTitle(""); setNoticeContent(""); setError(null); }} className="academy-button-secondary ml-2 mt-3">새 공지 작성</button>}
          <ModalActions pending={pending} onCancel={() => setNoticeTarget(null)} onConfirm={() => sendNotice()} confirmLabel="공지 저장·알림 요청" disabled={noticeSaved || noticeUncertain || !noticeTitle.trim() || !noticeContent.trim()} />
        </Modal>
      )}

      {startTarget && (
        <Modal title="수업을 시작하시겠습니까?" subtitle={startTarget.name} onClose={() => setStartTarget(null)} labelledBy="start-title">
          <div className="mt-4 rounded-xl bg-[var(--color-academy-soft)] p-4 text-sm">
            <p className="font-semibold tabular-nums">{startTarget.startTime}–{startTarget.endTime}</p>
            <p className="mt-1 text-[var(--color-academy-muted)]">학생 {startTarget.studentCount}명 · {startTarget.location || "장소 미정"}</p>
          </div>
          <ErrorMessage error={error} />
          <ModalActions pending={pending} onCancel={() => setStartTarget(null)} onConfirm={startLesson} confirmLabel={pending ? "시작 중…" : "수업 시작"} />
        </Modal>
      )}
    </main>
  );
}

function SummaryItem({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <p className={accent ? "font-semibold text-[var(--color-academy-ink)]" : "text-[var(--color-academy-muted)]"}>{label} <strong className="ml-1 font-semibold tabular-nums">{value}</strong></p>;
}

function StatusBadge({ status, inverted = false }: { status: StaffTodayClass["sessionStatus"]; inverted?: boolean }) {
  const text = status === "COMPLETED" ? "완료" : status === "IN_PROGRESS" ? "수업 중" : "시작 전";
  // 게슈탈트 T-07: «수업 중»은 수업 진행 화면·기사님 «운행 중»과 같은 진행 알약(주황 채움 + 진행 점)
  if (status === "IN_PROGRESS") return <LiveStatusPill>{text}</LiveStatusPill>;
  return <span className={`shrink-0 rounded-full px-3 py-1 text-xs ${status === "IN_PROGRESS" ? "bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : inverted ? "bg-white/10 text-white" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"}`}>{text}</span>;
}

function SeasonalBadge({ inverted = false }: { inverted?: boolean }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs ${inverted ? "bg-white/10 text-white" : "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]"}`}>특강</span>;
}

// f4: 오늘 하루 대타로 맡은 반 표시(담당 반과 구분)
function SubstituteBadge() {
  return <span className="rounded-full bg-[var(--color-academy-surface)] px-2.5 py-1 text-xs text-[var(--color-academy-muted)] ring-1 ring-[var(--color-academy-line)]">대타</span>;
}

// 남은·완료 수업 한 줄 행. 행 탭 = 그 아래에 수업 칸 펼치기(children), 시작 버튼은 행 열기와 섞이지 않게 전파 차단
function ClassRow({ lesson, startLocked, expanded, onOpen, onStart, children }: { lesson: StaffTodayClass; startLocked: boolean; expanded: boolean; onOpen: (lesson: StaffTodayClass) => void; onStart: (lesson: StaffTodayClass) => void; children?: React.ReactNode }) {
  const completed = lesson.sessionStatus === "COMPLETED";
  const startLabel = lesson.sessionStatus === "IN_PROGRESS" ? "수업 이어하기" : startLocked ? "현재 수업 종료 후 시작" : "수업 시작";
  return <li className="border-b border-[var(--color-academy-line)] last:border-b-0">
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={lessonBodyId(lesson)}
      aria-label={`${lesson.name} 수업`}
      onClick={() => onOpen(lesson)}
      onKeyDown={(event) => {
        // 행 안의 시작 버튼에서 누른 Enter 를 행이 가로채지 않게
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(lesson); }
      }}
      className="flex min-h-14 cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-academy-soft)]"
    >
      <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-academy-ink)]">{lesson.startTime}–{lesson.endTime}</span>
      {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1"><span className="break-keep font-semibold text-[var(--color-academy-ink)]">{lesson.name}</span>{isSeasonalLesson(lesson) && <SeasonalBadge />}{lesson.substitute && <SubstituteBadge />}</span>
      <span className="shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)]">{lesson.studentCount}명</span>
      {/* 펼쳐진 줄에서는 머리의 «시작»을 숨긴다 — 본문의 [수업 시작]이 쓰던 수업 내용을 먼저 저장하고 시작하기 때문(머리 버튼으로 시작하면 쓰던 글이 사라졌다) */}
      {completed ? <StatusBadge status={lesson.sessionStatus} /> : expanded ? null : (
        <button
          type="button"
          disabled={startLocked}
          aria-label={`${lesson.name} ${startLabel}`}
          title={startLocked ? "진행 중인 수업을 먼저 종료해 주세요." : undefined}
          onClick={(event) => { event.stopPropagation(); onStart(lesson); }}
          className="academy-button-tonal academy-button-sm shrink-0"
        >
          {startLocked ? "대기" : lesson.sessionStatus === "IN_PROGRESS" ? "이어하기" : "시작"}
        </button>
      )}
      {/* 줄 머리의 펼침 표시 */}
      <span className="flex shrink-0 text-[var(--color-academy-muted)]">
        <UiIcon name={expanded ? "expand_less" : "expand_more"} />
      </span>
    </div>
    {children}
  </li>;
}

function Modal({ title, subtitle, onClose, labelledBy, children }: { title: string; subtitle: string; onClose: () => void; labelledBy: string; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const closeDialog = useCallback(() => onCloseRef.current(), []);
  useStaffDialog(true, dialogRef, closeDialog);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby={labelledBy}><div ref={dialogRef} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-3"><div><h2 id={labelledBy} className="text-xl font-bold">{title}</h2><p className="mt-1 text-sm text-[var(--color-academy-muted)]">{subtitle}</p></div><button type="button" aria-label="닫기" data-dialog-initial-focus onClick={onClose} className="academy-button-text academy-button-sm shrink-0">닫기</button></div>{children}</div></div>;
}

function ModalActions({ pending, onCancel, onConfirm, confirmLabel, disabled = false }: { pending: boolean; onCancel: () => void; onConfirm: () => void; confirmLabel: string; disabled?: boolean }) { return <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" disabled={pending} onClick={onCancel} className="academy-button-secondary">취소</button><button type="button" disabled={pending || disabled} onClick={onConfirm} className="academy-button-primary">{confirmLabel}</button></div>; }
function ErrorMessage({ error }: { error: string | null }) { return error ? <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p> : null; }
