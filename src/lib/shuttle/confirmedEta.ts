/** 시각은 0~1439의 정수 분으로 다룬다. 화면·저장·문자에 같은 우선순위를 적용한다. */
export function isClockMinute(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1440;
}
export function parseClockMinute(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
export function formatClockMinute(value: unknown): string | null {
  return isClockMinute(value) ? `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}` : null;
}
export function confirmedEtaMin(stop: { etaManual?: unknown; etaMinutes?: unknown; etaLabel?: unknown }): number | null {
  // 명시한 수동 값이 잘못됐을 때 옛 자동 시각으로 조용히 되돌리지 않는다.
  if (stop.etaManual != null) return isClockMinute(stop.etaManual) ? stop.etaManual : null;
  if (stop.etaMinutes != null) return isClockMinute(stop.etaMinutes) ? stop.etaMinutes : null;
  if (typeof stop.etaLabel !== "string") return null;
  const label = stop.etaLabel.match(/(?:^|\s)((?:[01]?\d|2[0-3]):[0-5]\d)(?=$|\s)/)?.[1];
  return parseClockMinute(label?.padStart(5, "0"));
}
export function confirmedEtaLabel(stop: { etaManual?: unknown; etaMinutes?: unknown; etaLabel?: unknown }): string | null {
  return formatClockMinute(confirmedEtaMin(stop));
}
