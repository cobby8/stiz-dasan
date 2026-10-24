// 정규 배차 손편집(차량 간 정차·학생 이동, 학생 빼기)의 순수 계산 모듈.
// 화면(RouteSection, regularEditing 모드)은 이 함수가 돌려준 vehicles 로 상태를 바꾸고,
// touched 차량만 시각 재계산(recomputeRunTimes) + T맵 경로 재계산(scheduleReroute)을 건다.
// 부수효과·DB·fetch 가 없어 node --test 로 바로 검증한다.

// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다(dispatchIncrement.ts 와 같은 방식).
import { findSamePlaceIndex } from "../seasonal/stopMerge.ts";

type Pt = { lat: number; lng: number };
// 화면 타입(DispatchSuggestion["vehicles"])을 그대로 받되, 여기서 쓰는 필드만 요구한다.
export type EditStop<S = unknown> = { lat: number; lng: number; label: string; students: S[]; approx: boolean; isHub?: boolean; etaManual?: number | null };
export type EditRun<S = unknown, T extends EditStop<S> = EditStop<S>> = { stops: T[]; passengers: number; capacity: number; over: boolean; path?: Pt[] };
/** 노선 양 끝(등원=차고지→학원, 하원=학원→차고지). 삽입 위치 계산에만 쓴다. */
export type RouteEnds = { start: Pt; end: Pt };
export type EditResult<R> = { vehicles: R[]; touched: number[] };

function haversineKm(a: Pt, b: Pt): number {
  const R = 6371, toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 기존 정차 순서를 지킨 채, 이 지점을 끼워 넣을 때 추가 거리가 가장 작은 인덱스(RouteSection.bestInsertK 와 같은 규칙). */
export function bestInsertIndex(stops: readonly Pt[], ends: RouteEnds, p: Pt): number {
  const pts: Pt[] = [ends.start, ...stops.map((s) => ({ lat: s.lat, lng: s.lng })), ends.end];
  let bestK = 0, bestCost = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const cost = haversineKm(pts[k], p) + haversineKm(p, pts[k + 1]) - haversineKm(pts[k], pts[k + 1]);
    if (cost < bestCost) { bestCost = cost; bestK = k; }
  }
  return bestK;
}

// 깊은 복사(정차·학생 배열까지) — 원본 상태를 절대 건드리지 않는다.
function cloneVehicles<R extends EditRun>(vehicles: readonly R[]): R[] {
  return vehicles.map((v) => ({ ...v, stops: v.stops.map((s) => ({ ...s, students: [...s.students] })) }));
}

// 정차 구성이 바뀐 차량: 인원·정원초과 재계산 + 옛 T맵 경로 폐기(화면이 재계산한다).
function finalize<R extends EditRun>(vehicles: R[], touched: number[]): EditResult<R> {
  const uniq = [...new Set(touched)];
  for (const vi of uniq) {
    const v = vehicles[vi];
    const passengers = v.stops.reduce((a, s) => a + s.students.length, 0);
    vehicles[vi] = { ...v, passengers, over: passengers > v.capacity, path: undefined };
  }
  return { vehicles, touched: uniq };
}

// 대상 차량에 정차(또는 학생 한 명으로 만든 정차)를 넣는다.
// 같은 장소(≤30m, stopMerge 단일 기준)이면서 무료탑승 여부가 같은 정차가 있으면 합치고, 없으면 최적 위치에 삽입.
// 무료탑승 거점과 일반 정차는 좌표가 같아도 합치지 않는다(합치면 거점 표시가 사라진다).
function placeInto<S, T extends EditStop<S>>(stops: T[], incoming: T, ends: RouteEnds): void {
  const hub = !!incoming.isHub;
  const candidates = stops.map((s) => (!!s.isHub === hub ? s : { lat: null, lng: null }));
  const mi = findSamePlaceIndex(candidates, incoming.lat, incoming.lng);
  if (mi >= 0) {
    stops[mi] = { ...stops[mi], students: [...stops[mi].students, ...incoming.students] };
    return;
  }
  // 다른 차량으로 옮긴 정차의 손으로 고친 시각은 그 차량 동선에선 의미가 없어 풀어 준다(자동 계산으로).
  stops.splice(bestInsertIndex(stops, ends, incoming), 0, { ...incoming, etaManual: null });
}

/** 정차 하나를 통째로 다른 차량(회차)으로 옮긴다. 잘못된 인덱스·같은 차량이면 원본 그대로(touched 빈 배열). */
export function moveStopToVehicle<S, T extends EditStop<S>, R extends EditRun<S, T>>(
  vehicles: readonly R[], from: { v: number; s: number }, toV: number, ends: RouteEnds,
): EditResult<R> {
  const src = vehicles[from.v]?.stops[from.s];
  if (!src || !vehicles[toV] || from.v === toV) return { vehicles: [...vehicles], touched: [] };
  const vs = cloneVehicles(vehicles);
  const [moved] = vs[from.v].stops.splice(from.s, 1);
  placeInto<S, T>(vs[toV].stops, moved, ends);
  return finalize(vs, [from.v, toV]);
}

/** 학생 한 명만 다른 차량으로 옮긴다. 원래 정차가 비면 지운다(무료탑승 거점은 비어도 남긴다). */
export function moveStudentToVehicle<S, T extends EditStop<S>, R extends EditRun<S, T>>(
  vehicles: readonly R[], from: { v: number; s: number; i: number }, toV: number, ends: RouteEnds,
): EditResult<R> {
  const src = vehicles[from.v]?.stops[from.s];
  if (!src || src.students[from.i] === undefined || !vehicles[toV] || from.v === toV) return { vehicles: [...vehicles], touched: [] };
  const vs = cloneVehicles(vehicles);
  const stop = vs[from.v].stops[from.s];
  const [student] = stop.students.splice(from.i, 1);
  if (stop.students.length === 0 && !stop.isHub) vs[from.v].stops.splice(from.s, 1);
  // 학생은 원래 정차의 장소(좌표·라벨·거점 여부)를 그대로 들고 간다.
  placeInto<S, T>(vs[toV].stops, { ...stop, students: [student] }, ends);
  return finalize(vs, [from.v, toV]);
}

/** 이번 저장본에서 학생 한 명을 뺀다(명단은 그대로). 원래 정차가 비면 지운다(무료탑승 거점은 남긴다). */
export function removeStudentFromRoute<S, T extends EditStop<S>, R extends EditRun<S, T>>(
  vehicles: readonly R[], at: { v: number; s: number; i: number },
): EditResult<R> {
  const src = vehicles[at.v]?.stops[at.s];
  if (!src || src.students[at.i] === undefined) return { vehicles: [...vehicles], touched: [] };
  const vs = cloneVehicles(vehicles);
  const stop = vs[at.v].stops[at.s];
  stop.students.splice(at.i, 1);
  if (stop.students.length === 0 && !stop.isHub) vs[at.v].stops.splice(at.s, 1);
  return finalize(vs, [at.v]);
}

/**
 * 옮길 대상 회차의 수업시간(등원=시작, 하원=종료)이 원래 회차와 다르면 {from,to} 표시값, 같거나 판단 불가면 null.
 * 정규 배차는 한 방향 안에 여러 수업시간 회차가 있어, 다른 시간 회차로 옮기면 학생이 엉뚱한 시각에 탄다 → 화면이 확인을 받는다.
 */
export function runTimeChange(
  from: { classStart?: string | null; classEnd?: string | null } | undefined,
  to: { classStart?: string | null; classEnd?: string | null } | undefined,
  isPickup: boolean,
): { from: string; to: string } | null {
  const a = isPickup ? from?.classStart : from?.classEnd;
  const b = isPickup ? to?.classStart : to?.classEnd;
  if (!a || !b || a === b) return null;
  return { from: a, to: b };
}

/** 정원을 넘은 차량 목록(저장 전 경고용). 인원은 정차 학생 수로 다시 센다. */
export function overCapacityVehicles<R extends EditRun & { vehicleName: string; tripLabel?: string | null }>(vehicles: readonly R[]): { name: string; passengers: number; capacity: number }[] {
  return vehicles
    .map((v) => ({ name: `${v.vehicleName}${v.tripLabel ? ` ${v.tripLabel}` : ""}`, passengers: v.stops.reduce((a, s) => a + s.students.length, 0), capacity: v.capacity }))
    .filter((v) => v.passengers > v.capacity);
}
