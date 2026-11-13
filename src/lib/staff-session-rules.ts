// 선생님·기사님 화면의 작은 판정 규칙 모음 — 출시 전 점검(2026-11-13 원장 승인) b1·b2·b4·b5·b6·b7.
//
// 왜 한 파일에 모으는가:
//   «전체 출석에서 결석 신고 아이 빼기», «날짜가 바뀐 화면인지», «지난 날짜 수업인지»,
//   «로그인이 풀린 건지 권한이 없는 건지», «아이폰 스토어 앱인지» 는 화면과 서버 양쪽에서 같은 답을 내야 한다.
//   한쪽만 고치면 «화면은 막는데 서버는 받는» 갈림이 생긴다 → 여기 한 곳에서 정하고 tests/staff-session-rules.test.mjs 로 실행 검증한다.
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다). 날짜는 @/lib/datetime/kst 만 쓴다.
import { todayKst } from "@/lib/datetime/kst";

// ── b1. 전체 출석 ─────────────────────────────────────────────

/** 출석부 한 줄에서 판정에 필요한 부분만(화면의 StaffSessionStudent 와 호환). */
export type BulkAttendanceRow = {
  status: string | null;
  absenceReport: { reason: string; status: string; source: "SHEET" | "PARENT" } | null;
};

/**
 * «미확인 학생 전체 출석»의 대상을 나눈다.
 * - 이미 찍은 아이는 건드리지 않는다.
 * - 결석 신고(학부모 신고·원장 기간 결석)가 있는 아이는 일괄 출석에서 뺀다 → 선생님이 직접 확인한다.
 *   아이가 실제로 왔으면 그 줄의 «출석» 버튼을 직접 누르면 된다(개별 출석은 막지 않는다).
 */
export function splitBulkPresent<T extends BulkAttendanceRow>(rows: T[]): { targets: T[]; reported: T[] } {
  const unchecked = rows.filter((row) => !row.status);
  return {
    targets: unchecked.filter((row) => !row.absenceReport),
    reported: unchecked.filter((row) => Boolean(row.absenceReport)),
  };
}

/** 전체 출석 버튼 옆 안내 — 결석 신고 아이가 없으면 빈 문자열. */
export function bulkReportedNotice(count: number): string {
  return count > 0 ? `결석 신고 ${count}명은 직접 확인해 주세요.` : "";
}

/** 서버가 일괄 출석 요청에서 결석 신고 아이를 건너뛸 때 돌려주는 문구. */
export const BULK_SKIPPED_MESSAGE = "결석 신고가 있는 학생이라 전체 출석에서 건너뛰었습니다. 직접 확인해 주세요.";

/**
 * 전체 출석 중 «이미 출결이 기록된» 아이를 만났을 때(다른 기기에서 먼저 찍음) — 덮어쓰지 않고 건너뛴다(검수 3).
 * 덮어쓰면 다른 선생님이 찍은 «결석»이 «출석»으로 바뀌어 보강권·알림이 틀어진다.
 */
export const BULK_ALREADY_RECORDED_MESSAGE = "다른 기기에서 이미 출결이 기록돼 건너뛰었습니다. 화면을 새로고침해 확인해 주세요.";

/** 특강 좌석 출결은 저장됐지만 정규 출석 기록(Attendance)이 실패했을 때 그 줄에 보이는 안내(검수 2). */
export const SEAT_RECORD_WARNING_MESSAGE = "출결은 저장됐지만 정규 출석 기록이 실패했어요. 다시 눌러 주세요.";

// ── b2. 날이 바뀐 화면 ───────────────────────────────────────

/** 화면이 들고 있는 날짜(dateKey)가 오늘(KST)이 아닌가 — 밤새 열어 둔 화면을 다음 날 다시 볼 때. */
export function isStaleDateKey(dateKey: string, nowMs: number = Date.now()): boolean {
  return dateKey !== todayKst(nowMs);
}

export const STALE_DATE_MESSAGE = "날짜가 바뀌었어요. 화면을 새로고침해 주세요.";

// ── b6. 지난 날짜에 진행 중으로 남은 수업 ────────────────────

/** 수업 날짜가 오늘(KST)보다 앞인가. "YYYY-MM-DD" 는 글자 순서가 곧 날짜 순서다. */
export function isPastSessionDate(sessionYmd: string, nowMs: number = Date.now()): boolean {
  return String(sessionYmd).slice(0, 10) < todayKst(nowMs);
}

/**
 * 학부모 알림(출석·수업 종료)을 보낼 날인가.
 * 지난 날짜 수업을 뒤늦게 정리할 때 «방금 출석했어요/수업이 끝났어요»가 나가면 학부모가 혼란스럽다 → 보내지 않는다.
 */
export function shouldNotifyParentsForSession(sessionYmd: string, nowMs: number = Date.now()): boolean {
  return !isPastSessionDate(sessionYmd, nowMs);
}

/** «○○반(11월 12일) 수업이 아직 진행 중입니다. 먼저 끝내 주세요.» — 날짜를 모르면 반 이름만. */
export function activeSessionNotice(className: string, sessionYmd?: string | null): string {
  const ymd = sessionYmd ? String(sessionYmd).slice(0, 10) : "";
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  const when = m ? `(${Number(m[1])}월 ${Number(m[2])}일)` : "";
  return `${className}${when} 수업이 아직 진행 중입니다. 먼저 끝내 주세요.`;
}

// ── b5. 권한·로그인 실패를 화면이 알아듣게 ───────────────────

export type StaffFailureKind = "login" | "forbidden" | "network" | "other";

/**
 * 오류 문구로 종류를 가른다.
 * - login: 로그인이 풀림(requireAuth «인증이 필요합니다. 로그인해주세요.»)
 * - forbidden: 직원 권한이 없음·담당 수업이 아님
 * - network: 휴대폰 연결이 끊김(브라우저가 던지는 Failed to fetch 등)
 */
export function classifyStaffFailure(message: string | null | undefined): StaffFailureKind {
  const text = String(message ?? "");
  if (/인증이 필요|로그인해|로그인이 필요|not authenticated|unauthorized|jwt/i.test(text)) return "login";
  if (/staff permission|권한|담당 수업|담당 특강|코치 정보|forbidden|permission/i.test(text)) return "forbidden";
  if (/failed to fetch|networkerror|network error|load failed|fetch failed|네트워크|offline|timeout|timed out/i.test(text)) return "network";
  return "other";
}

export type StaffAccessFailure = { ok: false; message: string; needsLogin?: true };

/**
 * 서버 기능에서 권한 검사가 던진 오류를 «화면이 받을 수 있는 실패 값»으로 바꾼다.
 * 권한·로그인 문제가 아니면 null(→ 호출부가 원래대로 다시 던진다).
 */
export function staffAccessFailure(error: unknown): StaffAccessFailure | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const kind = classifyStaffFailure(raw);
  if (kind === "login") {
    return { ok: false, message: "로그인이 풀렸습니다. 다시 로그인해 주세요.", needsLogin: true };
  }
  if (kind === "forbidden") {
    // «담당 수업에만…» 처럼 이미 한국어 안내인 문구는 살리고, 영어 원문은 쉬운 문장으로 바꾼다.
    const friendly = /[가-힣]/.test(raw) ? raw : "이 수업을 볼 수 있는 권한이 없습니다. 원장님께 문의해 주세요.";
    return { ok: false, message: friendly };
  }
  return null;
}

/** 다시 로그인한 뒤 지금 화면으로 돌아오는 선생님 앱 로그인 주소. */
export function staffReloginHref(currentPath: string): string {
  const path = currentPath.startsWith("/staff") ? currentPath : "/staff";
  return `/staff/login?redirect=${encodeURIComponent(path)}`;
}

// ── b4. 코치 연결 ────────────────────────────────────────────

/** 선생님 계정에 코치가 연결되지 않아 수업이 하나도 안 보이는 상태인가(원장·부원장은 해당 없음). */
export function needsCoachLink(access: { canAccessAllClasses: boolean; coachId: string | null }): boolean {
  return !access.canAccessAllClasses && !access.coachId;
}

// ── b7. 아이폰 스토어 앱의 기사님 ────────────────────────────

/** 아이폰·아이패드(UA 기준). 아이패드 데스크톱 모드(Macintosh UA)는 못 잡는다 — 그 경우는 웹 화면이 그대로 열린다. */
export function isIosUserAgent(userAgent: string | null | undefined): boolean {
  return /iphone|ipad|ipod/i.test(String(userAgent ?? ""));
}

/**
 * 기사님 첫 화면에서 «운행 기능은 다음 업데이트에» 안내를 보여야 하나.
 * 아이폰 스토어 앱은 지금 /staff/shuttle·/staff/run 으로 가는 길을 앱이 막는다(앱 다음 업데이트에서 열림).
 * 거기로 보내면 화면이 멈춘 것처럼 보이므로, 그 경우만 안내 화면에 머문다.
 */
export function shouldShowIosDriverNotice(storeApp: boolean, userAgent: string | null | undefined): boolean {
  return storeApp && isIosUserAgent(userAgent);
}

/** 기사님 첫 화면(로그인 후 도착지). 여기서 운행 화면(/staff/run)으로 넘기거나 아이폰 앱 안내를 보인다. */
export const DRIVER_ENTRY_PATH = "/staff/driver";
/** 위치 전송(운행 시작)이 되는 기사님 운행 화면. */
export const DRIVER_RUN_PATH = "/staff/run";

// ── f1. 체험수업 아이(출시 전 수정 2026-11-13 원장 지시) ─────────────────

/**
 * 체험 아이의 출석부 키 — 정규 학생 ID·특강 좌석 ID 와 겹치지 않게 앞에 «trial:» 을 붙인다.
 * 서버 저장(saveStaffAttendance)은 이 표시를 보고 체험 장부(TrialLead)로 보낸다 —
 * 정규 출석 표(Attendance)에 섞이면 청구·출석률·보강권이 틀어진다.
 */
export const TRIAL_ROSTER_PREFIX = "trial:";
export function trialRosterKey(trialLeadId: string): string {
  return `${TRIAL_ROSTER_PREFIX}${trialLeadId}`;
}
/** «trial:<id>» 이면 체험 신청 id, 아니면 null. */
export function parseTrialRosterKey(key: string | null | undefined): string | null {
  const value = String(key ?? "");
  if (!value.startsWith(TRIAL_ROSTER_PREFIX)) return null;
  const id = value.slice(TRIAL_ROSTER_PREFIX.length).trim();
  return id && id.length <= 128 ? id : null;
}

/** 선생님 출석부에 체험 아이로 띄우는 체험 신청 상태 — 일정 확정(SCHEDULED)·체험 완료(ATTENDED). */
export const TRIAL_ROSTER_STATUSES = ["SCHEDULED", "ATTENDED"] as const;

type StaffMark = "PRESENT" | "LATE" | "ABSENT";

/**
 * 선생님이 체험 아이 출결을 찍은 뒤 체험 신청 상태(CRM 단계)를 어떻게 둘지.
 * - 출석·지각: 일정 확정(SCHEDULED)이면 «체험 완료(ATTENDED)»로 올린다 — 관리자가 누르던 «체험 완료»와 같은 값.
 * - 결석: 선생님이 앞서 출석·지각을 찍어 올린 것(이전 표시가 PRESENT/LATE)만 SCHEDULED 로 되돌린다.
 *   관리자가 직접 바꾼 단계(상담·등록 등)는 건드리지 않는다.
 * 체험 신청에는 «불참» 단계가 없어서, 결석 자체는 별도 칸(staffAttendanceStatus)에만 남긴다.
 */
export function trialLeadStatusAfterStaffMark(input: {
  currentStatus: string;
  previousMark: StaffMark | null;
  nextMark: StaffMark;
}): string {
  const { currentStatus, previousMark, nextMark } = input;
  if (nextMark === "PRESENT" || nextMark === "LATE") {
    return currentStatus === "SCHEDULED" ? "ATTENDED" : currentStatus;
  }
  if (currentStatus === "ATTENDED" && (previousMark === "PRESENT" || previousMark === "LATE")) return "SCHEDULED";
  return currentStatus;
}

// ── f3. 수강료·미납 표시 ─────────────────────────────────────

/**
 * 선생님 출석부에서 수강료·미납을 볼 수 있는 역할 — 원장(ADMIN)·부원장(VICE_ADMIN)만.
 * 선생님(INSTRUCTOR)·기사님은 화면에서도, 서버 응답에서도 금액·미납 값을 받지 않는다(2026-11-13 원장 지시).
 */
export function canSeeStaffFees(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "VICE_ADMIN";
}
