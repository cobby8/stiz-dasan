/**
 * 출결 화면 주소 쿼리 해석 — `/admin/attendance?date=YYYY-MM-DD&lesson=regular:<반 id>` · `lesson=seasonal:<특강 회차 id>`.
 *
 * 왜: 대시보드 «오늘 수업 처리 현황» 줄(`classDayHref` — src/lib/class-nudge/board.ts)이 이 주소로 보내는데
 * 출결 화면이 값을 읽지 않아, 그 수업이 아니라 출결 첫 화면이 열렸다.
 * 주소 값은 그대로 믿지 않는다 — 날짜는 실제 달력 날짜만, 수업은 두 형식만 통과시킨다.
 *
 * 순수 모듈(화면·DB 의존 없음) — tests/attendance-lesson-query.test.mjs 가 실행해서 확인한다.
 */
import { isKstYmd } from "@/lib/datetime/kst";
import { WEEK_MAX_YMD, WEEK_MIN_YMD } from "@/lib/attendance/weekBoard";

export type AttendanceLessonTarget = { kind: "regular" | "seasonal"; id: string };

export type AttendanceOpenTarget = {
  /** 열 날짜(YYYY-MM-DD) */
  date: string;
  /** 열 수업 — 없거나 모양이 틀리면 null(그 날짜만 연다) */
  lesson: AttendanceLessonTarget | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// id 는 글자·숫자·밑줄·붙임표만(주소에 섞인 다른 문자는 통과시키지 않는다)
const LESSON_RE = /^(regular|seasonal):([A-Za-z0-9_-]{1,100})$/;

/** 주소에 같은 이름이 두 번 오면 배열로 들어온다 — 첫 값만 본다 */
function single(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first : null;
}

/** `lesson` 값 하나 해석 — 두 형식이 아니면 null */
export function parseAttendanceLessonKey(raw: unknown): AttendanceLessonTarget | null {
  const value = single(raw);
  if (value === null) return null;
  const m = LESSON_RE.exec(value);
  return m ? { kind: m[1] as "regular" | "seasonal", id: m[2] } : null;
}

/**
 * 주소 쿼리 → 열 날짜·수업.
 * - 날짜가 없거나 틀리거나 볼 수 있는 기간(주간 보드·날짜 입력과 같은 2020~2030) 밖이면 null
 *   (= 쿼리 없이 들어온 것과 똑같이 동작한다. 수업만 있어도 날짜를 모르니 무시)
 * - 날짜는 맞고 수업이 틀리면 그 날짜만 연다
 */
export function parseAttendanceOpenQuery(query: { date?: unknown; lesson?: unknown } | null | undefined): AttendanceOpenTarget | null {
  const date = single(query?.date);
  if (date === null || !DATE_RE.test(date) || !isKstYmd(date)) return null;
  if (date < WEEK_MIN_YMD || date > WEEK_MAX_YMD) return null;
  return { date, lesson: parseAttendanceLessonKey(query?.lesson) };
}

/** 그날 수업 목록의 한 줄에서 맞춰 볼 값만 */
type LessonLike = { id: string; kind?: "REGULAR" | "SEASONAL"; sessionDateId?: string | null };

/**
 * 그날 수업 목록에서 주소가 가리키는 수업 찾기 — 없으면 null(휴강·지난 주소 등: 날짜만 연다).
 * 정규 = 반 id, 특강 = 회차 id(sessionDateId). 종류가 다르면 id 가 같아도 고르지 않는다.
 */
export function findLessonForTarget<T extends LessonLike>(lessons: readonly T[], target: AttendanceLessonTarget | null): T | null {
  if (!target) return null;
  if (target.kind === "seasonal") {
    return lessons.find((item) => item.kind === "SEASONAL" && item.sessionDateId === target.id) ?? null;
  }
  return lessons.find((item) => item.kind !== "SEASONAL" && item.id === target.id) ?? null;
}
