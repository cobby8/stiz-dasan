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
export function enrollmentDisplayStatus(status: string, startsOn: unknown, today: string): string {
  const start = commencementYmd(startsOn);
  return status === "ACTIVE" && start && start > today ? "SCHEDULED" : status;
}
/** SQL의 DATE와 일치하는 날짜 판정. 기존 null 개시일은 기존 동작을 보존한다. */
export function enrollmentHasStarted(startsOn: unknown, on: string): boolean {
  if (!isKstYmd(on)) return false;
  if (startsOn == null) return true;
  const start = commencementYmd(startsOn);
  return !!start && start <= on;
}
