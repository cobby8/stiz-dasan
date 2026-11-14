/**
 * 선생님이 «수업 기록»을 고칠 수 있는 기간과, 완료한 수업 다시 보기에 쓰는 순수 규칙 — 이 프로젝트의 한 창구
 * (2026-11-14 원장 지시 「선생님 화면에서 완료한 수업도 들어가면 내용을 볼 수 있고 수정할 수 있게」).
 *
 * 예전엔 «수업 당일 KST 자정까지»가 사진·영상·한 줄에 따로따로 적혀 있었고, 메모·출결은 «진행 중»만 받았다.
 * 이제 사진·영상·수업 한 줄·특이사항 메모·출결 정정·학부모에게 보내기가 **모두 판정 함수 하나**(staffSessionEditWindow)를 쓴다.
 *   - 선생님: 수업일을 포함해 STAFF_SESSION_EDIT_DAYS(7)일 동안. 수업일이 11/14 면 11/20 밤 자정까지.
 *   - 원장·부원장(unlimited): 기간 제한 없음.
 *   - 시작 전(PLANNED) 수업은 대상이 아니다(사진·영상은 «시작한 뒤», 한 줄은 feed/rules 가 «당일만»으로 따로 본다).
 *
 * 판정 함수의 몸통은 sessionVideo/rules.ts 에 있다 — 그 파일은 학부모 화면(feed/rules)도 함께 싣는 «의존 0» 순수 모듈이라,
 * 거기에 두어야 새 의존이 생기지 않는다. 선생님 화면·서버는 이 파일에서 가져다 쓴다(같은 함수의 다시 내보내기).
 *
 * ⚠️ 순수 모듈 — @/lib/datetime/kst · sessionVideo/rules 만 import 한다(prisma·next 금지). tests/staff-session-review.test.mjs 가 실제로 돌린다.
 *    날짜는 "YYYY-MM-DD"(KST) 글자로만 받는다. «오늘»은 호출부가 DB 시계(TODAY_KST_SQL)로 구해 넘긴다.
 */
import { diffDaysKst, isKstYmd } from "@/lib/datetime/kst";
import { STAFF_SESSION_EDIT_DAYS } from "@/lib/sessionVideo/rules";

export {
  STAFF_EDIT_EXPIRED_MESSAGE,
  STAFF_SESSION_EDIT_DAYS,
  staffSessionEditWindow,
  type SessionEditWindowInput,
  type SessionEditWindowReason,
  type SessionEditWindowResult,
} from "@/lib/sessionVideo/rules";

/** 선생님 «지난 수업» 목록에 보이는 날수(오늘 포함) */
export const STAFF_PAST_SESSION_LIST_DAYS = 14;
/** 완료한 수업을 고친 기록(OperationsAuditLog.action) */
export const STAFF_SESSION_REVIEW_AUDIT_ACTION = "STAFF_SESSION_REVIEW_EDIT";

/** 완료한 수업에서 선생님이 고칠 수 없는 줄(보강 온 아이·체험 아이·질병·부상 결석)에 보이는 말 */
export const STAFF_REVIEW_ASK_OWNER_MESSAGE = "완료한 수업의 보강·체험·질병·부상 결석 출결은 원장님께 요청해 주세요.";

/** 완료한 수업: 이미 예약·사용·불참 처리된 보강권이 걸린 결석을 출석·지각으로 고치려 할 때 */
export const STAFF_REVIEW_CREDIT_LOCKED_MESSAGE = "이 결석으로 나간 보강권이 이미 예약됐거나 사용돼 고칠 수 없습니다. 원장님께 요청해 주세요.";

/** 고칠 수 있는 마지막 날(KST) 안내 «수업 뒤 7일 동안» — 입력 칸 아래 한 줄 */
export const STAFF_EDIT_WINDOW_HINT = `수업 뒤 ${STAFF_SESSION_EDIT_DAYS}일 동안 고칠 수 있어요`;

// ── 완료한 수업의 출결 정정 ───────────────────────────────────────────

/** 출석부 한 줄의 종류 — 정규 수강생·특강 좌석·보강 온 아이·체험 아이 */
export type ReviewRosterKind = "REGULAR" | "SEASONAL" | "MAKEUP" | "TRIAL";

/**
 * 완료한 수업에서 선생님이 이 줄의 출결을 정정할 수 있는가.
 * 정규 수강생·특강 좌석만. 보강 온 아이는 보강 예약·보강권 «사용» 처리가 걸려 있고,
 * 체험 아이는 체험 단계(체험 완료 ↔ 일정 확정)가 걸려 있어 원장이 고친다.
 */
export function canCorrectAfterCompletion(kind: ReviewRosterKind): boolean {
  return kind === "REGULAR" || kind === "SEASONAL";
}

/**
 * 정정했을 때 보강권에 생기는 일 — REVOKE=안 쓴 권 회수 · KEEP_USED=이미 예약·사용·불참 처리된 권이 걸려 있음 ·
 * ISSUE=새로 나갈 수 있음(질병·부상 보류·정산된 결석이면 안 나간다) · NONE=변화 없음.
 * KEEP_USED 는 선생님이 고치지 못한다 — 서버가 정정을 거부하고 «원장님께 요청»을 돌려준다(진행 중 수업의 «다시 눌러 취소»가 같은 상황을 막는 것과 같다).
 */
export type CorrectionCreditEffect = "REVOKE" | "KEEP_USED" | "ISSUE" | "NONE";

/**
 * 정정 전에 미리 보는 보강권 영향(순수) — 실제 처리(syncMakeupCreditForAttendance)와 같은 규칙:
 *  - 결석 → 출석·지각: 안 쓴 권(AVAILABLE)만 회수, 예약·사용·불참(RESERVED·USED·NO_SHOW)은 그대로 남는다.
 *  - 출석·지각·미확인 → 결석: 이 결석의 권이 없거나 회수(REVOKED)된 것뿐이면 나간다. 이미 있으면 변화 없음.
 *  - 출석 ↔ 지각: 보강권과 무관.
 * @param creditStatuses 이 결석(같은 sourceKey)에 걸린 보강권 상태들
 */
export function correctionCreditEffect(input: {
  previousStatus: string | null;
  nextStatus: string;
  creditStatuses: readonly string[];
}): CorrectionCreditEffect {
  const wasAbsent = input.previousStatus === "ABSENT";
  const willBeAbsent = input.nextStatus === "ABSENT";
  if (wasAbsent === willBeAbsent) return "NONE";
  if (wasAbsent) {
    if (input.creditStatuses.includes("AVAILABLE")) return "REVOKE";
    return input.creditStatuses.some((status) => status === "RESERVED" || status === "USED" || status === "NO_SHOW") ? "KEEP_USED" : "NONE";
  }
  // 결석으로 바꿈 — 살아 있는 권(회수·소멸이 아닌 것)이 하나라도 있으면 새로 나가지 않는다
  return input.creditStatuses.every((status) => status === "REVOKED") ? "ISSUE" : "NONE";
}

const STATUS_WORD: Record<string, string> = { PRESENT: "출석", LATE: "지각", ABSENT: "결석" };

/** 정정 확인 창 문구 — «○○ 결석 → 출석으로 고칠까요?» + 보강권 한 줄(있을 때만) */
export function correctionConfirmMessage(input: {
  name: string;
  previousStatus: string | null;
  nextStatus: string;
  effect: CorrectionCreditEffect;
}): string {
  const from = input.previousStatus ? STATUS_WORD[input.previousStatus] ?? "미확인" : "미확인";
  const to = STATUS_WORD[input.nextStatus] ?? input.nextStatus;
  const head = `${input.name} ${from} → ${to}으로 고칠까요?`;
  if (input.effect === "REVOKE") return `${head}\n안 쓴 보강권은 회수돼요.`;
  if (input.effect === "KEEP_USED") return `${head}\n이미 쓴 보강권은 그대로 남아요.`;
  if (input.effect === "ISSUE") return `${head}\n결석 보강권이 나갈 수 있어요.`;
  return head;
}

// ── 지난 수업 목록 ────────────────────────────────────────────────────

export type PastSessionRow = {
  sessionId: string;
  /** 수업일(KST "YYYY-MM-DD") */
  ymd: string;
  className: string;
  startTime: string;
  endTime: string;
  seasonal: boolean;
  presentCount: number;
  absentCount: number;
  /** 한 줄·사진·영상 중 하나라도 있는가 */
  hasFeed: boolean;
  published: boolean;
};

/** 날짜 묶음(최근 날짜 먼저, 같은 날은 시작 시간 순) — 목록 화면이 그대로 그린다 */
export function groupPastSessions(rows: readonly PastSessionRow[]): Array<{ ymd: string; rows: PastSessionRow[] }> {
  const sorted = [...rows].filter((row) => isKstYmd(row.ymd)).sort((a, b) =>
    a.ymd !== b.ymd ? (a.ymd < b.ymd ? 1 : -1) : a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className));
  const groups: Array<{ ymd: string; rows: PastSessionRow[] }> = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.ymd === row.ymd) last.rows.push(row);
    else groups.push({ ymd: row.ymd, rows: [row] });
  }
  return groups;
}

/** 목록에 보일 날짜인가 — 오늘 포함 최근 STAFF_PAST_SESSION_LIST_DAYS 일(순수판, SQL 조건과 같은 뜻) */
export function inPastSessionListRange(sessionYmd: string, todayYmd: string): boolean {
  const days = diffDaysKst(sessionYmd, todayYmd);
  return Number.isFinite(days) && days >= 0 && days < STAFF_PAST_SESSION_LIST_DAYS;
}
