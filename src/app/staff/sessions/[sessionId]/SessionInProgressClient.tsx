"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  cancelClassSession,
  clearStaffAttendance,
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
import { useClassPeople } from "@/components/staff/RosterPersonInfo";
// 2026-11-15 접이식 구조와 병합: 학생 상세는 시트(SessionStudentSheet) 대신 출석부 줄 아래에 펼친다(내용은 같다).
// 일반 import 다 — 수업 중 연결이 끊겨도 이름을 누르면 바로 열려야 한다(나눠 받다 실패하면 화면 전체가 오류).
import { SessionStudentInfo } from "@/components/staff/SessionStudentInfo";
import { SessionMediaBar } from "@/components/staff/SessionMediaBar";
import { CompletedSessionPanel, PlannedLessonPanel, WorkspaceLinks, type PlannedLessonProps } from "@/components/staff/LessonWorkspacePanels";
import { PLAN_PREFILL_END_NOTICE, attendanceSaveBadge, attendanceSummaryLine, countRowErrors, findRosterPerson, isUntouchedPrefill, reportForFinish, resolveLessonText, workspaceSaveStatus } from "@/components/staff/sessionWorkspaceRules";
import { VoiceToTextButton } from "@/components/staff/VoiceToTextButton";
import { useStaffDialog } from "@/components/staff/useStaffDialog";
import { StatusChoiceButton, type StatusTone } from "@/components/staff/StatusChoiceButton";
import { LiveStatusPill } from "@/components/staff/LiveStatusPill";
import { ATTENDANCE_TONE, TONE_BADGE_CLASS } from "@/lib/ui/statusTones";
import { loadStaffSessionMonthlyFees } from "@/app/actions/staff-billing";
import type { StaffMonthlyFeeSummary } from "@/lib/staff-monthly-fee-types";
import { FEED_LINE_MAX } from "@/lib/feed/rules";
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

// «연락처 모아 보기»(이름 검색·전화·문자) — 기존 학생 정보 시트 그대로
const ClassPeopleSheet = dynamic(
  () => import("@/components/staff/ClassPeopleSheet").then((module) => module.ClassPeopleSheet),
  { ssr: false },
);
const ClassBillingSheet = dynamic(
  () => import("@/components/staff/ClassBillingSheet").then((module) => module.ClassBillingSheet),
  { ssr: false },
);

// 예전에는 «수업»·«출석부» 두 화면이었다. 지금은 한 화면이고, attendance 는 «출석부 칸을 펼치고 그리로 맞춰 열기» 뜻으로만 남았다.
type View = "main" | "attendance";
/** 화면이 뜬 뒤 학생 정보를 부르기까지 기다리는 시간 — 수업 시작 직후의 첫 출결 누름이 먼저 나가게 */
const PEOPLE_IDLE_DELAY_MS = 2500;
/** 안내 중 «잘 됐다»는 문구 — 이 밖의 안내는 전부 실패·주의로 본다(주의색 + role="alert") */
const SUCCESS_MESSAGE = /^(특이사항을 저장했습니다|전체 출석을 저장했습니다)/;
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
  /** 완료한 수업: 원장·부원장이면 true — 수정 기간(선생님 수업일 포함 7일) 제한 없음. 서버도 같은 기준으로 다시 막는다 */
  editUnlimited?: boolean;
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
    // 완료한 수업 다시 보기·고치기 — 홈의 줄 안(embedded)과 수업 주소(지난 수업에서 연 화면) 양쪽에서 같은 부품
    return <CompletedSessionPanel session={props.session} students={props.initialStudents} onLineSaved={props.onLineSaved} onOpenBilling={props.onOpenBilling} embedded={props.embedded === true} editUnlimited={props.editUnlimited === true} />;
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
  // 반 학생 정보(연락처·학교·메모·최근 출결) — 펼친 학생 정보와 명단의 «특이» 표시에 쓴다. 늦거나 실패해도 출결은 계속 된다.
  const [peopleWanted, setPeopleWanted] = useState(false);
  // 이름을 눌러 학생 정보를 펼친 줄(한 번에 하나)
  const [infoRow, setInfoRow] = useState<string | null>(null);
  // «연락처 모아 보기» 시트 · 종료 창의 한 줄 입력 칸 열림 여부
  const [showPeople, setShowPeople] = useState(false);
  const [editReport, setEditReport] = useState(false);
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
  // 반 학생 정보(기존 «학생 정보» 시트와 같은 조회·같은 권한 검사)는 «한가할 때» 부른다.
  // 서버 기능은 순서대로 처리돼서, 화면이 뜨자마자 부르면 첫 출결 저장이 그 뒤에 줄을 선다.
  //   - 화면이 뜨고 잠시 뒤(PEOPLE_IDLE_DELAY_MS) 또는 이름을 처음 눌렀을 때 «불러도 됨»으로 바뀐다
  //   - 출결 저장 중(한 줄·전체 출석)이면 끝날 때까지 미룬다(hold). «특이» 표시는 늦게 떠도 된다.
  const attendanceBusy = Object.keys(savingRows).length > 0 || Boolean(bulkAttendanceProgress);
  useEffect(() => {
    const timer = window.setTimeout(() => setPeopleWanted(true), PEOPLE_IDLE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const people = useClassPeople({ classId: session.classId, sessionId: session.id, sessionDateId: session.sessionDateId, enabled: peopleWanted, hold: attendanceBusy });
  const peopleState: "loading" | "ready" | "error" = people.error ? "error" : people.loaded ? "ready" : "loading";
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
  /** 출석부 칸을 펼치고 그 자리로 옮긴다 */
  const scrollToRoster = useCallback(() => {
    setOpenSections((current) => ({ ...current, attendance: true }));
    window.requestAnimationFrame(() => document.getElementById("session-attendance")?.scrollIntoView({ block: "start" }));
  }, []);
  // 수업을 막 시작하고 들어온 경우(?view=attendance) 명단으로 맞춘다 — 예전의 «출석부» 화면 주소를 그대로 받는다.
  useEffect(() => {
    if (initialView === "attendance") scrollToRoster();
  }, [initialView, scrollToRoster]);

  // 종료 창을 열 때: 이미 쓴 한 줄이 있으면 읽기 전용으로, 없으면 입력 칸으로 연다(같은 칸을 두 번 쓰게 하지 않는다).
  // 단, 미리 쓴 내용이 «채워진 그대로»면 선생님이 쓴 글이 아니다 → 입력 칸을 연 채 안내와 함께 보인다(모르고 내보내지 않게).
  function openEndConfirm() {
    setFinishError("");
    setEditReport(!report.trim() || lessonPrefilled);
    setShowEndConfirm(true);
  }

  // 수업 계획을 «수업 내용» 칸에 채운다 — 저장은 «수업 내용 저장» 또는 수업 종료 때 한다.
  function loadPlanIntoLine() {
    const planText = (session.plannedContent || "").trim();
    if (!planText) return;
    if (report.trim() && !window.confirm("지금 쓴 글을 지우고 수업 계획으로 바꿀까요?")) return;
    const filled = Array.from(planText).slice(0, FEED_LINE_MAX).join("");
    setReport(Array.from(planText).slice(0, FEED_LINE_MAX).join(""));
    // 불러온 글도 «채운 그대로»다 — 고치거나 저장하기 전에 종료하려 하면 종료 창에서 알린다
    setPrefillSource(filled);
  }
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

  // 선택된 버튼을 다시 눌렀을 때 — 출결을 «미확인»으로 되돌린다(2026-11-14 원장 지시).
  // 결석을 되돌릴 때만 한 번 묻는다. 그 결석으로 나간 보강권이 실제로 있을 때만 «회수» 문장을 붙인다(서버가 미리 알려 준다).
  // 이미 예약·사용된 보강권이 걸렸거나 정산된 결석이면 서버가 막고, 그 이유를 이 줄 아래에 보인다.
  async function clearAttendance(target: StaffSessionStudent) {
    const rowId = target.id;
    setRowNotice(rowId, "");
    setSavingRows((current) => ({ ...current, [rowId]: true }));
    try {
      if (target.status === "ABSENT") {
        const preview = await clearStaffAttendance({ sessionId: session.id, attendanceKey: target.attendanceKey, dryRun: true });
        if (!preview.ok) {
          setRowNotice(rowId, preview.message);
          if (isLoginFailure(preview)) setNeedsLogin(true);
          return;
        }
        const question = preview.creditRevoke
          ? `${target.name} 결석을 취소할까요? 이 결석으로 나간 보강권이 회수됩니다.`
          : `${target.name} 결석을 취소할까요?`;
        if (!window.confirm(question)) return;
      }
      const result = await clearStaffAttendance({ sessionId: session.id, attendanceKey: target.attendanceKey });
      if (!result.ok) {
        setRowNotice(rowId, result.message);
        if (isLoginFailure(result)) setNeedsLogin(true);
        return;
      }
      setStudents((current) => current.map((student) => (
        student.id === rowId ? { ...student, status: null, arrivedAt: null, ...absenceReportPatch(result) } : student
      )));
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

  // 한 줄 저장 — 그 줄만 잠그고(다른 아이는 계속 누를 수 있다), 실패 문구는 그 줄 아래에 보인다(b5).
  async function updateAttendance(rowId: string, status: AttendanceStatus, absenceReason?: "ILLNESS_INJURY" | null) {
    const target = students.find((student) => student.id === rowId);
    if (!target || savingRows[rowId]) return;
    // 이미 선택된 버튼을 다시 누름 = 취소(미확인). «질병·부상» 칩(absenceReason 을 보냄)은 결석을 유지한 채 사유만 바꾸므로 해당 없음.
    // 단, 그 줄에 오류 안내가 떠 있으면(예: «출결은 저장됐지만 정규 출석 기록이 실패했어요. 다시 눌러 주세요.»)
    // 같은 버튼을 다시 누르는 것은 «다시 저장»이다 — 안내대로 눌렀는데 출결이 지워지면 안 된다.
    const retryAfterError = rowNotices[rowId]?.tone === "error";
    if (target.status === status && absenceReason === undefined && !retryAfterError) return clearAttendance(target);
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
        // 글칸에 보이는 값 그대로 보낸다(선생님이 지웠으면 빈 값 — 미리 쓴 내용이 몰래 따라 나가지 않는다)
        const result = await completeClassSession({
          sessionId: session.id,
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
  // 시작 취소 잠금(들어온 쪽 «더보기»의 actionsLocked 와 같은 조건)
  const actionsLocked = pending || voiceBusy || memoStatus === "saving";
  const plan = (session.plannedContent || "").trim();
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
        <button id="session-end" type="button" disabled={endLocked} onClick={openEndConfirm} className="academy-button-secondary min-h-12! w-full text-base!">수업 종료</button>
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

      {/* 저장 결과 안내(전체 출석·메모 저장·시작 취소) — 칸을 접어도 보이게 칸 밖 위쪽에 둔다.
          «잘 됐다»는 문구만 안내색, 그 밖(실패·주의)은 주의색 + role="alert"(2026-11-14 리뷰 반영). */}
      {message && (SUCCESS_MESSAGE.test(message) ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)] p-3">
          <p aria-live="polite" className="min-w-0 text-sm text-[var(--color-academy-info)]">{message}</p>
          <button type="button" onClick={() => setMessage("")} className="academy-button-text academy-button-sm min-h-11! shrink-0">닫기</button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-3">
          <p role="alert" className="min-w-0 text-sm font-medium text-[var(--color-academy-warning)]">{message}</p>
          <button type="button" onClick={() => setMessage("")} className="academy-button-text academy-button-sm min-h-11! shrink-0">닫기</button>
        </div>
      ))}

      {/* ④ 출석부 — 접힘: 요약 한 줄(+ 저장 중·저장 실패), 펼침: 전체 출석 + 명단.
          명단은 학생 한 명 = 한 줄(이름·표시·출결 버튼, 2026-11-14 간결화). 이름을 누르면 «그 자리에서» 학생 정보가 펼쳐진다(시트가 아니다). */}
      <WorkspaceSection
        id="session-attendance"
        title="출석부"
        summary={<span aria-label="출결 현황" className={`tabular-nums ${counts.UNCHECKED > 0 ? "text-[var(--color-academy-warning)]" : ""}`}>{attendanceSummary}</span>}
        badge={saveBadge.text ? <span role="status" className="flex shrink-0 items-center gap-1 text-xs font-medium">
          {saveBadge.saving && <span className="rounded bg-[var(--color-academy-soft)] px-2 py-0.5 text-[var(--color-academy-muted)]">저장 중</span>}
          {saveBadge.failed > 0 && <span className="rounded bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-[var(--color-academy-danger)]">저장 실패 {saveBadge.failed}</span>}
        </span> : undefined}
        open={openSections.attendance}
        onToggle={() => toggleSection("attendance")}
      >
        <div className="space-y-2">
          {/* 게슈탈트 T-06: 확인할 학생이 남았을 때만 꽉 찬 버튼(주인공)이 보인다. 다 끝나면 사라져 명단이 올라온다. */}
          {(bulkSplit.targets.length > 0 || bulkBusy) && (
            <button type="button" disabled={pending || anyRowSaving || bulkSplit.targets.length === 0} aria-busy={pending && bulkBusy} onClick={markAllPresent} className="academy-button-primary min-h-12! w-full">
              {/* 미확인이면 보강 온 아이도 함께 출석 처리된다(원장 2026-11-09 «보강도 전체 출석에서 체크»). */}
              {bulkAttendanceProgress || (uncheckedMakeup > 0 ? `미확인 학생 전체 출석 (보강 ${uncheckedMakeup}명 포함)` : "미확인 학생 전체 출석")}
            </button>
          )}
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

          <section aria-label="학생 출결 명단" className="overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
            {students.length === 0 && <p className="px-3 py-4 text-sm text-[var(--color-academy-muted)]">이 수업에 등록된 학생이 없습니다.</p>}
            {students.map((student) => {
              const person = findRosterPerson(student, people.people);
              const infoOpen = infoRow === student.id;
              return <article key={student.id} data-student-row className="border-b border-[var(--color-academy-line)] px-3 py-1.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  {/* 이름 쪽을 누르면 이 줄 아래에 학생 정보가 펼쳐진다 — 연락처·수강료·메모·최근 출결은 거기서 본다 */}
                  <button type="button" aria-expanded={infoOpen} aria-controls={`roster-info-${student.id}`} aria-label={`${student.name} 상세 정보`} onClick={() => { setPeopleWanted(true); setInfoRow(infoOpen ? null : student.id); }} className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-left">
                    <span className="break-keep text-base font-semibold">{student.name}</span>
                    {/* 다른 반 아이가 보강 온 경우. 출석을 찍으면 보강권이 사용 처리되고, 결석이면 보강권은 그대로 남는다. */}
                    {student.makeup && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS[ATTENDANCE_TONE.MAKEUP]}`}>보강</span>
                    )}
                    {/* 체험수업 온 아이(f1). 출결은 체험 기록에만 남고 정규 출석·청구에는 섞이지 않는다. */}
                    {student.trial && (
                      // 보강(정보색)과 헷갈리지 않게 브랜드 색으로 구분한다.
                      <span className="rounded bg-[var(--color-academy-primary-soft)] px-1.5 py-0.5 text-xs text-[var(--brand-accent)]">체험</span>
                    )}
                    {/* 학부모가 미리 넣은 결석 신고 — 이게 안 보이면 선생님이 모르고 출석을 찍는다. 사유·확정 여부는 펼친 학생 정보에. */}
                    {student.absenceReport?.source === "PARENT" && (
                      <span className="rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-academy-warning)]">결석 신고</span>
                    )}
                    {/* 학부모가 알린 지각·조퇴 예정(«지각 예정 17:20») — 결석 신고가 있으면 그쪽이 우선(서버가 비워 보낸다) */}
                    {student.arrivalNotices?.map((label) => (
                      <span key={label} className="rounded bg-[var(--color-academy-info-soft)] px-1.5 py-0.5 text-xs font-medium tabular-nums text-[var(--color-academy-info)]">{label}</span>
                    ))}
                    {/* 미납은 원장·부원장(showFees)에게만 — 선생님은 수강료 조회 자체를 하지 않아 값도 없다(f3). 금액·청구는 펼친 학생 정보에. */}
                    {showFees && !student.makeup && !student.trial && feesByRoster.get(student.id)?.status === "UNPAID" && (
                      <span className="rounded bg-[var(--color-academy-warning-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--color-academy-warning)]">미납</span>
                    )}
                    {/* 학생 메모·건강 특이사항(학부모 입력)·오늘 출결 메모가 있으면 «특이» — 내용은 펼친 학생 정보에 */}
                    {(person?.memo || person?.healthNote || student.attendanceNote) && (
                      <span className={`rounded px-1.5 py-0.5 text-xs ${TONE_BADGE_CLASS.neutral}`}>특이</span>
                    )}
                    <span className="flex text-[var(--color-academy-faint)]">
                      <UiIcon name={infoOpen ? "expand_less" : "expand_more"} />
                    </span>
                  </button>
                  <div className="grid shrink-0 grid-cols-3 gap-2">
                    {(["PRESENT", "LATE", "ABSENT"] as AttendanceStatus[]).map((status) => (
                      <StatusChoiceButton key={status} tone={STATUS_TONE[status]} ariaLabel={`${student.name} ${STATUS_LABEL[status]}`} active={student.status === status} disabled={bulkBusy || Boolean(savingRows[student.id])} onClick={() => void updateAttendance(student.id, status)} className="min-w-12">
                        {STATUS_LABEL[status]}
                      </StatusChoiceButton>
                    ))}
                  </div>
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
                    className="academy-choice mb-1 mt-1 w-full disabled:opacity-60"
                  >
                    질병·부상 결석
                    {parentLocked && <span className="text-xs">(학부모 신고)</span>}
                  </button>;
                })()}
                {/* 이 아이 줄의 저장 상태·실패 문구(b5) — 어느 아이 얘기인지 바로 보이게 그 줄 아래에 둔다. */}
                {savingRows[student.id] && <p aria-live="polite" className="mt-1 text-xs text-[var(--color-academy-muted)]">저장 중…</p>}
                {/* 저장 실패=빨강, 건너뜀·참고 안내=주의색(검수 4 — 결석 신고 안내를 오류처럼 보이지 않게) */}
                {rowNotices[student.id] && (rowNotices[student.id].tone === "error" ? (
                  <p role="alert" className="mt-1 text-xs font-semibold text-[var(--color-academy-danger)]">
                    {rowNotices[student.id].text}
                  </p>
                ) : (
                  <p role="status" className="mt-1 text-xs text-[var(--color-academy-warning)]">
                    {rowNotices[student.id].text}
                  </p>
                ))}
                {/* 학생 정보 — 이름을 누르면 이 줄 아래에 펼쳐진다. 학생별 청구는 여기서 기존 청구 창(출결 맥락 포함)을 연다 */}
                {infoOpen && (
                  <div id={`roster-info-${student.id}`}>
                    <SessionStudentInfo
                      student={student}
                      person={person}
                      photoVersion={person ? people.photoVersions[person.id] : null}
                      peopleState={peopleState}
                      onReloadPeople={people.reload}
                      showFees={showFees}
                      feeLoading={feeLoading}
                      feeError={feeError}
                      feeMonth={feeData?.month ?? null}
                      fee={feesByRoster.get(student.id)}
                      onReloadFees={() => setFeeReload((value) => value + 1)}
                      onOpenBilling={(target) => setAttendanceBillingTarget(target)}
                    />
                  </div>
                )}
              </article>;
            })}
          </section>
          <p className="text-xs text-[var(--color-academy-muted)]">잘못 찍었으면 다른 버튼을 눌러 바로 고칠 수 있어요. 보강권도 함께 맞춰집니다.</p>

          {/* 예전 «더보기»·«학생 정보·수업 관리»에 있던 진입을 출석부 칸 아래 글자 버튼으로 옮겼다(2026-11-15 접이식 구조와 병합):
              연락처 모아 보기(이름 검색·전화·문자) · 반 전체 청구 확인(원장·부원장만, f3 보완) · 수업 공지(홈에서만).
              수업 시작 취소는 원장 지시대로 메모 칸 아래에 있다. */}
          <div className="flex flex-wrap gap-2" aria-label="수업 관리">
            <button type="button" aria-haspopup="dialog" onClick={() => setShowPeople(true)} className="academy-button-text academy-button-sm min-h-11! underline underline-offset-2">
              연락처 모아 보기
            </button>
            {showFees && <button type="button" onClick={() => setBillingStudent(null)} className="academy-button-text academy-button-sm min-h-11! underline underline-offset-2">
              반 전체 청구 확인
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
        {/* 수업 계획(수업 전에 미리 쓴 내용)은 이 칸 안의 접힌 한 줄 — 계획이 없으면 줄 자체를 그리지 않는다(2026-11-14 «오늘 수업» 한 칸).
            수업 내용을 따로 저장한 뒤에도 읽을 수 있고, «불러오기»로 글칸에 다시 채울 수 있다(저장은 «수업 내용 저장» 또는 수업 종료 때). */}
        {plan && (
          <div className="mb-3 rounded-xl bg-[var(--color-academy-soft)]">
            <button type="button" onClick={() => setShowPlan((current) => !current)} aria-expanded={showPlan} aria-controls="session-plan" className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-sm font-medium text-[var(--color-academy-muted)]">
              <span>수업 계획 보기</span>
              <UiIcon name={showPlan ? "expand_less" : "expand_more"} />
            </button>
            {showPlan && (
              <div id="session-plan" className="border-t border-[var(--color-academy-line)] px-3 py-3">
                <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--color-academy-muted)]">{plan}</p>
                {report.trim() !== plan && (
                  <button type="button" onClick={loadPlanIntoLine} className="academy-button-secondary academy-button-sm mt-2">수업 내용 칸에 불러오기</button>
                )}
              </div>
            )}
          </div>
        )}
        <LessonTextEditor inputId={`lesson-text-${session.id}`} phase="IN_PROGRESS" value={report} onChange={setReport} save={saveLessonText} prefilledFromPlan={lessonPrefilled} onBusyChange={setFeedBusy} />
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
      {/* 2026-11-15 원장 점검: 위험 작업으로 보이게 빨간 위험 버튼 하나(칸 전체 폭·44px 이상). 꽉 찬 빨강은 «종료 확인» 창의 최종 버튼뿐이라 테두리형을 쓴다. */}
      <div id="session-cancel-start">
        <p className="mb-1 text-xs text-[var(--color-academy-muted)]">시작을 취소해도 기록한 출결은 유지됩니다.</p>
        <button type="button" disabled={actionsLocked} onClick={cancelStart} className="academy-button-danger min-h-12! w-full">
          수업 시작 취소 (시작 전으로 되돌리기)
        </button>
      </div>

      {showPeople && <ClassPeopleSheet open classId={session.classId} sessionId={session.id} className={session.className} onClose={() => setShowPeople(false)} onOpenBilling={showFees ? (student) => { setShowPeople(false); setBillingStudent(student); } : undefined} />}
      {showFees && billingStudent !== undefined && <ClassBillingSheet key={`${session.classId}:${billingStudent?.id || "all"}`} open classId={session.classId} className={session.className} student={billingStudent} onClose={() => setBillingStudent(undefined)} />}
      {attendanceBillingSheet}

      {/* ⑨ 아래 고정 막대 [사진] [동영상] [갤러리] — 예전 «수업 종료 확인» 자리.
          수업 주소에서는 아래 탭(StaffBottomNav)이 숨어 화면 바닥에 붙고, 홈에서는 아래 탭 위에 띄운다. */}
      <SessionMediaBar
        photoRef={photoUploaderRef}
        videoRef={videoUploaderRef}
        photoState={photoState}
        videoState={videoState}
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
                <p className="mt-1 text-xs">명단에서 출석·지각·결석 중 하나를 선택해 주세요.</p>
              </div>
            )}
            {/* 리포트를 여기서 끝낸다. 지금까지는 원장이 PC 에서 따로 써야 나가서 운영 100회차 동안 발행이 0건이었다.
                한 줄은 선택이고, 비워도 출결·사진이 리포트가 된다.
                2026-11-14: 수업 내용 칸에서 이미 쓴 글이 있으면 같은 입력 칸을 또 보이지 않는다 — 읽기 전용 한 줄 + «고치기».
                쓴 글이 없을 때(또는 «고치기»를 눌렀을 때)만 입력 칸이 열린다. 종료할 때 보내는 값(report)은 어느 쪽이든 같다.
                2026-11-15 병합: 미리 쓴 내용이 «채워진 그대로»(선생님이 고치거나 저장한 적 없음)면 읽기 전용으로 넘기지 않고
                입력 칸을 연 채 바로 아래에서 알린다 — 모르고 학부모에게 내보내지 않게. */}
            {counts.UNCHECKED === 0 && (
              <div className="mt-4" data-end-report>
                {editReport ? (
                  <>
                    <label htmlFor="session-report" className="text-sm font-medium text-[var(--color-academy-ink)]">
                      학부모에게 보낼 글 <span className="font-normal text-[var(--color-academy-faint)]">(선택)</span>
                    </label>
                    <textarea
                      id="session-report"
                      value={report}
                      onChange={(event) => setReport(event.target.value)}
                      rows={2}
                      maxLength={FEED_LINE_MAX}
                      placeholder="예: 드리블 기본기 연습했습니다. 다들 잘 따라왔어요."
                      className="academy-input mt-1.5"
                    />
                    {/* 이 글칸에서 바로 고치거나 지울 수 있고, 한 글자라도 바꾸면 이 안내는 사라진다. */}
                    {lessonPrefilled && (
                      <p role="alert" className="mt-1.5 rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] p-2 text-xs font-medium text-[var(--color-academy-warning)]">{PLAN_PREFILL_END_NOTICE}</p>
                    )}
                  </>
                ) : (
                  <div className="flex items-start justify-between gap-2 rounded-xl bg-[var(--color-academy-soft)] p-3">
                    <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-[var(--color-academy-ink)]">
                      <span className="text-[var(--color-academy-muted)]">학부모에게 보낼 글: </span>{report.trim()}
                    </p>
                    <button type="button" disabled={pending} onClick={() => setEditReport(true)} className="academy-button-text academy-button-sm shrink-0">고치기</button>
                  </div>
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
                <button type="button" disabled={pending} onClick={() => { setShowEndConfirm(false); scrollToRoster(); }} className="academy-button-primary">명단으로 가기</button>
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
