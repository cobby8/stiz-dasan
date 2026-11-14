"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  cancelClassSession,
  completeClassSession,
  saveSessionFeedLine,
  saveSessionMemo,
  saveStaffAttendance,
} from "@/app/actions/staff-sessions";
import { SessionPhotoUploader, type SessionPhotoUploaderHandle, type SessionUploaderState } from "@/components/staff/SessionPhotoUploader";
import { SessionVideoUploader, type SessionVideoUploaderHandle, type SessionVideoUploaderState } from "@/components/staff/SessionVideoUploader";
// 2026-11-15 수업 한 화면: 접는 칸·통합 글칸·학생 정보·아래 올리기 막대
import UiIcon from "@/components/common/UiIcon";
import { WorkspaceSection } from "@/components/staff/WorkspaceSection";
import { LessonTextEditor, type LessonTextSaveResult } from "@/components/staff/LessonTextEditor";
import { RosterPersonInfo, useClassPeople } from "@/components/staff/RosterPersonInfo";
import { SessionMediaBar } from "@/components/staff/SessionMediaBar";
import { CompletedSessionPanel, PlannedLessonPanel, WorkspaceLinks, type PlannedLessonProps } from "@/components/staff/LessonWorkspacePanels";
import { PLAN_PREFILL_END_NOTICE, attendanceSaveBadge, attendanceSummaryLine, countRowErrors, findRosterPerson, isUntouchedPrefill, reportForFinish, resolveLessonText, workspaceSaveStatus } from "@/components/staff/sessionWorkspaceRules";
// 사유 라벨은 학부모 신고 화면과 같은 표를 쓴다(두 화면의 표기가 갈리면 안 된다).
import { REASON_LABEL as ABSENCE_REASON_LABEL } from "@/lib/regular/regularAbsenceRules";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import { StatusChoiceButton, StatusPill, type StatusTone } from "@/components/staff/StatusChoiceButton";
import { LiveStatusPill } from "@/components/staff/LiveStatusPill";
import { ATTENDANCE_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { loadStaffSessionMonthlyFees } from "@/app/actions/staff-billing";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import { monthlyFeeLabel } from "@/components/staff/StaffMonthlyFeeSummary";
import type {
  StaffSessionDetail,
  StaffSessionStudent,
} from "@/lib/staff-session-queries";
import { userErrorMessage } from "@/components/staff/userErrorMessage";
import { bulkReportedNotice, splitBulkPresent, staffReloginHref } from "@/lib/staff-session-rules";

/** 서버 기능이 «로그인이 풀렸다»고 돌려줬는가(b5) — 던지지 않고 { ok:false, needsLogin:true } 로 온다. */
function isLoginFailure(result: object): boolean {
  return "needsLogin" in result && (result as { needsLogin?: boolean }).needsLogin === true;
}

const ClassBillingSheet = dynamic(
  () => import("@/components/staff/ClassBillingSheet").then((module) => module.ClassBillingSheet),
  { ssr: false },
);

type View = "main" | "attendance";
/** 출석부 줄 안내의 종류 — 저장 실패(error)와 건너뜀·참고(notice)를 다른 색으로 보인다. */
type RowNoticeTone = "error" | "notice";
type AttendanceStatus = "PRESENT" | "LATE" | "ABSENT";

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "출석",
  LATE: "지각",
  ABSENT: "결석",
};

// 게슈탈트 T-03: 출석=초록(success)·지각=노랑(warning)·결석=빨강(danger) + 글자(2026-11-14 아이콘 완전 제거). 탑승 체크와 같은 약속.
const STATUS_TONE: Record<AttendanceStatus, StatusTone> = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
};

// 출결 저장 결과의 결석 사유 부분(정규 수강생만 값이 온다. 방학특강·보강 저장 결과엔 없다).
type AbsenceResultExtra = { absenceReport?: StaffSessionStudent["absenceReport"]; absenceMessage?: string | null };
/** 서버가 결석 신고 상태를 돌려줬으면 그 값으로 덮어쓸 조각, 아니면 빈 조각 */
function absenceReportPatch(result: object): Partial<Pick<StaffSessionStudent, "absenceReport">> {
  const report = (result as AbsenceResultExtra).absenceReport;
  return report === undefined ? {} : { absenceReport: report };
}

function formatElapsed(seconds: number) {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

type LiveSessionProps = {
  session: StaffSessionDetail;
  initialStudents: StaffSessionStudent[];
  /** "attendance" 면 출석부 칸을 펼친 채로 연다(수업을 막 시작했을 때). 화면을 둘로 나누던 예전 값의 이름을 그대로 쓴다 */
  initialView?: View;
  /** f3: 출석부에 수강료·미납 줄을 보일지 — 원장·부원장만 true(선생님은 조회 자체를 하지 않는다). */
  showFees: boolean;
  /** 오늘 수업 홈의 한 줄 안에 끼웠는가 — 아니면 수업 주소(/staff/sessions/[id]) 한 화면 */
  embedded?: boolean;
  /** 홈에서 이 줄이 펼쳐져 있는가(접으면 메모를 저장한다). 수업 주소에서는 항상 true */
  active?: boolean;
  /** 홈: 수업을 종료했다(저장한 수업 내용을 넘긴다) — 수업 주소에서는 홈으로 이동한다 */
  onFinished?: (content: string | null) => void;
  /** 홈: 수업 시작을 취소했다 */
  onCancelled?: () => void;
  /** 수업 내용을 저장했다(홈 목록에 반영) */
  onLineSaved?: (content: string | null) => void;
  /** 홈: 수업 공지 창 열기(대타 반은 넘기지 않는다) */
  onOpenNotice?: () => void;
  /** 홈: 끝난 수업의 청구 확인(원장·부원장만 넘긴다). 진행 중 수업은 이 부품이 직접 청구 창을 연다 */
  onOpenBilling?: (student?: { id: string; name: string }) => void;
  /** 홈: 줄을 접어도 보이게 출결 요약·저장 상태를 알린다 */
  onAttendanceStatus?: (status: { summary: string; saving: string; failed: string }) => void;
};

export type SessionWorkspaceProps =
  | (LiveSessionProps & { planned?: undefined })
  // 시작 전 수업(기록이 없을 수도 있다) — 오늘 수업 홈에서만 쓴다
  | { session?: null; planned: PlannedLessonProps };

/**
 * 선생님 «수업 한 화면» 부품(2026-11-15 원장 지시) — 오늘 수업 홈의 줄과 수업 주소(/staff/sessions/[id]) 양쪽에 끼운다.
 * 수업 단계에 맞는 본문을 고른다: 시작 전 = 수업 시작·미리 쓰기·명단 / 진행 중 = 아래 LiveSessionWorkspace / 완료 = 수업 내용·사진·영상·출결 요약.
 */
export default function SessionWorkspace(props: SessionWorkspaceProps) {
  if (!props.session) return <PlannedLessonPanel {...props.planned} />;
  if (props.session.status === "COMPLETED") {
    return <CompletedSessionPanel session={props.session} students={props.initialStudents} onLineSaved={props.onLineSaved} onOpenBilling={props.onOpenBilling} />;
  }
  return <LiveSessionWorkspace {...props} />;
}

function LiveSessionWorkspace({
  session,
  initialStudents,
  initialView = "main",
  showFees,
  embedded = false,
  active = true,
  onFinished,
  onCancelled,
  onLineSaved,
  onOpenNotice,
  onAttendanceStatus,
}: LiveSessionProps) {
  const router = useRouter();
  const [students, setStudents] = useState(initialStudents);
  // 한 화면에서 접었다 펴는 칸(2026-11-15). 출석부는 확인할 학생이 남았거나 막 시작했을 때 펼친 채로 연다.
  const [openSections, setOpenSections] = useState(() => ({
    attendance: initialView === "attendance" || initialStudents.some((student) => !student.status),
    lesson: false,
    media: false,
    memo: false,
  }));
  // 학생 정보는 «이름을 눌러 처음 펼칠 때»(또는 이름 검색을 쓸 때) 한 번만 읽는다.
  // 출석부를 열자마자 읽으면 그 조회가 출석 저장 요청보다 먼저 줄을 서서 첫 출석 저장이 늦어진다(서버 요청은 한 줄로 처리된다).
  const [peopleWanted, setPeopleWanted] = useState(false);
  const people = useClassPeople({ classId: session.classId, sessionId: session.id, sessionDateId: session.sessionDateId, enabled: peopleWanted });
  // 이름을 눌러 학생 정보를 펼친 줄(한 번에 하나)
  const [infoRow, setInfoRow] = useState<string | null>(null);
  const [rosterQuery, setRosterQuery] = useState("");
  // 아래 고정 막대([사진]·[동영상]·[갤러리])가 부르는 올리기 손잡이와 진행 상태
  const photoUploaderRef = useRef<SessionPhotoUploaderHandle>(null);
  const videoUploaderRef = useRef<SessionVideoUploaderHandle>(null);
  const [photoState, setPhotoState] = useState<SessionUploaderState | null>(null);
  const [videoState, setVideoState] = useState<SessionVideoUploaderState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [memo, setMemo] = useState(session.notes || "");
  const [message, setMessage] = useState("");
  const [bulkAttendanceProgress, setBulkAttendanceProgress] = useState("");
  // 저장 중인 줄만 잠근다(b5) — 예전엔 한 아이를 누르면 출석부 전체 버튼이 잠겨 다음 아이를 못 눌렀다.
  const [savingRows, setSavingRows] = useState<Record<string, true>>({});
  // 줄마다의 저장 실패·주의 문구 — 맨 위 한 칸에 띄우면 어느 아이 얘기인지 몰랐다.
  const [rowNotices, setRowNotices] = useState<Record<string, { text: string; tone: RowNoticeTone }>>({});
  // 로그인이 풀리면 «다시 로그인» 버튼을 보인다(b5).
  const [needsLogin, setNeedsLogin] = useState(false);
  const [finishError, setFinishError] = useState("");
  const [memoStatus, setMemoStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  // 종료 화면에서 바로 남기는 수업 리포트. 기본은 "바로 보내기" 켬 —
  // 꺼두면 지금처럼 아무도 발행하지 않아 학부모 화면이 계속 비어 있게 된다.
  // 2026-11-15: 수업 내용 = 피드 통합 글칸과 같은 값. 저장된 수업 내용으로 시작하고, 없으면 미리 쓴 내용을 «채워» 보여 준다
  // (채운 값은 자동 저장하지 않는다 — «수업 내용 저장» 이나 수업 종료 때 선생님이 확인하고 저장한다).
  const initialLessonText = resolveLessonText({ status: session.status, content: session.content, plannedContent: session.plannedContent });
  const [report, setReport] = useState(initialLessonText.value);
  // 미리 쓴 내용을 채운 글(채우지 않았거나 이미 저장했으면 null). 한 글자라도 고치거나 지우면 «채운 그대로»가 아니다.
  const [prefillSource, setPrefillSource] = useState<string | null>(initialLessonText.prefilledFromPlan ? initialLessonText.value : null);
  const lessonPrefilled = isUntouchedPrefill(prefillSource, report);
  // 수업 내용 저장 실패 — 칸·줄을 접어도 머리줄에 남긴다
  const [lessonSaveFailed, setLessonSaveFailed] = useState(false);
  // 수업 중에도 미리 쓴 내용을 읽어 볼 수 있게(읽기 전용, 접힌 작은 칸)
  const [showPlan, setShowPlan] = useState(false);
  // 한 줄 저장·음성 변환 중에는 수업 종료를 잠근다(메모와 같은 원칙)
  const [feedBusy, setFeedBusy] = useState(false);
  const [publishReport, setPublishReport] = useState(true);
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
  // 출석 저장(한 줄·전체)이 진행 중인가 — 홈에서 탭을 옮기기 전에 확인한다
  const attendanceSavingRef = useRef(false);
  const closeEndDialog = useCallback(() => setShowEndConfirm(false), []);
  useStaffDialog(showEndConfirm, endDialogRef, closeEndDialog, !pending);

  // 수강료 조회가 늦거나 실패해도 출석 버튼과 수업 저장은 계속 사용할 수 있습니다.
  // 선생님 화면(showFees=false)은 수강료를 아예 부르지 않는다(f3).
  useEffect(() => {
    if (!showFees) return;
    let active = true;
    queueMicrotask(() => {
      if (active) { setFeeLoading(true); setFeeError(""); setFeeData(null); }
    });
    void loadStaffSessionMonthlyFees({ sessionId: session.id })
      .then((result) => { if (active) setFeeData(result); })
      .catch((reason: unknown) => {
        if (active) setFeeError(userErrorMessage(reason, "수강료 정보를 불러오지 못했습니다."));
      })
      .finally(() => { if (active) setFeeLoading(false); });
    return () => { active = false; };
  }, [feeReload, session.id, showFees]);

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
          if (isLoginFailure(result)) setNeedsLogin(true);
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
        // 홈에 끼운 수업 칸: 탭을 옮기면 이 칸이 닫혀 저장 결과(실패 안내)를 보여 줄 곳이 없어진다 → 출석 저장이 끝난 뒤 옮긴다
        if (embedded && attendanceSavingRef.current) {
          const message = "출석 저장이 끝난 뒤 이동해 주세요.";
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
  }, [embedded, persistMemo, voiceBusy]);

  // 홈: 줄을 접으면(active → false) 메모를 저장하고, 이 칸이 화면에서 사라질 때도 한 번 더 저장한다.
  // (수업 주소에서는 아래 뒤로 가기 확인·이동 전 저장이 그대로 맡는다)
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (wasActiveRef.current && !active) void persistMemo(memoRef.current);
    wasActiveRef.current = active;
  }, [active, persistMemo]);
  useEffect(() => {
    if (!embedded) return;
    return () => { void persistMemo(memoRef.current); };
  }, [embedded, persistMemo]);

  useEffect(() => {
    // 뒤로 가기 확인은 수업 주소 전용이다 — 홈에 끼운 칸은 주소가 바뀌지 않아 이력을 건드리지 않는다
    if (embedded) return;
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
  }, [embedded, persistMemo, session.id]);

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

  // 아직 안 찍은 보강 온 아이 수 — «전체 출석» 버튼에 함께 처리된다고 보여 준다.
  const uncheckedMakeup = useMemo(() => students.filter((student) => student.makeup && !student.status).length, [students]);
  // 아직 안 찍은 체험 아이 수 — 전체 출석 대상이 아니라 따로 안내한다.
  const uncheckedTrial = useMemo(() => students.filter((student) => student.trial && !student.status).length, [students]);

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
  // absenceReason: "ILLNESS_INJURY"=질병·부상 표시 / null=표시 끄기 / 생략=그대로(출석·지각이면 서버가 출석부 사유를 지운다).
  // 수업 중에는 언제든 다른 버튼을 눌러 출석↔지각↔결석을 고칠 수 있다(보강권도 서버가 따라 맞춘다).
  // tone: "error"=저장 실패(빨강·다시 눌러야 함) / "notice"=건너뜀·참고 안내(주의색·정보 아이콘, 검수 4)
  function setRowNotice(rowId: string, text: string, tone: RowNoticeTone = "error") {
    setRowNotices((current) => {
      const next = { ...current };
      if (text) next[rowId] = { text, tone }; else delete next[rowId];
      return next;
    });
  }

  /** 특강 좌석은 저장됐지만 정규 출석 기록이 실패했다는 표시(검수 2) — 그 줄에 «다시 눌러 주세요». */
  function recordWarningOf(result: object): string | null {
    return "recordWarning" in result ? String((result as { recordWarning?: string }).recordWarning || "") || null : null;
  }

  // 한 줄 저장 — 그 줄만 잠그고(다른 아이는 계속 누를 수 있다), 실패 문구는 그 줄 아래에 보인다(b5).
  async function updateAttendance(rowId: string, status: AttendanceStatus, absenceReason?: "ILLNESS_INJURY" | null) {
    const target = students.find((student) => student.id === rowId);
    if (!target || savingRows[rowId]) return;
    setRowNotice(rowId, "");
    setSavingRows((current) => ({ ...current, [rowId]: true }));
    try {
      const result = await saveStaffAttendance({ sessionId: session.id, attendanceKey: target.attendanceKey, status, absenceReason });
      if (!result.ok) {
        setRowNotice(rowId, result.message);
        if (isLoginFailure(result)) setNeedsLogin(true);
        return;
      }
      // 일괄 요청이 아니면 건너뛰지 않지만, 형태상 올 수 있어 그대로 안내한다.
      if ("skipped" in result) {
        setRowNotice(rowId, result.message ?? "", "notice");
        return;
      }
      setStudents((current) =>
        current.map((student) =>
          student.id === rowId
            ? {
                ...student,
                status,
                arrivedAt: status === "LATE" ? student.arrivedAt || new Date().toISOString() : null,
                // 서버가 돌려준 결석 신고 상태로 맞춘다(정규 수강생만 값이 온다).
                ...absenceReportPatch(result),
              }
            : student,
        ),
      );
      const recordWarning = recordWarningOf(result);
      const absenceMessage = (result as AbsenceResultExtra).absenceMessage;
      if (recordWarning) setRowNotice(rowId, recordWarning, "error");
      else if (absenceMessage) setRowNotice(rowId, absenceMessage, "notice");
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

  // 전체 출석 — 결석 신고(학부모 신고·원장 기간 결석)가 있는 아이는 빼고 보낸다(b1).
  // 서버도 bulk 표시를 보고 한 번 더 걸러, 그사이 새로 들어온 신고도 건너뛴다.
  const bulkSplit = useMemo(() => splitBulkPresent(students), [students]);
  const bulkBusy = Boolean(bulkAttendanceProgress);
  const anyRowSaving = Object.keys(savingRows).length > 0;
  // 출석부 칸을 접어도 저장 중·저장 실패가 머리줄에 남는다(가장 중요한 보호 장치)
  const saveBadge = attendanceSaveBadge({ savingCount: Object.keys(savingRows).length, errorCount: countRowErrors(rowNotices), bulkBusy });
  useEffect(() => { attendanceSavingRef.current = saveBadge.saving; }, [saveBadge.saving]);
  const attendanceSummary = attendanceSummaryLine(counts);
  // 홈의 줄 머리에 넘길 저장 상태 — 출석뿐 아니라 메모·수업 내용 저장 실패도(줄을 접어도 보이게)
  const saveStatus = workspaceSaveStatus({ attendance: saveBadge, memoStatus, lessonSaveFailed });
  useEffect(() => {
    onAttendanceStatus?.({ summary: attendanceSummary, saving: saveStatus.saving, failed: saveStatus.failed });
    // onAttendanceStatus 는 홈의 setState — 값이 같으면 다시 그리지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendanceSummary, saveStatus.saving, saveStatus.failed]);

  function toggleSection(name: "attendance" | "lesson" | "media" | "memo") {
    // 메모 칸을 접을 때는 쓰던 메모를 바로 저장한다
    if (name === "memo" && openSections.memo) void persistMemo(memoRef.current);
    setOpenSections((current) => ({ ...current, [name]: !current[name] }));
  }

  /** 출석부 칸을 펼치고 그 자리로 옮긴다(종료 확인 창의 «출석부 확인하기») */
  function openAttendance() {
    setOpenSections((current) => ({ ...current, attendance: true }));
    window.requestAnimationFrame(() => document.getElementById("session-attendance")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  // 통합 글칸 저장 — 수업 중에는 수업 내용(Session.content)으로. 학부모는 수업 종료·발행 뒤에만 본다
  async function saveLessonText(text: string): Promise<LessonTextSaveResult> {
    try {
      const result = await saveSessionFeedLine({ sessionId: session.id, content: text });
      if (!result.ok) {
        setLessonSaveFailed(true);
        if (isLoginFailure(result)) setNeedsLogin(true);
        return { ok: false, message: result.message };
      }
      setLessonSaveFailed(false);
      // 저장했으니 더는 «채운 그대로»가 아니다
      setPrefillSource(null);
      onLineSaved?.(result.content);
      return { ok: true };
    } catch (error) {
      setLessonSaveFailed(true);
      throw error;
    }
  }

  // 이름 검색(학생이 많은 반) — 학생·보호자 이름, 학교·학년
  const visibleStudents = useMemo(() => {
    const keyword = rosterQuery.trim().toLocaleLowerCase("ko");
    if (!keyword) return students;
    return students.filter((student) => {
      const person = findRosterPerson(student, people.people);
      return [student.name, person?.school, person?.grade, ...(person?.guardians.map((guardian) => guardian.name) ?? [])]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase("ko").includes(keyword));
    });
  }, [people.people, rosterQuery, students]);
  // 학생 정보에는 있는데 출석부 줄과 이어지지 않은 학생(드문 경우) — 정보가 빠지지 않게 명단 아래에 따로 보인다
  const unmatchedPeople = useMemo(() => {
    const matched = new Set(students.map((student) => findRosterPerson(student, people.people)?.id).filter(Boolean));
    return people.people.filter((person) => !matched.has(person.id));
  }, [people.people, students]);

  function markAllPresent() {
    const targets = bulkSplit.targets;
    setMessage("");
    setBulkAttendanceProgress(`0/${targets.length} 처리 중`);
    startTransition(async () => {
      let skipped = 0;
      try {
        for (const [index, student] of targets.entries()) {
          const result = await saveStaffAttendance({
            sessionId: session.id,
            attendanceKey: student.attendanceKey,
            status: "PRESENT",
            bulk: true,
          });
          if (!result.ok) {
            setMessage(`${index - skipped}명은 저장됐습니다. ${result.message}`);
            if (isLoginFailure(result)) setNeedsLogin(true);
            return;
          }
          if ("skipped" in result) {
            // 화면을 연 뒤에 결석 신고가 들어왔거나 다른 기기에서 이미 찍힌 아이 — 그 줄에 이유를 남기고 건너뜀으로 센다.
            skipped += 1;
            setRowNotice(student.id, result.message ?? "", "notice");
          } else {
            setStudents((current) => current.map((row) => (
              row.id === student.id
                ? { ...row, status: "PRESENT", ...absenceReportPatch(result) }
                : row
            )));
            const recordWarning = recordWarningOf(result);
            if (recordWarning) setRowNotice(student.id, recordWarning, "error");
          }
          setBulkAttendanceProgress(`${index + 1}/${targets.length} 처리 중`);
        }
        if (targets.length > 0) {
          setMessage(skipped > 0
            ? `전체 출석을 저장했습니다. ${skipped}명은 건너뛰었어요(결석 신고·이미 기록됨) — 그 줄의 안내를 확인해 주세요.`
            : "전체 출석을 저장했습니다.");
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
        // 쓰던 메모를 먼저 저장한다(시작을 취소하면 «진행 중»이 아니라 더는 메모를 저장할 수 없다)
        const memoSaved = await persistMemo(memoRef.current);
        if (!memoSaved) {
          setMessage("특이사항 메모를 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.");
          return;
        }
        const result = await cancelClassSession({ sessionId: session.id });
        if (!result.ok) {
          setMessage(result.message);
          if (isLoginFailure(result)) setNeedsLogin(true);
          return;
        }
        // 홈에 끼운 칸은 이동하지 않고 그 줄이 «시작 전» 모양으로 바뀐다
        if (embedded) { onCancelled?.(); return; }
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
          // 글칸에 보이는 값 그대로(선생님이 지웠으면 빈 값 — 미리 쓴 내용이 몰래 따라 나가지 않는다)
          report,
          publishReport,
        });
        if (!result.ok) {
          setFinishError(result.message);
          if (isLoginFailure(result)) setNeedsLogin(true);
          return;
        }
        // 홈에 끼운 칸은 이동하지 않고 그 줄이 «완료» 로 바뀐다
        if (embedded) { setShowEndConfirm(false); onFinished?.(reportForFinish(report) || null); return; }
        // 이미 종료된 수업도 성공으로 보고 교사용 홈으로 안전하게 복귀합니다.
        // 학부모 알림은 서버가 응답 뒤에 끝까지 보낸다(after) — 화면은 기다리지 않는다.
        router.replace("/staff");
        router.refresh();
      } catch {
        setFinishError("수업 종료 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
    });
  }

  const attendanceBillingSheet = showFees && attendanceBillingTarget && <ClassBillingSheet
    key={`${session.id}:${attendanceBillingTarget.id}`}
    open classId={session.classId} className={session.className}
    student={{ id: attendanceBillingTarget.studentId || attendanceBillingTarget.id, name: attendanceBillingTarget.name }}
    attendanceContext={{ sessionId: session.id, rosterId: attendanceBillingTarget.id }}
    onSummaryLoaded={syncLoadedFee}
    onUpdated={() => setFeeReload((value) => value + 1)}
    onClose={closeAttendanceBilling}
  />;

  // 로그인이 풀렸을 때 — 다시 로그인하면 이 수업 화면으로 돌아온다(b5).
  const reloginBanner = needsLogin && (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">
      <span>로그인이 풀렸습니다. 다시 로그인하면 이 화면으로 돌아옵니다.</span>
      <button
        type="button"
        onClick={() => window.location.assign(staffReloginHref(`${window.location.pathname}${window.location.search}`))}
        className="academy-button-primary"
      >
        다시 로그인
      </button>
    </div>
  );

  const mediaBusy = Boolean(photoState?.busy || videoState?.busy);
  // 종료 잠금: 음성 입력 중·수업 내용 저장 중·메모 저장 중·오프라인 + 사진·영상을 올리는 중
  // (홈에서는 종료하면 이 칸이 바로 닫혀 올리던 영상이 끊긴다)
  const endLocked = pending || voiceBusy || feedBusy || memoStatus === "saving" || !online || mediaBusy;
  const memoFirstLine = memo.trim().split("\n")[0];
  const reportFirstLine = report.trim().split("\n")[0];
  // 수업 주소에서는 이 부품이 화면 전체(main), 홈에서는 수업 줄 안의 한 칸(div)이다
  const Wrapper = embedded ? "div" : "main";

  return (
    // 아래 고정 막대([사진]·[동영상]·[갤러리])에 본문이 가리지 않게 아래 여백을 둔다
    <Wrapper className={embedded ? "space-y-3" : "mx-auto max-w-lg space-y-3 px-4 pb-28 pt-4"}>
      {/* ① 머리: 시간·반·장소·«수업 중» → ② 수업 종료 → ③ 경과 시간 (2026-11-15: 종료 버튼은 경과 시간 위) */}
      <section aria-label="수업 진행" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] p-4 text-[var(--color-academy-ink)]">
        {/* 홈에서는 수업 줄 머리에 시간·반·«수업 중»이 이미 있어 되풀이하지 않는다 */}
        {!embedded && (
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium tabular-nums text-[var(--color-academy-ink)]">{session.startTime}~{session.endTime}</p>
              <h1 className="academy-heading mt-0.5">{session.className}</h1>
              <p className="mt-1 text-xs text-[var(--color-academy-muted)]">{session.location || "장소 미정"} · 학생 {session.studentCount}명</p>
            </div>
            <LiveStatusPill>수업 중</LiveStatusPill>
          </div>
        )}
        {/* 종료는 위험색이 아닌 보조 버튼 — 눌러도 확인 창(출결 4칸·미확인 차단·한 줄·바로 보내기)을 거친다. 최종 확정만 위험색 */}
        <button id="session-end" type="button" disabled={endLocked} onClick={() => { setFinishError(""); setShowEndConfirm(true); }} className="academy-button-secondary min-h-12! w-full text-base!">수업 종료</button>
        {(voiceBusy || memoStatus === "saving" || !online || mediaBusy) && <p className="mt-1 text-center text-xs text-[var(--color-academy-warning)]">{voiceBusy ? "음성 메모 처리 후 종료할 수 있습니다." : memoStatus === "saving" ? "메모 저장 후 종료할 수 있습니다." : !online ? "온라인 연결 후 종료할 수 있습니다." : "사진·영상을 올리는 중이에요. 다 올린 뒤 종료할 수 있습니다."}</p>}
        <div id="session-elapsed" className="mt-3 flex items-end justify-between border-t border-[var(--color-academy-line)] pt-3">
          <p className="text-xs text-[var(--color-academy-muted)]">수업 경과 시간</p>
          <p className="font-mono text-2xl font-semibold tabular-nums" aria-label={`수업 경과 ${formatElapsed(elapsed)}`}>{formatElapsed(elapsed)}</p>
        </div>
      </section>

      {reloginBanner}

      {!online && (
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-4 text-sm font-medium text-[var(--color-academy-danger)]" role="status">
          오프라인입니다. 작성한 메모는 연결이 복구되면 자동으로 다시 저장됩니다.
        </div>
      )}

      {/* 전체 출석 결과·메모 저장·시작 취소 안내 — 칸을 접어도 보이게 칸 밖 위쪽에 둔다 */}
      {message && <p role="alert" aria-live="assertive" className="rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm font-medium text-[var(--color-academy-warning)]">{message}</p>}

      {/* ④ 출석부 — 접힘: 요약 한 줄(+ 저장 중·저장 실패), 펼침: 전체 출석 + 학생 줄. 이름을 누르면 그 자리에서 학생 정보 */}
      <WorkspaceSection
        id="session-attendance"
        title="출석부"
        summary={<span className={`tabular-nums ${counts.UNCHECKED > 0 ? "text-[var(--color-academy-warning)]" : ""}`}>{attendanceSummary}</span>}
        badge={saveBadge.text ? <span role="status" className="flex shrink-0 items-center gap-1 text-xs font-medium">
          {saveBadge.saving && <span className="rounded bg-[var(--color-academy-soft)] px-2 py-0.5 text-[var(--color-academy-muted)]">저장 중</span>}
          {saveBadge.failed > 0 && <span className="rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-[var(--color-academy-danger)]">저장 실패 {saveBadge.failed}</span>}
        </span> : undefined}
        open={openSections.attendance}
        onToggle={() => toggleSection("attendance")}
      >
        <div className="space-y-3">
          {/* 게슈탈트 T-06: 확인할 학생이 남았을 때만 꽉 찬 버튼(이 화면의 주인공). 다 끝났으면 보조 버튼으로 낮춘다. */}
          <button type="button" disabled={pending || anyRowSaving || bulkSplit.targets.length === 0} aria-busy={pending && bulkBusy} onClick={markAllPresent} className={`${counts.UNCHECKED > 0 ? "academy-button-primary" : "academy-button-secondary"} min-h-12! w-full`}>
            {/* 미확인이면 보강 온 아이도 함께 출석 처리된다(원장 2026-11-09 «보강도 전체 출석에서 체크»). */}
            {bulkAttendanceProgress || (uncheckedMakeup > 0 ? `미확인 학생 전체 출석 (보강 ${uncheckedMakeup}명 포함)` : "미확인 학생 전체 출석")}
          </button>
          {counts.UNCHECKED > 0 && <p className="text-xs text-[var(--color-academy-warning)]">수업 종료 전에 모든 학생의 출결을 확인해 주세요.</p>}
          {/* 결석 신고 아이는 전체 출석에서 빠진다(b1). 실제로 왔으면 그 줄의 «출석»을 직접 누르면 된다. */}
          {bulkSplit.reported.length > 0 && (
            <p role="status" className="text-xs text-[var(--color-academy-warning)]">
              {bulkReportedNotice(bulkSplit.reported.length)} 실제로 왔으면 그 줄의 «출석»을 눌러 주세요.
            </p>
          )}
          {/* 체험 아이는 전체 출석에서 빠진다(검수 LOW-1) — 안 온 아이가 «체험 완료»로 올라가지 않게 직접 누른다. */}
          {uncheckedTrial > 0 && (
            <p role="status" className="text-xs text-[var(--color-academy-warning)]">
              체험 {uncheckedTrial}명은 전체 출석에서 빠집니다. 그 줄에서 직접 눌러 주세요.
            </p>
          )}
          <p className="text-xs text-[var(--color-academy-muted)]">잘못 찍었으면 다른 버튼을 눌러 바로 고칠 수 있어요. 보강권도 함께 맞춰집니다. 이름을 누르면 학생 정보가 펼쳐집니다.</p>

          {showFees && <div aria-live="polite" className="text-xs text-[var(--color-academy-muted)]">
            {feeLoading ?"수강료 조회 중 · 출석 확인은 바로 할 수 있습니다." : feeError ? <div role="alert" className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3">
              <p>{feeError}</p>
              <button type="button" onClick={() => setFeeReload((value) => value + 1)} className="academy-button-tonal academy-button-sm mt-1">수강료 다시 불러오기</button>
            </div> : feeData ? `${feeData.month.replace("-", "년 ")}월 기준 · 발행된 청구 또는 수강 정보` : "수강료 확인 필요"}
          </div>}

          {/* 학생 정보를 못 읽었을 때 — 출석 버튼은 그대로 쓸 수 있다 */}
          {people.error && (
            <div role="alert" className="rounded-xl bg-[var(--color-academy-soft)] p-3 text-xs text-[var(--color-academy-muted)]">
              <p>{people.error}</p>
              <button type="button" onClick={people.reload} className="academy-button-tonal academy-button-sm mt-1">학생 정보 다시 불러오기</button>
            </div>
          )}

          {/* 학생이 많은 반만 이름 검색을 보인다(예전 학생 정보 시트의 검색) */}
          {students.length > 8 && (
            <input value={rosterQuery} onFocus={() => setPeopleWanted(true)} onChange={(event) => setRosterQuery(event.target.value)} aria-label="학생·학부모 이름 검색" placeholder="학생·학부모 이름 검색" className="academy-input" />
          )}

          <section aria-label="학생 출결 명단" className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            {visibleStudents.length === 0 && <p className="px-3 py-4 text-center text-xs text-[var(--color-academy-muted)]">표시할 학생이 없습니다.</p>}
            {visibleStudents.map((student) => {
              const fee = feesByRoster.get(student.id);
              const infoOpen = infoRow === student.id;
              const person = findRosterPerson(student, people.people);
              return <article key={student.id} className="border-b border-[var(--color-academy-line)] px-3 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  {/* 이름 쪽을 누르면 이 줄 아래에 학생 정보가 펼쳐진다(예전엔 별도 시트). 출결 버튼은 그대로 이 줄에 있다 */}
                  <button type="button" aria-expanded={infoOpen} aria-controls={`roster-info-${student.id}`} onClick={() => { setPeopleWanted(true); setInfoRow(infoOpen ? null : student.id); }} className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left">
                    <strong className="text-base font-semibold">{student.name}</strong>
                    {/* 다른 반 아이가 보강 온 경우. 출석을 찍으면 보강권이 사용 처리되고, 결석이면 보강권은 그대로 남는다. */}
                    {student.makeup && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[ATTENDANCE_TONE.MAKEUP]}`}>보강</span>
                    )}
                    {/* 체험수업 온 아이(f1). 출결은 체험 기록에만 남고 정규 출석·청구에는 섞이지 않는다. */}
                    {student.trial && (
                      // 보강(정보색)과 헷갈리지 않게 브랜드 색으로 구분한다.
                      <span className="rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-0.5 text-xs text-[var(--brand-accent)]">체험</span>
                    )}
                    {student.trial && student.grade && (
                      <span className="text-xs text-[var(--color-academy-muted)]">{student.grade}</span>
                    )}
                    <span className="flex text-[var(--color-academy-muted)]">
                      <UiIcon name={infoOpen ? "expand_less" : "expand_more"} />
                    </span>
                  </button>
                  {student.status
                    ? <StatusPill tone={STATUS_TONE[student.status]}>{STATUS_LABEL[student.status]}</StatusPill>
                    : <StatusPill tone="neutral">미확인</StatusPill>}
                </div>
                {infoOpen && (
                  <div id={`roster-info-${student.id}`}>
                    {person ? (
                      <RosterPersonInfo
                        person={person}
                        photoVersion={people.photoVersions[person.id]}
                        todayStatus={student.status}
                        onOpenBilling={showFees ? (target) => setBillingStudent(target) : undefined}
                      />
                    ) : people.loading || !people.loaded ? (
                      <p role="status" className="py-2 text-xs text-[var(--color-academy-muted)]">{people.error ? "학생 정보를 불러오지 못했습니다." : "학생 정보를 불러오는 중입니다."}</p>
                    ) : (
                      // 보강·체험·특강 미전환 신청자는 이 반 학생 정보에 없다 — 출석부가 가진 것(학년·연락처)만 보인다
                      <p className="py-2 text-xs text-[var(--color-academy-muted)]">
                        이 반 학생 정보에 없는 학생입니다{student.makeup ? "(보강)" : student.trial ? "(체험)" : ""}.
                        {student.grade ? ` ${student.grade}` : ""}
                        {student.phone && <> · <a href={`tel:${student.phone.replace(/[^\d+]/g, "")}`} className="tabular-nums text-[var(--color-academy-primary)] underline underline-offset-2">{student.phone}</a></>}
                      </p>
                    )}
                  </div>
                )}
                {/* 보강 온 아이·체험 아이는 이 반 수강생이 아니라 수강료를 보여주지 않는다.
                    선생님 화면(showFees=false)은 수강료·미납 줄 자체를 숨긴다(f3). */}
                {showFees && !student.makeup && !student.trial && <button type="button" aria-label={`${student.name} 수강료·청구 확인`} onClick={() => setAttendanceBillingTarget(student)} className="mt-1 flex min-h-11 w-full flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-[var(--color-academy-primary-soft)] px-2 py-2 text-left">
                  <span className="text-xs tabular-nums text-[var(--color-academy-ink)]">
                    {feeLoading ? "수강료 조회 중…" : feeError ? "수강료 확인 필요" : <>
                      <span className="text-[var(--color-academy-muted)]">{feeData ? monthlyFeeLabel(feeData.month, fee?.period, fee?.sourceLabel) : "수강료"} </span>
                      {fee?.amount != null ? `${fee.amount.toLocaleString("ko-KR")}원` : "금액 확인 필요"}
                    </>}
                  </span>
                  <span className="text-xs font-medium text-[var(--brand-accent)]">
                    {!feeLoading && !feeError && (fee?.statusLabel || "확인 필요")}
                  </span>
                </button>}
                {/* 학부모가 미리 넣은 결석 신고. 이게 안 보이면 선생님이 모르고 출석을 찍어
                    학부모가 미리 알린 의미가 사라진다. 확정건은 원장이 확인한 것이라 따로 표시한다. */}
                {student.absenceReport?.source === "PARENT" && (
                  <p className="mt-2 inline-flex items-center gap-1 rounded-lg bg-[var(--color-academy-warning-soft)] px-2 py-1 text-xs font-medium text-[var(--color-academy-warning)]">
                    학부모 결석 알림
                    {ABSENCE_REASON_LABEL[student.absenceReport.reason]
                      ? ` · ${ABSENCE_REASON_LABEL[student.absenceReport.reason]}`
                      : ""}
                    {student.absenceReport.status === "CONFIRMED" ? " · 확정" : ""}
                  </p>
                )}
                <div className="mt-2 grid grid-cols-3 gap-3">
                  {(["PRESENT", "LATE", "ABSENT"] as AttendanceStatus[]).map((status) => (
                    <StatusChoiceButton key={status} tone={STATUS_TONE[status]} ariaLabel={`${student.name} ${STATUS_LABEL[status]}`} active={student.status === status} disabled={bulkBusy || Boolean(savingRows[student.id])} onClick={() => void updateAttendance(student.id, status)}>
                      {STATUS_LABEL[status]}
                    </StatusChoiceButton>
                  ))}
                </div>
                {/* 결석일 때만: 질병·부상 표시 → 청구 작업대 «이월 검토» 후보가 된다(이월 적용은 원장이 증빙 확인 후).
                    정규 수강생만(보강 온 아이·방학특강은 대상 아님). 학부모가 이미 신고한 날은 그 사유를 따른다. */}
                {student.status === "ABSENT" && !student.makeup && !student.trial && !session.sessionDateId && (() => {
                  const illness = student.absenceReport?.reason === "ILLNESS_INJURY";
                  const parentLocked = student.absenceReport?.source === "PARENT";
                  return <button
                    type="button"
                    aria-pressed={illness}
                    disabled={bulkBusy || Boolean(savingRows[student.id]) || parentLocked}
                    onClick={() => void updateAttendance(student.id, "ABSENT", illness ? null : "ILLNESS_INJURY")}
                    // 2026-11-13 UI 통일: 고르는 칩 공용 모양(고르면 ✓ + 보조 색). 눌림 여부는 aria-pressed 그대로. 높이 min-h-11 은 테마가 지킨다.
                    className="academy-choice mt-2 w-full disabled:opacity-60"
                  >
                    질병·부상 결석
                    {parentLocked && <span className="text-xs">(학부모 신고)</span>}
                  </button>;
                })()}
                {/* 이 아이 줄의 저장 상태·실패 문구(b5) — 어느 아이 얘기인지 바로 보이게 그 줄 아래에 둔다. */}
                {savingRows[student.id] && <p aria-live="polite" className="mt-1 text-xs text-[var(--color-academy-muted)]">저장 중…</p>}
                {/* 저장 실패=빨강·error 아이콘, 건너뜀·참고 안내=주의색·info 아이콘(검수 4 — 결석 신고 안내를 오류처럼 보이지 않게) */}
                {rowNotices[student.id] && (rowNotices[student.id].tone === "error" ? (
                  <p role="alert" className="mt-1 text-xs font-semibold text-[var(--color-academy-danger)]">
                    {rowNotices[student.id].text}
                  </p>
                ) : (
                  <p role="status" className="mt-1 text-xs text-[var(--color-academy-warning)]">
                    {rowNotices[student.id].text}
                  </p>
                ))}
              </article>;
            })}
          </section>

          {/* 학생 정보에는 있는데 출석부 줄과 이어지지 않은 학생 — 정보가 빠지지 않게 따로 보인다(드문 경우) */}
          {!rosterQuery && unmatchedPeople.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-[var(--color-academy-muted)]">출석부 줄과 이어지지 않은 학생 정보 {unmatchedPeople.length}명</p>
              {unmatchedPeople.map((person) => (
                <RosterPersonInfo key={person.id} person={person} photoVersion={people.photoVersions[person.id]} onOpenBilling={showFees ? (target) => setBillingStudent(target) : undefined} />
              ))}
            </div>
          )}

          {/* 예전 «학생 정보·수업 관리» 메뉴의 나머지 진입 — 청구 확인은 원장·부원장만(f3 보완), 수업 공지는 홈에서만 */}
          <div className="flex flex-wrap gap-2">
            {showFees && <button type="button" onClick={() => setBillingStudent(null)} className="academy-button-text academy-button-sm underline underline-offset-2">
              청구 확인
            </button>}
            <WorkspaceLinks onOpenNotice={onOpenNotice} />
          </div>
        </div>
      </WorkspaceSection>

      {/* ⑤ 수업 내용 = 피드 통합 글칸(2026-11-15). 미리 쓴 내용이 있으면 채워져 있고, 고치거나 바로 써서 저장한다.
          수업 종료 확인 창의 한 줄과 같은 값(report)이다. 학부모는 수업 종료·발행 뒤에만 본다. */}
      <WorkspaceSection
        id="session-lesson"
        title="수업 내용"
        summary={reportFirstLine || "아직 쓰지 않았어요"}
        badge={lessonSaveFailed ? <span role="status" className="shrink-0 rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-academy-danger)]">저장 실패</span> : lessonPrefilled ? <span className="shrink-0 rounded bg-[var(--color-academy-info-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-info)]">저장 전</span> : undefined}
        open={openSections.lesson}
        onToggle={() => toggleSection("lesson")}
      >
        <LessonTextEditor inputId={`lesson-text-${session.id}`} phase="IN_PROGRESS" value={report} onChange={setReport} save={saveLessonText} prefilledFromPlan={lessonPrefilled} onBusyChange={setFeedBusy} />
        {/* 수업 전에 미리 쓴 내용은 수업 중에도 읽을 수 있다(읽기 전용) — 예전 «오늘 수업 내용» 칸. 수업 내용을 따로 저장한 뒤에도 남는다 */}
        {session.plannedContent?.trim() && (
          <div className="mt-3 rounded-xl bg-[var(--color-academy-soft)]">
            <button type="button" aria-expanded={showPlan} aria-controls="session-plan" onClick={() => setShowPlan((current) => !current)} className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-xs font-medium text-[var(--color-academy-muted)]">
              <span>미리 쓴 내용</span>
              <UiIcon name={showPlan ? "expand_less" : "expand_more"} />
            </button>
            {showPlan && <p id="session-plan" className="whitespace-pre-wrap border-t border-[var(--color-academy-line)] px-3 py-3 text-sm leading-6 text-[var(--color-academy-ink)]">{session.plannedContent}</p>}
          </div>
        )}
      </WorkspaceSection>

      {/* ⑥ 올린 사진·영상 목록(지우기 포함). 올리기 버튼은 아래 고정 막대에 있다 — 이 칸은 접어도 안의 부품이 살아 있어 올리기가 끊기지 않는다.
          사진·영상은 이 수업에 참여한 학생의 보호자만 본다(사진 공개 동의·«나온 학생» 선택 없음). */}
      <WorkspaceSection
        id="session-photos"
        title="사진·영상"
        summary={`사진 ${photoState?.count ?? 0} · 영상 ${videoState?.count ?? 0}`}
        badge={mediaBusy ? <span role="status" className="shrink-0 rounded bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs text-[var(--color-academy-muted)]">올리는 중</span> : undefined}
        open={openSections.media}
        onToggle={() => toggleSection("media")}
      >
        <div className="space-y-4">
          <div id="session-photo-uploader">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 사진</h3>
            <SessionPhotoUploader ref={photoUploaderRef} sessionId={session.id} hideButtons onStateChange={setPhotoState} />
          </div>
          {/* 2026-11-14 수업 영상(원장 결정) — 찍어 올리면 이 수업 학생의 보호자만 학부모 화면에서 본다 */}
          <div id="session-videos">
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-academy-ink)]">수업 영상</h3>
            <SessionVideoUploader ref={videoUploaderRef} sessionId={session.id} hideButtons onStateChange={setVideoState} />
          </div>
          <p className="text-xs text-[var(--color-academy-muted)]">올리기는 화면 아래 «사진 · 동영상 · 갤러리» 버튼으로 합니다.</p>
        </div>
      </WorkspaceSection>

      {/* ⑦ 메모(수업 중 특이사항) + 음성 버튼 + 메모 지금 저장 */}
      <WorkspaceSection
        id="session-memo"
        title="메모"
        summary={memoFirstLine || "수업 중 특이사항"}
        badge={memoStatus === "error" ? <span role="status" className="shrink-0 rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-xs font-medium text-[var(--color-academy-danger)]">저장 실패</span> : memoStatus !== "saved" ? <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">{memoStatus === "saving" ? "저장 중" : "저장 대기"}</span> : undefined}
        open={openSections.memo}
        onToggle={() => toggleSection("memo")}
      >
        <div className="flex items-start justify-between gap-3">
          <p className="pt-1 text-xs text-[var(--color-academy-muted)]">수업 중 특이사항 — 선생님·원장만 봅니다</p>
          <VoiceToTextButton
            onBusyChange={setVoiceBusy}
            onText={(text) => {
              setMemoStatus("dirty");
              setMemo((current) => current ? `${current}\n${text}` : text);
            }}
          />
        </div>
        <textarea value={memo} onChange={(event) => { setMemoStatus("dirty"); setMemo(event.target.value); }} onBlur={() => void persistMemo(memoRef.current)} aria-label="수업 중 특이사항" rows={3} className="academy-input mt-2 leading-6" />
        <div className="mt-2 flex items-center justify-between gap-3 text-xs" aria-live="polite">
          <span className={memoStatus === "error" ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}>
            {memoStatus === "saving" ? "저장 중…" : memoStatus === "dirty" ? "변경사항 자동 저장 대기 중" : memoStatus === "error" ? "저장 실패 · 다시 시도해 주세요" : "저장됨"}
          </span>
        </div>
        <button type="button" disabled={pending || memoStatus === "saving" || !online} onClick={saveMemo} className="academy-button-secondary mt-3 w-full">메모 지금 저장</button>
      </WorkspaceSection>

      {/* ⑧ 수업 시작 취소 — 메모 아래(2026-11-15). 확인 창은 그대로, 기록한 출결·사진·메모는 유지된다 */}
      <div id="session-cancel-start" className="text-center">
        <button type="button" disabled={pending || voiceBusy || memoStatus === "saving"} onClick={cancelStart} className="academy-button-text">
          수업 시작 취소 (시작 전으로 되돌리기)
        </button>
        <p className="text-xs text-[var(--color-academy-muted)]">시작을 취소해도 기록한 출결은 유지됩니다.</p>
      </div>

      {showFees && billingStudent !== undefined && <ClassBillingSheet key={`${session.classId}:${billingStudent?.id || "all"}`} open classId={session.classId} className={session.className} student={billingStudent} onClose={() => setBillingStudent(undefined)} />}
      {attendanceBillingSheet}

      {/* ⑨ 아래 고정 막대 [사진] [동영상] [갤러리] — 예전 «수업 종료 확인» 자리.
          수업 주소에서는 아래 탭(StaffBottomNav)이 숨어 화면 바닥에 붙고, 홈에서는 아래 탭 위에 띄운다. */}
      <SessionMediaBar
        photoRef={photoUploaderRef}
        videoRef={videoUploaderRef}
        photoState={photoState}
        videoState={videoState}
        aboveBottomNav={embedded}
        onPicked={() => setOpenSections((current) => ({ ...current, media: true }))}
      />

      {showEndConfirm && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50 p-4 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="end-session-title">
          <div ref={endDialogRef} className="max-h-[calc(100dvh-2rem)] min-h-0 w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <h2 id="end-session-title" className="text-xl font-bold">수업을 종료하시겠습니까?</h2>
            <p className="mt-1 text-sm text-[var(--color-academy-muted)]">종료하면 학부모에게 수업 종료 알림이 전송됩니다.</p>
            <div className="mt-4 grid grid-cols-4 gap-2 text-center text-xs font-medium tabular-nums">
              <div className="rounded-lg bg-[var(--color-academy-success-soft)] p-2 text-[var(--color-academy-success)]">출석 {counts.PRESENT}</div>
              <div className="rounded-lg bg-[var(--color-academy-warning-soft)] p-2 text-[var(--color-academy-warning)]">지각 {counts.LATE}</div>
              <div className="rounded-lg bg-[var(--color-academy-danger-soft)] p-2 text-[var(--color-academy-danger)]">결석 {counts.ABSENT}</div>
              <div className="rounded-lg bg-[var(--color-academy-soft)] p-2 text-[var(--color-academy-muted)]">미확인 {counts.UNCHECKED}</div>
            </div>
            {counts.UNCHECKED > 0 && (
              <div className="mt-3 rounded-xl bg-[var(--color-academy-warning-soft)] p-3 text-sm text-[var(--color-academy-warning)]">
                <p className="font-semibold">출결 미확인 학생 {counts.UNCHECKED}명이 있어 아직 종료할 수 없습니다.</p>
                <p className="mt-1 text-xs">출석부에서 출석·지각·결석 중 하나를 선택해 주세요.</p>
              </div>
            )}
            {/* 리포트를 여기서 끝낸다. 지금까지는 원장이 PC 에서 따로 써야 나가서
                운영 100회차 동안 발행이 0건이었다. 한 줄은 선택이고, 비워도 출결·사진이
                리포트가 된다. */}
            {counts.UNCHECKED === 0 && (
              <div className="mt-4">
                <label htmlFor="session-report" className="text-sm font-medium text-[var(--color-academy-ink)]">
                  오늘 수업 한 줄 <span className="font-normal text-[var(--color-academy-faint)]">(선택 · 수업 내용 칸과 같은 내용)</span>
                </label>
                <textarea
                  id="session-report"
                  value={report}
                  onChange={(event) => setReport(event.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="예: 드리블 기본기 연습했습니다. 다들 잘 따라왔어요."
                  className="academy-input mt-1.5"
                />
                {/* 미리 쓴 내용을 채운 그대로(고치거나 저장한 적 없이) 종료하려는 경우 — 모르고 학부모에게 내보내지 않게 글칸 바로 아래에서 알린다.
                    이 글칸에서 바로 고치거나 지울 수 있고, 한 글자라도 바꾸면 이 안내는 사라진다. */}
                {lessonPrefilled && (
                  <p role="alert" className="mt-1.5 rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-2 text-xs font-medium text-[var(--color-academy-warning)]">{PLAN_PREFILL_END_NOTICE}</p>
                )}
                <label className="mt-2 flex min-h-11 items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
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
            {finishError && <p role="alert" aria-live="assertive" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{finishError}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={pending} data-dialog-initial-focus onClick={() => setShowEndConfirm(false)} className="academy-button-secondary">돌아가기</button>
              {counts.UNCHECKED > 0 ? (
                <button type="button" disabled={pending} onClick={() => { setShowEndConfirm(false); openAttendance(); }} className="academy-button-primary">출석부 확인하기</button>
              ) : (
                <button type="button" disabled={pending || voiceBusy || memoStatus === "saving" || !online} aria-busy={pending || memoStatus === "saving"} onClick={finishSession} className="academy-button-danger-solid">{pending ? "종료 처리 중…" : memoStatus === "saving" ? "메모 저장 중…" : "종료 확인"}</button>
              )}
            </div>
          </div>
        </div>
      )}
    </Wrapper>
  );
}
