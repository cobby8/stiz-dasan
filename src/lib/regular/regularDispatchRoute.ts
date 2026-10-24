import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
// reconcile/diff 는 의존성 없는 순수 공용 모듈이다(방학특강과 100% 공유).
// 유효 라이더 집합만 정규 명단(getRegularShuttleRiders)으로 바꿔 넘기면 그대로 동작한다.
import { reconcileSavedVehicles, diffSavedRoute } from "@/lib/seasonal/dispatchReconcile";
import type { SavedRouteChange, ConfirmedDispatchEta } from "@/lib/seasonal/dispatchRoute";
// 저장 payload에서 정차별 확정 라벨(승차/하차)을 뽑는 순수 로직 — 방학특강과 100% 공유(중복 0).
// 정규는 매칭키가 studentId 지만, 정규 payload도 학생 식별키로 studentId 를 requestId 자리에 넣어 저장하므로
// extractEtaByRequestId 를 그대로 재사용할 수 있다(Phase 1 에서 requestId←studentId 로 어댑트됨).
import { extractEtaByRequestId } from "@/lib/seasonal/dispatchEtaLookup";
import type { DispatchSuggestion } from "@/lib/seasonal/shuttle-optimize";
import { getRegularShuttleRiders } from "./shuttleRoster";
import { computeRegularDispatch } from "./shuttle-dispatch";
import { validateRegularDispatchVehicles } from "./regularDispatchPayload";
import { isServiceMonth, koreaServiceMonth } from "./serviceMonth";

/**
 * 정규 셔틀 동적배차 — 저장 노선(RegularDispatchRoute) 읽기/쓰기 + 조회용 병합 (Phase 2b).
 *
 * 방학특강 dispatchRoute.ts / shuttle-optimize.getDispatchForView 를 **요일 기준**으로 이식한다.
 *   - 저장 단위: (요일 × 방향) 1행. ON CONFLICT("dayOfWeek","direction") DO UPDATE.
 *   - reconcile-on-read: 저장본을 읽을 때 그 요일 유효 라이더에 없는 학생을 자동 제거 + 라벨 자동갱신.
 *   - 유효 라이더 = getRegularShuttleRiders 의 studentId(= 배차 코어의 정차-학생 식별키) 집합.
 *
 * ⚠️ reconcileSavedVehicles·diffSavedRoute 는 방학특강과 같은 함수를 그대로 쓴다(중복 0).
 * ⚠️ 스키마 변경 없음(2a 테이블 소비). $queryRawUnsafe·PgBouncer 우회.
 */

// 무료탑승 거점 판정 — 방학특강 dispatchRoute.isFreeHubLabelLocal 과 같은 기준(정규는 거의 없지만 일관 유지).
function isFreeHubLabelLocal(label: string | null | undefined): boolean {
  return (label ?? "").replace(/\s/g, "").includes("무료탑승");
}

// Class.dayOfWeek 유효값만 통과시킨다(SQL 주입·오타 방어).
const VALID_DOW = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
function normDow(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return VALID_DOW.has(s) ? s : null;
}
function normDir(v: unknown): "PICKUP" | "DROPOFF" | null {
  return v === "PICKUP" || v === "DROPOFF" ? v : null;
}
function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type SavedRegularDispatchRoute = {
  vehicles: unknown[];
  classStart: string | null;
  classEnd: string | null;
  savedAt: string | null;
  added: SavedRouteChange[];
  locationChanged: SavedRouteChange[];
};

/** 그 요일·방향의 저장된 정규 노선. 없으면 null. (reconcile-on-read 적용) */
export async function getSavedRegularDispatchRoute(
  dayOfWeek: string,
  direction: string,
  serviceMonth?: string,
  opts?: { strict?: boolean; raw?: boolean },
): Promise<SavedRegularDispatchRoute | null> {
  const dow = normDow(dayOfWeek), dir = normDir(direction);
  if (!dow || !dir) return null;
  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "payload", "classStart", "classEnd", "updatedAt"
         FROM "RegularDispatchRoute"
        WHERE "serviceMonth" = COALESCE($3, (SELECT MAX("serviceMonth") FROM "RegularShuttleStop"))
          AND "dayOfWeek" = $1 AND "direction" = $2
        LIMIT 1`,
      dow, dir, serviceMonth ?? null,
    );
    const r = rows[0];
    if (!r) return null;
    const payload = r.payload as { vehicles?: unknown[] } | null;
    const savedVehicles = Array.isArray(payload?.vehicles) ? payload!.vehicles! : [];

    let vehicles = savedVehicles;
    let added: SavedRouteChange[] = [];
    let locationChanged: SavedRouteChange[] = [];
    try {
      if (opts?.raw) return { vehicles: savedVehicles, classStart: (r.classStart as string | null) ?? null, classEnd: (r.classEnd as string | null) ?? null, savedAt: isoOrNull(r.updatedAt), added: [], locationChanged: [] };
      // 유효 라이더 = 그 요일 × 방향 정규 명단. 좌표 없는 이용자(unassigned)도 "유효 재적"으로 쳐서
      // reconcile 이 살려 두게 한다(좌표만 나중에 채우면 자연 복귀). 식별키 = studentId(= shuttleRequestId 대입).
      const roster = await getRegularShuttleRiders({ direction: dir, dayOfWeek: dow, serviceMonth });
      const allRiders = [...roster.riders, ...roster.unassigned];
      const validIds = new Set(allRiders.map((rider) => rider.studentId));
      // studentId → 현재 명단 라벨(저장본의 얼어붙은 정차 라벨을 텍스트만 자동갱신).
      const labelByRequestId = new Map(allRiders.map((rider) => [rider.studentId, rider.placeLabel]));
      vehicles = reconcileSavedVehicles(savedVehicles, validIds, labelByRequestId);

      // 변동 감지(추가/위치변경) — diff 는 rider.shuttleRequestId/place 를 읽으므로 정규 라이더를 그 계약으로 어댑트한다.
      const diffRiders = allRiders.map((rider) => ({
        shuttleRequestId: rider.studentId,
        studentName: rider.studentName,
        place: { latitude: rider.place.latitude, longitude: rider.place.longitude },
      }));
      const diff = diffSavedRoute(vehicles, diffRiders);
      const byId = new Map(allRiders.map((rider) => [rider.studentId, rider]));
      const enrich = (c: { requestId: string; name: string }): SavedRouteChange => {
        const rider = byId.get(c.requestId);
        const isHub = isFreeHubLabelLocal(rider?.placeLabel);
        return {
          requestId: c.requestId, name: c.name,
          lat: rider && !isHub ? (rider.place.latitude ?? null) : null,
          lng: rider && !isHub ? (rider.place.longitude ?? null) : null,
          label: rider?.placeLabel ?? "", isHub,
          grade: rider?.childGrade ?? null, parentPhone: rider?.parentPhone ?? null,
          childPhone: rider?.childPhone ?? null, rosterId: null,
        };
      };
      added = diff.added.map(enrich);
      locationChanged = diff.locationChanged.map(enrich);
    } catch (error) {
      if (opts?.strict) throw error;
      // 유효 명단을 확인하지 못한 저장본은 휴원·퇴원생이 섞였는지 알 수 없어 사용하지 않는다.
      // 빈 배열이면 기사 화면은 월별 시트 원본으로 안전하게 폴백한다.
      vehicles = [];
      added = [];
      locationChanged = [];
    }

    return {
      vehicles,
      classStart: (r.classStart as string | null) ?? null,
      classEnd: (r.classEnd as string | null) ?? null,
      savedAt: isoOrNull(r.updatedAt),
      added,
      locationChanged,
    };
  } catch (error) {
    if (opts?.strict) throw error;
    // 테이블이 아직 없는 환경 → 저장 없음으로 취급(화면은 자동 제안 그대로).
    return null;
  }
}

/**
 * 정규 셔틀의 "확정 승/하차 시각"을 저장된 배차 노선(RegularDispatchRoute)에서 찾아 돌려준다(학부모 마이페이지 Phase 3).
 *
 * 방학특강 getConfirmedDispatchEtas 의 정규판이다. 차이점은 두 가지뿐:
 *   1) 저장 단위가 (날짜 × 방향)이 아니라 **(요일 × 방향)** 이다 → 자녀 반의 요일로 조회한다.
 *   2) 학생 식별키가 shuttleRequestId 가 아니라 **studentId** 다(정규 payload가 studentId 로 저장됨).
 *      단, extractEtaByRequestId 는 "정차 students[].requestId" 문자열을 매칭하는데 정규는 그 자리에 studentId 를
 *      넣어 저장하므로(Phase 1 어댑트), 매칭키를 studentId 로 넘기면 그대로 동작한다(순수 로직 재사용).
 *
 * 입력: 본인 자녀 각각의 {studentId, 반 요일} 쌍. 반환 맵의 키 = `${studentId}::${dayOfWeek}`.
 *   (같은 자녀가 요일이 다른 두 반을 다니면 요일별로 확정시각이 다를 수 있어 요일까지 키에 넣는다.)
 *
 * 권한: 조회 함수는 인증하지 않는다(게이트웨이 원칙). 호출부(parent.ts)가 본인 자녀 studentId 만 넘기므로
 *   여기서 다시 필터하지 않는다(IDOR 안전). 미배차/미저장 요일은 자연히 빈 값(null)으로 남는다.
 */
export function regularEtaKey(studentId: string, dayOfWeek: string, serviceMonth?: string): string {
  return `${studentId}::${dayOfWeek}${serviceMonth ? `::${serviceMonth}` : ""}`;
}

export async function getConfirmedRegularDispatchEtas(
  pairs: { studentId: string; dayOfWeek: string }[],
  serviceMonth: string = koreaServiceMonth(),
): Promise<Map<string, ConfirmedDispatchEta>> {
  const result = new Map<string, ConfirmedDispatchEta>();
  if (!isServiceMonth(serviceMonth)) return result;
  // 유효한 (studentId, 요일) 쌍만 추린다. 요일은 화이트리스트(normDow)로 걸러 SQL 주입·오타를 막는다.
  const clean = (pairs ?? [])
    .map((p) => ({ studentId: typeof p.studentId === "string" ? p.studentId : "", dow: normDow(p.dayOfWeek) }))
    .filter((p): p is { studentId: string; dow: string } => p.studentId !== "" && p.dow != null);
  if (clean.length === 0) return result;

  // 미리 모든 쌍을 빈 값으로 채워 둔다(조회 실패/미저장이어도 안전하게 null 로 응답).
  for (const p of clean) result.set(regularEtaKey(p.studentId, p.dow, serviceMonth), { pickupEtaLabel: null, dropoffEtaLabel: null });

  // 필요한 요일만 조회한다(전체 요일 × 2방향은 최대 14행이라 매우 가볍다).
  const dows = [...new Set(clean.map((p) => p.dow))];
  // studentId → 그 학생이 필요로 하는 요일 집합. 아래서 "이 학생의 요일과 일치하는 노선"만 반영한다.
  const dowsByStudent = new Map<string, Set<string>>();
  for (const p of clean) {
    const set = dowsByStudent.get(p.studentId) ?? new Set<string>();
    set.add(p.dow);
    dowsByStudent.set(p.studentId, set);
  }
  const wantStudents = new Set(clean.map((p) => p.studentId));

  try {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "dayOfWeek", "direction", "payload"
         FROM "RegularDispatchRoute"
        WHERE "dayOfWeek" = ANY($1::text[])
          AND "serviceMonth"=$2`,
      dows, serviceMonth,
    );
    for (const r of rows) {
      const dow = normDow(r.dayOfWeek);
      const dir = normDir(r.direction);
      if (!dow || !dir) continue;
      const payload = r.payload as { vehicles?: unknown } | null;
      // 매칭키 = studentId(정규 payload 저장 규칙). 정차 라벨 맵을 만든다.
      const byStudent = extractEtaByRequestId(payload?.vehicles, dir);
      if (byStudent.size === 0) continue;
      for (const studentId of wantStudents) {
        // 이 노선의 요일을 실제로 다니는 자녀만 반영한다(요일 불일치 오염 방지).
        if (!dowsByStudent.get(studentId)?.has(dow)) continue;
        const label = byStudent.get(studentId);
        if (!label) continue;
        const cur = result.get(regularEtaKey(studentId, dow, serviceMonth))!;
        if (dir === "PICKUP" && cur.pickupEtaLabel == null) cur.pickupEtaLabel = label;
        if (dir === "DROPOFF" && cur.dropoffEtaLabel == null) cur.dropoffEtaLabel = label;
      }
    }
  } catch {
    // 테이블이 아직 없는 구버전 DB 등 → 시각 없음으로 둔다(학부모 화면은 종전과 동일).
  }
  return result;
}

/** 조정된 정규 노선을 저장(덮어쓰기). 원장/관리자만. */
export async function saveRegularDispatchRoute(input: {
  dayOfWeek: string; direction: string; vehicles: unknown[];
  serviceMonth?: string;
  classStart?: string | null; classEnd?: string | null;
  expectedSavedAt?: string | null;
}): Promise<{ savedAt: string | null }> {
  const admin = await requireAdmin();
  const dow = normDow(input.dayOfWeek), dir = normDir(input.direction);
  if (!dow || !dir) throw new Error("요일 또는 방향이 올바르지 않습니다.");
  const vehicles = validateRegularDispatchVehicles(input.vehicles);
  const driverIds = [...new Set(vehicles.flatMap((vehicle) => {
    if (vehicle == null || typeof vehicle !== "object" || Array.isArray(vehicle)) return [];
    const id = (vehicle as Record<string, unknown>).driverUserId;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  }))];
  if (driverIds.length > 0) {
    // 클라이언트가 임의 사용자 ID를 넣어도 기사 계정만 배차에 저장되도록 서버에서 다시 검증한다.
    const drivers = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "User" WHERE id = ANY($1::text[]) AND role='DRIVER'`,
      driverIds,
    );
    if (drivers.length !== driverIds.length) throw new Error("담당 기사 계정을 다시 선택해 주세요.");
  }
  const payloadJson = JSON.stringify({ vehicles });
  const serviceMonth = input.serviceMonth ?? koreaServiceMonth();
  if (!isServiceMonth(serviceMonth)) throw new Error("적용 월은 YYYY-MM 형식이어야 합니다.");
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `INSERT INTO "RegularDispatchRoute" ("serviceMonth","dayOfWeek","direction","payload","classStart","classEnd","savedByUserId","updatedAt")
     SELECT $1, $2, $3, $4::jsonb, $5, $6, $7, now()
     WHERE NOT $8::boolean OR $9::timestamptz IS NULL OR EXISTS (
       SELECT 1 FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 AND "dayOfWeek"=$2 AND "direction"=$3
         AND date_trunc('milliseconds',"updatedAt")=$9::timestamptz)
     ON CONFLICT ("serviceMonth","dayOfWeek","direction") DO UPDATE SET
       "payload" = EXCLUDED."payload",
       "classStart" = EXCLUDED."classStart",
       "classEnd" = EXCLUDED."classEnd",
       "savedByUserId" = EXCLUDED."savedByUserId",
       "updatedAt" = now()
     WHERE NOT $8::boolean OR date_trunc('milliseconds',"RegularDispatchRoute"."updatedAt")=$9::timestamptz
     RETURNING "updatedAt"`,
    serviceMonth, dow, dir, payloadJson,
    input.classStart ?? null, input.classEnd ?? null, admin.appUserId ?? null,
    input.expectedSavedAt !== undefined, input.expectedSavedAt ?? null,
  );
  if (!rows.length) throw new Error("다른 창에서 노선이 변경되었습니다. 다시 불러온 뒤 수정해 주세요.");
  return { savedAt: isoOrNull(rows[0]?.updatedAt) };
}

/** 해당 월·요일·방향의 저장 노선만 삭제한다. 자동 제안 원본 차량표는 삭제하지 않는다. */
export async function deleteRegularDispatchRoute(dayOfWeek: string, direction: string, serviceMonth?: string, expectedSavedAt?: string | null): Promise<boolean> {
  await requireAdmin();
  const dow = normDow(dayOfWeek), dir = normDir(direction);
  if (!dow || !dir) throw new Error("요일 또는 방향이 올바르지 않습니다.");
  const month = serviceMonth ?? koreaServiceMonth();
  if (!isServiceMonth(month)) throw new Error("적용 월은 YYYY-MM 형식이어야 합니다.");
  const count = await prisma.$executeRawUnsafe(
    `DELETE FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 AND "dayOfWeek"=$2 AND "direction"=$3
      AND (NOT $4::boolean OR date_trunc('milliseconds',"updatedAt")=$5::timestamptz)`,
    month, dow, dir, expectedSavedAt !== undefined, expectedSavedAt ?? null,
  );
  if (!Number(count) && expectedSavedAt !== undefined) throw new Error("다른 창에서 노선이 변경되었습니다. 다시 불러온 뒤 수정해 주세요.");
  return Number(count) > 0;
}

/**
 * 조회용 노선(요일 × 방향) — 방학특강 getDispatchForView 의 정규판.
 *   1) 저장본이 있으면 그대로(reconcile 반영) 쓴다(T맵 0회).
 *   2) 없으면 allowTmap=true 면 T맵으로 새로 계산(관리자 첫 진입), false 면 직선 추정(base).
 */
export async function getRegularDispatchForView(
  dayOfWeek: string,
  direction: "PICKUP" | "DROPOFF",
  allowTmap: boolean,
  serviceMonth?: string,
): Promise<DispatchSuggestion> {
  const dow = normDow(dayOfWeek) ?? "Mon";
  // 먼저 T맵 없이 기준정보를 얻는다(직선 추정 base).
  const base = await computeRegularDispatch({ direction, dayOfWeek: dow, serviceMonth, localOnly: true });
  const saved = await getSavedRegularDispatchRoute(dow, direction, serviceMonth, { strict: allowTmap });
  if (saved && Array.isArray(saved.vehicles)) {
    return {
      ...base,
      savedAt: saved.savedAt, loadedFromSaved: true,
      vehicles: saved.vehicles as DispatchSuggestion["vehicles"],
      totalRiders: (saved.vehicles as DispatchSuggestion["vehicles"]).reduce((count, vehicle) => count + vehicle.stops.reduce((total, stop) => total + stop.students.length, 0), 0),
      classStart: saved.classStart ?? base.classStart,
      classEnd: saved.classEnd ?? base.classEnd,
      routingProvider: "TMAP",
      added: saved.added as DispatchSuggestion["added"],
      locationChanged: saved.locationChanged as DispatchSuggestion["locationChanged"],
    };
  }
  // 저장본이 없을 때만: 관리자 첫 진입은 T맵으로 계산, 그 외는 직선 추정 base.
  return allowTmap ? computeRegularDispatch({ direction, dayOfWeek: dow, serviceMonth, localOnly: false }) : base;
}
