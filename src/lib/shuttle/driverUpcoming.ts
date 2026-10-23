export type DriverScheduledStop = { key: string; time: string | null; isTerminal?: boolean };
export type DriverUpcomingState = {
  nextKey: string | null;
  remainingMinutes: number | null;
  clockLabel: string | null;
  isViewingToday: boolean;
};

export function parseDriverScheduleTime(time: string | null): number | null {
  if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** 휴대폰의 달력·시계로 표시만 계산합니다. 탑승 완료나 실제 도착을 판단하지 않습니다. */
export function getDriverUpcoming(stops: readonly DriverScheduledStop[], viewDate: string, now: Date): DriverUpcomingState {
  if (!Number.isFinite(now.getTime())) return { nextKey: null, remainingMinutes: null, clockLabel: null, isViewingToday: false };
  const pad = (value: number) => String(value).padStart(2, "0");
  const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const clockLabel = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const isViewingToday = viewDate === localDate;
  const current = now.getHours() * 60 + now.getMinutes();
  let next: { key: string; minutes: number } | null = null;
  if (isViewingToday) {
    for (const stop of stops) {
      const minutes = parseDriverScheduleTime(stop.time);
      if (stop.isTerminal || minutes === null) continue;
      // 같은 시각은 현재 운행 목록 순서를 유지하고, 시간 미정·차고지 안내는 제외합니다.
      if (minutes >= current && (!next || minutes < next.minutes)) next = { key: stop.key, minutes };
    }
  }
  return { nextKey: next?.key ?? null, remainingMinutes: next ? next.minutes - current : null, clockLabel, isViewingToday };
}
