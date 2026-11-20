// 선생님·기사님 화면의 작은 판정 규칙 모음 — 출시 전 점검(2026-11-13 원장 승인) b1·b2·b4·b5·b6·b7.
//
// 왜 한 파일에 모으는가:
//   «전체 출석에서 결석 신고 아이 빼기», «날짜가 바뀐 화면인지», «지난 날짜 수업인지»,
//   «로그인이 풀린 건지 권한이 없는 건지», «아이폰 스토어 앱인지» 는 화면과 서버 양쪽에서 같은 답을 내야 한다.
//   한쪽만 고치면 «화면은 막는데 서버는 받는» 갈림이 생긴다 → 여기 한 곳에서 정하고 tests/staff-session-rules.test.mjs 로 실행 검증한다.
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다). 날짜는 @/lib/datetime/kst 만 쓴다.
import { addDaysKst, isKstYmd, kstDow, todayKst } from "@/lib/datetime/kst";
import { canSeePaymentAmount } from "@/lib/auth/moneyAccess";

// ── b1. 전체 출석 ─────────────────────────────────────────────

/** 출석부 한 줄에서 판정에 필요한 부분만(화면의 StaffSessionStudent 와 호환). */
export type BulkAttendanceRow = {
  status: string | null;
  absenceReport: { reason: string; status: string; source: "SHEET" | "PARENT" } | null;
  /** 체험수업 아이(f1) — 전체 출석 대상이 아니다. */
  trial?: boolean;
};

/**
 * «미확인 학생 전체 출석»의 대상을 나눈다.
 * - 이미 찍은 아이는 건드리지 않는다.
 * - 결석 신고(학부모 신고·원장 기간 결석)가 있는 아이는 일괄 출석에서 뺀다 → 선생님이 직접 확인한다.
 *   아이가 실제로 왔으면 그 줄의 «출석» 버튼을 직접 누르면 된다(개별 출석은 막지 않는다).
 * - 체험 아이는 아예 빼고(targets·reported 어디에도 없음) 개별로만 찍는다 —
 *   안 온 체험 아이가 일괄 출석으로 «체험 완료»에 올라가는 사고를 막는다(검수 LOW-1).
 */
export function splitBulkPresent<T extends BulkAttendanceRow>(rows: T[]): { targets: T[]; reported: T[] } {
  const unchecked = rows.filter((row) => !row.status && !row.trial);
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

// ── 날짜 이동(2026-11-16 원장 지시) — 선생님이 다가올 수업을 미리 보고 수업 내용을 미리 쓴다 ──

/** 오늘 포함 며칠 뒤까지 미리 볼 수 있는가(지난 날짜는 «지난 수업» 화면이 맡는다). */
export const STAFF_PREVIEW_DAYS = 14;

/** 미리 쓸 수 있는 날짜인가 — 오늘 ~ 오늘+14일. "YYYY-MM-DD" 는 글자 순서가 곧 날짜 순서다. */
export function canPlanOnDate(ymd: string, today: string = todayKst()): boolean {
  return isKstYmd(ymd) && ymd >= today && ymd <= addDaysKst(today, STAFF_PREVIEW_DAYS);
}

/** 주소의 ?date= 값으로 화면 날짜를 정한다 — 형식이 틀리거나 범위 밖(지난 날·너무 먼 날)이면 오늘. */
export function resolveStaffViewDate(raw: unknown, today: string = todayKst()): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && canPlanOnDate(value, today) ? value : today;
}

/** 날짜 칸에 늘어놓을 날짜들 — 오늘부터 14일 뒤까지(15칸). */
export function staffPreviewDates(today: string = todayKst()): string[] {
  return Array.from({ length: STAFF_PREVIEW_DAYS + 1 }, (_, index) => addDaysKst(today, index));
}

/** 반 요일(Class.dayOfWeek = "Mon" 등)이 그 날짜의 요일과 같은가 — 수업이 없는 날짜에 수업 기록이 생기지 않게 서버가 확인한다. */
const CLASS_DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export function classDayKeyOf(ymd: string): string {
  return CLASS_DAY_KEYS[kstDow(ymd)];
}

export const PLAN_TOO_FAR_MESSAGE = `수업 내용은 ${STAFF_PREVIEW_DAYS}일 뒤 수업까지만 미리 쓸 수 있습니다.`;
export const PLAN_NO_CLASS_MESSAGE = "이 날짜에는 이 반 수업이 없습니다. 날짜를 다시 확인해 주세요.";

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

// ── 수업 종료가 «끝난 줄 알았는데 진행 중»으로 남는 일 막기(2026-11-20 원장 승인) ──────────
//
// 사건: 11/19 수업이 종료되지 않은 채 남아, 다음 날 다른 수업 시작이 «먼저 끝내 주세요»로 막혔다.
//   ① 막힌 자리에서 바로 끝낼 수 있게(정리용 종료) ② 늦은 종료는 리포트를 기본으로 발행하지 않게
//   ③ 종료 버튼이 아무 말 없이 무시되지 않게 — 세 가지 판정을 화면·서버가 같이 쓴다.

/**
 * 수업을 종료할 때 리포트를 학부모에게 발행할지.
 * - 오늘 수업: 화면이 끄지 않았으면 발행한다(값이 없으면 발행 — 기존 규칙 그대로).
 * - 지난 날짜 수업(늦은 종료): 화면이 «보내기»를 켰을 때(publishReport === true)만 발행한다.
 *   하루 지난 수업의 리포트가 선생님도 모르게 «발행됨»으로 나가지 않게.
 * - 오늘 날짜를 모르면(DB 시계를 못 읽음) 지난 날로 단정하지 않고 기존 규칙을 따른다.
 * 날짜는 인자로 받는다(이 함수는 시계를 보지 않는다). "YYYY-MM-DD" 는 글자 순서가 곧 날짜 순서다.
 */
export function shouldPublishOnComplete(input: {
  sessionYmd: string;
  todayYmd: string;
  publishReport?: boolean;
}): boolean {
  const sessionYmd = String(input.sessionYmd ?? "").slice(0, 10);
  const todayYmd = String(input.todayYmd ?? "").slice(0, 10);
  const late = isKstYmd(sessionYmd) && isKstYmd(todayYmd) && sessionYmd < todayYmd;
  return late ? input.publishReport === true : input.publishReport !== false;
}

/** 종료 창을 처음 열 때 «학부모에게 바로 보내기» 체크의 기본값 — 지난 날짜 수업이면 끔, 그 밖은 켬. */
export function defaultPublishOnComplete(sessionYmd: string, todayYmd: string): boolean {
  return shouldPublishOnComplete({ sessionYmd, todayYmd });
}

/** 지난 날짜 수업의 종료 창에서 «바로 보내기» 옆에 보이는 한 줄. */
export const LATE_COMPLETE_NOTICE = "지난 날짜 수업이라 학부모 알림은 나가지 않습니다.";

/**
 * «종료 확인»을 눌렀는데 지금은 종료할 수 없을 때 보일 문구 — 종료할 수 있으면 빈 문자열.
 * 예전엔 이 상태에서 눌러도 아무 반응이 없었다(버튼이 꺼져 있거나 함수가 말없이 끝남).
 */
export function finishBlockedMessage(input: {
  voiceBusy: boolean;
  memoSaving: boolean;
  online: boolean;
  /** 연결 끊김 안내를 이미 한 번 보였는가 — 보인 뒤 다시 누르면 그대로 요청을 보낸다 */
  offlineWarned?: boolean;
}): string {
  if (input.voiceBusy) return "음성 입력을 마친 뒤 다시 눌러 주세요.";
  if (input.memoSaving) return "메모를 저장하는 중입니다. 잠시 뒤 다시 눌러 주세요.";
  // 휴대폰의 «연결 끊김» 표시는 틀릴 때가 있다 — 영영 못 끝내지 않게 한 번만 막고, 다시 누르면 보내 본다.
  if (!input.online && !input.offlineWarned) return OFFLINE_FINISH_MESSAGE;
  return "";
}

/** 연결이 끊긴 것으로 보일 때 «종료 확인»을 처음 누르면 보이는 문구(다시 누르면 요청을 보낸다). */
export const OFFLINE_FINISH_MESSAGE = "인터넷 연결이 끊긴 것 같습니다. 연결을 확인한 뒤 다시 눌러 주세요.";

/** 종료 요청에 이 시간(ms) 넘게 응답이 없으면 «응답이 늦습니다» 안내를 보인다. */
export const SLOW_RESPONSE_MS = 12_000;
/** 수업 종료 확인 창 — 응답이 늦을 때. «새로 고침» 버튼과 함께 보인다. */
export const FINISH_SLOW_MESSAGE = "응답이 늦습니다. 이 화면을 닫지 말고 잠시 기다려 주세요. 계속 멈춰 있으면 새로 고침 뒤 다시 종료해 주세요.";
/** 막힌 자리 안내 창 — 응답이 늦을 때. 이때부터 «닫기»가 눌린다. */
export const BLOCKING_SLOW_MESSAGE = "응답이 늦습니다. 닫고 다시 시도할 수 있습니다.";

/** 수업 종료를 서버가 거부한 사유(서버 기록용 짧은 코드). */
export type CompleteRefusalReason = "GATE" | "NOT_IN_PROGRESS" | "NOT_PAST" | "NOT_STARTER" | "ATTENDANCE_MISSING" | "STATE_CHANGED";

/**
 * 종료 거부를 서버 기록에 남길 값 — 수업 id·사유 코드·(있으면) 출결 미확인 인원 수만.
 * 학생 이름 같은 개인정보는 넣지 않는다.
 */
export function completeRefusalLog(input: {
  sessionId: string;
  reason: CompleteRefusalReason;
  missingCount?: number;
}): { sessionId: string; reason: CompleteRefusalReason; missingCount?: number } {
  const log: { sessionId: string; reason: CompleteRefusalReason; missingCount?: number } = {
    sessionId: String(input.sessionId ?? "").slice(0, 100),
    reason: input.reason,
  };
  if (typeof input.missingCount === "number" && Number.isFinite(input.missingCount)) log.missingCount = input.missingCount;
  return log;
}

/**
 * 막힌 자리의 «그 수업 종료하기»로 끝낼 수 있는 수업인가 — 본인이 시작한 수업만.
 * (다른 수업 시작을 막는 기준 = startClassSession 의 «startedByUserId = 본인» 과 같다)
 */
export function canFinishBlockingSession(input: { startedByUserId: string | null | undefined; userId: string | null | undefined }): boolean {
  return Boolean(input.userId) && input.startedByUserId === input.userId;
}

/**
 * 정리용 종료(막힌 자리의 «그 수업 종료하기»)를 받을 수업 날짜인가 — 지난 날짜 수업만(2026-11-20 검수 결정).
 * 오늘 수업을 이 길로 끝내면 학부모 알림·리포트 없이 끝나 버린다 → 오늘·미래 수업은 그 수업 화면에서 끝낸다.
 * 오늘 날짜를 모르면(빈 값·이상한 값) 안전하게 거부한다. 날짜는 인자로 받는다(시계를 보지 않는다).
 */
export function canCleanupFinish(input: { sessionYmd: string | null | undefined; todayYmd: string | null | undefined }): boolean {
  const sessionYmd = String(input.sessionYmd ?? "").slice(0, 10);
  const todayYmd = String(input.todayYmd ?? "").slice(0, 10);
  return isKstYmd(sessionYmd) && isKstYmd(todayYmd) && sessionYmd < todayYmd;
}

/** 오늘(또는 날짜를 확인하지 못한) 수업을 정리용 종료로 끝내려 할 때. */
export const BLOCKING_NOT_PAST_MESSAGE = "오늘 수업은 그 수업 화면에서 종료해 주세요.";

/** 막힌 자리 안내 창의 둘째 줄(지난 날짜 수업일 때만 보인다). */
export const BLOCKING_FINISH_HINT = "지난 날짜 수업이고 출결이 다 확인됐으면 여기서 바로 끝낼 수 있습니다. 학부모 알림과 리포트 발행은 하지 않습니다.";
/** 그 수업을 본인이 시작하지 않았을 때. */
export const BLOCKING_NOT_STARTER_MESSAGE = "직접 시작한 수업만 여기서 끝낼 수 있습니다. 그 수업 화면에서 종료해 주세요.";
/** 종료 요청이 서버에 닿지 못했을 때(연결 끊김 등). */
export const BLOCKING_FINISH_NETWORK_MESSAGE = "연결이 불안정해 종료하지 못했습니다. 다시 눌러 주세요.";
/** 정리용 종료가 끝난 뒤 화면에 보일 한 줄. */
export function blockingFinishedNotice(className: string | null | undefined): string {
  const name = String(className ?? "").trim();
  return `${name ? `${name} 수업` : "그 수업"}을 종료했습니다. 이제 수업을 시작할 수 있습니다.`;
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
/** 안드로이드 스토어 앱 전용 — 로그인 확인 뒤 운행 링크 화면(/driver/열쇠)으로 보내는 길(앱은 /staff/run 을 막는다, 2026-11-16). */
export const DRIVER_APP_RUN_PATH = "/staff/run/open";

/** 기사님 운행 화면으로 갈 주소 — 안드로이드 스토어 앱이면 앱 위치 공유가 켜지는 길, 그 밖(브라우저)은 기존 운행표. */
export function driverRunPathFor(storeApp: boolean, userAgent: string | null | undefined): string {
  return storeApp && /android/i.test(String(userAgent ?? "")) ? DRIVER_APP_RUN_PATH : DRIVER_RUN_PATH;
}

/** 스토어 앱이 막지 않는 기사님 셔틀 화면(명단·승하차 체크). */
export const DRIVER_SHUTTLE_PATH = "/staff/shuttle";

/**
 * 기사님 첫 화면(/staff/driver)에 «운행 시작»을 눌러 왔다는 표시 — 셔틀 명단의 «운행 시작» 버튼만 붙인다(2026-11-18 원장 결정 F).
 * 표시 없이 온 경우(로그인 직후·앱을 다시 엶·/staff 에서 넘겨짐)는 운행 화면이 아니라 셔틀 명단으로 간다 —
 * 운행 화면에는 아래 메뉴·이름 메뉴가 없어, 첫 화면이 그곳이면 다른 화면으로 갈 길이 없었다.
 */
export const DRIVER_START_PARAM = "start";
export const DRIVER_START_HREF = `${DRIVER_ENTRY_PATH}?${DRIVER_START_PARAM}=1`;

/**
 * 기사님 첫 화면이 넘길 주소. 아이폰 스토어 앱 안내는 부르는 쪽이 먼저 가른다(shouldShowIosDriverNotice).
 *  - «운행 시작»을 눌러 왔으면: 운행 화면(안드로이드 스토어 앱은 위치 공유가 켜지는 앱 길, 그 밖은 운행표)
 *  - 그 밖(로그인 직후 등): 셔틀 명단 — 거기서 «운행 시작»을 눌러 운행 화면에 들어간다
 */
export function driverEntryTarget(startRun: boolean, storeApp: boolean, userAgent: string | null | undefined): string {
  return startRun ? driverRunPathFor(storeApp, userAgent) : DRIVER_SHUTTLE_PATH;
}

/**
 * 위치 기록이 이 시간(초) 안에 갱신됐으면 «운행 중»으로 본다 — 관리자·선생님의 «차량 현재 위치»가 쓰는 10분과 같다.
 */
export const DRIVER_RUN_ACTIVE_WINDOW_SECONDS = 600;

/**
 * 오늘 운행이 «진행 중»인가(순수 함수, 2026-11-18 F 보완).
 * 근거 = 고정 운행 링크의 위치 기록(DriverLocation) 한 줄: 위치 공유가 켜져 있고(sharing) 최근에 갱신됐을 때만.
 * 왜: 운행 중에 앱이 다시 켜지면 첫 화면이 명단이라, «운행 시작»을 다시 누르지 않고 체크만 하면 위치가 끊긴 채 달린다.
 *     진행 중이면 기사님 첫 화면이 예전처럼 운행 화면으로 바로 넘긴다. 줄이 없거나 값이 이상하면 «아님»(명단으로).
 * 경과 시간은 DB 시계(now() - updatedAt)로 잰 값을 받는다 — 서버·기기 시계를 쓰지 않는다.
 */
export function isDriverRunInProgress(
  row: { sharing?: unknown; secondsAgo?: unknown } | null | undefined,
  windowSeconds = DRIVER_RUN_ACTIVE_WINDOW_SECONDS,
): boolean {
  if (!row || row.sharing !== true) return false;
  const seconds = typeof row.secondsAgo === "bigint" ? Number(row.secondsAgo) : row.secondsAgo;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= windowSeconds;
}

/** «아직 운행 링크가 없습니다» 안내를 한 번 보이라는 탭 안 표시(sessionStorage) — 값은 남긴 시각(ms) */
export const SHUTTLE_NO_RUN_FLAG_KEY = "stiz:shuttle-no-run-notice:v1";
/** 그 표시가 살아 있는 시간 — 되돌아가는 한 번의 이동에만 쓰이게 짧게 */
export const SHUTTLE_NO_RUN_FLAG_TTL_MS = 10_000;

/** 표시가 아직 유효한가(순수 함수) */
export function isNoRunFlagFresh(raw: string | null | undefined, now: number, ttl = SHUTTLE_NO_RUN_FLAG_TTL_MS): boolean {
  if (!raw) return false;
  const at = Number(raw);
  return Number.isFinite(at) && now >= at && now - at <= ttl;
}

/**
 * 안내 표시를 달고 온 칸(?notice=no-run)을 «한 칸 뒤로» 접어도 되나(순수 함수, 2026-11-18).
 * «운행 시작»을 누르면 [명단] → [기사님 첫 화면 → 운행 링크 없음 → 명단?notice] 로 명단 칸이 둘이 되어 뒤로가 한 번 헛돈다.
 * 브라우저가 «바로 앞 칸이 같은 명단 화면»이라고 알려 줄 때만 접는다 — 모르면 접지 않는다(엉뚱한 곳으로 back 하지 않게).
 */
export function canCollapseNoRunEntry(previousPath: string | null | undefined): boolean {
  return previousPath === DRIVER_SHUTTLE_PATH;
}

/** 셔틀 명단 위에 «아직 운행 링크가 없습니다» 안내를 보이라는 쿼리(2026-11-18 원장 결정 G) */
export const SHUTTLE_NOTICE_PARAM = "notice";
export const SHUTTLE_NOTICE_NO_RUN = "no-run";

/**
 * 앱 길(/staff/run/open)에서 오늘 운행 열쇠가 없을 때 갈 주소(2026-11-17 뒤로 가기 조사 native #7).
 * 왜: 안드로이드 스토어 앱은 /staff/run 을 막고 «준비 중» 창만 띄운다 — 거기로 넘기면 화면이 «운행 화면을 여는 중…»에서 멈춘다.
 * 스토어 앱이면 앱이 여는 셔틀 화면으로, 브라우저는 «아직 운행 링크가 없습니다» 안내가 있는 운행표로 보낸다.
 * 2026-11-18: 셔틀 화면으로 보낼 때 안내 표시(?notice=no-run)를 싣는다 — 예전엔 아무 말 없이 명단만 보여 «운행 시작»이 안 먹은 것처럼 보였다.
 */
export function driverRunMissingKeyPath(storeApp: boolean): string {
  return storeApp ? `${DRIVER_SHUTTLE_PATH}?${SHUTTLE_NOTICE_PARAM}=${SHUTTLE_NOTICE_NO_RUN}` : DRIVER_RUN_PATH;
}

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

/**
 * 관리자 체험 관리 화면의 «선생님 출결» 배지(검수 LOW-4). 안 찍었거나 모르는 값이면 null(배지 없음).
 * 색은 출석부와 같은 약속: 출석=초록·지각=노랑·결석=빨강.
 */
export function trialStaffMarkBadge(mark: string | null | undefined): { label: string; tone: "success" | "warning" | "danger" } | null {
  if (mark === "PRESENT") return { label: "출석", tone: "success" };
  if (mark === "LATE") return { label: "지각", tone: "warning" };
  if (mark === "ABSENT") return { label: "결석", tone: "danger" };
  return null;
}

/** 서버가 일괄 출석 요청에서 체험 아이를 건너뛸 때 돌려주는 문구(검수 LOW-1). */
export const TRIAL_BULK_SKIPPED_MESSAGE = "체험 아이는 전체 출석에서 빠집니다. 그 줄에서 직접 눌러 주세요.";

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

// ── 부원장 금액 가림(2026-11-14 원장 결정) ─────────────────────────

/**
 * 직원 화면 금액을 «미납 청구 1건 금액만» 남기고 가려야 하는 역할인가 — 부원장(VICE_ADMIN)만.
 * 원장은 다 보고, 선생님(INSTRUCTOR)·기사님은 기존 동작(f3 — 출석부 금액은 아예 안 받음, 청구 탭은 그대로)을 바꾸지 않는다.
 */
export function staffMasksSettledAmounts(role: string | null | undefined): boolean {
  return role === "VICE_ADMIN";
}

/**
 * 직원 화면 청구 한 건의 금액을 역할에 맞게 가린다 — 부원장이면 미납(PENDING·OVERDUE)이 아닌 청구의
 * amount·invoiceAmount 를 null 로. 판정은 moneyAccess.canSeePaymentAmount 를 그대로 쓴다(규칙 한 곳).
 * statusKey = 결제 상태가 들어 있는 칸 이름(화면마다 status / paymentStatus 로 다르다).
 */
export function maskStaffBillAmounts<T extends { amount: number | null; invoiceAmount: number | null }>(
  item: T,
  role: string | null | undefined,
  paymentStatus: string | null | undefined,
): T {
  if (!staffMasksSettledAmounts(role) || canSeePaymentAmount(role, paymentStatus)) return item;
  return { ...item, amount: null, invoiceAmount: null };
}

/**
 * 출석부 월 수강료 요약 한 줄 — 부원장은 아직 안 낸 것(미납·납부 확인 대기)과 청구 미생성(예정 수강료 = 가격표 성격)만
 * 금액을 본다. 납부 완료·확인 필요·미확인 줄은 금액을 null 로(납부 완료는 화면 «—»). 선생님은 이 값을 아예 받지 않는다(f3).
 */
export function maskStaffMonthlyFeeAmount<T extends { amount: number | null; status: string }>(
  summary: T,
  role: string | null | undefined,
): T {
  if (!staffMasksSettledAmounts(role)) return summary;
  if (summary.status === "UNPAID" || summary.status === "PENDING_CONFIRMATION" || summary.status === "UNISSUED") return summary;
  return { ...summary, amount: null };
}

/**
 * 안드로이드 스토어 앱의 «운행 시작 한 번» 길(2026-11-20 원장 지시).
 * 셔틀 명단의 «운행 시작»을 눌러 온 운행 화면은 주소에 같은 표시(?start=1)를 달고 열려, 도착하자마자 위치 공유 동의 창을 띄운다.
 * 예전에는 운행 화면에서 «운행 시작»을 한 번 더 눌러야 해서, 첫 번째만 누르고 체크만 하면 위치가 나가지 않았다.
 */
export function driverAppRunHref(token: string): string {
  return `/driver/${token}?${DRIVER_START_PARAM}=1`;
}

/**
 * 운행 화면에 도착하자마자 위치 공유 시작을 요청할지(순수 함수).
 *  - 앱(네이티브) 위치 공유에서만: 시작 요청은 앱의 동의 창을 띄울 뿐이고, 동의·권한 허용은 기사님이 직접 누른다.
 *  - 앱이 «지금 운행 상태»를 한 번 알려 준 뒤에만(nativeReady): 이미 운행 중인데 동의 창을 또 띄우지 않게.
 *  - 앱이 알려 준 상태로 판단한다(화면이 따로 계산한 «운행 중/종료» 값이 아니라).
 *    어제 정상 종료한 휴대폰은 상태가 «종료됨(stopped)»으로 오는데, 그때도 오늘 운행은 시작해야 한다.
 *    서버 연결 중(requesting)·종료 처리 중(stopping)·종료 확인 대기(stop-unknown)에는 요청하지 않는다.
 *  - 한 화면에서 한 번만(기사님이 «운행 시작»을 직접 누른 뒤에도 다시 요청하지 않는다).
 */
export function shouldAutoStartRun(input: {
  autoStart: boolean;
  alreadyTried: boolean;
  gpsMode: string;
  nativeReady: boolean;
  nativeRunning: boolean;
  gpsState: string;
  transmission: string;
}): boolean {
  return input.autoStart && !input.alreadyTried && input.gpsMode === "native" && input.nativeReady && !input.nativeRunning
    && input.gpsState !== "requesting" && input.transmission !== "stopping" && input.transmission !== "stop-unknown";
}
