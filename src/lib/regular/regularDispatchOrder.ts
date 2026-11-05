// 정규 배차 화면에서 등원·하원 회차 카드를 «하루 시간순»으로 섞어 보이기 위한 정렬 키.
// 화면(RouteSection timeOrdered)은 이 값을 CSS order 로 써서, 두 방향 카드를 한 목록에 시간순으로 놓는다.
//
// 규칙
// - 카드의 기준 시각: 등원 = 수업 시작(classStart), 하원 = 수업 종료(classEnd).
//   없으면 회차 이름(tripLabel 예 「15:00 수업」「16:00 종료」)의 HH:MM, 그것도 없으면 출발 시각(departTime).
// - 같은 시각이면 하원(종료) 먼저, 그다음 등원(수업) — 실제 차가 앞 수업 학생을 내려 주고 다음 수업 학생을 태우러 간다.
// - 같은 시각·같은 방향이면 원래 차량 순서(vIdx)를 유지한다.
// - 시각을 모르면 맨 뒤로 보낸다.

type OrderRun = { classStart?: string | null; classEnd?: string | null; tripLabel?: string | null; departTime?: string | null };

const UNKNOWN_MINUTES = 24 * 60; // 시각을 모르는 회차 — 모든 실제 시각보다 뒤

// "15:00" · "15:00 수업" · "수업 19:20 종료" 처럼 문자열 안의 첫 HH:MM 을 자정 기준 분으로 바꾼다.
function hhmmToMinutes(value: string | null | undefined): number | null {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// 이 회차 카드의 기준 시각(분). 모르면 UNKNOWN_MINUTES.
export function runAnchorMinutes(run: OrderRun, isPickup: boolean): number {
  return hhmmToMinutes(isPickup ? run.classStart : run.classEnd)
    ?? hhmmToMinutes(run.tripLabel)
    ?? hhmmToMinutes(run.departTime)
    ?? UNKNOWN_MINUTES;
}

// CSS order 값(정수). 작을수록 위. 분 → 방향(하원 0, 등원 1) → 차량 순서 순으로 비교한 것과 같다.
export function runTimelineOrder(run: OrderRun, isPickup: boolean, vIdx: number): number {
  return (runAnchorMinutes(run, isPickup) * 2 + (isPickup ? 1 : 0)) * 100 + Math.min(Math.max(vIdx, 0), 99);
}
