// 정규 배차 화면에서 등원·하원 회차 카드를 «하루 시간순»으로 섞어 보이기 위한 정렬 키.
// 화면(RouteSection timeOrdered)은 이 값을 CSS order 로 써서, 두 방향 카드를 한 목록에 시간순으로 놓는다.
//
// 기준 = «그 차가 실제로 출발하는 시각» (2026-11-05 원장 지적으로 정정)
//   예전엔 등원=수업 시작, 하원=수업 종료를 기준으로 써서 「17:00 수업 등원」(16:35 출발)이
//   「16:00 수업 하원」(17:05 출발)보다 뒤로 갔다. 원장: 「16시 등원, 17시 등원, 16시 하차 순이어야 시간순」.
//
// 규칙
// 1. 카드의 「출발」 시각(departTime — 화면 입력칸 값, 손으로 고치면 그 값). 고치면 순서도 따라간다.
// 2. 출발 시각이 없을 때만: 등원 = 수업 시작 30분 전, 하원 = 수업 종료.
// 3. 그것도 없으면 회차 이름(tripLabel 예 「15:00 수업」)의 HH:MM, 모두 없으면 맨 뒤.
// 4. 수업시간이 없는 회차(「수업시간 확인 필요」)는 출발 시각이 있어도 맨 뒤 — 시각이 믿을 만하지 않다.
// 5. 같은 시각이면 등원 먼저, 같은 시각·같은 방향이면 원래 차량 순서(vIdx).

type OrderRun = {
  classStart?: string | null; classEnd?: string | null; tripLabel?: string | null;
  timeGroupLabel?: string | null; departTime?: string | null;
};

const UNKNOWN_MINUTES = 24 * 60; // 맨 뒤 — 모든 실제 시각(0~1439분)보다 뒤
const PICKUP_LEAD_MINUTES = 30; // 출발 시각이 없을 때 등원 차가 수업 몇 분 전에 출발한다고 볼지
const MISSING_CLASS_LABEL = "수업시간 확인 필요"; // shuttle-dispatch.ts 가 수업시간 없는 회차에 붙이는 이름

// "15:00" · "15:00 수업" · "수업 19:20 종료" 처럼 문자열 안의 첫 HH:MM 을 자정 기준 분으로 바꾼다.
function hhmmToMinutes(value: string | null | undefined): number | null {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = Number(match[1]), m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// 수업시간 없는 회차인가 — 회차 묶음 이름이나 회차 이름이 「수업시간 확인 필요」로 시작한다.
function isMissingClassTime(run: OrderRun): boolean {
  return [run.timeGroupLabel, run.tripLabel].some((label) => String(label ?? "").startsWith(MISSING_CLASS_LABEL));
}

// 이 회차 카드의 정렬 시각(분). 모르면·수업시간이 없으면 UNKNOWN_MINUTES.
export function runAnchorMinutes(run: OrderRun, isPickup: boolean): number {
  if (isMissingClassTime(run)) return UNKNOWN_MINUTES;
  const depart = hhmmToMinutes(run.departTime);
  if (depart != null) return depart;
  if (isPickup) {
    const start = hhmmToMinutes(run.classStart);
    if (start != null) return Math.max(start - PICKUP_LEAD_MINUTES, 0);
  } else {
    const end = hhmmToMinutes(run.classEnd);
    if (end != null) return end;
  }
  return hhmmToMinutes(run.tripLabel) ?? UNKNOWN_MINUTES;
}

// CSS order 값(정수). 작을수록 위. 분 → 방향(등원 0, 하원 1) → 차량 순서 순으로 비교한 것과 같다.
export function runTimelineOrder(run: OrderRun, isPickup: boolean, vIdx: number): number {
  return (runAnchorMinutes(run, isPickup) * 2 + (isPickup ? 0 : 1)) * 100 + Math.min(Math.max(vIdx, 0), 99);
}
