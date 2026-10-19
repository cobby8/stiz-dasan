"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  cancelClassSession,
  completeClassSession,
  saveSessionMemo,
  saveStaffAttendance,
} from "@/app/actions/staff-sessions";
import { SessionPhotoUploader } from "@/components/staff/SessionPhotoUploader";
// 사유 라벨은 학부모 신고 화면과 같은 표를 쓴다(두 화면의 표기가 갈리면 안 된다).
import { REASON_LABEL as ABSENCE_REASON_LABEL } from "@/lib/regular/regularAbsenceRules";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import { loadStaffSessionMonthlyFees } from "@/app/actions/staff-billing";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import { monthlyFeeLabel } from "@/components/staff/StaffMonthlyFeeSummary";
import type {
  StaffSessionDetail,
  StaffSessionStudent,
} from "@/lib/staff-session-queries";

const ClassPeopleSheet = dynamic(
  () => import("@/components/staff/ClassPeopleSheet").then((module) => module.ClassPeopleSheet),
  { ssr: false },
);
const ClassBillingSheet = dynamic(
  () => import("@/components/staff/ClassBillingSheet").then((module) => module.ClassBillingSheet),
  { ssr: false },
);

type View = "main" | "attendance";
type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "출석",
  LATE: "지각",
  ABSENT: "결석",
};

function formatElapsed(seconds: number) {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

export default function SessionInProgressClient({
  session,
  initialStudents,
  initialView,
}: {
  session: StaffSessionDetail;
  initialStudents: StaffSessionStudent[];
  initialView: View;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>(initialView);
  const [students, setStudents] = useState(initialStudents);
  const [elapsed, setElapsed] = useState(0);
  const [memo, setMemo] = useState(session.notes || "");
  const [message, setMessage] = useState("");
  const [bulkAttendanceProgress, setBulkAttendanceProgress] = useState("");
  const [finishError, setFinishError] = useState("");
  const [memoStatus, setMemoStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [showPlan, setShowPlan] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  // 종료 화면에서 바로 남기는 수업 리포트. 기본은 "바로 보내기" 켬 —
  // 꺼두면 지금처럼 아무도 발행하지 않아 학부모 화면이 계속 비어 있게 된다.
  const [report, setReport] = useState("");
  const [publishReport, setPublishReport] = useState(true);
  const [showPeople, setShowPeople] = useState(false);
  const [billingStudent, setBillingStudent] = useState<{ id: string; name: string } | null | undefined>(undefined);
  const [feeData, setFeeData] = useState<{ month: string; items: StaffMonthlyFeeSummary[] } | null>(null);
  const [feeLoading, setFeeLoading] = useState(true);
  const [feeError, setFeeError] = useState("");
  const [feeReload, setFeeReload] = useState(0);
  const [attendanceBillingTarget, setAttendanceBillingTarget] = useState<StaffSessionStudent | null>(null);
  const [pending, startTransition] = useTransition();
  const endDialogRef = useRef<HTMLDivElement>(null);
  const memoRef = useRef(memo);
  const lastSavedMemoRef = useRef(memo);
  const memoSaveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const wasOnlineRef = useRef(true);
  const voiceBusyRef = useRef(voiceBusy);
  const closeEndDialog = useCallback(() => setShowEndConfirm(false), []);
  useStaffDialog(showEndConfirm, endDialogRef, closeEndDialog, !pending);

  // 수강료 조회가 늦거나 실패해도 출석 버튼과 수업 저장은 계속 사용할 수 있습니다.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) { setFeeLoading(true); setFeeError(""); setFeeData(null); }
    });
    void loadStaffSessionMonthlyFees({ sessionId: session.id })
      .then((result) => { if (active) setFeeData(result); })
      .catch((reason: unknown) => {
        if (active) setFeeError(reason instanceof Error ? reason.message : "수강료 정보를 불러오지 못했습니다.");
      })
      .finally(() => { if (active) setFeeLoading(false); });
    return () => { active = false; };
  }, [feeReload, session.id]);

  const feesByRoster = useMemo(() => new Map(feeData?.items.map((item) => [item.rosterId, item]) ?? []), [feeData]);
  const closeAttendanceBilling = useCallback(() => setAttendanceBillingTarget(null), []);
  const syncLoadedFee = useCallback((month: string, summary: StaffMonthlyFeeSummary) => {
    setFeeData((current) => current?.month === month ? {
      ...current,
      items: [...current.items.filter((item) => item.rosterId !== summary.rosterId), summary],
    } : current);
  }, []);

  useEffect(() => {
    memoRef.current = memo;
  }, [memo]);

  useEffect(() => {
    voiceBusyRef.current = voiceBusy;
  }, [voiceBusy]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const persistMemo = useCallback(async (notes: string, announce = false) => {
    if (notes === lastSavedMemoRef.current) return true;
    setMemoStatus("saving");
    const save = async () => {
      try {
        const result = await saveSessionMemo({ sessionId: session.id, notes });
        if (!result.ok) {
          setMemoStatus("error");
          setMessage(result.message);
          return false;
        }
        lastSavedMemoRef.current = notes;
        setMemoStatus(memoRef.current === notes ? "saved" : "dirty");
        if (announce) setMessage("특이사항을 저장했습니다.");
        return true;
      } catch {
        setMemoStatus("error");
        setMessage("특이사항을 저장하지 못했습니다. 네트워크 연결을 확인해 주세요.");
        return false;
      }
    };
    memoSaveQueueRef.current = memoSaveQueueRef.current.then(save, save);
    return memoSaveQueueRef.current;
  }, [session.id]);

  useEffect(() => {
    const prepareToLeave = (event: Event) => {
      const navigationEvent = event as CustomEvent<{
        handled: boolean;
        complete: (result: { ok: boolean; message?: string }) => void;
      }>;
      if (!navigationEvent.detail) return;
      navigationEvent.detail.handled = true;

      void (async () => {
        if (voiceBusy) {
          const message = "음성 메모 처리가 끝난 뒤 이동해 주세요.";
          setMessage(message);
          navigationEvent.detail.complete({ ok: false, message });
          return;
        }

        const saved = await persistMemo(memoRef.current);
        if (!saved) {
          const message = "특이사항을 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";
          setMessage(message);
          navigationEvent.detail.complete({ ok: false, message });
          return;
        }
        navigationEvent.detail.complete({ ok: true });
      })();
    };

    window.addEventListener("staff:prepare-navigation", prepareToLeave);
    return () => window.removeEventListener("staff:prepare-navigation", prepareToLeave);
  }, [persistMemo, voiceBusy]);

  useEffect(() => {
    const guardKey = `staff-session-${session.id}`;
    const currentState = typeof history.state === "object" && history.state ? history.state : {};
    const alreadyGuarded = currentState.staffSessionGuard === guardKey;
    const hasPreviousEntry = alreadyGuarded ? currentState.staffSessionHadPrevious === true : history.length > 1;
    const sentinelState = { ...currentState, staffSessionGuard: guardKey, staffSessionHadPrevious: hasPreviousEntry };
    if (!alreadyGuarded) {
      history.replaceState({ ...currentState, staffSessionGuardBase: guardKey }, "", window.location.href);
      history.pushState(sentinelState, "", window.location.href);
    }

    let preparingToLeave = false;
    let allowNavigation = false;

    const handlePopState = () => {
      if (allowNavigation) return;

      // 먼저 동일 주소의 보호 이력을 복원해 iOS 스와이프 중에도 수업 화면을 유지합니다.
      history.pushState(sentinelState, "", window.location.href);
      if (preparingToLeave) return;

      const confirmed = window.confirm("수업이 진행 중입니다. 수업 기록을 저장하고 이전 화면으로 이동할까요?");
      if (!confirmed) return;

      preparingToLeave = true;
      void (async () => {
        if (voiceBusyRef.current) {
          setMessage("음성 메모 처리가 끝난 뒤 이동해 주세요.");
          window.alert("음성 메모 처리가 끝난 뒤 다시 시도해 주세요.");
          preparingToLeave = false;
          return;
        }

        const saved = await persistMemo(memoRef.current);
        if (!saved) {
          setMessage("특이사항을 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
          window.alert("수업 기록을 저장하지 못해 현재 화면을 유지합니다.");
          preparingToLeave = false;
          return;
        }

        allowNavigation = true;
        window.removeEventListener("popstate", handlePopState);
        // 감지 직후 복구한 sentinel과 원래 세션 이력 두 칸을 함께 건너뜁니다.
        if (hasPreviousEntry) history.go(-2);
        else window.location.assign("/staff");
      })();
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      allowNavigation = true;
      window.removeEventListener("popstate", handlePopState);
    };
  }, [persistMemo, session.id]);

  useEffect(() => {
    if (memo === lastSavedMemoRef.current) return;
    const timer = window.setTimeout(() => void persistMemo(memo), 900);
    return () => window.clearTimeout(timer);
  }, [memo, persistMemo]);

  useEffect(() => {
    const reconnected = online && !wasOnlineRef.current;
    wasOnlineRef.current = online;
    if (reconnected && memoRef.current !== lastSavedMemoRef.current) {
      void persistMemo(memoRef.current);
    }
  }, [online, persistMemo]);

  useEffect(() => {
    const warnBeforeLeave = (event: BeforeUnloadEvent) => {
      if (memoStatus === "saved" && !voiceBusy) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeave);
    return () => window.removeEventListener("beforeunload", warnBeforeLeave);
  }, [memoStatus, voiceBusy]);

  useEffect(() => {
    if (!session.startedAt) return;
    const update = () => {
      const startedAt = new Date(session.startedAt!).getTime();
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [session.startedAt]);

  const counts = useMemo(
    () => ({
      PRESENT: students.filter((student) => student.status === "PRESENT").length,
      LATE: students.filter((student) => student.status === "LATE").length,
      ABSENT: students.filter((student) => student.status === "ABSENT").length,
      UNCHECKED: students.filter((student) => !student.status).length,
    }),
    [students],
  );

  // studentId 파라미터명이지만 실제로는 로스터 행의 고유 id(정규=studentId / 방학특강=enrollmentDateId)다.
  // 서버에는 그 행의 attendanceKey(방학특강이면 좌석ID)를 넘겨 좌석 기준으로 저장한다.
  function updateAttendance(rowId: string, status: AttendanceStatus) {
    setMessage("");
    const target = students.find((student) => student.id === rowId);
    if (!target) return;
    startTransition(async () => {
      try {
        const result = await saveStaffAttendance({ sessionId: session.id, attendanceKey: target.attendanceKey, status });
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        setStudents((current) =>
          current.map((student) =>
            student.id === rowId
              ? {
                  ...student,
                  status,
                  arrivedAt: status === "LATE" ? student.arrivedAt || new Date().toISOString() : null,
                }
              : student,
          ),
        );
        if (result.notificationWarning) {
          setMessage("출결은 저장됐지만 학부모 알림은 재전송이 필요합니다.");
        }
      } catch {
        setMessage("출석을 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
      }
    });
  }

  function markAllPresent() {
    const unchecked = students.filter((student) => !student.status);
    setMessage("");
    setBulkAttendanceProgress(`0/${unchecked.length} 처리 중`);
    startTransition(async () => {
      try {
        for (const [index, student] of unchecked.entries()) {
          const result = await saveStaffAttendance({
            sessionId: session.id,
            attendanceKey: student.attendanceKey,
            status: "PRESENT",
          });
          if (!result.ok) {
            setMessage(`${index}명은 저장됐습니다. ${result.message}`);
            return;
          }
          setStudents((current) => current.map((row) => (
            row.id === student.id ? { ...row, status: "PRESENT" } : row
          )));
          setBulkAttendanceProgress(`${index + 1}/${unchecked.length} 처리 중`);
        }
        if (unchecked.length > 0) {
          setMessage("전체 출석을 저장했습니다. 알림 전달 상태는 관리자 장부에서 재확인할 수 있습니다.");
        }
      } catch {
        setMessage("저장 중 연결이 끊겼습니다. 화면에 반영된 학생은 저장됐으니 남은 학생만 다시 처리해 주세요.");
      } finally {
        setBulkAttendanceProgress("");
      }
    });
  }

  function saveMemo() {
    void persistMemo(memo, true);
  }

  // 실수/테스트로 시작한 수업을 '시작 전' 상태로 되돌린다.
  // 세션 상태만 되돌리고 출결 기록은 그대로 유지된다(서버에서 보장).
  function cancelStart() {
    if (pending || voiceBusy || memoStatus === "saving") return;
    // 되돌리기는 위험/비가역 성격이므로 반드시 한 번 확인받는다.
    if (!window.confirm("수업 시작을 취소하고 '시작 전' 상태로 되돌릴까요? (기록한 출결은 그대로 유지됩니다)")) return;
    setMessage("");
    startTransition(async () => {
      try {
        const result = await cancelClassSession({ sessionId: session.id });
        if (!result.ok) {
          setMessage(result.message);
          return;
        }
        // 세션이 더 이상 IN_PROGRESS가 아니므로 진행 화면을 벗어난다.
        // 진행 페이지도 status가 바뀌면 /staff로 리다이렉트하므로 그 흐름과 일관되게 이동한다.
        router.replace(session.sessionDateId ? "/staff/seasonal" : "/staff");
        router.refresh();
      } catch {
        setMessage("수업 시작 취소 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
    });
  }

  function finishSession() {
    if (pending || voiceBusy || memoStatus === "saving") return;
    setFinishError("");
    startTransition(async () => {
      try {
        const memoSaved = await persistMemo(memoRef.current);
        if (!memoSaved) {
          setFinishError("특이사항 메모를 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
          return;
        }
        const result = await completeClassSession({
          sessionId: session.id,
          report,
          publishReport,
        });
        if (!result.ok) {
          setFinishError(result.message);
          return;
        }
        // 이미 종료된 수업도 성공으로 보고 교사용 홈으로 안전하게 복귀합니다.
        if (result.notificationWarning) {
          setShowEndConfirm(false);
          setMessage(`수업은 종료됐지만 학부모 알림 ${result.notificationWarning.failedCount}건이 전달되지 않았습니다. 관리자가 재전송 상태를 확인해 주세요.`);
          window.setTimeout(() => {
            router.replace("/staff");
            router.refresh();
          }, 2500);
        } else {
          router.replace("/staff");
          router.refresh();
        }
      } catch {
        setFinishError("수업 종료 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
    });
  }

  const attendanceBillingSheet = attendanceBillingTarget && <ClassBillingSheet
    key={`${session.id}:${attendanceBillingTarget.id}`}
    open classId={session.classId} className={session.className}
    student={{ id: attendanceBillingTarget.studentId || attendanceBillingTarget.id, name: attendanceBillingTarget.name }}
    attendanceContext={{ sessionId: session.id, rosterId: attendanceBillingTarget.id }}
    onSummaryLoaded={syncLoadedFee}
    onUpdated={() => setFeeReload((value) => value + 1)}
    onClose={closeAttendanceBilling}
  />;

  if (view === "attendance") {
    return (
      <main className="mx-auto max-w-lg space-y-4 px-4 py-5 pb-32">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-[var(--brand-accent)]">{session.className}</p>
            <h1 className="text-2xl font-black text-brand-navy-900 dark:text-white">출석 확인</h1>
          </div>
          <button type="button" onClick={() => setView("main")} className="min-h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm font-black dark:border-gray-700 dark:bg-gray-900">
            수업으로 돌아가기
          </button>
        </div>

        <section aria-label="출결 현황" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-[var(--color-academy-line)] py-3 text-sm font-bold">
          <span className="text-[var(--color-academy-success)]">출석 {counts.PRESENT}</span>
          <span className="text-[var(--color-academy-warning)]">지각 {counts.LATE}</span>
          <span className="text-[var(--color-academy-danger)]">결석 {counts.ABSENT}</span>
          <span className="text-[var(--color-academy-muted)]">미확인 {counts.UNCHECKED}</span>
        </section>

        <button type="button" disabled={pending || counts.UNCHECKED === 0} aria-busy={pending && Boolean(bulkAttendanceProgress)} onClick={markAllPresent} className="min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)] disabled:opacity-50">
          {bulkAttendanceProgress || "미확인 학생 전체 출석"}
        </button>
        {message && <p role="alert" aria-live="assertive" className="rounded-xl bg-amber-50 p-3 text-sm font-bold text-amber-800">{message}</p>}

        <div aria-live="polite" className="text-xs font-bold text-[var(--color-academy-muted)]">
          {feeLoading ? "수강료 조회 중 · 출석 확인은 바로 할 수 있습니다." : feeError ? <div role="alert" className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3">
            <p>{feeError}</p>
            <button type="button" onClick={() => setFeeReload((value) => value + 1)} className="mt-1 min-h-11 text-[var(--brand-accent)]">수강료 다시 불러오기</button>
          </div> : feeData ? `${feeData.month.replace("-", "년 ")}월 기준 · 발행된 청구 또는 수강 정보` : "수강료 확인 필요"}
        </div>

        <section aria-label="학생 출결 명단" className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
          {students.map((student) => {
            const fee = feesByRoster.get(student.id);
            return <article key={student.id} className="border-b border-[var(--color-academy-line)] px-3 py-3 last:border-b-0">
              <div className="flex items-center justify-between">
                <strong className="text-base dark:text-white">{student.name}</strong>
                <span className="text-xs font-bold text-gray-500">{student.status ? STATUS_LABEL[student.status] : "미확인"}</span>
              </div>
              <button type="button" aria-label={`${student.name} 수강료·청구 확인`} onClick={() => setAttendanceBillingTarget(student)} className="mt-1 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-[var(--color-academy-primary-soft)] px-2 py-2 text-left">
                <span className="text-xs font-bold text-[var(--color-academy-ink)]">
                  {feeLoading ? "수강료 조회 중…" : feeError ? "수강료 확인 필요" : <>
                    <span className="text-[var(--color-academy-muted)]">{feeData ? monthlyFeeLabel(feeData.month, fee?.period, fee?.sourceLabel) : "수강료"} </span>
                    {fee?.amount != null ? `${fee.amount.toLocaleString("ko-KR")}원` : "금액 확인 필요"}
                  </>}
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-bold text-[var(--brand-accent)]">
                  {!feeLoading && !feeError && (fee?.statusLabel || "확인 필요")}
                  <span className="material-symbols-outlined text-base" aria-hidden="true">chevron_right</span>
                </span>
              </button>
              {/* 학부모가 미리 넣은 결석 신고. 이게 안 보이면 선생님이 모르고 출석을 찍어
                  학부모가 미리 알린 의미가 사라진다. 확정건은 원장이 확인한 것이라 따로 표시한다. */}
              {student.absenceReport && (
                <p className="mt-2 inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-xs font-black text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  <span className="material-symbols-outlined text-sm" aria-hidden="true">event_busy</span>
                  학부모 결석 알림
                  {ABSENCE_REASON_LABEL[student.absenceReport.reason]
                    ? ` · ${ABSENCE_REASON_LABEL[student.absenceReport.reason]}`
                    : ""}
                  {student.absenceReport.status === "CONFIRMED" ? " · 확정" : ""}
                </p>
              )}
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(["PRESENT", "LATE", "ABSENT"] as AttendanceStatus[]).map((status) => (
                  <button key={status} type="button" aria-label={`${student.name} ${STATUS_LABEL[status]}`} aria-pressed={student.status === status} disabled={pending} onClick={() => updateAttendance(student.id, status)} className={`min-h-11 rounded-xl border text-sm font-black ${student.status === status ? "border-[var(--brand-accent)] bg-[var(--brand-accent)] text-[var(--brand-accent-contrast)]" : "border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"}`}>
                    {STATUS_LABEL[status]}
                  </button>
                ))}
              </div>
            </article>;
          })}
        </section>
        {attendanceBillingSheet}
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 px-4 pb-28">
      {/* 진행 상태는 밝은 라벤더 안에서 읽고 출결 경고는 의미색으로 따로 구분합니다. */}
      <section className="sticky top-0 z-30 -mx-4 rounded-b-3xl border-b border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))] text-[var(--color-academy-ink)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-[var(--brand-accent)]">{session.startTime}~{session.endTime}</p>
            <h1 className="mt-0.5 text-xl font-black">{session.className}</h1>
            <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{session.location || "장소 미정"} · 학생 {session.studentCount}명</p>
          </div>
          <span className="academy-status rounded-full px-3 py-1 text-xs font-bold">수업 중</span>
        </div>
        <div className="mt-3 flex items-end justify-between border-t border-[var(--color-academy-line)] pt-3">
          <p className="text-xs font-bold text-[var(--color-academy-muted)]">수업 경과 시간</p>
          <p className="font-mono text-3xl font-black tabular-nums" aria-label={`수업 경과 ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</p>
        </div>
      </section>

      {!online && (
        <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800" role="status">
          <span className="material-symbols-outlined" aria-hidden="true">wifi_off</span>
          오프라인입니다. 작성한 메모는 연결이 복구되면 자동으로 다시 저장됩니다.
        </div>
      )}

      <section aria-label="출석 확인" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-black">{counts.UNCHECKED > 0 ? `출석 미확인 ${counts.UNCHECKED}명` : "출석 확인 완료"}</h2>
            <p className="mt-1 text-xs font-bold text-[var(--color-academy-muted)]">출석 {counts.PRESENT} · 지각 {counts.LATE} · 결석 {counts.ABSENT}</p>
          </div>
          <button type="button" onClick={() => setView("attendance")} className="min-h-11 shrink-0 rounded-xl bg-[var(--brand-accent)] px-4 text-sm font-black text-[var(--brand-accent-contrast)]">
            출석부 확인
          </button>
        </div>
        {counts.UNCHECKED > 0 && <p className="mt-3 text-xs font-bold text-[var(--color-academy-warning)]">수업 종료 전에 모든 학생의 출결을 확인해 주세요.</p>}
      </section>

      <details className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-sm font-bold">
          학생 정보·수업 관리
          <span className="material-symbols-outlined text-[var(--color-academy-muted)]" aria-hidden="true">expand_more</span>
        </summary>
        <div className="grid gap-1 border-t border-[var(--color-academy-line)] py-2">
          <button type="button" onClick={() => setShowPeople(true)} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm font-bold">
            <span className="material-symbols-outlined text-[var(--brand-accent)]" aria-hidden="true">contacts</span>
            학생 정보 <span className="ml-auto text-xs font-medium text-[var(--color-academy-muted)]">전화 · 문자</span>
          </button>
          <button type="button" onClick={() => setBillingStudent(null)} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm font-bold">
            <span className="material-symbols-outlined text-[var(--brand-accent)]" aria-hidden="true">receipt_long</span>
            청구 확인
          </button>
          <button type="button" disabled={pending || voiceBusy || memoStatus === "saving"} onClick={cancelStart} className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-sm font-bold text-[var(--color-academy-muted)] disabled:opacity-50">
            <span className="material-symbols-outlined" aria-hidden="true">undo</span>
            수업 시작 취소 (시작 전으로 되돌리기)
          </button>
          <p className="px-2 pb-1 text-xs text-[var(--color-academy-muted)]">시작을 취소해도 기록한 출결은 유지됩니다.</p>
        </div>
      </details>

      <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <button type="button" onClick={() => setShowPlan((current) => !current)} aria-expanded={showPlan} aria-controls="session-plan" className="flex min-h-14 w-full items-center justify-between px-5 text-left font-black">
          <span className="flex items-center gap-2"><span className="material-symbols-outlined text-[var(--brand-accent)]">description</span>오늘 수업 내용</span>
          <span className="material-symbols-outlined">{showPlan ? "expand_less" : "expand_more"}</span>
        </button>
        {showPlan && <p id="session-plan" className="border-t border-gray-100 px-5 py-4 whitespace-pre-wrap text-sm leading-7 text-gray-600 dark:border-gray-800 dark:text-gray-300">{session.plannedContent || "미리 등록한 수업 내용이 없습니다."}</p>}
      </section>

      <section id="session-photos" className="scroll-mt-40 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 flex items-center gap-2 font-black"><span className="material-symbols-outlined text-[var(--brand-accent)]">photo_camera</span>수업 사진</h2>
        {/* 사진 태깅은 실제 Student(전환된 학생)만 대상으로 한다. 방학특강 미전환 신청자는 Student가 없어 제외. */}
        <SessionPhotoUploader
          sessionId={session.id}
          students={students
            .filter((student) => student.studentId)
            .map((student) => ({ id: student.studentId as string, name: student.name }))}
        />
      </section>

      <section id="session-memo" className="scroll-mt-40 rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 font-black"><span className="material-symbols-outlined text-[var(--brand-accent)]">mic</span>수업 중 특이사항</h2>
          <VoiceToTextButton
            onBusyChange={setVoiceBusy}
            onText={(text) => {
              setMemoStatus("dirty");
              setMemo((current) => current ? `${current}\n${text}` : text);
            }}
          />
        </div>
        <textarea value={memo} onChange={(event) => { setMemoStatus("dirty"); setMemo(event.target.value); }} onBlur={() => void persistMemo(memoRef.current)} aria-label="수업 중 특이사항" rows={3} className="mt-4 w-full rounded-xl border border-gray-200 bg-white p-3 text-sm leading-6 outline-none focus:border-[var(--brand-accent)] dark:border-gray-700 dark:bg-gray-800" />
        <div className="mt-2 flex items-center justify-between gap-3 text-xs font-bold" aria-live="polite">
          <span className={memoStatus === "error" ? "text-red-600" : "text-gray-500"}>
            {memoStatus === "saving" ? "저장 중…" : memoStatus === "dirty" ? "변경사항 자동 저장 대기 중" : memoStatus === "error" ? "저장 실패 · 다시 시도해 주세요" : "저장됨"}
          </span>
        </div>
        <button type="button" disabled={pending || memoStatus === "saving" || !online} onClick={saveMemo} className="mt-3 min-h-12 w-full rounded-xl bg-brand-navy-900 px-4 text-sm font-black text-white disabled:opacity-50">메모 지금 저장</button>
      </section>

      {message && <p aria-live="polite" className="rounded-xl bg-blue-50 p-3 text-sm font-bold text-blue-700">{message}</p>}

      {showPeople && <ClassPeopleSheet open classId={session.classId} sessionId={session.id} className={session.className} onClose={() => setShowPeople(false)} onOpenBilling={(student) => { setShowPeople(false); setBillingStudent(student); }} />}
      {billingStudent !== undefined && <ClassBillingSheet key={`${session.classId}:${billingStudent?.id || "all"}`} open classId={session.classId} className={session.className} student={billingStudent} onClose={() => setBillingStudent(undefined)} />}

      {/* 수업 진행 화면에서는 하단 탭바(StaffBottomNav)가 숨겨지므로, 종료 바를 화면 최하단에 밀착시킨다.
          홈 인디케이터(safe-area)만큼만 아래 여백을 줘 겹침 없이 항상 접근 가능하게 한다. */}
      <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="rounded-2xl border border-gray-200 bg-white/95 p-2 shadow-lg backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
          <button type="button" disabled={pending || voiceBusy || memoStatus === "saving" || !online} onClick={() => { setFinishError(""); setShowEndConfirm(true); }} className="min-h-14 w-full rounded-xl border-2 border-red-200 bg-white px-4 font-black text-red-700 disabled:opacity-50 dark:border-red-900 dark:bg-gray-900 dark:text-red-300"><span className="material-symbols-outlined mr-2 align-middle">stop_circle</span>수업 종료 확인</button>
          {(voiceBusy || memoStatus === "saving" || !online) && <p className="mt-1 text-center text-[11px] font-bold text-amber-700">{voiceBusy ? "음성 메모 처리 후 종료할 수 있습니다." : memoStatus === "saving" ? "메모 저장 후 종료할 수 있습니다." : "온라인 연결 후 종료할 수 있습니다."}</p>}
        </div>
      </div>

      {showEndConfirm && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="end-session-title">
          <div ref={endDialogRef} className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <h2 id="end-session-title" className="text-xl font-black dark:text-white">수업을 종료하시겠습니까?</h2>
            <p className="mt-1 text-sm text-gray-500">종료하면 학부모에게 수업 종료 알림이 전송됩니다.</p>
            <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs font-bold">
              <div className="rounded-lg bg-green-50 p-2 text-green-700">출석 {counts.PRESENT}</div>
              <div className="rounded-lg bg-amber-50 p-2 text-amber-700">지각 {counts.LATE}</div>
              <div className="rounded-lg bg-red-50 p-2 text-red-700">결석 {counts.ABSENT}</div>
              <div className="rounded-lg bg-gray-100 p-2 text-gray-600">미확인 {counts.UNCHECKED}</div>
            </div>
            {counts.UNCHECKED > 0 && (
              <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-black">출결 미확인 학생 {counts.UNCHECKED}명이 있어 아직 종료할 수 없습니다.</p>
                <p className="mt-1 text-xs font-medium">출석부에서 출석·지각·결석 중 하나를 선택해 주세요.</p>
              </div>
            )}
            {/* 리포트를 여기서 끝낸다. 지금까지는 원장이 PC 에서 따로 써야 나가서
                운영 100회차 동안 발행이 0건이었다. 한 줄은 선택이고, 비워도 출결·사진이
                리포트가 된다. */}
            {counts.UNCHECKED === 0 && (
              <div className="mt-4">
                <label htmlFor="session-report" className="text-sm font-black text-gray-700 dark:text-gray-200">
                  오늘 수업 한 줄 <span className="font-bold text-gray-400">(선택)</span>
                </label>
                <textarea
                  id="session-report"
                  value={report}
                  onChange={(event) => setReport(event.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="예: 드리블 기본기 연습했습니다. 다들 잘 따라왔어요."
                  className="mt-1.5 w-full rounded-xl border border-gray-200 p-3 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                />
                <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-bold text-gray-700 dark:text-gray-200">
                  <input
                    type="checkbox"
                    checked={publishReport}
                    onChange={(event) => setPublishReport(event.target.checked)}
                    className="size-5"
                  />
                  학부모에게 바로 보내기
                </label>
              </div>
            )}
            {finishError && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{finishError}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={pending} data-dialog-initial-focus onClick={() => setShowEndConfirm(false)} className="min-h-12 rounded-xl border border-gray-200 font-bold dark:border-gray-700">돌아가기</button>
              {counts.UNCHECKED > 0 ? (
                <button type="button" disabled={pending} onClick={() => { setShowEndConfirm(false); setView("attendance"); }} className="min-h-12 rounded-xl bg-[var(--brand-accent)] px-3 font-black text-[var(--brand-accent-contrast)] disabled:opacity-50">출석부 확인하기</button>
              ) : (
                <button type="button" disabled={pending || voiceBusy || memoStatus === "saving" || !online} aria-busy={pending || memoStatus === "saving"} onClick={finishSession} className="min-h-12 rounded-xl bg-red-600 font-black text-white disabled:opacity-50">{pending ? "종료 처리 중…" : memoStatus === "saving" ? "메모 저장 중…" : "종료 확인"}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
