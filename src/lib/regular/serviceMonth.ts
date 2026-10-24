/** 서버 위치와 무관하게 STIZ 운영 기준(Asia/Seoul)의 YYYY-MM을 만든다. */
export function koreaServiceMonth(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(value);
  const part = (type: "year" | "month") => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

export function isServiceMonth(value: unknown): value is string {
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * 저장된 명단 달 목록 중 기준일(YYYY-MM-DD 또는 YYYY-MM)이 속한 달 "이하"의 가장 최근 달을 고른다.
 * - 왜: 「다음 달 명단 만들기」로 미래 달 행이 먼저 생겨도, 기사님·기본 화면은 지금 달 명단을 계속 봐야 한다.
 * - 목록에 기준 달 이하가 하나도 없으면(빈 목록·미래 달만) undefined → 호출부의 기존 동작(최신 달)을 따른다.
 * - "YYYY-MM" 문자열은 사전순 = 시간순이라 문자열 비교로 충분하다.
 */
export function pickServiceMonthFor(months: readonly string[], ymd: string): string | undefined {
  const target = String(ymd ?? "").slice(0, 7);
  if (!isServiceMonth(target)) return undefined;
  let best: string | undefined;
  for (const month of months) {
    if (!isServiceMonth(month) || month > target) continue; // 형식이 이상하거나 미래 달은 제외
    if (best === undefined || month > best) best = month;
  }
  return best;
}
