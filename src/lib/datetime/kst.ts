/**
 * 한국시간(KST) 날짜 계산 — **이 프로젝트의 유일한 창구**.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 왜 한 곳에 모으는가 — 실제로 세 번 터졌다
 * ─────────────────────────────────────────────────────────────────────────
 * 배포된 서버(Vercel)는 **UTC** 로 돌고 개발 PC 는 **KST** 로 돈다. 그래서 시간대를
 * 잘못 다룬 코드는 **로컬에서는 멀쩡하고 배포하면 틀린다.** 테스트도 빌드도 통과한다.
 * 이 유형은 눈으로 읽어서 절대 못 찾는다 — 반드시 실행해서 확인해야 한다.
 *
 * ■ 함정 1 — `T00:00:00+09:00` 에 `getUTC*` 를 쓰면 **하루 밀린다**
 *     new Date("2026-08-14T00:00:00+09:00")  // = 2026-08-13T15:00Z
 *       .getUTCDay()                          // → 4(목).  실제로는 금요일이다.
 *   ⚠️ 무서운 점: **`T12:00:00+09:00` 은 우연히 맞는다**(= 03:00Z, 같은 날).
 *      똑같이 생긴 코드가 시각 리터럴 하나로 갈려서, 옆 파일을 보고 따라 쓰면 터진다.
 *      2026-08-12 실측: 방학특강 보강에서 금요일 반의 추천 날짜가 토요일로 나가고 있었다.
 *
 * ■ 함정 2 — `new Date().toISOString().slice(0,10)` 은 "오늘"이 아니다
 *   UTC 날짜다. KST 00:00~09:00 사이에는 **어제 날짜**가 나온다.
 *   새벽에 출석부를 열면 전날 출석부가 뜬다.
 *
 * ■ 함정 3 — `getDay() / getDate() / getHours()` 는 **서버 시간대**를 따른다
 *   로컬(KST)에서는 맞고 Vercel(UTC)에서는 9시간 어긋난다. 가장 늦게 발견된다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 규칙
 * ─────────────────────────────────────────────────────────────────────────
 *  1. 날짜는 **"YYYY-MM-DD" 문자열**로 들고 다닌다. Date 객체는 계산에만 쓰고 저장하지 않는다.
 *  2. 달력 값(오늘·요일·날짜 더하기)이 필요하면 **이 모듈만** 쓴다. 각 파일에서 새로 만들지 않는다.
 *  3. DB 쪽 판정은 SQL 에서 `AT TIME ZONE 'Asia/Seoul'` 로 한다. 서버 시계를 믿지 않는다.
 *  4. `Date.prototype.getDay/getDate/getMonth/getHours` 는 쓰지 않는다.
 *  5. 새 헬퍼가 필요하면 여기에 추가하고 테스트를 함께 붙인다.
 */

export const KST = "Asia/Seoul";

const DAY_MS = 86_400_000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const YMD_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit",
});

/** 어떤 시각이든 KST 달력 날짜("YYYY-MM-DD")로. */
export function toKstYmd(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return YMD_FORMAT.format(d);
}

/**
 * 오늘(KST). "오늘"은 반드시 이걸로 구한다.
 * 🚫 `new Date().toISOString().slice(0,10)` 은 UTC 날짜라 새벽에 어제가 나온다.
 */
export function todayKst(nowMs: number = Date.now()): string {
  return toKstYmd(nowMs);
}

/** 달력 날짜 형식인지 + 실재하는 날짜인지. (2026-02-30 은 false) */
export function isKstYmd(ymd: unknown): boolean {
  const m = YMD_RE.exec(String(ymd ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * KST 달력 날짜의 요일. 0=일 … 6=토. 잘못된 입력은 NaN.
 * 🚫 `new Date(ymd + "T00:00:00+09:00").getUTCDay()` 로 구하지 말 것 — 하루 밀린다.
 *    여기서는 시간대를 아예 개입시키지 않고 **달력 숫자 그대로** 만든다.
 */
export function kstDow(ymd: string): number {
  const m = YMD_RE.exec(String(ymd ?? ""));
  if (!m) return NaN;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/**
 * KST 달력 날짜(+선택적 "HH:MM")의 절대 시각(ms).
 * 시각을 생략하면 그 날 KST 자정. 시각 비교는 반드시 이걸 거쳐서 한다.
 */
export function kstAt(ymd: string, hhmm?: string | null): number {
  if (!isKstYmd(ymd)) return NaN;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ""));
  const time = m ? `${m[1].padStart(2, "0")}:${m[2]}:00` : "00:00:00";
  return new Date(`${ymd}T${time}+09:00`).getTime();
}

/** KST 달력 기준으로 날짜 더하기/빼기. 시간대 이동 없이 달력만 센다. */
export function addDaysKst(ymd: string, days: number): string {
  if (!isKstYmd(ymd)) return "";
  // 정오를 기준점으로 삼아 어떤 오차가 끼어도 날짜가 넘어가지 않게 한다.
  return toKstYmd(new Date(`${ymd}T12:00:00+09:00`).getTime() + days * DAY_MS);
}

/** 두 KST 달력 날짜 사이의 일수(뒤 - 앞). */
export function diffDaysKst(fromYmd: string, toYmd: string): number {
  if (!isKstYmd(fromYmd) || !isKstYmd(toYmd)) return NaN;
  return Math.round((kstAt(toYmd) - kstAt(fromYmd)) / DAY_MS);
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** "8/14(금)" — 화면 표시용. */
export function kstLabel(value: Date | string | number): string {
  const ymd = typeof value === "string" && isKstYmd(value) ? value : toKstYmd(value);
  if (!isKstYmd(ymd)) return "";
  const m = YMD_RE.exec(ymd)!;
  return `${Number(m[2])}/${Number(m[3])}(${DOW_KO[kstDow(ymd)]})`;
}

// 24시간제 "HH:MM". hourCycle 을 못 박아야 자정이 "24:05" 로 나오는 엔진 차이를 피한다.
const HM_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: KST, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** 어떤 시각이든 KST 시각 "HH:MM"(24시간제)으로. 잘못된 입력은 "". */
export function kstHm(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return HM_FORMAT.format(d);
}

/** 공개 화면의 게시일. 서버·휴대폰 시간대가 달라도 같은 한국 날짜를 표시한다. */
export function formatKstDate(
  value: Date | string | number | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric" },
  fallback = "날짜 확인 중",
): string {
  if (value === null || value === undefined || value === "") return fallback;
  let input: Date | string | number = value;
  if (typeof value === "string") {
    const civil = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    if (!civil || !isKstYmd(civil[1])) return fallback;
    // 날짜만 있거나 시간대가 없는 공개 값도 한국 달력 기준으로 읽는다.
    input = value === civil[1] ? `${value}T00:00:00+09:00`
      : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+09:00`;
  }
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) return fallback;
  return new Intl.DateTimeFormat("ko-KR", { ...options, timeZone: KST }).format(date);
}

/** 한국 현재 월부터 이어지는 월 선택 표시. 해외 기기의 전월·전년도 노출을 막는다. */
export function kstMonthLabels(nowMs: number = Date.now(), count = 2): string[] {
  const ymd = todayKst(nowMs);
  if (!ymd) return [];
  const [year, month] = ymd.split("-").map(Number);
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, offset) => {
    const index = month - 1 + offset;
    return `${year + Math.floor(index / 12)}년 ${index % 12 + 1}월`;
  });
}
