export type TmapWaypoint = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
};

export type TmapRouteOptimizationInput = {
  start: TmapWaypoint;
  end: TmapWaypoint;
  waypoints: TmapWaypoint[];
};

export type TmapRouteOptimizationResult = {
  provider: "TMAP";
  orderedWaypointIds: string[];
  rawSummary?: {
    totalDistance?: number;
    totalTime?: number;
  };
  /** 실제 도로 경로 좌표(출발→…→도착 순). 지도에 경로를 그릴 때 쓴다. */
  path?: { lat: number; lng: number }[];
};

export class TmapApiError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = "TMAP_API_ERROR",
  ) {
    super(message);
    this.name = "TmapApiError";
  }
}

const TMAP_REQUEST_TIMEOUT_MS = 10_000;

function isTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function productLimit(count: number) {
  if (count <= 10) return 10;
  if (count <= 20) return 20;
  if (count <= 30) return 30;
  return 100;
}

function routeOptimizationUrl(waypointCount: number) {
  const override = process.env.TMAP_ROUTE_OPTIMIZATION_URL?.trim();
  if (override) return override;
  const limit = productLimit(waypointCount);
  return `https://apis.openapi.sk.com/tmap/routes/routeOptimization${limit}?version=1&format=json`;
}

function pointPayload(point: TmapWaypoint, prefix: "start" | "end") {
  return {
    [`${prefix}Name`]: point.name,
    [`${prefix}X`]: String(point.longitude),
    [`${prefix}Y`]: String(point.latitude),
  };
}

function collectWaypointIds(value: unknown, knownIds: Set<string>, output: string[] = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) collectWaypointIds(item, knownIds, output);
    return output;
  }
  const row = value as Record<string, unknown>;
  const candidate = row.viaPointId ?? row.viaId ?? row.id;
  if (candidate !== undefined) {
    const id = String(candidate);
    if (knownIds.has(id) && !output.includes(id)) output.push(id);
  }
  for (const item of Object.values(row)) collectWaypointIds(item, knownIds, output);
  return output;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function distMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// 응답 features의 LineString 좌표(도로 경로)를 순서대로 이어 붙인다. T맵 좌표는 [경도, 위도].
// ⚠️ /routes(경유지)는 본 경로 뒤에 '경유지로 향하는 짧은 연결선'(도로명 없는 2점 세그먼트)을 붙여서 준다.
//    그대로 이어붙이면 지도에 긴 직선 점프가 생기므로, 직전 끝점과 크게 끊긴(>150m) 세그먼트는 건너뛴다.
function extractPath(value: unknown): { lat: number; lng: number }[] {
  const out: { lat: number; lng: number }[] = [];
  const feats = (value as { features?: unknown })?.features;
  if (!Array.isArray(feats)) return out;
  for (const f of feats) {
    const geom = (f as { geometry?: { type?: string; coordinates?: unknown } })?.geometry;
    if (geom?.type !== "LineString" || !Array.isArray(geom.coordinates)) continue;
    const seg: { lat: number; lng: number }[] = [];
    for (const c of geom.coordinates) {
      const lng = Number((c as unknown[])?.[0]), lat = Number((c as unknown[])?.[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) seg.push({ lat, lng });
    }
    if (!seg.length) continue;
    // 이 세그먼트가 지금까지의 경로 끝과 끊겨 있으면(경유지 연결선 찌꺼기) 건너뛴다.
    if (out.length && distMeters(out[out.length - 1], seg[0]) > 150) continue;
    for (const c of seg) {
      const last = out[out.length - 1];
      if (!last || last.lat !== c.lat || last.lng !== c.lng) out.push(c);
    }
  }
  return out;
}

function extractSummary(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  const properties = data.properties && typeof data.properties === "object" ? data.properties as Record<string, unknown> : {};
  return {
    totalDistance: numberValue(data.totalDistance ?? properties.totalDistance),
    totalTime: numberValue(data.totalTime ?? properties.totalTime),
  };
}

// T맵 경유지 최적화는 startTime(출발 예정시각, yyyyMMddHHmm)이 필수다. 없으면 400(9401)로 거절된다.
// 교통량 예측 기준 시각일 뿐이라 현재 시각(학원 시간대)을 넣는다.
function tmapStartTime(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}${g("month")}${g("day")}${g("hour")}${g("minute")}`;
}

type LatLng = { lat: number; lng: number };
export type FixedRouteResult = { provider: "TMAP"; path: LatLng[]; totalTime: number; totalDistance: number };

// 한 구간(출발+경유지≤5+도착)의 실도로 경로·시간을 /routes로 받는다.
async function routesLeg(appKey: string, start: LatLng, end: LatLng, vias: LatLng[]): Promise<FixedRouteResult> {
  const body: Record<string, unknown> = {
    startX: String(start.lng), startY: String(start.lat), endX: String(end.lng), endY: String(end.lat),
    reqCoordType: "WGS84GEO", resCoordType: "WGS84GEO", searchOption: "0", startName: "S", endName: "E",
  };
  if (vias.length) body.passList = vias.map((v) => `${v.lng},${v.lat}`).join("_");
  const res = await fetch("https://apis.openapi.sk.com/tmap/routes?version=1&format=json", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", appKey },
    signal: AbortSignal.timeout(TMAP_REQUEST_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new TmapApiError("T맵 경로 요청이 실패했습니다.");
  const j = await res.json().catch(() => null);
  const path = extractPath(j);
  if (!path.length) throw new TmapApiError("T맵 경로 좌표를 확인하지 못했습니다.");
  const props = ((j as { features?: { properties?: Record<string, unknown> }[] })?.features?.[0]?.properties) ?? {};
  return { provider: "TMAP", path, totalTime: Number(props.totalTime) || 0, totalDistance: Number(props.totalDistance) || 0 };
}

// 사용자가 정한 순서 그대로(재정렬 없이) 실도로 경로·시간을 계산한다.
// /routes passList는 최대 5개라, 경유지가 많으면 경계를 공유하며 구간을 쪼개 호출하고 이어붙인다.
export async function routeFixedOrderWithTmap(input: { start: LatLng; end: LatLng; waypoints: LatLng[] }): Promise<FixedRouteResult> {
  const appKey = process.env.TMAP_APP_KEY?.trim();
  if (!appKey) throw new TmapApiError("TMAP_APP_KEY 환경변수가 설정되지 않았습니다.", 500);
  const nodes: LatLng[] = [input.start, ...input.waypoints, input.end];
  if (nodes.length < 2) throw new TmapApiError("좌표가 부족합니다.", 400);
  const path: LatLng[] = [];
  let totalTime = 0, totalDistance = 0;
  let i = 0;
  while (i < nodes.length - 1) {
    const endIdx = Math.min(i + 6, nodes.length - 1); // 출발 + 경유지 최대 5 + 도착 = 7노드
    const leg = await routesLeg(appKey, nodes[i], nodes[endIdx], nodes.slice(i + 1, endIdx));
    for (const c of leg.path) {
      const last = path[path.length - 1];
      if (!last || last.lat !== c.lat || last.lng !== c.lng) path.push(c); // 경계 중복 제거
    }
    totalTime += leg.totalTime; totalDistance += leg.totalDistance;
    i = endIdx;
  }
  return { provider: "TMAP", path, totalTime, totalDistance };
}

// 한 구간(점대점)만 재시도로 감싼다. 구간별 호출은 연속 호출이라 일시 실패(429 등)가 잦다.
async function routesLegRetry(appKey: string, start: LatLng, end: LatLng, retries = 1): Promise<FixedRouteResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await routesLeg(appKey, start, end, []); // 경유지 없이 두 정차 사이만 잇는다.
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1))); // 200ms backoff
    }
  }
  throw lastErr;
}

// 한 구간(정차 사이)의 실도로 이동시간·거리·경로. 실패 시 time/distance=null, path=[].
export type SegmentLeg = { time: number | null; distance: number | null; path: LatLng[] };
export type SegmentsRouteResult = {
  provider: "TMAP";
  segments: SegmentLeg[]; // 길이 = 노드수-1 = 정차수+1
  path: LatLng[]; // 성공 구간을 순서대로 이어붙인 전체 경로
  totalTime: number; // 성공 구간 시간 합(초)
  totalDistance: number; // 성공 구간 거리 합(m)
};

// 정류장 순서를 옮겼을 때 시각 다시 계산(routeRetime)용 — 지점 쌍마다 실도로 이동 «분».
// 쌍마다 따로 호출하고(경유 없음), 실패한 쌍은 null 로 남겨 화면이 직선 추정으로 채우게 한다.
// ⚠️ 쌍 N개 = T맵 호출 N번. 호출부(API)가 개수를 제한한다(순서를 옮길 때만 부른다).
export async function pairLegMinutesWithTmap(pairs: { a: LatLng; b: LatLng }[]): Promise<(number | null)[]> {
  const appKey = process.env.TMAP_APP_KEY?.trim();
  if (!appKey) return pairs.map(() => null);
  const out: (number | null)[] = [];
  for (const { a, b } of pairs) {
    try {
      const leg = await routesLegRetry(appKey, a, b);
      out.push(leg.totalTime > 0 ? leg.totalTime / 60 : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

// 정차 사이를 "점대점 단일 경로"로 개별 호출해 각 구간의 실제 이동시간을 얻는다.
// 왜 이렇게? 기존 routeFixedOrderWithTmap는 총시간만 주고 구간 시간이 없어, 정차별 ETA를
// 직선거리 비율로 추정 배분했다(부정확). 구간마다 /routes를 따로 부르면 각 정차의 실도로 ETA가 나온다.
// ⚠️ 정차 N개면 T맵 호출 N+1번. "편집할 때만" 부르므로 수용 가능(조회 시엔 호출 안 함).
// ⚠️ 한 구간이 실패해도 그 구간만 null 처리하고 나머지는 살린다(전체 폴백보다 부분 유지가 낫다).
export async function routeSegmentsWithTmap(input: { start: LatLng; end: LatLng; waypoints: LatLng[] }): Promise<SegmentsRouteResult> {
  const appKey = process.env.TMAP_APP_KEY?.trim();
  if (!appKey) throw new TmapApiError("TMAP_APP_KEY 환경변수가 설정되지 않았습니다.", 500);
  const nodes: LatLng[] = [input.start, ...input.waypoints, input.end];
  if (nodes.length < 2) throw new TmapApiError("좌표가 부족합니다.", 400);

  const segments: SegmentLeg[] = [];
  const path: LatLng[] = [];
  let totalTime = 0, totalDistance = 0;
  for (let i = 0; i < nodes.length - 1; i++) {
    try {
      const leg = await routesLegRetry(appKey, nodes[i], nodes[i + 1]);
      segments.push({ time: leg.totalTime, distance: leg.totalDistance, path: leg.path });
      for (const c of leg.path) {
        const last = path[path.length - 1];
        if (!last || last.lat !== c.lat || last.lng !== c.lng) path.push(c); // 경계 좌표 중복 제거
      }
      totalTime += leg.totalTime; totalDistance += leg.totalDistance;
    } catch {
      // 이 구간만 실패 처리. 호출부가 segMin 추정으로 폴백하도록 time=null을 남긴다.
      segments.push({ time: null, distance: null, path: [] });
    }
  }
  return { provider: "TMAP", segments, path, totalTime, totalDistance };
}

export async function optimizeWaypointOrderWithTmap(input: TmapRouteOptimizationInput): Promise<TmapRouteOptimizationResult> {
  const appKey = process.env.TMAP_APP_KEY?.trim();
  if (!appKey) throw new TmapApiError("TMAP_APP_KEY 환경변수가 설정되지 않았습니다.", 500);
  if (!input.waypoints.length) {
    return { provider: "TMAP", orderedWaypointIds: [], rawSummary: undefined };
  }

  // ⚠️ T맵은 viaPointId "0"을 "값 없음"으로 취급해 400(9401)을 낸다(호출부가 인덱스 0을 쓰면 항상 실패).
  //    내부용 안전 id(wpN)로 바꿔 보내고, 응답 순서를 호출부가 준 원래 id로 되돌린다.
  const originalBySafe = new Map<string, string>();
  const safeById = new Map<string, string>();
  input.waypoints.forEach((point, index) => {
    const safe = `wp${index}`;
    originalBySafe.set(safe, point.id);
    safeById.set(point.id, safe);
  });

  let response: Response;
  let body: unknown = null;
  try {
    response = await fetch(routeOptimizationUrl(input.waypoints.length), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        appKey,
      },
      signal: AbortSignal.timeout(TMAP_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        reqCoordType: "WGS84GEO",
        resCoordType: "WGS84GEO",
        startTime: tmapStartTime(),
        ...pointPayload(input.start, "start"),
        ...pointPayload(input.end, "end"),
        viaPoints: input.waypoints.map((point) => ({
          viaPointId: safeById.get(point.id),
          viaPointName: point.name,
          viaX: String(point.longitude),
          viaY: String(point.latitude),
        })),
      }),
    });
    body = await response.json().catch((error: unknown) => {
      // fetch에 전달한 신호는 응답 본문을 읽는 동안에도 유효합니다.
      // 시간 초과는 바깥 catch에서 504로 변환하고, 잘못된 JSON만 기존처럼 빈 응답으로 처리합니다.
      if (isTimeoutError(error)) throw error;
      return null;
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new TmapApiError(
        "T맵 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.",
        504,
        "TMAP_OPTIMIZATION_TIMEOUT",
      );
    }
    throw new TmapApiError("T맵 경유지 최적화 요청에 연결하지 못했습니다.");
  }
  if (!response.ok) {
    throw new TmapApiError("T맵 경유지 최적화 요청이 실패했습니다.");
  }

  const knownSafeIds = new Set(originalBySafe.keys());
  const orderedSafeIds = collectWaypointIds(body, knownSafeIds);
  if (orderedSafeIds.length !== input.waypoints.length) {
    throw new TmapApiError("T맵 응답에서 경유지 추천 순서를 확인하지 못했습니다.");
  }

  return {
    provider: "TMAP",
    // 내부 안전 id → 호출부가 준 원래 id로 되돌린다.
    orderedWaypointIds: orderedSafeIds.map((safe) => originalBySafe.get(safe) as string),
    rawSummary: extractSummary(body),
    path: extractPath(body),
  };
}
