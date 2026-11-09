import { isKstYmd, toKstYmd } from "@/lib/datetime/kst";

/** 날짜 자체를 보존한다. 월·승인 시각으로 시작일을 만들어내지 않는다. */
export function commencementYmd(value: unknown): string | null {
  // Prisma의 DATE는 UTC 자정으로 전달된다. 해당 날짜는 KST 오전 9시로 같은 달력 날짜다.
  // 임의 시각을 날짜로 오인하지 않으며 Invalid Date도 빈 값으로 처리한다.
  if (value instanceof Date && (!Number.isFinite(value.getTime()) || value.getUTCHours() !== 0 || value.getUTCMinutes() !== 0 || value.getUTCSeconds() !== 0 || value.getUTCMilliseconds() !== 0)) return null;
  const date = value instanceof Date ? toKstYmd(value) : typeof value === "string" ? value : "";
  return isKstYmd(date) ? date : null;
}
export function requireCommencement(value: unknown): string {
  const date = commencementYmd(value);
  if (!date || date < "2000-01-01" || date > "2100-12-31") throw new Error("수강 개시일을 정확히 선택해 주세요.");
  return date;
}
/*
 * 수강 «상태» 판정 규칙 (2026-11-09 원장 지시로 개정 — 이 파일 한 곳에서만 정한다)
 * - Enrollment 가 ACTIVE 면 등록(승인)한 날부터 «수강 중/재원생»이다. 개시일이 미래여도 «수강 예정»으로 따로 빼지 않는다.
 * - 개시일(startsOn)은 ① 청구 수강료 시수 계산 ② 그날 이전 수업 회차 출석부 명단 제외 에만 쓴다(enrollmentHasStarted).
 * 옛 규칙(개시일 > 오늘 이면 SCHEDULED)은 폐기됐다. displayStatus 는 화면 호환을 위해 남겨 두지만 status 와 같다.
 */
export const CURRENT_ENROLLMENT_STATUS = "ACTIVE";
/** 수강 중(재원) 여부 — 개시일과 무관하게 상태만 본다 */
export function isCurrentEnrollment(status: string | null | undefined): boolean {
  return status === CURRENT_ENROLLMENT_STATUS;
}
/** SQL 쪽 같은 규칙. alias = Enrollment 별칭(코드가 정한 식별자만 넣는다) */
export function currentEnrollmentSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("invalid alias");
  return `${alias}.status = '${CURRENT_ENROLLMENT_STATUS}'`;
}
/** 화면 표시 상태 — 새 기준에선 status 그대로(개시일이 미래인 ACTIVE 도 ACTIVE) */
export function enrollmentDisplayStatus(status: string, _startsOn?: unknown, _today?: string): string {
  return status;
}
/** 개시일이 오늘보다 뒤인가 — «11-13 개시» 같은 안내 문구에만 쓴다(상태·인원 판정에 쓰지 말 것) */
export function enrollmentStartsLater(startsOn: unknown, today: string): boolean {
  const start = commencementYmd(startsOn);
  return !!start && isKstYmd(today) && start > today;
}
/** SQL의 DATE와 일치하는 날짜 판정. 기존 null 개시일은 기존 동작을 보존한다. */
export function enrollmentHasStarted(startsOn: unknown, on: string): boolean {
  if (!isKstYmd(on)) return false;
  if (startsOn == null) return true;
  const start = commencementYmd(startsOn);
  return !!start && start <= on;
}
