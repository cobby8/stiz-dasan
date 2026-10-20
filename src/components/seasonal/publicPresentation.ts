import type { SeasonalProgram } from "./types";

/** Display dates in Korea without leaking an ISO timestamp into visitor-facing text. */
export function publicSeasonalDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value);
  if (!Number.isFinite(date.getTime())) return "일정 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric" }).format(date);
}

export function isPastSeasonalProgram(program: SeasonalProgram, now = Date.now()): boolean {
  if (program.status === "ENDED") return true;
  if (!program.operationEnd) return false;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(program.operationEnd)
    ? `${program.operationEnd}T23:59:59.999+09:00` : program.operationEnd;
  const end = new Date(value).getTime();
  return Number.isFinite(end) && end < now;
}
