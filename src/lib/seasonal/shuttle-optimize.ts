import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { routeSegmentsWithTmap, type SegmentsRouteResult } from "@/lib/shuttle/tmap";
// 태울 학생 판정은 절대 여기서 하지 않는다. 게이트웨이 한 곳만 통과한다.
// (여기서 WHERE 절을 손으로 다시 쓰다가 취소자·폐강 반 학생이 배차에 실리는 사고가 5번 반복됐다.)
import { getConfirmedShuttleRosterForDate } from "./shuttleRoster";
import { getSavedDispatchRoute } from "./dispatchRoute";
import { firstDateOfSameWeekday } from "./weekday";
// 정차 병합의 단일 기준(같은 장소 판정). 자동 제안·증분 배차·화면 배정이 모두 이걸 쓴다.
import { findSamePlaceIndex } from "./stopMerge";
import { planIncrementalInsert, type IncrTarget } from "./dispatchIncrement";
import { mergeTmapRoute, type RunRouteFields } from "./tmapRouteMerge";
// 구간 실제시간 → 방향별 stop ETA 누적(순수 함수). 테스트가 prisma 없이 검증하도록 분리했다.
import { segmentMinutes, nodeTimesFromSegments } from "./shuttle-eta";

// 방학특강 셔틀 노선 자동 제안 엔진.
// - 그 날짜에 실제 등원(SCHEDULED)하는 셔틀 학생만 배차(요일별 반복 스케줄 반영).
// - 정차 순서는 T맵 경유지 최적화(실도로) 우선, 실패/키없음 시 직선거리 최근접(NN)으로 폴백.
// - 차고지(하루 운행 시작점)를 등원의 출발, 하원의 복귀 지점으로 사용한다.
// - 예상 시각은 T맵 총 소요시간을 정차 간 거리 비율로 배분해 계산(폴백은 직선거리 기준).

type Geo = { lat: number; lng: number; name: string };
const ACADEMY_FALLBACK: Geo = { lat: 37.6145625, lng: 127.1563125, name: "STIZ 다산점" };

const ROAD_FACTOR = 1.3, SPEED_KM_PER_MIN = 0.4;
const MIN_PER_KM = ROAD_FACTOR / SPEED_KM_PER_MIN;
// PICKUP_BUFFER_MIN: 수업 시작 **몇 분 전에 학원에 도착**시킬지. 등원 시각은 이 도착 시각에서
//   T맵 구간시간을 거꾸로 빼며 역산되므로(planRun), 이 값이 곧 전체 등원 시간표의 기준점이다.
//   2026-08-03 원장 지시로 10 → 5 (수업 09:30 → 학원 도착 09:25).
//   ⚠️ 정규 셔틀도 같은 엔진(buildDispatchFromRiders)을 쓰므로 함께 5분 전 도착이 된다.
//      이미 저장된 노선은 바뀌지 않는다 — 그 노선을 다시 계산할 때부터 적용된다.
const STOP_DWELL_MIN = 1.5, PICKUP_BUFFER_MIN = 5, DROPOFF_BUFFER_MIN = 5;

export type DispatchDirection = "PICKUP" | "DROPOFF";
type Pt = { lat: number; lng: number };
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

export async function getSettings(): Promise<{ academy: Geo; depot: Geo | null; hub: Geo | null; hubDropoff: Geo | null }> {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "academyLatitude" AS alat, "academyLongitude" AS alng, "academyAddress" AS aaddr,
              "shuttleDepotLatitude" AS dlat, "shuttleDepotLongitude" AS dlng, "shuttleDepotAddress" AS daddr,
              "shuttleHubLatitude" AS hlat, "shuttleHubLongitude" AS hlng, "shuttleHubName" AS hname,
              "shuttleHubDropoffLatitude" AS xlat, "shuttleHubDropoffLongitude" AS xlng, "shuttleHubDropoffName" AS xname, "shuttleHubDropoffAddress" AS xaddr
         FROM "AcademySettings" LIMIT 1`,
    );
    const r = rows[0] ?? {};
    const alat = Number(r.alat), alng = Number(r.alng);
    const academy: Geo = Number.isFinite(alat) && Number.isFinite(alng)
      ? { lat: alat, lng: alng, name: r.aaddr ? `STIZ 다산점 · ${r.aaddr}` : "STIZ 다산점" }
      : ACADEMY_FALLBACK;
    const dlat = Number(r.dlat), dlng = Number(r.dlng);
    const depot: Geo | null = Number.isFinite(dlat) && Number.isFinite(dlng)
      ? { lat: dlat, lng: dlng, name: r.daddr ? `차고지 · ${r.daddr}` : "차고지" } : null;
    const hlat = Number(r.hlat), hlng = Number(r.hlng);
    const hub: Geo | null = Number.isFinite(hlat) && Number.isFinite(hlng)
      ? { lat: hlat, lng: hlng, name: (r.hname && String(r.hname)) || "무료 탑승 거점" } : null;
    const xlat = Number(r.xlat), xlng = Number(r.xlng);
    const hubDropoff: Geo | null = Number.isFinite(xlat) && Number.isFinite(xlng)
      ? { lat: xlat, lng: xlng, name: (r.xname && String(r.xname)) || (r.xaddr && String(r.xaddr)) || "거점 하차 지점" } : null;
    return { academy, depot, hub, hubDropoff };
  } catch { return { academy: ACADEMY_FALLBACK, depot: null, hub: null, hubDropoff: null }; }
}

function haversineKm(a: Pt, b: Pt): number {
  const R = 6371, toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function segMin(a: Pt, b: Pt): number { return haversineKm(a, b) * MIN_PER_KM + STOP_DWELL_MIN; }

function hhmmToMin(t: string | null): number | null { if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function minToHHMM(x: number): string { const v = Math.max(0, Math.round(x)); return `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; }
function pinnedSrc(s: unknown) { return s === "MAP_PIN" || s === "CURRENT_LOCATION"; }
// 무료탑승 거점에서 타는 학생 판정 — 명단 화면(isFreeHubRow)과 같은 기준(라벨에 '무료탑승' 포함).
function isFreeHubLabel(label: string | null | undefined): boolean {
  return (label ?? "").replace(/\s/g, "").includes("무료탑승");
}

// rosterId(확정본) 또는 requestId(원본)로 그 학생의 명단 행을 되짚는다. 화면에서 무료탑승으로 옮길 때 쓴다.
// isAbsent: **저장되지 않는 파생값**. 노선을 읽을 때 그날 출결로 매번 다시 계산해 붙인다(reconcile).
//   기사님 화면의 '결석예정' 뱃지 전용이며, 관리자 노선표·인원수·정원 판정에는 절대 쓰지 않는다.
//   저장 시 saveDispatchRoute가 떼어낸다 — payload에 남으면 다음 주에도 결석으로 따라온다.
type StopStudent = { name: string; grade: string | null; parentPhone: string | null; childPhone: string | null; rosterId: string | null; requestId: string; pickupLabel: string; applicationId: string | null; isAbsent?: boolean };
// etaMinutes: 그 정차의 승/하차 예상 시각을 '자정 기준 분'으로 담는 숫자 필드.
// T2에서 정차별 '확정시간 편집'을 붙일 때 문자열 라벨 파싱 없이 이 숫자를 직접 쓴다.
// etaManual: 관리자가 그 정차 시각을 손으로 고쳐 '확정'한 값(자정 기준 분). 있으면 표시·저장 기준이 되고
//   재계산해도 자동값(etaMinutes)으로 덮이지 않는다(T2). 서버는 자동값만 계산하고 이 필드는 클라가 오버레이한다.
type Stop = { lat: number; lng: number; label: string; students: StopStudent[]; approx: boolean; isHub?: boolean; etaLabel?: string; etaMinutes?: number; etaManual?: number | null };
type Run = {
  index: number; vehicleName: string; plate: string | null; capacity: number; tripLabel: string | null;
  /** 정규 배차에서만 쓰는 담당 기사 계정. 방학특강 노선에는 별도 관계형 필드가 있어 선택값이다. */
  driverUserId?: string | null;
  /** 정규 셔틀은 한 요일 안에서도 수업시간별 실행이 다르다. 저장·재계산 때 이 실행의 앵커를 보존한다. */
  classStart?: string | null; classEnd?: string | null; timeGroupLabel?: string | null;
  passengers: number; stops: Stop[]; over: boolean;
  provider: "TMAP" | "LOCAL"; tmapMinutes: number | null; tmapKm: number | null; depotTime: string | null;
  // 첫 노드 출발 시각 / 마지막 노드 도착 시각. 등원=차고지 출발·학원 도착, 하원=학원 출발·차고지 복귀.
  // 화면에서 출발 시각을 직접 조정할 때 기준값으로 쓴다.
  departTime: string | null; arriveTime: string | null;
  // T맵 실도로 경로 좌표(출발→…→도착). 지도에 경로를 그릴 때 쓴다. 직선 추정이면 없음.
  path?: { lat: number; lng: number }[];
};

export type DispatchSuggestion = {
  savedAt?: string | null;
  loadedFromSaved?: boolean;
  direction: DispatchDirection;
  date: string | null; dow: string | null;
  classStart: string | null; classEnd: string | null;
  academy: Geo; depot: Geo | null; hub: Geo | null;
  vehicles: Run[];
  unassigned: { name: string; label: string | null }[];
  availableDates: { date: string; label: string }[];
  totalRiders: number;
  vehicleFleet: { name: string; plate: string | null; capacity: number }[];
  routingProvider: "TMAP" | "LOCAL"; // 전체적으로 T맵이 쓰였는지
  /** 정규 셔틀 시간대별 실행 요약. 방학특강에는 없으므로 선택값이다. */
  timeGroups?: { anchor: string | null; label: string; riders: number }[];
  // 저장 노선 이후의 변동(Phase 2a). 저장본이 있을 때만 채워지고, 관리자 배너 표시에만 쓴다.
  // 기사님 화면(DriverRunClient)은 이 필드를 읽지 않으므로 노출되지 않는다.
  added?: DispatchChange[];
  locationChanged?: DispatchChange[];
};

// 변동 대상 1명(신규/복귀 또는 위치변경). 화면에서 '추천 배정'·'좌표 자동 반영'에 필요한 정보까지 실어 보낸다.
// (예전엔 {requestId,name}뿐이라 클라이언트가 좌표·학생정보를 몰라 서버 증분배차에 의존했다.)
export type DispatchChange = {
  requestId: string; name: string;
  lat: number | null; lng: number | null; // 현재(변경 후) 승·하차 좌표. isHub이거나 미확정이면 null.
  label: string;                           // 승·하차 위치 라벨
  isHub: boolean;                          // 무료탑승 거점 학생이면 true(좌표 대신 hub 정차로 배정)
  grade: string | null; parentPhone: string | null; childPhone: string | null; rosterId: string | null;
};

function nnOrder(stops: Stop[], from: Pt): Stop[] {
  const rest = [...stops]; const out: Stop[] = []; let cur: Pt = from;
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) { const d = haversineKm(cur, rest[i]); if (d < bd) { bd = d; bi = i; } }
    const nx = rest.splice(bi, 1)[0]; out.push(nx); cur = nx;
  }
  return out;
}

// backoff용 지연. 이 프로젝트는 setTimeout 사용 제약이 없다.
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// 증분 재배차는 변동 차량마다 T맵을 연속 호출해 일시 실패(429 등)가 잦다.
// 짧게 최대 2회 재시도(200ms, 400ms backoff, 합 600ms ≤ 1초)로 일시 실패를 흡수한다.
// 그래도 최종 실패하면 planRun의 폴백(mergeTmapRoute 실패 분기)이 이전 실도로 경로를 지켜 준다.
// 구간별 T맵 호출을 재시도로 감싼다. routeSegmentsWithTmap 자체가 구간 단위 부분실패는
// 이미 내부에서 흡수하므로, 여기서 재시도되는 건 appKey 누락 등 '전체 실패'뿐이다.
async function routeSegmentsWithTmapRetry(
  input: { start: Pt; end: Pt; waypoints: Pt[] },
  retries = 2,
): Promise<SegmentsRouteResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await routeSegmentsWithTmap(input);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

// 한 차량(run)의 경로·시각 계산. 등원: 차고지→정차→학원 / 하원: 학원→정차→차고지.
// keepOrder=true면 NN 재정렬을 하지 않고 run.stops 순서를 그대로 쓴다(증분 재배차 = 저장 순서 보존).
async function planRun(run: Run, direction: DispatchDirection, academy: Geo, depot: Geo | null, csMin: number | null, ceMin: number | null, localOnly = false, keepOrder = false) {
  const startPt: Geo = direction === "PICKUP" ? (depot ?? academy) : academy;
  const endPt: Geo = direction === "PICKUP" ? academy : (depot ?? academy);
  // 순서는 최근접(NN)으로 정한다. routeOptimization(최적경로) API는 제공량이 작아 429가 잦으므로 쓰지 않고,
  // 제공량이 넉넉한 /routes(다중경로)로 그 순서의 실도로 경로·시간을 받는다(순서 변경 재계산과 동일 방식).
  // ★ keepOrder면 재정렬 없이 이미 잡힌 순서를 그대로 유지한다(증분 삽입 결과 보존).
  const order = keepOrder ? [...run.stops] : nnOrder(run.stops, startPt);

  // ★ 선파괴 금지: 진입 시 기존 실도로 경로/제공자/시간을 보관해 둔다.
  //   T맵이 "성공했을 때만" 새 값으로 갈아끼우고, T맵을 호출했는데 실패하면 이 이전값을 복원한다.
  //   (기존엔 여기서 무조건 지운 탓에, 증분 재배차 중 T맵 일시 실패 시 저장된 실도로 경로가 사라져 직선으로 퇴화했다.)
  const prev: RunRouteFields = { provider: run.provider, tmapMinutes: run.tmapMinutes, tmapKm: run.tmapKm, path: run.path };

  // 1) 경로 노드: [start, ...정차, end]. 구간 수 = 노드수-1 = 정차수+1.
  const path: Pt[] = [startPt, ...order, endPt];
  // 각 구간의 직선거리 추정시간(분). T맵 구간이 실패하면 이 값으로 폴백해 ETA가 비지 않게 한다.
  const fallbackMin: number[] = [];
  for (let i = 1; i < path.length; i++) fallbackMin.push(segMin(path[i - 1], path[i]));

  // 구간별 실도로 시간(초, 실패 구간은 null). 기본은 전부 null(=T맵 미호출·전체실패 → 전 구간 fallback).
  let segSeconds: (number | null)[] = fallbackMin.map(() => null);

  if (!localOnly && run.stops.length >= 1) {
    // T맵을 실제로 호출하는 경우에만 폴백(prev 복원)이 의미를 가진다.
    let merged: RunRouteFields;
    try {
      // ★ 총시간만 주던 routeFixedOrder 대신, 정차 사이마다 개별 호출해 '구간별 실제 시간'을 받는다.
      const res = await routeSegmentsWithTmapRetry({
        start: { lat: startPt.lat, lng: startPt.lng },
        end: { lat: endPt.lat, lng: endPt.lng },
        waypoints: order.map((s) => ({ lat: s.lat, lng: s.lng })),
      });
      // 구간 시간(초). 성공 구간은 실측, 실패 구간은 null → 아래 segmentMinutes가 fallbackMin으로 대체.
      segSeconds = res.segments.map((s) => s.time);
      // 한 구간이라도 성공했으면 실도로 경로/시간으로 갱신, 전부 실패면 prev 복원(mergeTmapRoute).
      const anyOk = res.segments.some((s) => s.time != null && s.time > 0);
      merged = mergeTmapRoute(prev, anyOk
        ? {
            ok: true,
            tmapMinutes: res.totalTime > 0 ? Math.round(res.totalTime / 60) : null,
            tmapKm: res.totalDistance > 0 ? Math.round(res.totalDistance / 100) / 10 : null,
            path: res.path.length ? res.path : undefined, // 지도에 그릴 실도로 경로(성공 구간 이어붙임)
          }
        : { ok: false });
    } catch {
      // 전체 실패(appKey 누락 등) → 이전값 유지 + segSeconds는 전부 null 유지(전 구간 fallback).
      merged = mergeTmapRoute(prev, { ok: false });
    }
    run.provider = merged.provider; run.tmapMinutes = merged.tmapMinutes; run.tmapKm = merged.tmapKm; run.path = merged.path;
  } else {
    // T맵 미호출(localOnly=전체제안 base, 또는 정차 0) → 종전 동작 그대로 LOCAL/무path로 초기화(회귀 금지).
    run.provider = "LOCAL"; run.tmapMinutes = null; run.tmapKm = null; run.path = undefined;
  }

  // 2) 구간 실제시간(분). 성공 구간=실측, 실패/미호출 구간=fallbackMin(직선추정). (순수 함수)
  const segMinutes = segmentMinutes(segSeconds, fallbackMin);

  // 3) 방향별 시각 누적(순수 함수). PICKUP=학원 도착 기준 역산 / DROPOFF=학원 출발 기준 순방향.
  const anchorMin = direction === "PICKUP" ? (csMin ?? 0) - PICKUP_BUFFER_MIN : (ceMin ?? 0) + DROPOFF_BUFFER_MIN;
  const times = nodeTimesFromSegments(segMinutes, direction, anchorMin);

  // 각 정차(order[i])는 노드 times[i+1]에 해당. 표시용 라벨 + T2용 숫자(etaMinutes)를 함께 남긴다.
  order.forEach((s, i) => {
    s.etaLabel = `${minToHHMM(times[i + 1])} ${direction === "PICKUP" ? "승차" : "하차"}`;
    s.etaMinutes = Math.round(times[i + 1]); // 확정시간 편집(T2)이 기준값으로 쓰는 분 단위 숫자
  });
  run.stops = order;
  run.depotTime = depot ? minToHHMM(direction === "PICKUP" ? times[0] : times[path.length - 1]) : null;
  // 첫 노드 출발/마지막 노드 도착(방향 무관 대칭). 출발 시각 수동 조정의 기준값.
  run.departTime = minToHHMM(times[0]);
  run.arriveTime = minToHHMM(times[path.length - 1]);
}

export async function suggestDispatch(opts: { direction: DispatchDirection; date?: string | null }): Promise<DispatchSuggestion> {
  await requireAdmin();
  return computeDispatch(opts);
}

/**
 * 조회용 노선 — T맵 제공량을 아끼는 게 목적이다.
 *   1) 저장된(원장 확정) 노선이 있으면 그걸 그대로 쓴다(T맵 0회). 기준정보만 T맵 없이 채운다.
 *   2) 없으면: allowTmap=true면 T맵으로 새로 계산(관리자 첫 진입), false면 직선 추정(기사님 화면).
 * "볼 때"는 절대 T맵을 부르지 않도록 하는 진입점. 실제 T맵 호출은 "편집(자동 제안·순서 변경)"에서만.
 */
export async function getDispatchForView(date: string | null, direction: DispatchDirection, allowTmap: boolean): Promise<DispatchSuggestion> {
  // 먼저 T맵 없이 기준정보(+날짜 확정)를 얻는다. NN 정렬은 순수 계산이라 외부 호출 0.
  const base = await computeDispatch({ direction, date, localOnly: true });
  const resolvedDate = base.date;
  // 요일별 관리: 노선은 그 요일의 '대표 날짜'(첫 운행일)에만 저장/조회한다. 같은 요일이면 모두 같은 노선.
  const canonicalDate = resolvedDate ? firstDateOfSameWeekday(base.availableDates, resolvedDate) : null;
  // 노선은 대표일(canonicalDate)에서 꺼내되, **결석 판정은 실제로 보고 있는 날짜(resolvedDate)** 기준이어야 한다.
  const saved = canonicalDate
    ? await getSavedDispatchRoute(canonicalDate, direction, { attendanceDate: resolvedDate, strict: allowTmap })
    : null;
  if (saved && Array.isArray(saved.vehicles)) {
    // hub stop label을 현재 DB 거점 이름으로 실시간 교체 — 거점 이름 변경 시 재계산 없이도 반영된다.
    const currentHubName = base.hub?.name;
    const vehicles = (currentHubName
      ? (saved.vehicles as DispatchSuggestion["vehicles"]).map((v) => ({
          ...v,
          stops: (v.stops ?? []).map((s) => (s.isHub ? { ...s, label: currentHubName } : s)),
        }))
      : saved.vehicles) as DispatchSuggestion["vehicles"];
    // ★ 헤더의 "탑승 N명"은 base(=오늘 명단 기준, 결석 제외)가 아니라 **실제로 화면에 그려지는 저장 노선**을
    //   기준으로 세야 한다. 그러지 않으면 정차별 인원 합과 헤더 숫자가 어긋난다(결석자가 있으면 반드시 어긋남).
    const savedRiderCount = vehicles.reduce(
      (acc, v) => acc + (v.stops ?? []).reduce((a, s) => a + (s.students?.length ?? 0), 0),
      0,
    );
    return {
      ...base,
      savedAt: saved.savedAt, loadedFromSaved: true,
      vehicles,
      totalRiders: savedRiderCount,
      classStart: saved.classStart ?? base.classStart,
      classEnd: saved.classEnd ?? base.classEnd,
      routingProvider: "TMAP",
      // 저장 노선 이후의 변동을 그대로 전달(관리자 배너용). 기사님 화면은 이 필드를 매핑하지 않는다.
      added: saved.added,
      locationChanged: saved.locationChanged,
    };
  }
  // 저장본이 없을 때만: 관리자 첫 진입은 T맵으로 계산, 기사님 화면은 직선 추정(base) 그대로.
  return allowTmap ? computeDispatch({ direction, date: resolvedDate, localOnly: false }) : base;
}

// 배차 코어가 입력으로 받는 "라이더 1명"의 최소 계약(shape).
// 방학특강 ShuttleRosterRider 와 정규 RegularShuttleRider(어댑터 경유)가 모두 이 형태를 만족한다.
// 코어는 이 필드들만 읽으므로, 명단 소스가 무엇이든(방학특강/정규) 같은 엔진을 태울 수 있다.
export type DispatchRiderInput = {
  studentName: string;
  childGrade: string | null;
  parentPhone: string | null;
  childPhone: string | null;
  rosterId: string | null;          // 확정본 행 id(정규는 없음 → null)
  shuttleRequestId: string;         // 정차-학생 식별 키(정규는 studentId 를 대입)
  applicationId: string | null;     // 학생 상세 모달 키
  placeLabel: string;               // 승·하차 위치 라벨
  place: { latitude: number | null; longitude: number | null; source: string | null };
};

/**
 * 배차 코어(명단 → 차량·정차·경로·시각) — 명단 소스에 독립적인 순수 재사용부.
 *
 * 방학특강(computeDispatch)·정규(computeRegularDispatch)가 **명단만 각자 준비**해 이 함수에 태운다.
 * 차량(ShuttleVehicle)·학원/차고지/거점 좌표(AcademySettings)·정차 묶기·NN 정렬·정원 배차·
 * planRun(T맵 실도로/직선 폴백)·ETA 계산은 전부 여기서 공유한다(회귀 방지: 기존 seasonal 로직 그대로 이동).
 *
 * date 는 "운행이 성립하는 날/요일"의 식별자다. null 이면 스켈레톤(base)만 돌려준다(종전 동작 유지).
 */
export async function buildDispatchFromRiders(input: {
  direction: DispatchDirection;
  date: string | null;
  dow: string | null;
  availableDates: { date: string; label: string }[];
  classStart: string | null;
  classEnd: string | null;
  riders: DispatchRiderInput[];
  localOnly: boolean;
}): Promise<DispatchSuggestion> {
  const { direction, date, dow, availableDates, localOnly } = input;
  const { academy, depot, hub, hubDropoff } = await getSettings();
  // 등원은 탑승 거점, 하원은 하차 거점(없으면 탑승 거점으로 폴백)
  const effectiveHub = direction === "DROPOFF" ? (hubDropoff ?? hub) : hub;

  const vehRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT name, "plateNumber" AS plate, capacity FROM "ShuttleVehicle" WHERE "isActive" = true ORDER BY name ASC`,
  );
  const fleet = vehRows.map((v) => ({ name: String(v.name), plate: v.plate ?? null, capacity: Math.max(1, Number(v.capacity) || 1) }));
  const vehicleFleet = fleet.length ? fleet : [{ name: "미등록 차량", plate: null, capacity: 9 }];

  const base: DispatchSuggestion = {
    direction, date, dow, classStart: null, classEnd: null, academy, depot, hub: effectiveHub,
    vehicles: [], unassigned: [], availableDates, totalRiders: 0, vehicleFleet, routingProvider: "LOCAL",
  };
  if (!date) return base;

  // 방향에 맞는 위치(하원=등원 동일 옵션 포함)는 명단 준비 단계에서 이미 골라져 place 로 들어온다.
  const riders = input.riders;
  if (riders.length === 0) return base;

  const classStart = input.classStart;
  const classEnd = input.classEnd;

  const unassigned: { name: string; label: string | null }[] = [];
  // 정차 목록. 좌표 격자 키(toFixed)가 아니라 **거리 기준**으로 병합한다 —
  // 격자는 경계에 걸치면 1m 떨어진 두 점도 다른 정차가 돼(실제 사고) 같은 아파트가 갈라졌다.
  // 한 노선의 정차는 많아야 수십 개라 선형 탐색으로 충분하다.
  const builtStops: Stop[] = [];
  // 무료 탑승 거점(1호점 등). 거점에서 타는/내리는 학생이 있을 때만 노선에 넣는다(빈 거점은 아래에서 제외).
  const hubStop: Stop | null = effectiveHub ? { lat: effectiveHub.lat, lng: effectiveHub.lng, label: effectiveHub.name, students: [], approx: false, isHub: true } : null;
  for (const r of riders) {
    const student: StopStudent = {
      name: r.studentName, grade: r.childGrade, parentPhone: r.parentPhone, childPhone: r.childPhone,
      rosterId: r.rosterId, requestId: r.shuttleRequestId, pickupLabel: r.placeLabel, applicationId: r.applicationId ?? null,
    };
    // '무료탑승'으로 지정된 학생은 집이 아니라 거점에서 타고(등원)/내린다(하원). 좌표가 없어도 배차 가능.
    if (hubStop && isFreeHubLabel(r.placeLabel)) { hubStop.students.push(student); continue; }
    const { latitude: lat, longitude: lng } = r.place;
    const label = r.placeLabel;
    if (lat == null || lng == null) { unassigned.push({ name: r.studentName, label }); continue; }
    const hit = findSamePlaceIndex(builtStops, lat, lng);
    if (hit >= 0) builtStops[hit].students.push(student);
    else builtStops.push({ lat, lng, label, students: [student], approx: !pinnedSrc(r.place.source) });
  }

  const allStops: Stop[] = builtStops;
  // 거점에 실제로 타는 학생이 있을 때만 경유한다. 아무도 없으면 노선에서 뺀다(빈 거점 제외).
  if (hubStop && hubStop.students.length > 0) allStops.push(hubStop);

  // 정원 배차: 차고지(등원)/학원(하원) 기준 최근접순으로 채운 뒤, 정원 초과 시 같은 차량 추가 운행
  const fillFrom: Pt = direction === "PICKUP" ? (depot ?? academy) : academy;
  const ordered = nnOrder(allStops, fillFrom);
  const runs: Run[] = [];
  const tripByVeh: Record<number, number> = {};
  let vi = 0;
  const mkRun = (): Run => {
    const idx = Math.min(vi, vehicleFleet.length - 1);
    const veh = vehicleFleet[idx];
    tripByVeh[idx] = (tripByVeh[idx] ?? 0) + 1;
    const trip = tripByVeh[idx];
    const reused = vi >= vehicleFleet.length;
    return { index: runs.length + 1, vehicleName: veh.name, plate: veh.plate, capacity: veh.capacity, tripLabel: reused || trip > 1 ? `${trip}차 운행` : null, passengers: 0, stops: [], over: false, provider: "LOCAL", tmapMinutes: null, tmapKm: null, depotTime: null, departTime: null, arriveTime: null };
  };
  let run = mkRun();
  for (const stop of ordered) {
    const n = stop.students.length;
    if (run.stops.length > 0 && run.passengers + n > run.capacity) { runs.push(run); vi++; run = mkRun(); }
    run.stops.push(stop); run.passengers += n;
  }
  if (run.stops.length) runs.push(run);

  const csMin = hhmmToMin(classStart), ceMin = hhmmToMin(classEnd);
  for (const v of runs) { await planRun(v, direction, academy, depot, csMin, ceMin, localOnly); v.over = v.passengers > v.capacity; }

  return {
    direction, date, dow, classStart, classEnd, academy, depot, hub,
    vehicles: runs, unassigned, availableDates,
    totalRiders: riders.length - unassigned.length, vehicleFleet,
    routingProvider: runs.some((r) => r.provider === "TMAP") ? "TMAP" : "LOCAL",
  };
}

// 인증 없이 노선을 계산한다. 관리자 경로는 suggestDispatch(requireAdmin)로만 부르고,
// 기사님 전용 링크는 유효 토큰을 확인한 뒤 이 함수를 직접 부른다(토큰이 관리자 인증을 대신함).
export async function computeDispatch(opts: { direction: DispatchDirection; date?: string | null; localOnly?: boolean }): Promise<DispatchSuggestion> {
  const direction = opts.direction === "DROPOFF" ? "DROPOFF" : "PICKUP";
  const localOnly = opts.localOnly === true; // true면 T맵 미호출(직선 추정) — 조회·기사님 화면에서 제공량 절약

  // ⚠️ 태울 학생은 게이트웨이 한 곳으로만 읽는다.
  // 여기서 SQL을 새로 쓸 때마다 취소자·폐강 반 필터가 빠지는 사고가 반복됐다(5회).
  // 운행일 후보와 그날 명단을 한 번에 받아 오므로 이 파일에는 대상자 쿼리가 아예 없다.
  const plan = await getConfirmedShuttleRosterForDate(opts.date ?? null, direction);
  const availableDates = plan.availableDates.map((x) => {
    const [, mm, dd] = x.date.split("-");
    return { date: x.date, label: `${Number(mm)}/${Number(dd)} (${DOW_KO[x.dow]})` };
  });
  const date = plan.date;
  const dow = date ? (availableDates.find((x) => x.date === date)?.label.match(/\((.)\)/)?.[1] ?? null) : null;

  // 명단만 방학특강 게이트웨이에서 준비하고, 나머지(차량·좌표·경로·시각)는 공유 코어에 위임한다.
  return buildDispatchFromRiders({
    direction, date, dow, availableDates,
    classStart: plan.classStart, classEnd: plan.classEnd,
    riders: plan.riders, // ShuttleRosterRider 는 DispatchRiderInput 계약을 이미 만족한다(place.source 포함).
    localOnly,
  });
}

/**
 * 증분 재배차(Phase 2b) — 저장된 노선의 기존 정차 순서를 **그대로 두고**, 신규·복귀·위치변경 학생만
 * cheapest-insertion으로 가장 적합한 위치에 끼워넣은 뒤, 변경된 차량만 순서 고정으로 T맵 시간을 다시 계산한다.
 * ★ 전체 재최적화(suggestDispatch/computeDispatch) 금지 — 기존 정차 상호 순서를 절대 재배열하지 않는다.
 *
 * 저장본이 없으면 전체 자동배차(computeDispatch)로 폴백한다(끼워넣을 기준 노선이 없으므로).
 */
export async function incrementalDispatch(opts: { direction: DispatchDirection; date?: string | null }): Promise<DispatchSuggestion> {
  await requireAdmin();
  const direction = opts.direction === "DROPOFF" ? "DROPOFF" : "PICKUP";

  // 1) 기준정보(+날짜 확정)를 T맵 없이 얻는다. 저장본이 있으면 base.vehicles는 쓰지 않는다.
  const base = await computeDispatch({ direction, date: opts.date ?? null, localOnly: true });
  const date = base.date;
  if (!date) return base;

  // 2) 저장된 노선(reconcile=제거 반영)과 added/locationChanged를 얻는다. 없으면 전체 재최적화로 폴백.
  const saved = await getSavedDispatchRoute(date, direction);
  if (!saved || !Array.isArray(saved.vehicles) || saved.vehicles.length === 0) {
    return computeDispatch({ direction, date, localOnly: false });
  }

  // 3) 삽입 대상 = added(신규·복귀) + locationChanged(위치변경). 그날 유효 명단에서 학생 정보를 되짚는다.
  const plan = await getConfirmedShuttleRosterForDate(date, direction);
  const riderById = new Map(plan.riders.map((r) => [r.shuttleRequestId, r]));
  const targetIds = [
    ...(saved.added ?? []).map((a) => a.requestId),
    ...(saved.locationChanged ?? []).map((c) => c.requestId),
  ];
  const targets: IncrTarget[] = [];
  for (const id of targetIds) {
    const r = riderById.get(id);
    if (!r) continue; // 명단에서 사라졌으면(방어) 건너뛴다.
    const student: StopStudent = {
      name: r.studentName, grade: r.childGrade, parentPhone: r.parentPhone, childPhone: r.childPhone,
      rosterId: r.rosterId, requestId: r.shuttleRequestId, pickupLabel: r.placeLabel, applicationId: r.applicationId ?? null,
    };
    const isHub = isFreeHubLabel(r.placeLabel);
    targets.push({
      requestId: r.shuttleRequestId,
      student: student as unknown as Record<string, unknown>,
      name: r.studentName,
      lat: isHub ? null : (r.place.latitude ?? null),
      lng: isHub ? null : (r.place.longitude ?? null),
      label: r.placeLabel,
      approx: !pinnedSrc(r.place.source),
      isHub,
    });
  }

  // 4) 순수 로직으로 삽입(기존 순서 보존). start/end는 방향에 맞춘 차고지/학원 기준.
  const { academy, depot } = base;
  const startPt = direction === "PICKUP" ? (depot ?? academy) : academy;
  const endPt = direction === "PICKUP" ? academy : (depot ?? academy);
  const result = planIncrementalInsert(
    saved.vehicles,
    targets,
    { start: { lat: startPt.lat, lng: startPt.lng }, end: { lat: endPt.lat, lng: endPt.lng } },
  );

  // 5) 삽입/제거로 정차 기하가 바뀐 차량만 순서 고정으로 T맵 재계산(path·시간·eta 갱신). 나머지는 그대로.
  const vehicles = result.vehicles as Run[];
  const classStart = saved.classStart ?? base.classStart;
  const classEnd = saved.classEnd ?? base.classEnd;
  const csMin = hhmmToMin(classStart), ceMin = hhmmToMin(classEnd);
  for (const vi of result.reroute) {
    const v = vehicles[vi];
    if (!v) continue;
    await planRun(v, direction, academy, depot, csMin, ceMin, false, /* keepOrder */ true);
    v.over = v.passengers > v.capacity;
  }

  const totalStudents = vehicles.reduce((acc, v) => acc + (v.passengers ?? 0), 0);
  return {
    ...base,
    classStart, classEnd,
    vehicles,
    unassigned: result.unassigned,
    totalRiders: totalStudents,
    routingProvider: vehicles.some((v) => v.provider === "TMAP") ? "TMAP" : "LOCAL",
    // 삽입을 반영했으므로 배너의 변동 목록은 비운다(이번 재배차로 처리됨).
    added: [],
    locationChanged: [],
  };
}
