// 정규 수업 "사전 결석 신고"(#3 Step B)용 순수 로직.
// ⚠️ 순수 모듈 — 요일/날짜 계산과 사유 검증은 실수하기 쉬워 유닛 테스트로 고정한다.
//    import 는 마감 공용 규칙(changeDeadline, 그쪽은 import 0) 하나뿐이다.
// (방학특강 parentAbsenceRules 와 같은 역할이나, 정규는 "달력 날짜(YYYY-MM-DD)" 기준이다.)
import {
  ABSENCE_CUTOFF_MINUTES,
  CHANGE_CLOSED_MESSAGE,
  hmToMinutes as sharedHmToMinutes,
  isChangeOpen,
} from "@/lib/parent/changeDeadline";

// ── 결석 사유 5종(방학특강과 동일 집합) ────────────────────────────────────
export const VALID_REASONS = [
  "ILLNESS_INJURY",
  "PERSONAL",
  "FAMILY_TRIP",
  "SCHOOL_EVENT",
  "ETC",
] as const;

export type AbsenceReason = (typeof VALID_REASONS)[number];

export const REASON_LABEL: Record<string, string> = {
  ILLNESS_INJURY: "질병/부상",
  PERSONAL: "개인 사정",
  FAMILY_TRIP: "가족 여행",
  SCHOOL_EVENT: "학교 행사",
  ETC: "기타",
};

export function isValidReason(v: unknown): v is AbsenceReason {
  return typeof v === "string" && (VALID_REASONS as readonly string[]).includes(v);
}

// ── 요일 문자열("Mon" 등) ↔ 인덱스(0=일 ~ 6=토) ─────────────────────────────
// Class.dayOfWeek 는 "Mon","Tue"... 형식이다(enrollments.dayOfWeek 와 동일, summary.ts 참고).
export const DAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export const DAY_KO: string[] = ["일", "월", "화", "수", "목", "금", "토"];

// dayOfWeek 문자열 → 인덱스. 알 수 없으면 null.
export function dayIndexOf(dayOfWeek: string): number | null {
  const i = DAY_INDEX[dayOfWeek];
  return i == null ? null : i;
}

// ── 날짜(YYYY-MM-DD) 유틸 ─────────────────────────────────────────────────
// ⚠️ 타임존 영향을 없애려고 항상 UTC 자정으로 다뤄 순수·결정론적으로 계산한다.
//    (날짜만 다루므로 UTC 로 고정해도 요일/일수 계산은 정확하다.)
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(v: unknown): v is string {
  return typeof v === "string" && YMD_RE.test(v);
}

// YYYY-MM-DD → 그 날짜의 요일 인덱스(0=일 ~ 6=토). 형식 오류면 null.
export function ymdToDayIndex(ymd: string): number | null {
  if (!isYmd(ymd)) return null;
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

// YYYY-MM-DD 에 n일을 더한 새 날짜 문자열.
export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// a > b (a가 b보다 미래)인지. 둘 다 YYYY-MM-DD.
export function isFutureYmd(a: string, todayYmd: string): boolean {
  if (!isYmd(a) || !isYmd(todayYmd)) return false;
  return a > todayYmd; // ISO 날짜 문자열은 사전순 = 날짜순
}

// ── 신고·취소·사유 변경 마감 (2026-11-14 결석 당일 취소·보강 연결) ─────────────────
// 원장 요청: «결석 신고 후 취소나 변경 기능이 없어서 불편하다». 예전에는 수업 당일이면 목록에서
// 그 줄이 사라져 오늘 결석을 신고도 취소도 못 했다. 이제 «수업 시작 1시간 전»까지 받는다.
//
// ★ 화면·서버(신고·취소)·카카오 대화가 모두 이 함수 하나로 판정한다 — 한쪽만 다르면
//   «화면에는 버튼이 있는데 서버가 거절» 같은 어긋남이 생긴다.
// ★ 입력은 전부 KST 로 바꾼 «글자»다(날짜 YYYY-MM-DD, 시각 HH:mm). 이 함수는 시간대를 모른다 —
//   서버(UTC)에서도 PC(KST)에서도 같은 답이 나온다. «지금»은 호출부가 kst.ts 로 만들어 넘긴다.

// (2026-11-15 마감 통일·날짜 바꾸기) 판정 본문은 셔틀·보강과 함께 쓰는 @/lib/parent/changeDeadline 으로 옮겼다.
//   이 파일의 이름들은 그대로 남아 그쪽을 부르기만 한다 — 결석 쪽 호출부·테스트는 바뀌지 않는다.

/** 수업 시작 몇 분 전까지 신고·취소·사유 변경을 받는가 */
export const ABSENCE_CHANGE_CUTOFF_MINUTES = ABSENCE_CUTOFF_MINUTES;

/** 마감 뒤 학부모에게 보이는 글(화면·서버 오류 문구 공용 — 셔틀·보강 화면과 같은 글) */
export const ABSENCE_CHANGE_CLOSED_MESSAGE = CHANGE_CLOSED_MESSAGE;

/** "HH:mm"(또는 "H:mm", 뒤에 초가 붙어도 됨) → 자정부터의 분. 읽을 수 없으면 null. */
export const hmToMinutes = sharedHmToMinutes;

/**
 * 지금 이 수업의 결석을 신고·취소·사유 변경할 수 있는가.
 *
 * - 수업 시작 60분 전까지 열려 있다(정확히 60분 전 = 아직 가능, 59분 전 = 마감).
 * - 시작 시각을 알 수 없는 수업은 «당일 0시»를 마감으로 본다(= 전날까지만 가능).
 * - 지난 날짜는 항상 마감. 입력이 잘못되면 안전한 쪽(마감)으로 답한다.
 *
 * @param classYmd  수업 날짜(KST) "YYYY-MM-DD"
 * @param startTime 수업 시작 시각 "HH:mm" (모르면 null·빈 글자)
 * @param nowYmd    지금 날짜(KST) "YYYY-MM-DD"
 * @param nowHm     지금 시각(KST) "HH:mm"
 */
export function isAbsenceChangeOpen(
  classYmd: string,
  startTime: string | null | undefined,
  nowYmd: string,
  nowHm: string,
): boolean {
  // 얇은 껍데기 — 공용 마감 함수에 결석 마감(60분)을 넣어 부른다
  return isChangeOpen(classYmd, startTime, nowYmd, nowHm, ABSENCE_CHANGE_CUTOFF_MINUTES);
}

/**
 * 서버 재검증용: 그 반 요일과 맞는 날짜이고, 아직 마감 전인가.
 * (예전 isReportableDate 는 «내일 이후»만 받았다 — 오늘 수업도 1시간 전까지 받도록 이 함수로 바꿨다)
 */
export function isReportableAt(
  classYmd: string,
  dayOfWeek: string,
  startTime: string | null | undefined,
  nowYmd: string,
  nowHm: string,
): boolean {
  const target = dayIndexOf(dayOfWeek);
  const actual = ymdToDayIndex(classYmd);
  if (target == null || actual == null || target !== actual) return false;
  return isAbsenceChangeOpen(classYmd, startTime, nowYmd, nowHm);
}

// ── 다가오는 수업일 계산 ──────────────────────────────────────────────────
// 오늘(todayYmd) "이후"의, 해당 요일에 맞는 날짜를 최대 weeks개 생성한다.
// includeToday=true 이고 오늘이 그 요일이면 «오늘»을 맨 앞에 한 줄 더 붙인다(앞날 weeks개는 그대로).
//   (2026-11-14: 오늘 수업도 목록에 보여 1시간 전까지 신고·취소하게 — 마감 여부는 isAbsenceChangeOpen 이 따로 본다)
export function computeUpcomingDates(
  todayYmd: string,
  dayOfWeek: string,
  weeks: number,
  includeToday = false,
): string[] {
  if (!isYmd(todayYmd)) return [];
  const target = dayIndexOf(dayOfWeek);
  if (target == null) return [];
  const todayIdx = ymdToDayIndex(todayYmd);
  if (todayIdx == null) return [];

  // 오늘로부터 그 요일까지의 일수. 오늘(delta=0)은 앞날 목록에서 빼고 다음 주로 민다.
  let delta = (target - todayIdx + 7) % 7;
  const todayIsClassDay = delta === 0;
  if (delta === 0) delta = 7;

  const first = addDaysYmd(todayYmd, delta);
  const out: string[] = [];
  // 오늘 수업 — 요청한 경우에만 맨 앞에(주 수가 0이면 아무것도 만들지 않는다)
  if (includeToday && todayIsClassDay && weeks > 0) out.push(todayYmd);
  for (let i = 0; i < Math.max(0, weeks); i++) {
    out.push(addDaysYmd(first, i * 7));
  }
  return out;
}

// (미래 + 요일 일치) 날짜인지 — 날짜만 보는 옛 헬퍼(«내일 이후»만 true).
// ⚠️ 학부모 신고·취소의 서버 검증은 이 함수가 아니라 isReportableAt(오늘 수업 1시간 전까지)이다.
//    2026-11-14 부터 서버에서 쓰는 곳이 없다 — 날짜만으로 판정해야 하는 곳이 생기면 쓰도록 남겨 둔다.
export function isReportableDate(ymd: string, dayOfWeek: string, todayYmd: string): boolean {
  if (!isFutureYmd(ymd, todayYmd)) return false;
  const target = dayIndexOf(dayOfWeek);
  const actual = ymdToDayIndex(ymd);
  return target != null && actual != null && target === actual;
}
