// 기사님 「새 학생 배정」 — 남은 칸 계산 · 칸별 운행 순서·추천 · 저장 요청 만들기(순수 함수, DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가(2026-11-05): 셔틀 신청이 승인된 새 학생을 원장이 명단에 넣기 전까지 기사님 화면(운행표)에 안 보였다.
//   기사님이 휴대폰에서 「아직 운행표에 없는 칸(요일 × 등원/하원)」을 보고 한 칸씩 바로 넣게 한다.
// 계산은 관리자 학생 추가와 **같은 함수**(enrolledClassSlots·findRouteCell·suggestPlacement·resolveCellPlacement)를 쓴다.
//   새 규칙을 만들지 않는다 — 화면 순서·추천·저장 위치가 관리자 화면과 어긋나지 않게.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다(런타임 import 는 .ts 확장자).

// @ts-expect-error -- TypeScript runtime test compatibility
import { enrolledClassSlots, findRouteCell, JOIN_RADIUS_METERS, resolveCellPlacement, resolveStudentPoint, studentRosterRows, suggestPlacement, type EnrolledClass, type GeoPoint, type PlacementChoice } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { WEEKDAY_LABELS, type RosterDirection } from "./regularRosterEditLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { normalizeStopName } from "./regularDriverRouteLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { distanceMeters } from "../seasonal/stopMerge.ts";
// 반경 안 추천(장소명 출입구 일치 우선)은 공용 한 곳 것을 쓴다.
// @ts-expect-error -- TypeScript runtime test compatibility
import { pickNearbyStop } from "./stopNameMatch.ts";
// 반 이동 재배정 판정(D4) — 옛 칸·새 칸 짝은 이 한 곳에서만 계산한다.
// @ts-expect-error -- TypeScript runtime test compatibility
import { planStudentReassign, type ReassignPair } from "./regularReassignLogic.ts";
import type { RegularShuttleStop } from "./regularSheet";

/** 「기존 정류장에 태우기」 후보로 보여 줄 최대 거리(미터). 합류 추천 반경(300m)보다 넓게 — 기사님이 고를 여지. */
export const JOIN_OPTION_RADIUS_METERS = 1000;
/** 후보 정류장은 가까운 순으로 최대 이만큼만(휴대폰 한 화면). */
export const JOIN_OPTION_LIMIT = 3;

/** 사용자에게 그대로 보여 줄 오류(한국어) + HTTP 상태. API 가 그대로 돌려준다. */
export class DriverAssignError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 학생 상세 위치(StudentShuttleLocation) 한 건. */
export type AssignPlace = { name: string | null; address: string; latitude: number; longitude: number };

/** 서버가 DB 에서 읽어 넘기는 학생 한 명의 재료. */
export type AssignStudentInput = {
  studentId: string;
  name: string;
  grade: string | null;
  /** 신청서의 셔틀 희망 시각(예: "16:40"). */
  wishTime: string | null;
  /** 명단의 이름+전화 행(학생 id 없는 옛 행)을 같은 학생으로 묶을 때만 쓴다. 화면에는 내려가지 않는다. */
  parentPhone: string | null;
  /** 수강(다니는 ACTIVE·휴원 PAUSED). 개시일이 그 달 이후인 수강은 서버가 이미 뺐다. */
  enrolled: EnrolledClass[];
  pickup: AssignPlace | null;
  dropoff: AssignPlace | null;
  /**
   * 승인된 셔틀 신청서가 있는 학생인지. false = 신청서 없이 «그 달 명단에 행이 있는 학생»(시트 이관 포함, 2026-11-09 보드 확장).
   * false 인 학생은 «신규» 칸을 띄우지 않고 «재배정»(반 이동) 칸만 띄운다. 비어 있으면 true(예전 호출 그대로).
   */
  hasApplication?: boolean;
};

/** 남은 칸 한 개 = 요일 × 방향. classTime 은 그 요일 명단 칸 글자(관리자 학생 추가와 같은 맞춤). */
export type OpenLeg = { weekday: number; direction: RosterDirection; classTime: string; startTime: string; label: string };

export type AssignRouteStop = {
  label: string;
  arriveTime: string | null;
  /** 이미 타는 학생 — 이름만(전화·주소 금지). */
  riders: string[];
};

/**
 * 「기존 정류장에 태우기」 후보 한 줄.
 * - 그 칸 정차: stopIndex = route 안 자리, otherDay = false.
 * - 같은 달 다른 요일·반 정류장(2026-11-05 추가): stopIndex = null, otherDay = true, key 로 고른다.
 *   고르면 그 정류장 이름·좌표로 새 정차를 position 자리(운행 거리가 가장 적게 늘어나는 자리)에 넣는다.
 */
export type AssignJoinOption = {
  stopIndex: number | null;
  /** 다른 요일 정류장 식별값(이름|위도|경도). 그 칸 정차는 null. */
  key: string | null;
  otherDay: boolean;
  /** 다른 요일 정류장을 넣을 자리(0 = 첫 정차 앞, route.length = 맨 뒤). 그 칸 정차는 null. */
  position: number | null;
  label: string; distanceMeters: number | null; riders: number; recommended: boolean;
  /** 추천 이유(추천 후보만) — «이름 일치: 후문» / «가장 가까움 88m» / «이름 같음». 화면 추천 배지 옆에 짧게. */
  recommendReason: string | null;
};

/** 기사님 화면 선택 — 관리자와 같은 JOIN/INSERT + 「다른 요일 정류장」(OTHER). */
export type AssignChoice = PlacementChoice | { kind: "OTHER"; key: string };

/** 다른 요일·반 정류장(그 칸에 없는 이름) — 저장할 때 이름·좌표를 그대로 쓴다. */
type OtherStop = { key: string; name: string; lat: number; lng: number };

export type AssignLegPlan = OpenLeg & {
  key: string;
  /** 지금 기사님 화면의 그 수업·방향 순서. */
  route: AssignRouteStop[];
  /** 화면을 연 뒤 운행표가 바뀌었는지 저장할 때 확인하는 값(행 id 묶음의 짧은 지문). */
  routeVersion: string;
  /** ① 「기존 정류장에 태우기」 후보(가까운 순). */
  joinOptions: AssignJoinOption[];
  /** ① 「학생 위치에 새 정류장」 — 학생 상세 위치가 없거나 같은 이름 정류장이 이미 있으면 null. */
  newStop: { name: string; address: string } | null;
  /** 처음 골라 둘 값(추천). */
  defaultChoice: AssignChoice | null;
  /** 새 정류장의 처음 자리(0 = 첫 정차 앞, route.length = 맨 뒤). */
  defaultPosition: number;
  reason: string;
  /** 새 정류장도 기존 정류장도 고를 수 없을 때의 안내(그 칸은 이번 화면에서 넣지 못함). */
  blocked: string | null;
  /**
   * 반 이동 재배정 칸이면 옛 칸 정보(넣기 = 새 칸 추가 + 옛 칸 삭제 한 트랜잭션). 신규 칸은 비어 있다.
   * 저장 요청은 reassign: true 만 보낸다 — 지울 옛 행은 서버가 다시 계산한다(화면 값 불신).
   */
  reassign?: { label: string; fromWeekday: number; fromClassTime: string; fromStopName: string; replaceRowIds: string[] };
};

export type AssignStudentPlan = {
  studentId: string;
  name: string;
  grade: string | null;
  wishTime: string | null;
  /** 수업 요약 — 「월·수 17:00~17:55」. */
  classes: string;
  pickup: string | null;
  dropoff: string | null;
  legs: AssignLegPlan[];
};

const DIR_ORDER: Record<RosterDirection, number> = { BOARD: 0, ALIGHT: 1 };
const DIR_KO: Record<RosterDirection, string> = { BOARD: "등원", ALIGHT: "하원" };
const rank = (w: number) => (w === 0 ? 7 : w); // 월 → 일 순서

function placeText(p: AssignPlace | null): string | null {
  if (!p) return null;
  return (p.name ?? "").trim() || p.address.trim() || null;
}

/** 다니는 수업 요약 — 같은 시각이면 요일을 묶는다(「월·수 17:00~17:55」). 휴원 수업은 뺀다. */
export function summarizeClasses(enrolled: readonly EnrolledClass[]): string {
  const byTime = new Map<string, number[]>();
  for (const c of enrolled) {
    if (c.status === "PAUSED") continue;
    const t = `${c.startTime}~${c.endTime}`;
    const list = byTime.get(t) ?? [];
    if (!list.includes(c.weekday)) list.push(c.weekday);
    byTime.set(t, list);
  }
  return [...byTime.entries()]
    .map(([t, days]) => `${days.sort((a, b) => rank(a) - rank(b)).map((d) => WEEKDAY_LABELS[d]).join("·")} ${t}`)
    .join(", ");
}

/**
 * 남은 칸 — 다니는(ACTIVE) 수업 요일 × 등원/하원 중, 그 달 명단에 이 학생의 같은 요일·방향 행이 없는 칸.
 * - 휴원(PAUSED) 수업은 칸을 만들지 않는다(휴원만 있는 학생은 칸 0 → 목록에서 빠진다).
 * - 「이미 있는지」는 관리자 명단이 학생을 묶는 규칙(studentRosterRows: 학생 id, 또는 이름+학부모 전화)으로 본다.
 * - 한 요일에 수업이 둘이면 등원은 이른 수업, 하원은 늦은 수업 칸으로 넣는다.
 */
export function openLegsFor(student: Pick<AssignStudentInput, "studentId" | "name" | "parentPhone" | "enrolled">, stops: readonly RegularShuttleStop[]): OpenLeg[] {
  const active = student.enrolled.filter((c) => c.status !== "PAUSED");
  // 명단 칸 글자는 그 달 명단의 같은 시작 시각 글자에 맞춘다(16:00~16:55 수업 → 「16:00~17:00」 칸).
  const slots = enrolledClassSlots(active, stops.map((s) => ({ weekday: s.weekday, classTime: s.classTime })));
  const riding = studentRosterRows(stops, { id: student.studentId, name: student.name, parentPhone: student.parentPhone });
  const out: OpenLeg[] = [];
  const weekdays = [...new Set(slots.map((s: { weekday: number }) => s.weekday))] as number[];
  for (const weekday of weekdays) {
    const daySlots = slots.filter((s: { weekday: number }) => s.weekday === weekday); // 시각 순(enrolledClassSlots 가 정렬)
    for (const direction of ["BOARD", "ALIGHT"] as const) {
      if (riding.some((r) => r.weekday === weekday && r.direction === direction)) continue; // 이미 운행표에 있음
      const slot = direction === "BOARD" ? daySlots[0] : daySlots[daySlots.length - 1];
      out.push({
        weekday, direction, classTime: slot.classTime, startTime: slot.enrolledTime.split("~")[0] ?? slot.classTime,
        label: `${WEEKDAY_LABELS[weekday]} ${DIR_KO[direction]}`,
      });
    }
  }
  return out.sort((a, b) => rank(a.weekday) - rank(b.weekday) || DIR_ORDER[a.direction] - DIR_ORDER[b.direction]);
}

/** 짧은 지문(djb2) — 운행표 칸의 행 id 순서가 같으면 같은 값. 화면을 연 뒤 순서가 바뀌었는지만 본다. */
export function routeVersionOf(route: readonly { rows: { rowId: string }[] }[]): string {
  const text = route.map((s) => s.rows.map((r) => r.rowId).join(",")).join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${route.length}-${h.toString(36)}`;
}

/** 추천 거리 계산에 쓸 학생 위치 — 학생 상세 위치(그 방향 → 반대 방향) 우선, 없으면 관리자 화면과 같은 규칙(resolveStudentPoint). */
function studentPointFor(student: AssignStudentInput, direction: RosterDirection, stops: readonly RegularShuttleStop[]): GeoPoint | null {
  const own = direction === "BOARD" ? student.pickup : student.dropoff;
  const other = direction === "BOARD" ? student.dropoff : student.pickup;
  const place = own ?? other;
  if (place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) return { lat: place.latitude, lng: place.longitude };
  const riding = studentRosterRows(stops, { id: student.studentId, name: student.name, parentPhone: student.parentPhone });
  return resolveStudentPoint({
    direction,
    draft: { stopName: "", latitude: null, longitude: null },
    rosterStops: stops,
    places: { pickup: student.pickup, dropoff: student.dropoff },
    riding,
  }).point;
}

/** 새 정류장에 쓸 학생 상세 위치(그 방향 → 반대 방향). */
function newStopPlace(student: AssignStudentInput, direction: RosterDirection): AssignPlace | null {
  return (direction === "BOARD" ? student.pickup : student.dropoff) ?? (direction === "BOARD" ? student.dropoff : student.pickup);
}

/** 다른 요일 정류장 식별값 — 이름(공백 무시)과 좌표가 같으면 같은 정류장. */
function otherStopKey(name: string, lat: number, lng: number): string {
  return `${normalizeStopName(name)}|${lat}|${lng}`;
}

/**
 * 같은 달 명단 전체에서 좌표 있는 고유 정류장(이름+좌표) 중 그 칸에 없는 이름.
 * 그 칸에 같은 이름 정차가 있으면 뺀다 — 고르면 기사님 화면에서 그 정차로 합쳐지므로 「그 칸 정차」 후보와 같다.
 */
function otherDayStops(stops: readonly RegularShuttleStop[], cell: readonly { label: string }[]): OtherStop[] {
  const inCell = new Set(cell.map((s) => normalizeStopName(s.label)));
  const seen = new Map<string, OtherStop>();
  for (const s of stops) {
    if (s.direction !== "BOARD" && s.direction !== "ALIGHT") continue; // 운영 정차(PIVOT/RETURN) 제외
    const name = (s.stopName ?? "").trim();
    if (!name || inCell.has(normalizeStopName(name))) continue;
    const lat = s.latitude, lng = s.longitude;
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = otherStopKey(name, lat, lng);
    if (!seen.has(key)) seen.set(key, { key, name, lat, lng });
  }
  return [...seen.values()];
}

/** 다른 요일 정류장을 그 칸에 새 정차로 넣을 자리 — 관리자 추천 ③(추가 거리 최소)을 그대로 쓴다. */
function otherStopPosition(cell: Parameters<typeof suggestPlacement>[0]["stops"], direction: RosterDirection, o: OtherStop, academy: GeoPoint | null, depot: GeoPoint | null): number {
  // stopName 은 비운다(그 칸에 없는 이름이라 ① 이름 합류가 없음) · 반경 -1 = ② 가까운 정차 합류를 끈다.
  const s = suggestPlacement({ stops: cell, direction, stopName: "", student: { lat: o.lat, lng: o.lng }, academy, depot, joinRadiusMeters: -1 });
  return s.choice.kind === "INSERT" ? s.choice.position : cell.length;
}

/**
 * 한 칸의 배정 화면 재료 — 지금 운행 순서 · 「기존 정류장에 태우기」 후보 · 「새 정류장」 · 추천.
 * 추천은 관리자 학생 추가와 같은 suggestPlacement(같은 이름/300m 안 정차 합류, 아니면 운행 거리가 가장 적게 늘어나는 자리).
 */
export function planLeg(student: AssignStudentInput, leg: OpenLeg, stops: readonly RegularShuttleStop[], academy: GeoPoint | null, depot: GeoPoint | null): AssignLegPlan {
  const cell = findRouteCell(stops, leg.weekday, leg.classTime, leg.direction);
  const point = studentPointFor(student, leg.direction, stops);
  const place = newStopPlace(student, leg.direction);
  const placeName = place ? placeText(place) ?? "" : "";
  const suggestion = suggestPlacement({ stops: cell, direction: leg.direction, stopName: placeName, student: point, academy, depot });

  // 기사님 화면은 정류장 이름 글자로 정차를 묶는다 → 같은 이름이 이미 있으면 「새 정류장」이 아니라 그 정류장 합류가 된다.
  const clash = placeName ? cell.some((s: { label: string }) => normalizeStopName(s.label) === normalizeStopName(placeName)) : false;
  const newStop = place && placeName && !clash ? { name: placeName, address: place.address } : null;

  // ① 기존 정류장 후보: 학생 위치가 있으면 가까운 순(1km 안, 최대 3곳) + 추천, 없으면 그 칸 정차 전부(거리 모름).
  //    2026-11-05: 그 칸에 없는 「같은 달 다른 요일·반 정류장」도 거리순 후보에 넣는다(38m 정류장이 빠지고 97m 가 추천되던 버그).
  const sugJoin = suggestion.choice.kind === "JOIN" ? suggestion.choice.stopIndex : -1;
  type Cand = { stopIndex: number | null; other: OtherStop | null; d: number | null };
  let cands: Cand[] = cell.map((s: { lat: number | null; lng: number | null }, i: number) => ({
    stopIndex: i, other: null,
    d: point && s.lat != null && s.lng != null ? distanceMeters(point.lat, point.lng, s.lat, s.lng) : null,
  }));
  if (point) {
    for (const o of otherDayStops(stops, cell)) cands.push({ stopIndex: null, other: o, d: distanceMeters(point.lat, point.lng, o.lat, o.lng) });
  }
  // 추천: 이름이 같은 그 칸 정차(관리자 추천 ①)는 그대로 둔다. 아니면 합류 반경(300m, 기존 값) 안 후보 중
  //   장소명 출입구 일치(같은 단지 «후문» 등, 2026-11-09) → 없으면 가장 가까운 곳. 규칙은 stopNameMatch 한 곳.
  const sameName = sugJoin >= 0 && !!placeName && normalizeStopName(cell[sugJoin].label) === normalizeStopName(placeName);
  let rec: Cand | null = sugJoin >= 0 ? cands[sugJoin] : null;
  let recReason: string | null = sameName ? "이름 같음" : null;
  if (!sameName && point) {
    const labelOf = (c: Cand) => (c.other ? c.other.name : cell[c.stopIndex as number].label);
    const pick = pickNearbyStop(placeName, cands.map((c) => ({ label: labelOf(c), distanceMeters: c.d })), JOIN_RADIUS_METERS);
    if (pick) { rec = cands[pick.index]; recReason = pick.reason; }
  }
  if (point) {
    cands = cands.filter((c) => c === rec || (c.d != null && c.d <= JOIN_OPTION_RADIUS_METERS))
      .sort((a, b) => (a === rec ? -1 : b === rec ? 1 : (a.d ?? Infinity) - (b.d ?? Infinity)))
      .slice(0, JOIN_OPTION_LIMIT);
  } else if (rec) {
    cands = [rec, ...cands.filter((c) => c !== rec)];
  }
  const joinOptions: AssignJoinOption[] = cands.map((c) => c.other
    ? {
      stopIndex: null, key: c.other.key, otherDay: true,
      // 자리 = 관리자 추천 ③(운행 거리가 가장 적게 늘어나는 자리) — 합류 반경을 꺼서 그 칸 정차 합류로 바뀌지 않게.
      position: otherStopPosition(cell, leg.direction, c.other, academy, depot),
      label: c.other.name, distanceMeters: c.d == null ? null : Math.round(c.d), riders: 0, recommended: c === rec,
      recommendReason: c === rec ? recReason : null,
    }
    : {
      stopIndex: c.stopIndex, key: null, otherDay: false, position: null,
      label: cell[c.stopIndex as number].label, distanceMeters: c.d == null ? null : Math.round(c.d),
      riders: cell[c.stopIndex as number].rows.length, recommended: c === rec,
      recommendReason: c === rec ? recReason : null,
    });

  // 새 정류장 처음 자리 = 추천 끼울 자리, 추천이 합류면 그 정류장 바로 뒤.
  const defaultPosition = suggestion.choice.kind === "INSERT" ? suggestion.choice.position : Math.min(sugJoin + 1, cell.length);
  const toChoice = (o: AssignJoinOption): AssignChoice => (o.otherDay ? { kind: "OTHER", key: o.key as string } : { kind: "JOIN", stopIndex: o.stopIndex as number });
  const recOption = joinOptions.find((o) => o.recommended) ?? null;
  let defaultChoice: AssignChoice | null = recOption ? toChoice(recOption) : suggestion.choice;
  if (defaultChoice.kind === "INSERT" && !newStop) defaultChoice = joinOptions[0] ? toChoice(joinOptions[0]) : null;
  const blocked = !newStop && joinOptions.length === 0
    ? "학생 승차·하차 위치가 아직 없어 이 칸은 넣을 수 없어요. 학원에 위치 등록을 부탁해 주세요."
    : null;

  return {
    ...leg,
    key: `${leg.weekday}|${leg.direction}`,
    route: cell.map((s: { label: string; arriveTime: string | null; rows: { name: string }[] }) => ({ label: s.label, arriveTime: s.arriveTime, riders: s.rows.map((r) => r.name) })),
    routeVersion: routeVersionOf(cell),
    joinOptions,
    newStop,
    defaultChoice: blocked ? null : defaultChoice,
    defaultPosition,
    reason: suggestion.reason,
    blocked,
  };
}

/**
 * 재배정 칸의 추천 재료 — 그 방향 학생 위치를 «옛 칸 정류장»으로 바꿔 넘긴다.
 * 왜: 반만 바뀌었을 때 가장 흔한 답은 «같은 정류장 그대로»다. 옛 정류장 이름이 새 칸에 있으면 이름 같음 합류가,
 * 없으면 그 이름·좌표의 새 정차가 기본값이 된다. 옛 칸 좌표가 없으면 학생 상세 위치를 그대로 쓴다.
 */
function reassignHintStudent(student: AssignStudentInput, pair: ReassignPair): AssignStudentInput {
  const f = pair.from;
  if (f.latitude == null || f.longitude == null || !Number.isFinite(f.latitude) || !Number.isFinite(f.longitude) || !f.stopName.trim()) return student;
  const place: AssignPlace = { name: f.stopName, address: "", latitude: f.latitude, longitude: f.longitude };
  return pair.direction === "BOARD" ? { ...student, pickup: place } : { ...student, dropoff: place };
}

/** 재배정 칸 하나의 화면 재료 — planLeg(같은 추천·같은 지문) + 옛 칸 정보. */
function planReassignLeg(student: AssignStudentInput, pair: ReassignPair, stops: readonly RegularShuttleStop[], academy: GeoPoint | null, depot: GeoPoint | null): AssignLegPlan {
  const plan = planLeg(reassignHintStudent(student, pair), pair.to, stops, academy, depot);
  return {
    ...plan,
    reassign: { label: pair.label, fromWeekday: pair.from.weekday, fromClassTime: pair.from.classTime, fromStopName: pair.from.stopName, replaceRowIds: [...pair.from.rowIds] },
  };
}

/**
 * 학생 목록 → 화면 목록. 남은 칸이 0 인 학생(이미 다 들어감·휴원만 있음)은 뺀다.
 * - 신규 칸: 승인 셔틀 신청 학생만(hasApplication !== false), 기존 규칙(openLegsFor) 그대로.
 * - 재배정 칸(2026-11-09 D4): 명단에 행이 있는 학생 모두. 같은 요일·방향이 신규로도 잡히면 재배정이 우선(옛 칸도 함께 정리해야 하므로).
 */
export function buildAssignBoard(input: {
  students: readonly AssignStudentInput[];
  stops: readonly RegularShuttleStop[];
  academy: GeoPoint | null;
  depot: GeoPoint | null;
}): AssignStudentPlan[] {
  const out: AssignStudentPlan[] = [];
  for (const s of input.students) {
    const pairs = planStudentReassign(s, input.stops).pairs as ReassignPair[];
    const reassignKeys = new Set(pairs.map((p) => `${p.to.weekday}|${p.direction}`));
    const fresh = s.hasApplication === false ? [] : openLegsFor(s, input.stops).filter((l) => !reassignKeys.has(`${l.weekday}|${l.direction}`));
    if (fresh.length === 0 && pairs.length === 0) continue;
    const legs = [
      ...fresh.map((leg) => planLeg(s, leg, input.stops, input.academy, input.depot)),
      ...pairs.map((p) => planReassignLeg(s, p, input.stops, input.academy, input.depot)),
    ].sort((a, b) => rank(a.weekday) - rank(b.weekday) || DIR_ORDER[a.direction] - DIR_ORDER[b.direction]);
    out.push({
      studentId: s.studentId, name: s.name, grade: s.grade, wishTime: s.wishTime,
      classes: summarizeClasses(s.enrolled),
      pickup: placeText(s.pickup), dropoff: placeText(s.dropoff),
      legs,
    });
  }
  return out;
}

// ── 저장 요청 검사·변환 ─────────────────────────────────────────

export type AssignRequest = {
  month: string;
  studentId: string;
  weekday: number;
  direction: RosterDirection;
  choice: AssignChoice;
  routeVersion: string;
  includeNextMonth: boolean;
  /** 반 이동 재배정 칸 넣기(새 칸 추가 + 옛 칸 삭제). 지울 옛 행은 서버가 다시 계산한다. */
  reassign: boolean;
};

const BAD_REQUEST = "요청 형식이 올바르지 않습니다.";

/** POST 본문 검사 — 형식만 본다(자격·빈 칸 여부는 서버가 DB 로 다시 본다). */
export function parseAssignRequest(raw: unknown): AssignRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const o = raw as Record<string, unknown>;
  const month = typeof o.month === "string" ? o.month.trim() : "";
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const studentId = typeof o.studentId === "string" ? o.studentId.trim() : "";
  if (!studentId || studentId.length > 64) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const weekday = o.weekday;
  if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const direction = o.direction === "BOARD" || o.direction === "ALIGHT" ? o.direction : null;
  if (!direction) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const c = o.choice as Record<string, unknown> | null;
  const isIndex = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 500;
  let choice: AssignChoice;
  if (c && c.kind === "JOIN" && isIndex(c.stopIndex)) choice = { kind: "JOIN", stopIndex: c.stopIndex as number };
  else if (c && c.kind === "OTHER" && typeof c.key === "string" && c.key.length > 0 && c.key.length <= 300) choice = { kind: "OTHER", key: c.key };
  else if (c && c.kind === "INSERT" && isIndex(c.position)) choice = { kind: "INSERT", position: c.position as number };
  else throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  const routeVersion = typeof o.routeVersion === "string" ? o.routeVersion.slice(0, 64) : "";
  if (!routeVersion) throw new DriverAssignError(BAD_REQUEST, 400, "BAD_REQUEST");
  return { month, studentId, weekday, direction, choice, routeVersion, includeNextMonth: o.includeNextMonth !== false, reassign: o.reassign === true };
}

export const ROUTE_CHANGED = "운행표가 그사이 바뀌었어요. 새 순서를 다시 불러왔어요.";
export const ALREADY_ASSIGNED = "이미 운행표에 있어요.";

/**
 * 서버 재검사 + addRosterStudent 입력 만들기.
 * student 는 서버가 DB 에서 다시 읽은 「승인된 셔틀 신청 + 다니는 수업」 학생이다(클라이언트 값을 믿지 않는다).
 * - 그 요일·방향이 다니는 수업 칸이 아니거나 이미 명단에 있으면 409
 * - 화면을 연 뒤 그 칸 순서가 바뀌었으면 409(다시 불러오기)
 * - 고른 자리는 관리자 화면과 같은 resolveCellPlacement 로 「기준 행 id·시각」을 다시 계산한다.
 */
export function buildAssignAddInput(req: AssignRequest, student: AssignStudentInput, stops: readonly RegularShuttleStop[], academy: GeoPoint | null, depot: GeoPoint | null): Record<string, unknown> {
  // 「다니는 수업 요일인지」를 먼저 본다 — 이미 들어간 칸과 처음부터 없는 칸을 구분해 안내한다.
  const active = student.enrolled.filter((c) => c.status !== "PAUSED");
  if (!active.some((c) => c.weekday === req.weekday)) throw new DriverAssignError("이 요일에 다니는 수업이 없어요.", 409, "NOT_CLASS_DAY");
  const leg = openLegsFor(student, stops).find((l) => l.weekday === req.weekday && l.direction === req.direction);
  if (!leg) throw new DriverAssignError(ALREADY_ASSIGNED, 409, "ALREADY_ASSIGNED");
  return addInputForLeg(req, student, leg, stops, academy, depot);
}

/**
 * 한 칸의 저장 입력(신규·재배정 공용) — 화면을 연 뒤 순서가 바뀌었는지 확인하고, 고른 자리를 다시 계산한다.
 * student 는 그 칸 추천에 쓴 학생 재료(재배정이면 옛 칸 정류장으로 바꾼 것)다 — 화면과 같은 지문·후보가 나와야 한다.
 */
function addInputForLeg(req: AssignRequest, student: AssignStudentInput, leg: OpenLeg, stops: readonly RegularShuttleStop[], academy: GeoPoint | null, depot: GeoPoint | null): Record<string, unknown> {
  const plan = planLeg(student, leg, stops, academy, depot);
  if (plan.routeVersion !== req.routeVersion) throw new DriverAssignError(ROUTE_CHANGED, 409, "ROUTE_CHANGED");
  if (plan.blocked) throw new DriverAssignError(plan.blocked, 409, "LOCATION_REQUIRED");

  const n = plan.route.length;
  const asked = req.choice;
  if (asked.kind === "JOIN" && asked.stopIndex >= n) throw new DriverAssignError(ROUTE_CHANGED, 409, "ROUTE_CHANGED");
  if (asked.kind === "INSERT" && (asked.position > n || !plan.newStop)) throw new DriverAssignError(ROUTE_CHANGED, 409, "ROUTE_CHANGED");
  // 다른 요일 정류장 = 화면에 보여 준 후보 중 같은 key 만(그사이 명단이 바뀌어 없으면 다시 불러오기).
  const other = asked.kind === "OTHER" ? plan.joinOptions.find((o) => o.otherDay && o.key === asked.key) : undefined;
  const otherStop = other ? otherDayStops(stops, plan.route).find((o) => o.key === other.key) ?? null : null;
  if (asked.kind === "OTHER" && (!other || !otherStop || other.position == null || other.position > n)) throw new DriverAssignError(ROUTE_CHANGED, 409, "ROUTE_CHANGED");
  // 다른 요일 정류장은 관리자와 같은 「새 정차(INSERT)」로 넣는다 — 자리는 화면에 보여 준 그 자리.
  const choice: PlacementChoice = asked.kind === "OTHER" ? { kind: "INSERT", position: other!.position as number } : asked;

  const place = newStopPlace(student, req.direction);
  const res = resolveCellPlacement({
    stops, weekday: leg.weekday, classTime: leg.classTime, direction: leg.direction,
    stopName: otherStop?.name ?? plan.newStop?.name ?? "",
    // 시각 보간은 실제로 차가 서는 곳(다른 요일 정류장이면 그 정류장 좌표) 기준.
    student: otherStop ? { lat: otherStop.lat, lng: otherStop.lng } : studentPointFor(student, req.direction, stops),
    academy, depot, studentId: student.studentId, override: { choice },
  });
  // 정류장 값: 합류 = 그 정류장 이름(이름·좌표·시각은 서버가 대상 행에서 복사), 다른 요일 정류장 = 그 이름·좌표, 새 정류장 = 학생 상세 위치.
  const stop = choice.kind === "JOIN"
    ? { stopName: res.stops[choice.stopIndex].label, arriveTime: null, latitude: null, longitude: null }
    : otherStop
      ? { stopName: otherStop.name, arriveTime: res.arriveTime, latitude: otherStop.lat, longitude: otherStop.lng }
      : { stopName: plan.newStop!.name, arriveTime: res.arriveTime, latitude: place!.latitude, longitude: place!.longitude };
  const placement: Record<string, unknown> = {
    weekday: leg.weekday, classTime: leg.classTime, direction: leg.direction, mode: res.request.mode, rowId: res.request.rowId,
  };
  if (choice.kind === "INSERT") placement.arriveTime = res.arriveTime;
  return {
    serviceMonth: req.month,
    scope: req.includeNextMonth ? "FROM_THIS_MONTH" : "THIS_MONTH",
    studentId: student.studentId,
    studentName: student.name,
    slots: [{ weekday: leg.weekday, classTime: leg.classTime }],
    board: leg.direction === "BOARD" ? stop : null,
    alight: leg.direction === "ALIGHT" ? stop : null,
    placements: [placement],
  };
}

export const NOT_REASSIGN = "이 칸은 재배정할 칸이 아니에요. 화면을 새로 불러와 주세요.";

/**
 * 재배정 저장 입력 — 서버가 다시 읽은 수강·명단으로 재배정 짝을 다시 계산해, 고른 요일·방향의 짝을 찾는다.
 * 지울 옛 행(replaceRowIds)도 여기서 정한다(화면이 보낸 값은 쓰지 않는다).
 */
export function buildReassignAddInput(req: AssignRequest, student: AssignStudentInput, stops: readonly RegularShuttleStop[], academy: GeoPoint | null, depot: GeoPoint | null): { input: Record<string, unknown>; replaceRowIds: string[]; pair: ReassignPair } {
  const pair = (planStudentReassign(student, stops).pairs as ReassignPair[]).find((p) => p.to.weekday === req.weekday && p.direction === req.direction);
  if (!pair) throw new DriverAssignError(NOT_REASSIGN, 409, "NOT_REASSIGN");
  const input = addInputForLeg(req, reassignHintStudent(student, pair), pair.to, stops, academy, depot);
  return { input, replaceRowIds: [...pair.from.rowIds], pair };
}

/**
 * 재배정 트랜잭션 안(달 잠금 뒤) 마지막 확인 — 잠금 안 명단으로 짝을 다시 계산해 같은 옛 행·같은 새 칸인지 본다.
 * 그사이 누가 옛 칸을 지웠거나 새 칸을 넣었으면 409(다시 불러오기).
 */
export function assertReassignStillOpen(rows: readonly RegularShuttleStop[], student: AssignStudentInput, pair: Pick<ReassignPair, "direction" | "from" | "to">): void {
  const again = (planStudentReassign(student, rows).pairs as ReassignPair[]).find((p) => p.to.weekday === pair.to.weekday && p.direction === pair.direction);
  const same = again && again.from.rowIds.length === pair.from.rowIds.length && again.from.rowIds.every((id) => pair.from.rowIds.includes(id));
  if (!same) throw new DriverAssignError(ROUTE_CHANGED, 409, "ROUTE_CHANGED");
}

/** 트랜잭션 안(달 잠금 뒤) 마지막 확인 — 그 사이 다른 사람이 같은 칸을 넣었으면 409. */
export function assertLegStillOpen(rows: readonly RegularShuttleStop[], student: Pick<AssignStudentInput, "studentId" | "name" | "parentPhone">, weekday: number, direction: RosterDirection): void {
  const riding = studentRosterRows(rows, { id: student.studentId, name: student.name, parentPhone: student.parentPhone });
  if (riding.some((r) => r.weekday === weekday && r.direction === direction)) throw new DriverAssignError(ALREADY_ASSIGNED, 409, "ALREADY_ASSIGNED");
}
