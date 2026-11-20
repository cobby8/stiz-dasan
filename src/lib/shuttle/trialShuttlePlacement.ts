// 체험 셔틀 «끼울 자리» 계산(순수) — 그날 정규 운행표의 어느 묶음(수업시간 × 방향), 어느 정류장 다음에 들를지.
// ─────────────────────────────────────────────────────────────────────────────
// 새 추천 규칙을 만들지 않는다. 정규 «학생 추가»가 쓰는 함수(regularRosterPlacementLogic)를 그대로 부른다:
//   ① 같은 정류장 이름 ② 가까운 정차(300m) ③ 운행 거리가 가장 적게 늘어나는 자리.
// 다른 점 하나: 체험 학생은 정규 명단에 줄을 만들지 않으므로 «합류»도 «그 정류장 바로 다음에 들른다»로 저장한다
// (TrialShuttleRide.afterStopName). 정규 줄은 하나도 건드리지 않는다.

import { findRouteCell, rosterClassTimeFor, suggestPlacement, type GeoPoint } from "./regularRosterPlacementLogic";
import type { RegularShuttleStop } from "./regularSheet";
import type { TrialRideDirection } from "./trialShuttleRules";

/** 배정 패널이 보여 주는 정차 한 곳(이름·시각·좌표만 — 학생 이름·전화는 싣지 않는다). */
export type TrialRunStop = { label: string; arriveTime: string | null; lat: number | null; lng: number | null };
/** 운행 묶음 하나(그 요일의 수업시간 × 방향). */
export type TrialRunOption = { classTime: string; stops: TrialRunStop[] };

function hhmm(value: string | null | undefined): string | null {
  const m = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
function toMin(value: string | null | undefined): number | null {
  const t = hhmm(value);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null;
}
function fromMin(min: number): string {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/**
 * 그 요일 명단에서 방향별 운행 묶음 목록 — 기사님 화면과 같은 함수(findRouteCell)로 정차 순서를 만든다.
 * 수업시간 글자 순(이른 수업 먼저).
 */
export function trialRunOptions(stops: readonly RegularShuttleStop[], weekday: number, direction: TrialRideDirection): TrialRunOption[] {
  const classTimes = [...new Set(
    stops
      .filter((s) => s.weekday === weekday && s.direction === direction && s.studentName && s.classTime)
      .map((s) => String(s.classTime)),
  )].sort((a, b) => a.localeCompare(b));
  return classTimes.map((classTime) => ({
    classTime,
    stops: findRouteCell(stops, weekday, classTime, direction).map((s) => ({ label: s.label, arriveTime: hhmm(s.arriveTime), lat: s.lat, lng: s.lng })),
  }));
}

/**
 * 체험 수업 시각에 맞는 운행 묶음을 미리 고른다 — 정규 «학생 추가»와 같은 «시작 시각 기준»(rosterClassTimeFor).
 * 맞는 묶음이 없으면 시작 시각이 가장 가까운 묶음, 묶음이 하나도 없으면 null(관리자가 고르거나 적는다).
 */
export function pickTrialClassTime(input: {
  weekday: number;
  /** 체험 수업 시작·끝 'HH:MM' */
  start: string | null;
  end: string | null;
  options: readonly TrialRunOption[];
}): string | null {
  if (input.options.length === 0) return null;
  const start = hhmm(input.start);
  if (!start) return input.options[0].classTime;
  const matched = rosterClassTimeFor(
    input.weekday, start, hhmm(input.end) ?? start,
    input.options.map((o) => ({ weekday: input.weekday, classTime: o.classTime })),
  );
  const exact = input.options.find((o) => o.classTime === matched);
  if (exact) return exact.classTime;
  const target = toMin(start)!;
  let best = input.options[0], gap = Infinity;
  for (const option of input.options) {
    const m = toMin(option.classTime);
    if (m == null) continue;
    const d = Math.abs(m - target);
    if (d < gap) { gap = d; best = option; }
  }
  return best.classTime;
}

export type TrialPlacementSuggestion = {
  /** 이 정류장 다음에 들른다. null = 묶음 맨 앞 */
  afterStopName: string | null;
  /** 추천 예상 시각 'HH:MM'. 계산할 근거가 없으면 null(관리자가 적는다) */
  arriveTime: string | null;
  /** 화면에 그대로 보일 추천 이유 */
  reason: string;
};

/** 앞뒤 정차 시각으로 추정할 수 없을 때 붙이는 간격(분) — 추천일 뿐이고 관리자가 고친다. */
const EDGE_GAP_MINUTES = 3;

/** 끼울 자리·예상 시각 추천. 정규 «학생 추가»의 suggestPlacement 결과를 «어느 정류장 다음»으로 옮긴다. */
export function suggestTrialPlacement(input: {
  stops: readonly TrialRunStop[];
  direction: TrialRideDirection;
  stopName: string;
  point: GeoPoint | null;
  academy: GeoPoint | null;
  depot: GeoPoint | null;
}): TrialPlacementSuggestion {
  const stops = input.stops.map((s) => ({ ...s, rows: [] as { rowId: string }[] }));
  const suggestion = suggestPlacement({
    stops, direction: input.direction, stopName: input.stopName, student: input.point, academy: input.academy, depot: input.depot,
  });
  if (suggestion.choice.kind === "JOIN") {
    const stop = stops[suggestion.choice.stopIndex];
    return {
      afterStopName: stop.label,
      arriveTime: hhmm(stop.arriveTime),
      // 정규 추천 문구의 «합류»는 체험에서는 «같은 곳에서 함께 탄다»는 뜻이다(명단에 줄을 만들지 않는다)
      reason: `${suggestion.reason} 같은 시각에 함께 태우면 됩니다.`,
    };
  }
  const position = suggestion.choice.position;
  const prev = stops[position - 1], next = stops[position];
  let arriveTime = hhmm(suggestion.arriveTime);
  let note = "";
  if (!arriveTime) {
    const prevMin = toMin(prev?.arriveTime ?? null), nextMin = toMin(next?.arriveTime ?? null);
    if (prev && prevMin != null && !next) { arriveTime = fromMin(prevMin + EDGE_GAP_MINUTES); note = ` 예상 시각은 앞 정차 +${EDGE_GAP_MINUTES}분으로 잡았으니 확인해 주세요.`; }
    else if (next && nextMin != null && !prev) { arriveTime = fromMin(nextMin - EDGE_GAP_MINUTES); note = ` 예상 시각은 다음 정차 −${EDGE_GAP_MINUTES}분으로 잡았으니 확인해 주세요.`; }
    else note = " 예상 시각은 직접 적어 주세요.";
  }
  return { afterStopName: prev ? prev.label : null, arriveTime, reason: `${suggestion.reason}${note}` };
}

/** 자리 고르기 목록 — «맨 앞» + 정차마다 «○○ 다음». 값은 afterStopName(맨 앞 = 빈 글자). */
export function trialPlacementChoices(stops: readonly TrialRunStop[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const out = [{ value: "", label: stops.length > 0 ? "맨 앞(첫 정차 전)" : "첫 정차로" }];
  stops.forEach((stop, index) => {
    if (seen.has(stop.label)) return; // 같은 이름 정차가 두 번이면 뒤쪽 것 다음으로 끼워진다(운행표 규칙과 같다)
    seen.add(stop.label);
    out.push({ value: stop.label, label: `${index + 1}. ${stop.label}${stop.arriveTime ? ` ${stop.arriveTime}` : ""} 다음` });
  });
  return out;
}
