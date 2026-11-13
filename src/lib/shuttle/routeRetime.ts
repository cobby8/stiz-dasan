// 정규 셔틀 «순서를 옮기면 시각을 다시 계산» — 순수 함수(브라우저·서버·테스트 공용, 외부 의존 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가? (2026-11-13 원장 결정)
//   예전엔 순서를 옮기면 «시각 칸은 자리에 남고 정류장만 갈아 끼웠다». 그래서 1호점(14:36)을 맨 뒤로 옮기면
//   1호점이 원래 플루리움에 도착하던 14:49 를 받는 식으로, 운행할 수 없는 시간표가 저장됐다.
//
// 규칙 (원장 예: 첫 탑승 14:30 · 학원 도착 15:00 에서 14:35 정류장을 14:55 자리로 옮기면
//        그 사이 정류장들은 첫 탑승을 고정한 채 조금씩 앞으로 당겨져야 운행이 된다)
//   · 등원: «첫 탑승 시각» 고정. 이후 정류장 = 앞 정류장 시각 + 두 정류장 사이 이동 시간.
//           마지막 정류장 + 학원까지 이동 시간 = 학원 도착 예상(수업 시작과 비교는 화면이 한다).
//   · 하원: «학원 출발 시각» 고정(= 원래 첫 하차 시각 − 학원→그 정류장 이동 시간, 아이들 하차 여유 보존).
//           이후는 등원과 같이 이동 시간을 쌓는다. 학원 좌표가 없으면 첫 하차 시각을 고정한다.
//   · 이동 시간 = 지도(T맵 실도로) 분. 없으면 직선거리 추정.
//   · «기사님 실제 속도» 보정: 옮기기 전 순서의 실제 운행 시간 ÷ 같은 순서의 지도 시간 = 배율.
//     지도 시간엔 아이 태우는 시간이 빠져 있어, 이 배율을 곱해야 지금 운행 감각과 같은 시간표가 된다.
//   · 좌표 없는 정류장이 있으면 계산하지 않는다(ok:false) — 호출부가 옛 방식으로 두고 «직접 확인»을 띄운다.

export type RetimePoint = { lat: number; lng: number };
export type RetimeStop = { key: string; label: string; time: string | null; point: RetimePoint | null };
/** 두 지점 사이 지도 이동 분. 모르면 null(→ 직선 추정). */
export type LegMinutes = (a: RetimePoint, b: RetimePoint) => number | null;

export type RetimeResult =
  | {
      ok: true;
      /** 정류장 key → 새 시각 'HH:MM'. */
      times: Record<string, string>;
      /** 등원: 학원 도착 예상 / 하원: null. */
      arrival: string | null;
      /** 하원: 학원 출발 시각 / 등원: null. */
      departure: string | null;
      /** 적용한 «기사님 속도» 배율(지도 시간 × 배율 = 실제 운행 시간). */
      pace: number;
      /** 지도 시간을 못 받아 직선 추정을 한 구간이 하나라도 있으면 true. */
      estimated: boolean;
    }
  | { ok: false; reason: string };

// 직선 → 도로 보정과 평균 속도(동네 길·신호 포함). 지도 시간을 못 받을 때만 쓴다.
const ROAD_FACTOR = 1.4;
const AVG_KMH = 25;
// 배율이 터무니없이 튀지 않게(시각 오타·같은 시각 연속 등) 묶어 둔다.
const PACE_MIN = 0.6;
const PACE_MAX = 3;

function haversineMeters(a: RetimePoint, b: RetimePoint): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 직선거리로 어림한 이동 분. */
export function straightLineMinutes(a: RetimePoint, b: RetimePoint): number {
  return (haversineMeters(a, b) * ROAD_FACTOR) / ((AVG_KMH * 1000) / 60);
}

export function parseHHMM(t: string | null | undefined): number | null {
  const m = typeof t === "string" ? /^(\d{1,2}):(\d{2})$/.exec(t.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

export function formatHHMM(minutes: number): string {
  const v = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** 묶음 키(R:<수업시간>:board|alight)에서 수업 시작·끝 'HH:MM'. 모르면 null. */
export function classWindowOfGroupKey(groupKey: string): { start: string | null; end: string | null } {
  const m = /(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/.exec(groupKey);
  return m ? { start: m[1].padStart(5, "0"), end: m[2].padStart(5, "0") } : { start: null, end: null };
}

/** 같은 지점 쌍을 한 번만 묻도록 쓰는 캐시 키. */
export function legKey(a: RetimePoint, b: RetimePoint): string {
  return `${a.lat.toFixed(6)},${a.lng.toFixed(6)}>${b.lat.toFixed(6)},${b.lng.toFixed(6)}`;
}

/**
 * 계산에 필요한 지점 쌍(지도 시간을 미리 받아 둘 목록) — 옮기기 전·후 순서의 이웃 쌍 + 학원 구간.
 * 같은 좌표끼리(0m)는 묻지 않는다.
 */
export function neededLegs(input: { direction: "BOARD" | "ALIGHT"; before: RetimeStop[]; after: RetimeStop[]; academy: RetimePoint | null }): [RetimePoint, RetimePoint][] {
  const out = new Map<string, [RetimePoint, RetimePoint]>();
  const add = (a: RetimePoint | null, b: RetimePoint | null) => {
    if (!a || !b || (a.lat === b.lat && a.lng === b.lng)) return;
    out.set(legKey(a, b), [a, b]);
  };
  for (const list of [input.before, input.after]) {
    for (let i = 1; i < list.length; i++) add(list[i - 1].point, list[i].point);
    if (list.length === 0) continue;
    if (input.direction === "BOARD") add(list[list.length - 1].point, input.academy);
    else add(input.academy, list[0].point);
  }
  return [...out.values()];
}

/**
 * 순서를 옮긴 한 묶음(한 수업 × 등원 또는 하원)의 새 시각.
 * before = 옮기기 전 순서·시각(배율·하원 출발 기준) · after = 새 순서(같은 정류장들).
 * anchorTime(등원) = 지금 화면의 첫 탑승 시각(원장이 고쳤으면 그 값). 없으면 before 맨 앞 시각.
 */
export function retimeRun(input: {
  direction: "BOARD" | "ALIGHT";
  before: RetimeStop[];
  after: RetimeStop[];
  anchorTime?: string | null;
  academy: RetimePoint | null;
  legMinutes?: LegMinutes;
}): RetimeResult {
  const { direction, before, after, academy } = input;
  if (after.length === 0) return { ok: true, times: {}, arrival: null, departure: null, pace: 1, estimated: false };
  const noPoint = after.filter((s) => !s.point).map((s) => s.label);
  if (noPoint.length > 0) return { ok: false, reason: `위치(좌표)가 없는 정류장이 있어 시각을 자동 계산하지 못했어요: ${noPoint.join(", ")}` };

  let estimated = false;
  const leg = (a: RetimePoint, b: RetimePoint): number => {
    if (a.lat === b.lat && a.lng === b.lng) return 0;
    const m = input.legMinutes?.(a, b);
    if (typeof m === "number" && Number.isFinite(m) && m >= 0) return m;
    estimated = true;
    return straightLineMinutes(a, b);
  };

  // ① 기사님 속도 배율 — 옮기기 전 순서에서 시각·좌표가 다 있는 «처음~끝» 구간의 실제 시간 ÷ 지도 시간.
  let pace = 1;
  const timed = before.filter((s) => s.point && parseHHMM(s.time) != null);
  if (timed.length >= 2 && timed.length === before.length) {
    const observed = parseHHMM(timed[timed.length - 1].time)! - parseHHMM(timed[0].time)!;
    let predicted = 0;
    for (let i = 1; i < timed.length; i++) predicted += leg(timed[i - 1].point!, timed[i].point!);
    if (observed > 0 && predicted >= 1) pace = Math.min(PACE_MAX, Math.max(PACE_MIN, observed / predicted));
  }

  // ② 기준 시각.
  let start: number; // after[0] 의 시각(분)
  let departure: number | null = null;
  if (direction === "BOARD") {
    const anchor = parseHHMM(input.anchorTime ?? null) ?? parseHHMM(before[0]?.time);
    if (anchor == null) return { ok: false, reason: "첫 탑승 시각이 없어 시각을 자동 계산하지 못했어요. 맨 앞 정류장 시각을 먼저 넣어 주세요." };
    start = anchor;
  } else {
    const first = before[0];
    const firstTime = parseHHMM(first?.time);
    if (firstTime == null) return { ok: false, reason: "첫 하차 시각이 없어 시각을 자동 계산하지 못했어요. 맨 앞 정류장 시각을 먼저 넣어 주세요." };
    if (academy && first.point) {
      departure = firstTime - leg(academy, first.point) * pace;
      start = departure + leg(academy, after[0].point!) * pace;
    } else {
      start = firstTime; // 학원 좌표를 모르면 첫 하차 시각을 고정한다.
    }
  }

  // ③ 이동 시간 쌓기(분 단위 소수는 쌓은 뒤 마지막에만 반올림 — 반올림 오차가 누적되지 않게).
  const times: Record<string, string> = {};
  let t = start;
  times[after[0].key] = formatHHMM(t);
  for (let i = 1; i < after.length; i++) {
    t += leg(after[i - 1].point!, after[i].point!) * pace;
    times[after[i].key] = formatHHMM(t);
  }
  const arrival = direction === "BOARD" && academy ? formatHHMM(t + leg(after[after.length - 1].point!, academy) * pace) : null;
  return { ok: true, times, arrival, departure: departure == null ? null : formatHHMM(departure), pace, estimated };
}
