/**
 * «복귀 예정» 공용 규칙 — 학부모가 그 수강을 쓸 수 있는가(2026-11-14 원장 지적).
 *
 * 문제: 복귀 신청이 승인돼도 수강(Enrollment)은 복귀일에 크론이 바꿀 때까지 PAUSED 다.
 *   그래서 승인된 뒤에도 복귀일 «이후» 수업의 결석 신고·셔틀 변경을 미리 할 수 없었다.
 * 결정(안 A): 수강 상태·출석부·청구·정원은 건드리지 않고, «학부모가 쓸 수 있나» 판정만 한 곳에 더한다.
 *   쓸 수 있다 = ACTIVE, 또는 PAUSED + 승인됐지만 아직 반영 전인 복귀 신청(RESUME·APPROVED·appliedAt NULL).
 *   단, 복귀 예정 반은 «복귀일 이후 날짜»만 쓸 수 있다(usableOn).
 *
 * 복귀 신청이 수강을 가리키는 키 = "enrollmentId" (학부모 복귀 신청 submitResumeRequest 가 채우고,
 *   적용 크론 applyDueEnrollmentChangesWithSummary 도 이 칸으로 수강을 찾는다).
 * "effectiveFrom" 은 date 열이라 변환 없이 그대로 비교·to_char 한다.
 *
 * 이 파일은 다른 모듈을 import 하지 않는다 — 테스트가 그대로 올려 실행한다(tests/resume-window.test.mjs).
 */

/** SQL 별칭은 글자·숫자·밑줄만(조각을 문자열로 끼워 넣으므로 다른 글자는 거절한다) */
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkedAlias(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`resumeWindow: 잘못된 SQL 별칭 "${alias}"`);
  return alias;
}

/**
 * 승인됐지만 아직 반영 전인 «앞으로의» 복귀 신청(그 수강의) — 두 조각이 같은 조건을 쓰게 한 곳에 둔다.
 *
 * ★ appliedAt NULL 만으로는 모자라다(2026-11-14 검수): appliedAt 은 크론이 «적용»했을 때만 채워진다.
 *   크론이 복귀를 «보류(HOLD)»하면 신청 행은 APPROVED·appliedAt NULL 로 영영 남는다
 *   (예: 승인 뒤 원장이 직접 ACTIVE 로 바꿈 → 적용일에 «이미 복귀 상태»로 보류 → 나중에 다시 휴원 →
 *    옛 신청이 맞아떨어져 휴원 내내 결석 신고·셔틀 변경이 통과한다).
 *   ① 크론이 이미 처리(적용·보류)한 신청은 뺀다 — 크론 대상 조회(admin-change-request.ts
 *      applyDueEnrollmentChangesWithSummary)와 글자까지 같은 조건: 운영 원장 키 'enrollment-change:' || 신청 id.
 *   ② 복귀일이 이미 지난 신청은 «예정»이 아니라 뺀다(원장 기록이 없어도 — 두 번째 방어선).
 *      «오늘»은 DB 에서 KST 로 만든다(서버 시계는 UTC). 복귀일 당일은 크론이 돌기 전에도 쓸 수 있게 >= 로 둔다.
 */
function approvedResumeWhere(e: string): string {
  return `rw."enrollmentId" = ${e}.id AND rw.kind = 'RESUME' AND rw.status = 'APPROVED' AND rw."appliedAt" IS NULL`
    + ` AND rw."effectiveFrom" >= (NOW() AT TIME ZONE 'Asia/Seoul')::date`
    + ` AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" oc WHERE oc."idempotencyKey" = 'enrollment-change:' || rw.id)`;
}

/**
 * SQL 조각: «이 수강(e)을 학부모가 쓸 수 있는 상태인가».
 * 휴원 중이고 복귀 승인이 없는 수강·복귀 신청이 대기(PENDING)인 수강은 거짓이다.
 */
export function parentUsableEnrollmentSql(enrollmentAlias: string = "e"): string {
  const e = checkedAlias(enrollmentAlias);
  return `(${e}.status = 'ACTIVE' OR (${e}.status = 'PAUSED' AND EXISTS (SELECT 1 FROM "EnrollmentChangeRequest" rw WHERE ${approvedResumeWhere(e)})))`;
}

/**
 * SQL 조각: 그 수강의 복귀일("YYYY-MM-DD" 글자). 승인·미반영 복귀 신청 중 가장 이른 적용일.
 * 다니는 중(ACTIVE)이거나 승인된 복귀가 없으면 NULL.
 */
export function resumeFromSql(enrollmentAlias: string = "e"): string {
  const e = checkedAlias(enrollmentAlias);
  return `(SELECT to_char(MIN(rw."effectiveFrom"), 'YYYY-MM-DD') FROM "EnrollmentChangeRequest" rw WHERE ${e}.status = 'PAUSED' AND ${approvedResumeWhere(e)})`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 그 날짜(ymd)에 이 수강을 쓸 수 있나.
 * ACTIVE → 항상 / PAUSED + 복귀일 있음 → 복귀일 당일부터 / 그 밖(퇴원·복귀일 없음·형식 오류) → 불가.
 */
export function usableOn(status: string | null | undefined, resumeFrom: string | null | undefined, ymd: string): boolean {
  if (status === "ACTIVE") return true;
  if (status !== "PAUSED") return false;
  if (!resumeFrom || !YMD.test(resumeFrom) || !YMD.test(ymd)) return false;
  return ymd >= resumeFrom;
}

/**
 * 학생 한 명의 수강들(쓸 수 있는 것만 넘긴다)에서 «언제부터 쓸 수 있나».
 * 다니는 반이 하나라도 있으면 null(제한 없음), 전부 복귀 예정이면 가장 이른 복귀일.
 * 셔틀 «오늘만» 변경처럼 반이 아니라 학생 단위로 받는 신청에 쓴다.
 */
export function earliestUsableFrom(rows: readonly { status: string; resumeFrom: string | null }[]): string | null {
  if (rows.some((r) => r.status === "ACTIVE")) return null;
  const dates = rows.map((r) => r.resumeFrom).filter((d): d is string => !!d && YMD.test(d)).sort();
  return dates[0] ?? null;
}

/**
 * 일정 계산용: 복귀 예정 반을 «그 날짜부터 수업이 있는 반»으로 바꿔 수강 중인 반 뒤에 붙인다(2026-11-14 홈·달력).
 * 달력·«다음 수업» 계산은 이미 startsOn(개시일) 전 수업을 빼므로, 그 자리에 «개시일과 복귀일 중 늦은 날»을 넣으면
 * 복귀일 전 날짜에는 표시되지 않고 복귀일 당일부터 일반 수업처럼 보인다. 복귀일이 형식에 안 맞는 행은 버린다(추측하지 않는다).
 * ※ 일정 표시에만 쓴다 — «수강 중인 반» 목록(결제·수강 변경·특강)에는 섞지 않는다.
 */
export function withResumingForSchedule<T extends { startsOn?: string | null }, R extends { startsOn?: string | null; resumeFrom: string }>(
  enrollments: readonly T[] | null | undefined,
  resuming: readonly R[] | null | undefined,
): (T | R)[] {
  const out: (T | R)[] = [...(enrollments ?? [])];
  for (const r of resuming ?? []) {
    if (!r.resumeFrom || !YMD.test(r.resumeFrom)) continue;
    const startsOn = r.startsOn && YMD.test(r.startsOn) && r.startsOn > r.resumeFrom ? r.startsOn : r.resumeFrom;
    out.push({ ...r, startsOn });
  }
  return out;
}

/** 복귀일 전 날짜로 신청했을 때의 오류 코드(서버 검사) */
export const BEFORE_RESUME_CODE = "BEFORE_RESUME_DATE";

/** 복귀일을 함께 실어 던진다 — 받는 쪽이 «복귀일(M/D)» 문구를 만들 수 있게 */
export class BeforeResumeError extends Error {
  resumeFrom: string;
  constructor(resumeFrom: string) {
    super(BEFORE_RESUME_CODE);
    this.name = "BeforeResumeError";
    this.resumeFrom = resumeFrom;
  }
}

/** 오류에서 복귀일을 꺼낸다(이 오류가 아니면 null) */
export function resumeFromOfError(error: unknown): string | null {
  if (!(error instanceof Error) || error.message !== BEFORE_RESUME_CODE) return null;
  const value = (error as { resumeFrom?: unknown }).resumeFrom;
  return typeof value === "string" && YMD.test(value) ? value : null;
}

/** "2026-11-16" → "11/16" (형식이 아니면 빈 글자) */
function md(ymd: string | null | undefined): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? `${Number(m[1])}/${Number(m[2])}` : "";
}

/** 안내 한 줄: «복귀일(11/16) 이후 수업부터 신청할 수 있어요» — 결석은 verb 를 «신고»로 */
export function resumeNotice(resumeFrom: string | null | undefined, verb: "신청" | "신고" = "신청"): string {
  const when = md(resumeFrom);
  return `복귀일${when ? `(${when})` : ""} 이후 수업부터 ${verb}할 수 있어요`;
}
