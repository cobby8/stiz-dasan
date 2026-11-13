// 보강권 규칙 — 부수효과·DB 접근이 전혀 없는 순수 모듈.
//
// 왜 따로 떼는가(dispatchReconcile.ts 와 같은 이유):
//   보강권은 학부모의 권리이고 돈과 직결된다. 만료를 하루 잘못 계산하면
//   "쓸 수 있던 보강권이 사라졌다"는 분쟁이 된다. node --test 로 실제 돌려 보고
//   검증할 수 있어야 해서, DB에 붙지 않은 순수 함수로 분리한다.
//
// 근거 — 2026-08-09 개정 이용약관 「수업의 보강」
//   · 결석 1회당 보강권 1회 발급
//   · 결석이 발생한 날로부터 2개월 이내 사용, 지나면 자동 소멸
//   · 예약 후 무단 불참 시 사용한 것으로 처리
//   · 미리 취소하면 보강권 유지
//   · 학년이 맞는 다른 수업, 정원 +2 까지

export type MakeupSourceType = "REGULAR" | "SEASONAL";

export type MakeupCreditStatus =
  | "AVAILABLE" // 사용 가능
  | "RESERVED"  // 보강 예약됨
  | "USED"      // 참석 완료
  | "NO_SHOW"   // 무단 불참 — 약관상 사용한 것으로 처리
  | "EXPIRED"   // 2개월 경과 소멸
  | "REVOKED";  // 결석이 취소되어 회수

/** 아직 쓸 수 있는(잔여로 세는) 상태. */
export const OPEN_STATUSES: MakeupCreditStatus[] = ["AVAILABLE", "RESERVED"];

/** 이미 소진되어 되돌릴 수 없는 상태. */
export const CLOSED_STATUSES: MakeupCreditStatus[] = ["USED", "NO_SHOW", "EXPIRED", "REVOKED"];

/**
 * 중복 발급 방지용 자연키.
 *
 * 출결을 결석→출석→결석으로 여러 번 바꿔도 **한 결석에 보강권은 한 장**이어야 한다.
 * 이 키에 유니크 인덱스가 걸려 있어 DB가 최종 방어선 역할을 한다.
 */
export function makeSourceKey(input:
  | { sourceType: "REGULAR"; classId: string; absenceYmd: string }
  | { sourceType: "SEASONAL"; enrollmentDateId: string },
): string {
  if (input.sourceType === "REGULAR") return `REGULAR:${input.classId}:${input.absenceYmd}`;
  return `SEASONAL:${input.enrollmentDateId}`;
}

/**
 * 만료 시각 — **결석일로부터** 2개월. 발급일이 아니다.
 *
 * 약관이 "결석이 발생한 날로부터 2개월"이라고 못 박고 있다. 출결을 늦게 입력했다고
 * 학부모가 손해 보거나 이득 보면 안 되므로 발급 시점과 무관하게 결석일로 계산한다.
 *
 * 말일 보정: 12/31 결석 → 2/31 은 없으므로 2월 말일로 맞춘다(JS Date 는 3/3 으로 넘어간다).
 */
export function calcExpiry(absenceDate: Date, months = 2): Date {
  const d = new Date(absenceDate.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);                       // 말일 넘침 방지: 먼저 1일로
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** 그 시점에 만료됐는가. 경계(정확히 같은 순간)는 아직 유효로 본다 — 학부모에게 유리하게. */
export function isExpired(credit: { expiresAt: Date; status: MakeupCreditStatus }, now: Date): boolean {
  if (CLOSED_STATUSES.includes(credit.status)) return false; // 이미 끝난 건 만료 대상이 아니다
  return credit.expiresAt.getTime() < now.getTime();
}

/** 지금 예약에 쓸 수 있는가. */
export function isUsable(credit: { expiresAt: Date; status: MakeupCreditStatus }, now: Date): boolean {
  return credit.status === "AVAILABLE" && !isExpired(credit, now);
}

export type CreditCounts = { available: number; reserved: number; used: number; expired: number };

/** 학부모 화면에 보여줄 잔여 집계. 만료가 아직 반영 안 된 건도 지금 시점으로 판정한다. */
export function summarize(
  credits: { expiresAt: Date; status: MakeupCreditStatus }[],
  now: Date,
): CreditCounts {
  const out: CreditCounts = { available: 0, reserved: 0, used: 0, expired: 0 };
  for (const c of credits) {
    if (c.status === "USED" || c.status === "NO_SHOW") out.used++;
    else if (c.status === "EXPIRED" || c.status === "REVOKED") out.expired++;
    else if (isExpired(c, now)) out.expired++;   // 크론이 아직 안 돌았어도 화면엔 만료로 보인다
    else if (c.status === "RESERVED") out.reserved++;
    else out.available++;
  }
  return out;
}

export type ClassCandidate = {
  classId: string;
  className: string;
  dayOfWeek: string;
  startTime: string;
  /** 시간표에 등록된 수업별 학년 구성. 예: ["초4","초5","초6","중1"] */
  grades: string[];
  /** 학년 구성이 비어 있을 때 보조로 읽는 대상 학년 글자. 예: "초4~중1" (시간표·직접 만든 슬롯의 gradeRange) */
  gradeRangeText?: string | null;
  capacity: number;
  /** 정규 수강생 수 */
  enrolled: number;
  /** 이미 잡힌 보강 예약 수 */
  booked: number;
};

/**
 * 학생 학년 표기를 시간표 학년 구성("초5")과 같은 형태로 맞춘다.
 *
 * 대부분 이미 "초5"·"중1" 로 들어 있지만, 손으로 입력하다 "5학년" 처럼 남은 값이 있다.
 * (2026-08-09 실측: 전체 316명 중 "4학년"·"5학년" 2명) 그대로 두면 이 학생들만
 * 추천이 0건이 되어 "우리 애는 왜 예약이 안 되냐"는 문의가 된다.
 * 초등 표기가 생략된 "N학년"은 초등으로 본다 — 중·고는 늘 "중1"처럼 붙여 쓴다.
 */
export function normalizeGrade(raw: string | null | undefined): string {
  const g = (raw ?? "").replace(/\s+/g, "");
  if (!g) return "";
  const m = /^(\d)학년$/.exec(g);
  if (m) return `초${m[1]}`;
  return g;
}

// ── 학년을 숫자로 (2026-11-14 결석 당일 취소·보강 연결) ─────────────────────────────
// 원장 요청: «지금 수강하는 반과 학년대가 비슷한 반 중 선택해서 보강할 수 있어야 하는데 연결이 아예 안 돼».
// 예전에는 학생 학년 글자("초5")가 반의 학년 구성에 «글자까지 똑같이» 들어 있어야 후보가 됐다.
// 그래서 표기가 조금만 달라도("초등5학년"), 한 학년만 벗어나도 후보가 0건이었다.
// 이제 학년을 숫자로 바꿔 «반의 대상 학년 범위 ±1학년» 안이면 후보로 본다.
//
//   7세=0 · 초1=1 … 초6=6 · 중1=7 … 중3=9 · 고1=10 … 고3=12  (6세=-1, 5세=-2)
//   성인·빈 값·모르는 표기 = null(후보를 만들지 않는다 — 임의 배정 금지)

/** 한 자리 숫자만(앞뒤에 다른 숫자가 붙지 않은) — "2026" 같은 연도 숫자를 학년으로 읽지 않는다 */
const STAGE_BASE: Record<string, number> = { 초: 0, 중: 6, 고: 9 };
const STAGE_MAX: Record<string, number> = { 초: 6, 중: 3, 고: 3 };

/** 공백과 «2026년» 같은 연도 표기를 걷어낸다 */
function cleanGradeText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").replace(/\d{4}년(도)?/g, "");
}

function stageNumber(stage: string, n: number): number | null {
  if (!(stage in STAGE_BASE) || n < 1 || n > STAGE_MAX[stage]) return null;
  return STAGE_BASE[stage] + n;
}

/**
 * 학년 표기 하나 → 숫자. 읽을 수 없으면 null.
 * "초5"·"초등5"·"초등5학년"·"초등 5학년"·"초등학교 5학년"·"2026년 초등 5학년"·"5학년"(초등으로 본다)·
 * "중1"·"중학교 1학년"·"고1"·"7세" 를 읽는다. "성인"·"대학생"·빈 값은 null.
 */
export function gradeToNumber(raw: string | null | undefined): number | null {
  const g = cleanGradeText(raw);
  if (!g) return null;
  let m = /^([5-7])세$/.exec(g);
  if (m) return Number(m[1]) - 7;
  m = /^(초|중|고)(?:등학교|등|학교)?(\d)(?:학년)?$/.exec(g);
  if (m) return stageNumber(m[1], Number(m[2]));
  // 초등 표기가 생략된 "N학년"은 초등으로 본다 — 중·고는 늘 "중1"처럼 붙여 쓴다(normalizeGrade 와 같은 기준)
  m = /^(\d)학년$/.exec(g);
  if (m) return stageNumber("초", Number(m[1]));
  return null;
}

/** 반의 대상 학년 범위(숫자, 양 끝 포함) */
export type GradeSpan = { min: number; max: number };

/**
 * 대상 학년 글자("초4~중1", "초4~6", "7세, 초1·초2") → 그 안에서 읽힌 학년들의 숫자 목록.
 * "초4~6"처럼 뒤쪽에 단계가 생략되면 앞의 단계를 이어받는다.
 * 숫자가 없는 자유 문장("초등저~고 (일부 중학생 가능)")은 빈 목록 — 절대 짐작하지 않는다.
 */
export function gradeNumbersInText(raw: string | null | undefined): number[] {
  const text = cleanGradeText(raw);
  const out: number[] = [];
  let lastStage: string | null = null;
  const re = /(초|중|고)?(?:등학교|등|학교)?(?<!\d)(\d)(?!\d)(세|학년)?/g;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]);
    if (m[3] === "세") {
      if (n >= 5 && n <= 7) out.push(n - 7);
      lastStage = null;
      continue;
    }
    // 단계가 적혀 있으면 그것, 없으면 바로 앞 학년의 단계, 그것도 없고 "N학년"이면 초등
    const stage: string | null = m[1] ?? lastStage ?? (m[3] === "학년" ? "초" : null);
    if (!stage) continue;
    const value = stageNumber(stage, n);
    if (value == null) continue;
    out.push(value);
    lastStage = stage;
  }
  return out;
}

/**
 * 반의 대상 학년 범위. 학년 구성 목록(gradesJSON)을 먼저 쓰고, 비어 있으면 대상 학년 글자를 보조로 읽는다.
 * 둘 다 읽을 수 없으면 null — 그 반은 후보에서 뺀다(학년을 모르는 반에 학생을 보내지 않는다).
 */
export function classGradeSpan(grades: string[], gradeRangeText?: string | null): GradeSpan | null {
  let nums = grades.map((g) => gradeToNumber(g)).filter((n): n is number => n != null);
  if (nums.length === 0) nums = gradeNumbersInText(gradeRangeText);
  if (nums.length === 0) return null;
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** 학년대가 비슷하다고 보는 폭 — 반의 대상 학년 범위에서 위아래 1학년까지 */
export const MAKEUP_GRADE_TOLERANCE = 1;

/** 학생 학년(숫자)이 반의 대상 학년 범위 ±1 안인가 */
export function isGradeNear(studentGrade: number | null, span: GradeSpan | null, tolerance = MAKEUP_GRADE_TOLERANCE): boolean {
  if (studentGrade == null || !span) return false;
  return studentGrade >= span.min - tolerance && studentGrade <= span.max + tolerance;
}

/**
 * 학년대가 비슷한 반만 고른다(자리·날짜는 아직 보지 않는다).
 * 빼는 반: 원래 결석한 반(excludeClassId) · 그 학생이 이미 다니는 반(excludeClassIds) · 학년 정보가 없는 반.
 * 학생 학년을 모르면 빈 목록.
 */
export function matchClassesByGrade<T extends Pick<ClassCandidate, "classId" | "grades" | "gradeRangeText">>(
  candidates: T[],
  studentGrade: string | null | undefined,
  opts: { excludeClassId?: string | null; excludeClassIds?: readonly string[] } = {},
): T[] {
  const grade = gradeToNumber(studentGrade);
  if (grade == null) return [];
  const excluded = new Set<string>(opts.excludeClassIds ?? []);
  if (opts.excludeClassId) excluded.add(opts.excludeClassId);
  return candidates
    .filter((c) => !excluded.has(c.classId))
    .filter((c) => isGradeNear(grade, classGradeSpan(c.grades, c.gradeRangeText)));
}

/**
 * 날짜별 남은 자리 — 이미 잡힌 보강은 «그 날짜 것만» 센다.
 * 예전에는 반 전체의 보강 예약 수를 날짜 구분 없이 세어, 다른 주에 예약이 몇 건 있으면 빈 날까지 마감으로 보였다.
 * (관리자 쪽 정원 검사 assertMakeupSeatAvailable 도 날짜별로 센다)
 *
 * @param bookedByYmd 그 반의 날짜("YYYY-MM-DD")별 보강 예약 수. 없는 날짜는 0.
 * @returns 날짜마다 남은 자리(0 이하 = 마감). 호출부가 마감된 날짜만 뺀다.
 */
export function remainingSeatsByDate(
  c: Pick<ClassCandidate, "capacity" | "enrolled">,
  dateYmds: readonly string[],
  bookedByYmd: Readonly<Record<string, number>> | ReadonlyMap<string, number>,
): { ymd: string; remaining: number }[] {
  const bookedOn = (ymd: string): number => {
    const v = bookedByYmd instanceof Map ? bookedByYmd.get(ymd) : (bookedByYmd as Record<string, number>)[ymd];
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return dateYmds.map((ymd) => ({ ymd, remaining: remainingSeats({ capacity: c.capacity, enrolled: c.enrolled, booked: bookedOn(ymd) }) }));
}

/** 후보가 0건일 때의 이유 — 화면이 이유를 나눠 보인다 */
export type MakeupEmptyReason =
  | "NO_GRADE"  // 학생 학년 정보가 없다 → 학원으로 문의
  | "NO_MATCH"  // 학년대가 맞는 반이 없다
  | "NO_DATE"   // 맞는 반은 있지만 사용 기한 안에 열리는 날이 없다
  | "FULL";     // 맞는 반·날짜는 있지만 모두 자리가 없다

/** 보강은 정원 +2 까지 받는다(2026-08-09 개정 약관). */
export const MAKEUP_OVER_CAPACITY = 2;

export function remainingSeats(c: Pick<ClassCandidate, "capacity" | "enrolled" | "booked">): number {
  return c.capacity + MAKEUP_OVER_CAPACITY - (c.enrolled + c.booked);
}

/**
 * 학생 학년으로 보강 가능한 반을 고른다.
 *
 * 학년 판정은 **시간표에 등록된 수업별 학년 구성**(ScheduleSlot.gradesJSON)을 숫자로 바꿔
 * «반의 대상 학년 범위 ±1학년» 안인지로 본다(matchClassesByGrade — 2026-11-14 전에는 글자가 똑같아야 했다).
 * 프로그램의 대상연령("초등저~고 (일부 중학생 가능)")은 자유 문장이라 절대 파싱하지 않는다.
 *
 * 자리는 c.booked(호출부가 센 보강 예약 수)로 한 번에 본다. 학부모 예약 화면은 날짜별로 봐야 해서
 * 이 함수 대신 matchClassesByGrade + remainingSeatsByDate 를 쓴다(parent-makeup.ts).
 *
 * 정렬: 자리 여유가 많은 순 → 요일·시각 순. 여유 있는 반을 먼저 권해 특정 반 쏠림을 막는다.
 */
export function recommendClasses(
  candidates: ClassCandidate[],
  studentGrade: string | null,
  opts: { excludeClassId?: string | null; excludeClassIds?: readonly string[] } = {},
): (ClassCandidate & { remaining: number })[] {
  return matchClassesByGrade(candidates, studentGrade, opts)
    .map((c) => ({ ...c, remaining: remainingSeats(c) }))
    .filter((c) => c.remaining > 0)
    .sort((a, b) =>
      b.remaining - a.remaining ||
      a.dayOfWeek.localeCompare(b.dayOfWeek) ||
      a.startTime.localeCompare(b.startTime));
}
