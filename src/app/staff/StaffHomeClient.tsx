"use client";

import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  savePlannedClassContent,
  startClassSession,
} from "@/app/actions/staff-sessions";
import { createStaffClassNotice, getStaffClassNoticeStatus } from "@/app/actions/staff-notices";
import { deliveryStatusText, type DeliveryStatusSummary } from "@/lib/parent-staff-status";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { LiveStatusPill } from "@/components/staff/LiveStatusPill";
import type { StaffTodayClass } from "@/lib/staff-session-queries";
import { isStaleDateKey, STALE_DATE_MESSAGE, staffReloginHref } from "@/lib/staff-session-rules";

function isSeasonalLesson(lesson: StaffTodayClass) {
  return lesson.kind === "SEASONAL";
}

const ClassPeopleSheet = dynamic(
  () => import("@/components/staff/ClassPeopleSheet").then((module) => module.ClassPeopleSheet),
  { ssr: false },
);
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
  const [contentTarget, setContentTarget] = useState<StaffTodayClass | null>(null);
  const [plannedContent, setPlannedContent] = useState("");
  const [noticeTarget, setNoticeTarget] = useState<StaffTodayClass | null>(null);
  const [noticeTitle, setNoticeTitle] = useState("");
  const [noticeContent, setNoticeContent] = useState("");
  const noticeOperation = useRef<{ classId: string; id: string } | null>(null);
  const [noticeResult, setNoticeResult] = useState("");
  const [noticeSaved, setNoticeSaved] = useState(false);
  const [noticeUncertain, setNoticeUncertain] = useState(false);
  const [noticeResumeNeeded, setNoticeResumeNeeded] = useState(false);
  const [peopleTarget, setPeopleTarget] = useState<StaffTodayClass | null>(null);
  const [billingTarget, setBillingTarget] = useState<{ lesson: StaffTodayClass; student?: { id: string; name: string } } | null>(null);
  // 남은·완료 수업 행을 누르면 여는 하단 시트(장소·수업 내용·빠른 메뉴는 여기서)
  const [detailTarget, setDetailTarget] = useState<StaffTodayClass | null>(null);
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

  function openContent(lesson: StaffTodayClass) {
    setError(null);
    setContentTarget(lesson);
    setPlannedContent(lesson.plannedContent || "");
  }

  function saveContent() {
    if (!contentTarget) return;
    setError(null);
    startTransition(async () => {
      // 특강은 회차(sessionDateId)를 함께 보내야 특강 기록에 저장된다(G11) — 빠지면 정규 수업 기록으로 들어갔다.
      const result = await savePlannedClassContent({
        classId: contentTarget.id,
        date: dateKey,
        plannedContent,
        ...(contentTarget.sessionDateId ? { sessionDateId: contentTarget.sessionDateId } : {}),
      });
      if (!result.ok) {
        setError(result.message);
        if ("needsLogin" in result && result.needsLogin) setNeedsLogin(true);
        // 날짜가 바뀐 화면이면 오늘 화면으로 새로 불러온다(b2).
        if (result.message === STALE_DATE_MESSAGE) router.refresh();
        return;
      }
      setClasses((current) => current.map((lesson) => lesson.id === contentTarget.id
        ? { ...lesson, sessionId: result.sessionId, sessionStatus: "PLANNED", plannedContent }
        : lesson));
      setContentTarget(null);
    });
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
      router.push(`/staff/sessions/${result.sessionId}?view=attendance`);
    });
  }

  function openContacts(lesson: StaffTodayClass) {
    setPeopleTarget(lesson);
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
      router.push(`/staff/sessions/${lesson.sessionId}`);
      return;
    }
    if (runningClass) {
      setError(`${runningClass.name} 수업을 먼저 종료해 주세요.`);
      return;
    }
    setStartTarget(lesson);
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
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold tabular-nums text-[var(--color-academy-ink)]">{focusClass.startTime}–{focusClass.endTime}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-bold">{focusClass.name}</h2>
                      {isSeasonalLesson(focusClass) && <SeasonalBadge />}
                      {focusClass.substitute && <SubstituteBadge />}
                    </div>
                  </div>
                  <StatusBadge status={focusClass.sessionStatus} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm text-[var(--color-academy-muted)]">
                  <span>학생 <span className="tabular-nums">{focusClass.studentCount}</span>명</span>
                  <span>{focusClass.location || "장소 미정"}</span>
                </div>
                {focusClass.plannedContent && <p className="mt-3 line-clamp-2 text-sm leading-5 text-[var(--color-academy-muted)]">{focusClass.plannedContent}</p>}
              </div>
              {focusClass.sessionStatus !== "COMPLETED" && (
                <div className="space-y-2 px-4 pb-4">
                  <button type="button" onClick={() => openPrimaryAction(focusClass)} className="academy-button-primary min-h-12! w-full text-base!">
                    {focusClass.sessionStatus === "IN_PROGRESS" ? "수업으로 돌아가기" : "수업 시작"}
                  </button>
                  {/* 다른 수업 시작 잠금 안내 — 버튼 바로 아래 한 줄(근접성). 잠금 동작 자체는 openPrimaryAction 그대로. */}
                  {runningClass && (
                    <p role="status" className="text-xs text-[var(--color-academy-muted)]">
                      현재 수업을 종료한 뒤 다음 수업을 시작할 수 있습니다.
                    </p>
                  )}
                  <details className="rounded-xl bg-[var(--color-academy-surface)]">
                    <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium text-[var(--color-academy-muted)]">수업 준비·관리</summary>
                    <div className="grid grid-cols-2 gap-2 p-2" aria-label="수업 빠른 메뉴">
                      <SecondaryButton label="수업 내용" onClick={() => openContent(focusClass)} disabled={focusClass.sessionStatus === "IN_PROGRESS"} />
                      <SecondaryButton label="학생 정보" onClick={() => setPeopleTarget(focusClass)} />
                      {showFees && <SecondaryButton label="청구 확인" onClick={() => setBillingTarget({ lesson: focusClass })} />}
                      {/* f4: 대타로만 보이는 반은 수업 공지를 숨긴다 — 서버도 대타에게는 공지 권한을 주지 않는다. */}
                      {!focusClass.substitute && <SecondaryButton label="수업 공지" onClick={() => { setError(null); setNoticeTarget(focusClass); }} />}
                    </div>
                  </details>
                </div>
              )}
            </article>
          </section>

          {otherClasses.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="academy-section-title">남은 수업</h2>
                <span className="text-sm tabular-nums text-[var(--color-academy-muted)]">{otherClasses.length}개</span>
              </div>
              {/* 한 수업 = 한 줄 행(시간 | 반 | 인원 | 시작). 빠른 메뉴는 행을 눌러 시트에서 */}
              <ul aria-label="남은 수업 목록" className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {otherClasses.map((lesson) => (
                  <ClassRow key={lesson.scheduleKey} lesson={lesson} startLocked={Boolean(runningClass && lesson.sessionStatus !== "IN_PROGRESS")} onOpen={setDetailTarget} onStart={openPrimaryAction} />
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <p role="status" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-neutral-soft)] px-4 py-5 font-medium text-[var(--color-academy-ink)]">오늘 수업을 모두 마쳤습니다.</p>
      )}

      {completedClasses.length > 0 && (
        <details className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium text-[var(--color-academy-muted)]">완료한 수업 {completedCount}개</summary>
          <ul aria-label="완료한 수업 목록" className="border-t border-[var(--color-academy-line)]">
            {completedClasses.map((lesson) => <ClassRow key={lesson.scheduleKey} lesson={lesson} startLocked={false} onOpen={setDetailTarget} onStart={openPrimaryAction} />)}
          </ul>
        </details>
      )}

      {detailTarget && (
        <ClassDetailSheet
          lesson={detailTarget}
          startLocked={Boolean(runningClass && detailTarget.sessionStatus !== "IN_PROGRESS")}
          showFees={showFees}
          onClose={() => setDetailTarget(null)}
          // 시트를 먼저 닫고 기존 동작을 그대로 부른다(두 창이 겹치지 않게)
          onAction={(action) => {
            const lesson = detailTarget;
            setDetailTarget(null);
            if (action === "start") openPrimaryAction(lesson);
            else if (action === "content") openContent(lesson);
            else if (action === "contacts") openContacts(lesson);
            else if (action === "billing") { if (showFees) setBillingTarget({ lesson }); }
            else { setError(null); setNoticeTarget(lesson); }
          }}
        />
      )}

      {peopleTarget && <ClassPeopleSheet key={`${peopleTarget.id}:${peopleTarget.sessionId || peopleTarget.sessionDateId || "today"}`} open classId={peopleTarget.id} sessionId={peopleTarget.sessionId} sessionDateId={peopleTarget.sessionDateId} className={peopleTarget.name} onClose={() => setPeopleTarget(null)} onOpenBilling={showFees ? (student) => { const lesson = peopleTarget; setPeopleTarget(null); setBillingTarget({ lesson, student }); } : undefined} />}
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

      {contentTarget && (
        <Modal title="수업 내용 미리 작성" subtitle={contentTarget.name} onClose={() => setContentTarget(null)} labelledBy="content-title">
          <textarea value={plannedContent} onChange={(event) => setPlannedContent(event.target.value)} rows={7} placeholder="오늘 진행할 내용, 교재 페이지, 준비물 등을 입력하세요." className="academy-input mt-4 leading-6" />
          <VoiceToTextButton onText={(text) => setPlannedContent((current) => current ? `${current}\n${text}` : text)} />
          <ErrorMessage error={error} />
          <ModalActions pending={pending} onCancel={() => setContentTarget(null)} onConfirm={saveContent} confirmLabel="저장" />
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

// 2026-11-13 UI 통일: 아이콘 없이 글자만(테마 보조 버튼 44px)
function SecondaryButton({ label, onClick, disabled = false }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="academy-button-secondary">{label}</button>;
}

// 남은·완료 수업 한 줄 행. 행 탭 = 상세 시트, 시작 버튼은 행 열기와 섞이지 않게 전파 차단
function ClassRow({ lesson, startLocked, onOpen, onStart }: { lesson: StaffTodayClass; startLocked: boolean; onOpen: (lesson: StaffTodayClass) => void; onStart: (lesson: StaffTodayClass) => void }) {
  const completed = lesson.sessionStatus === "COMPLETED";
  const startLabel = lesson.sessionStatus === "IN_PROGRESS" ? "수업으로 돌아가기" : startLocked ? "현재 수업 종료 후 시작" : "수업 시작";
  return <li
    role="button"
    tabIndex={0}
    aria-label={`${lesson.name} 수업 상세`}
    onClick={() => onOpen(lesson)}
    onKeyDown={(event) => {
      // 행 안의 시작 버튼에서 누른 Enter 를 행이 가로채지 않게
      if (event.target !== event.currentTarget) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(lesson); }
    }}
    className="flex min-h-14 cursor-pointer items-center gap-2 border-b border-[var(--color-academy-line)] px-3 py-1.5 last:border-b-0 hover:bg-[var(--color-academy-soft)]"
  >
    <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-academy-ink)]">{lesson.startTime}–{lesson.endTime}</span>
    {/* 반 이름은 자르지 않고 줄바꿈 허용(말줄임 금지) */}
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1"><span className="break-keep font-semibold text-[var(--color-academy-ink)]">{lesson.name}</span>{isSeasonalLesson(lesson) && <SeasonalBadge />}{lesson.substitute && <SubstituteBadge />}</span>
    <span className="shrink-0 text-right text-xs tabular-nums text-[var(--color-academy-muted)]">{lesson.studentCount}명</span>
    {completed ? <StatusBadge status={lesson.sessionStatus} /> : (
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
  </li>;
}

type ClassDetailAction = "start" | "content" | "contacts" | "billing" | "notice";

// 행을 누르면 여는 하단 시트: 기존 카드에 있던 정보·빠른 메뉴를 그대로 옮긴 것
function ClassDetailSheet({ lesson, startLocked, showFees, onClose, onAction }: { lesson: StaffTodayClass; startLocked: boolean; showFees: boolean; onClose: () => void; onAction: (action: ClassDetailAction) => void }) {
  const completed = lesson.sessionStatus === "COMPLETED";
  return <ListDetailPanel onClose={onClose} titleId="staff-class-detail-title">
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-academy-line)] px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium tabular-nums text-[var(--color-academy-ink)]">{lesson.startTime}–{lesson.endTime}</p>
        <div className="flex flex-wrap items-center gap-2"><h2 id="staff-class-detail-title" className="text-lg font-bold text-[var(--color-academy-ink)]">{lesson.name}</h2>{isSeasonalLesson(lesson) && <SeasonalBadge />}{lesson.substitute && <SubstituteBadge />}<StatusBadge status={lesson.sessionStatus} /></div>
      </div>
      <button type="button" aria-label="닫기" onClick={onClose} className="grid size-11 shrink-0 place-items-center rounded-full"><span aria-hidden="true" className="material-symbols-outlined">close</span></button>
    </div>
    <div className="space-y-3 px-4 pb-4 pt-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--color-academy-muted)]">
        <span>학생 <span className="tabular-nums">{lesson.studentCount}</span>명</span>
        <span>{lesson.location || "장소 미정"}</span>
      </div>
      {lesson.plannedContent && <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-academy-ink)]">{lesson.plannedContent}</p>}
      {!completed && <>
        <div className="grid grid-cols-2 gap-2" aria-label={`${lesson.name} 수업 빠른 메뉴`}>
          <SecondaryButton label="수업 내용" onClick={() => onAction("content")} />
          <SecondaryButton label="학생 정보" onClick={() => onAction("contacts")} />
          {showFees && <SecondaryButton label="청구 확인" onClick={() => onAction("billing")} />}
          {!lesson.substitute && <SecondaryButton label="수업 공지" onClick={() => onAction("notice")} />}
        </div>
        <button type="button" disabled={startLocked} title={startLocked ? "진행 중인 수업을 먼저 종료해 주세요." : undefined} onClick={() => onAction("start")} className="academy-button-primary min-h-12! w-full text-base!">
          {lesson.sessionStatus === "IN_PROGRESS" ? "수업으로 돌아가기" : startLocked ? "현재 수업 종료 후 시작" : "수업 시작"}
        </button>
      </>}
    </div>
  </ListDetailPanel>;
}

function Modal({ title, subtitle, onClose, labelledBy, children }: { title: string; subtitle: string; onClose: () => void; labelledBy: string; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const closeDialog = useCallback(() => onCloseRef.current(), []);
  useStaffDialog(true, dialogRef, closeDialog);
  return <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby={labelledBy}><div ref={dialogRef} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"><div className="flex items-start justify-between gap-3"><div><h2 id={labelledBy} className="text-xl font-bold">{title}</h2><p className="mt-1 text-sm text-[var(--color-academy-muted)]">{subtitle}</p></div><button type="button" aria-label="닫기" data-dialog-initial-focus onClick={onClose} className="min-h-11 min-w-11 rounded-full p-2"><span className="material-symbols-outlined">close</span></button></div>{children}</div></div>;
}

function ModalActions({ pending, onCancel, onConfirm, confirmLabel, disabled = false }: { pending: boolean; onCancel: () => void; onConfirm: () => void; confirmLabel: string; disabled?: boolean }) { return <div className="mt-5 grid grid-cols-2 gap-2"><button type="button" disabled={pending} onClick={onCancel} className="academy-button-secondary">취소</button><button type="button" disabled={pending || disabled} onClick={onConfirm} className="academy-button-primary">{confirmLabel}</button></div>; }
function ErrorMessage({ error }: { error: string | null }) { return error ? <p role="alert" className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{error}</p> : null; }
