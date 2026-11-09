// 학생 셔틀 위치(StudentShuttleLocation) 수정 → 셔틀 명단 정류장 반영 계획(순수 함수, DB 접근 없음) — 2026-11-09 원장 결정 D3.
// ─────────────────────────────────────────────────────────────────────────────
// 왜(허재원 사례): 학생 상세에서 위치를 고쳐도 명단(RegularShuttleStop)엔 안 가서 기사님은 옛 곳에 섰다.
// 원장 결정(단순화): 확인 창 없이 «이번 달부터» 그 학생의 해당 방향 칸(PICKUP→등원, DROPOFF→하원)에 바로 반영한다.
//   - 300m 안에 이름이 맞는 기존 정류장이 있으면 그 정류장 이름·좌표로 합류(기사님 화면에서 같은 정차로 묶인다).
//       이름이 맞는다 = ① 공백·표기(e편한/이편한)·꼬리말(아파트·단지)만 다른 같은 이름, 또는
//                      ② 같은 단지 + 같은 출입구(정문·후문…) — stopNameMatch.pickNearbyStop 의 «이름 일치».
//     «가장 가까움»만으로는 합류하지 않는다(길 건너 다른 단지 정류장으로 옮겨 가는 사고 방지).
//   - 없으면 새 위치 그대로(장소명 = 정류장 이름, 장소명 필수는 저장 쪽이 막는다).
// 행 id 는 유지(UPDATE)한다 — 탑승 체크 키라서 지우고 다시 넣으면 그날 체크가 끊긴다. 순서·시각은 건드리지 않는다.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다(런타임 import 는 .ts 확장자).

// @ts-expect-error -- TypeScript runtime test compatibility
import { studentRosterRows } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { distanceMeters } from "../seasonal/stopMerge.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { NAME_MATCH_RADIUS_METERS, normalizePlaceName, pickNearbyStop } from "./stopNameMatch.ts";
import type { RegularShuttleStop } from "./regularSheet";

export type LocationKind = "PICKUP" | "DROPOFF";
export type LocationApplyPlace = { name: string; latitude: number; longitude: number };

export type LocationApplyPlan = {
  direction: "BOARD" | "ALIGHT";
  /** 실제로 바뀌는 이 학생 행(이미 같은 이름·좌표면 빠진다). 비면 바꿀 것 없음. */
  rowIds: string[];
  /** 그 학생의 해당 방향 행 전체(바뀌지 않는 행 포함). */
  allRowIds: string[];
  stopName: string;
  latitude: number;
  longitude: number;
  /** NAME = 근처 기존 정류장에 합류, NEW = 새 위치 그대로. */
  by: "NAME" | "NEW";
  /** 짧은 이유(감사 기록·알림 문구용). */
  reason: string;
};

export function kindToDirection(kind: LocationKind): "BOARD" | "ALIGHT" {
  return kind === "PICKUP" ? "BOARD" : "ALIGHT";
}

/** 같은 좌표인지(소수 6자리 ≈ 0.1m). */
function sameCoord(a: number | null | undefined, b: number): boolean {
  return a != null && Number.isFinite(a) && Math.abs(a - b) < 1e-6;
}

/**
 * 그 달 명단(stops)에서 이 학생의 kind 방향 행을 새 위치로 맞추는 계획. 이 학생 행이 없으면 null.
 * 합류 후보 = 그 달 다른 학생의 등·하원 정류장(좌표 있는 것, 이름+좌표로 하나씩).
 */
export function planLocationApply(
  stops: readonly RegularShuttleStop[],
  student: { id: string; name: string; parentPhone: string | null },
  kind: LocationKind,
  place: LocationApplyPlace,
): LocationApplyPlan | null {
  const direction = kindToDirection(kind);
  const mine = (studentRosterRows(stops, student) as RegularShuttleStop[]).filter((r) => r.direction === direction && r.id);
  if (mine.length === 0) return null;
  const mineIds = new Set(mine.map((r) => r.id as string));

  // 후보 정류장(이 학생 행 제외, 좌표 있는 등·하원 정류장만, 이름+좌표 단위로 하나씩).
  const seen = new Set<string>();
  const cands: { label: string; lat: number; lng: number; d: number }[] = [];
  for (const s of stops) {
    if ((s.direction !== "BOARD" && s.direction !== "ALIGHT") || (s.id && mineIds.has(s.id))) continue;
    const label = (s.stopName ?? "").trim();
    const lat = s.latitude, lng = s.longitude;
    if (!label || lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const key = `${label}|${lat}|${lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({ label, lat, lng, d: distanceMeters(place.latitude, place.longitude, lat, lng) });
  }

  // ① 같은 이름(표기만 다른) 300m 안 → 가장 가까운 것.
  const want = normalizePlaceName(place.name);
  const exact = cands.filter((c) => c.d <= NAME_MATCH_RADIUS_METERS && want !== "" && normalizePlaceName(c.label) === want)
    .sort((a, b) => a.d - b.d)[0];
  // ② 같은 단지 + 같은 출입구(이름 일치만 — «가장 가까움»으로는 합류하지 않는다).
  const pick = exact ? null : pickNearbyStop(place.name, cands.map((c) => ({ label: c.label, distanceMeters: c.d })), NAME_MATCH_RADIUS_METERS);
  const gate = pick && pick.by === "NAME" ? cands[pick.index] : null;
  const hit = exact ?? gate;

  const target = hit
    ? { stopName: hit.label, latitude: hit.lat, longitude: hit.lng, by: "NAME" as const,
        reason: `${Math.round(hit.d)}m 안 기존 정류장 «${hit.label}»에 합류` }
    : { stopName: place.name.trim(), latitude: place.latitude, longitude: place.longitude, by: "NEW" as const,
        reason: "새 위치를 정류장으로" };
  const rowIds = mine
    .filter((r) => r.stopName !== target.stopName || !sameCoord(r.latitude, target.latitude) || !sameCoord(r.longitude, target.longitude))
    .map((r) => r.id as string);
  return { direction, rowIds, allRowIds: mine.map((r) => r.id as string), ...target };
}
