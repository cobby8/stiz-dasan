/**
 * 학부모 «신청 바꾸기» 마감 — 결석 신고·셔틀 당일 변경·보강 예약이 함께 쓰는 한 곳(2026-11-15 마감 통일·날짜 바꾸기).
 *
 * 왜 한 곳인가: 세 기능의 마감이 제각각이었다.
 *   결석은 수업 1시간 전까지 서버가 막았지만, 셔틀은 지난 날짜·운행 뒤에도 취소가 됐고,
 *   보강은 저장된 시각(관리자 예약은 UTC 자정)에 따라 당일 오전 9시까지 취소되기도 했다.
 *   화면·서버·카카오 대화가 모두 이 파일의 함수로 판정한다 — 한쪽만 다르면 «버튼은 있는데 서버가 거절»이 된다.
 *
 * ★ 2026-11-15 마감 1시간 전 통일(원장 결정 «학부모 마감은 수업시작 한시간전으로 하자. 보강도 마찬가지야»):
 *   결석·셔틀(등원·하원·둘 다)·보강(예약·취소·날짜 바꾸기) 모두 «수업 시작 60분 전»까지다.
 *   셔틀은 그 학생이 그 날짜에 듣는 반의 가장 이른 시작 시각, 보강은 보강 가는 반의 시작 시각이 기준이다.
 *   기준 시각을 모르면(그 날짜에 수업이 없는 셔틀·시작 시각이 비어 있는 반) «전날까지»다.
 *   ※ 관리자가 대신 넣는 셔틀 변경(admin-shuttle-exception)은 이 마감을 적용하지 않는다.
 *
 * ★ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 그대로 올려 실행한다).
 * ★ 입력은 전부 KST 로 바꾼 «글자»다(날짜 "YYYY-MM-DD", 시각 "HH:mm"). 이 함수들은 시간대를 모른다 —
 *   서버(UTC)에서도 PC(KST)에서도 같은 답이 나온다. «지금»은 호출부가 kst.ts 로 만들어 넘긴다.
 */

/** 학부모 마감: 수업 시작 몇 분 전까지 — 결석·셔틀·보강 공통. 원장 결정이 바뀌면 이 한 줄만 고친다. */
export const PARENT_CHANGE_CUTOFF_MINUTES = 60;
/** 기능별 이름(값은 위 한 줄을 따른다 — 따로 숫자를 적지 않는다) */
export const ABSENCE_CUTOFF_MINUTES = PARENT_CHANGE_CUTOFF_MINUTES;
export const SHUTTLE_CUTOFF_MINUTES = PARENT_CHANGE_CUTOFF_MINUTES;
export const MAKEUP_CUTOFF_MINUTES = PARENT_CHANGE_CUTOFF_MINUTES;

/** 안내 글에 쓰는 마감 글자: 60 → «1시간», 90 → «90분»(상수를 바꾸면 화면·카카오 안내도 같이 바뀐다) */
export const PARENT_CHANGE_CUTOFF_TEXT =
  PARENT_CHANGE_CUTOFF_MINUTES % 60 === 0 ? `${PARENT_CHANGE_CUTOFF_MINUTES / 60}시간` : `${PARENT_CHANGE_CUTOFF_MINUTES}분`;

/** 마감 뒤 학부모에게 보이는 글(세 화면·서버 오류 문구 공용) */
export const CHANGE_CLOSED_MESSAGE = "마감 시간이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요.";
/** 이미 지난 보강 */
export const MAKEUP_PAST_MESSAGE = "이미 지난 보강은 취소할 수 없습니다. 학원으로 문의해 주세요.";

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" → 그 날짜 0시의 일련 번호(ms, 시간대 없음). 형식이 틀리거나 없는 날짜(2/30)면 null. */
function ymdToDayMs(ymd: unknown): number | null {
  const m = YMD_RE.exec(typeof ymd === "string" ? ymd : "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 달력 숫자만으로 만든다 — 시간대가 끼어들 자리가 없다
  const ms = Date.UTC(y, mo - 1, d);
  const probe = new Date(ms);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return ms;
}

/** 두 날짜 사이의 일수(대상 − 지금). 입력이 틀리면 null. */
function dayDiff(targetYmd: unknown, nowYmd: unknown): number | null {
  const target = ymdToDayMs(targetYmd);
  const now = ymdToDayMs(nowYmd);
  if (target == null || now == null) return null;
  return Math.round((target - now) / 86_400_000);
}

/** "HH:mm"(또는 "H:mm", 뒤에 초가 붙어도 됨) → 자정부터의 분. 읽을 수 없으면 null. */
export function hmToMinutes(hm: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(typeof hm === "string" ? hm.trim() : "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 지금 그 날짜의 신청을 바꿀 수 있는가(신청·취소·변경·날짜 바꾸기 공용).
 *
 * - 시작 시각의 cutoffMinutes 분 전까지 열려 있다(정확히 그 시각 = 아직 가능, 1분 지나면 마감).
 * - 수업이 시작된 뒤에는 항상 마감이다(cutoffMinutes 가 0 이어도 시작 시각 정각부터 닫힌다).
 * - 시작 시각을 모르면 «당일 0시»가 마감 = 전날까지만 가능.
 * - 지난 날짜는 항상 마감. 입력이 잘못되면 안전한 쪽(마감)으로 답한다.
 *
 * @param targetYmd     대상 날짜(KST) "YYYY-MM-DD"
 * @param startTime     기준 시작 시각 "HH:mm" (모르면 null·빈 글자)
 * @param nowYmd        지금 날짜(KST) "YYYY-MM-DD"
 * @param nowHm         지금 시각(KST) "HH:mm"
 * @param cutoffMinutes 시작 몇 분 전에 마감하는가(0 이상)
 */
export function isChangeOpen(
  targetYmd: string,
  startTime: string | null | undefined,
  nowYmd: string,
  nowHm: string,
  cutoffMinutes: number,
): boolean {
  const days = dayDiff(targetYmd, nowYmd);
  if (days == null || days < 0) return false;
  const nowMin = hmToMinutes(nowHm);
  if (nowMin == null) return false;
  if (!Number.isFinite(cutoffMinutes) || cutoffMinutes < 0) return false;
  const startMin = hmToMinutes(startTime);
  // 시작 시각을 모르면 그 날짜 0시가 마감 — 지금이 그 전날 이전이어야 한다
  if (startMin == null) return days > 0;
  // 지금부터 시작까지 남은 분(자정을 넘어가는 경우도 같은 식으로 계산된다)
  const minutesUntilStart = days * 1440 + startMin - nowMin;
  return minutesUntilStart > 0 && minutesUntilStart >= cutoffMinutes;
}

// ── 셔틀 당일 변경 ─────────────────────────────────────────────────────────────

/** 여러 시작 시각 중 가장 이른 것("HH:mm" 그대로). 읽을 수 있는 시각이 하나도 없으면 null. */
export function earliestStartTime(startTimes: readonly (string | null | undefined)[]): string | null {
  let best: { minutes: number; text: string } | null = null;
  for (const text of startTimes) {
    const minutes = hmToMinutes(text);
    if (minutes == null) continue;
    if (!best || minutes < best.minutes) best = { minutes, text: String(text).trim() };
  }
  return best ? best.text : null;
}

/**
 * 지금 그 날짜의 셔틀 변경을 (학부모가) 신청·취소·옮길 수 있는가 — 등원·하원·둘 다 모두 같은 마감이다.
 *
 * 기준 시각 = 그 학생이 그 날짜(요일)에 듣는 반들의 가장 이른 시작 시각(호출부가 골라 넘긴다).
 * 그 날짜에 수업이 없거나 시각을 모르면 «전날까지»(당일 닫힘). 지난 날짜는 항상 닫힘.
 */
export function isShuttleChangeOpen(
  serviceYmd: string,
  classStartTimes: readonly (string | null | undefined)[],
  nowYmd: string,
  nowHm: string,
): boolean {
  return isChangeOpen(serviceYmd, earliestStartTime(classStartTimes), nowYmd, nowHm, SHUTTLE_CUTOFF_MINUTES);
}

// ── 보강 예약 ─────────────────────────────────────────────────────────────────

/**
 * 보강 예약을 지금 잡거나·취소하거나·옮길 수 있는가 = 보강 수업 시작 1시간 전까지(당일도 그 전이면 된다).
 *
 * ★ 날짜는 저장된 «시각»이 아니라 «KST 달력 날짜 글자»로 받는다. 학부모 예약은 KST 자정,
 *   관리자 예약은 UTC 자정(= KST 09:00)으로 저장돼 있어 저장 시각으로 비교하면 같은 날 보강인데 마감이 9시간 달랐다.
 *   시각은 보강 가는 반의 시작 시각(Class.startTime)을 쓴다 — 모르면 전날까지.
 */
export function isMakeupChangeOpen(
  makeupYmd: string | null | undefined,
  classStartTime: string | null | undefined,
  nowYmd: string,
  nowHm: string,
): boolean {
  return isChangeOpen(String(makeupYmd ?? ""), classStartTime, nowYmd, nowHm, MAKEUP_CUTOFF_MINUTES);
}

/** 보강을 바꿀 수 없을 때의 글: 지난 날짜면 «지난 보강» 글, 아니면(당일 마감 뒤) 공통 마감 글 */
export function makeupClosedMessage(makeupYmd: string | null | undefined, nowYmd: string): string {
  const days = dayDiff(makeupYmd, nowYmd);
  return days != null && days < 0 ? MAKEUP_PAST_MESSAGE : CHANGE_CLOSED_MESSAGE;
}
