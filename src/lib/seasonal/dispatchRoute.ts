import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import { addDaysKst, kstDow } from "@/lib/datetime/kst";
// 저장 시점 이후의 수강상태 변동(결석·수강취소·폐강 등)을 "읽을 때" 반영하기 위해 유효 명단 게이트웨이를 쓴다.
// ⚠️ 순환 import 주의: shuttleRoster.ts는 dispatchRoute를 import하지 않으므로(단방향) 여기서 가져와도 안전하다.
//    shuttle-optimize.ts는 dispatchRoute를 import하므로, 반대로 여기서 shuttle-optimize를 import하면 순환이 된다.
//    그래서 Run/Stop 타입을 재사용하지 않고 이 파일 안에 최소 구조 타입을 직접 정의한다.
import { getConfirmedShuttleRosterForDate, getWeekdayMembers } from "./shuttleRoster";
// reconcile 로직은 의존성 없는 순수 모듈이 정본이다(shuttleRosterEdit.ts와 같은 이유 — 실제 실행 테스트 가능).
import { reconcileSavedVehicles, diffSavedRoute } from "./dispatchReconcile";
// 저장 payload에서 requestId별 확정 정차 라벨을 뽑는 순수 로직(학부모 마이페이지 확정시각 표시에 쓴다).
import { extractEtaByRequestId } from "./dispatchEtaLookup";

// 저장된 배차 노선(SeasonalDispatchRoute) 읽기/쓰기.
// 자동 제안을 손으로 조정한 결과를 (날짜 × 방향) 단위로 1행 저장한다. PgBouncer 때문에 $queryRawUnsafe 고정.

// 저장 노선 이후의 "추가/변경" 요약(Phase 2a). 저장본을 바꾸지 않고 화면 배너에만 쓰는 진단값이다.
// 화면에서 '추천 배정'·'좌표 자동 반영'을 하려면 좌표·라벨·학생정보까지 필요하므로 함께 실어 보낸다.
export type SavedRouteChange = {
  requestId: string; name: string;
  lat: number | null; lng: number | null; // 현재(변경 후) 좌표. isHub이거나 미확정이면 null.
  label: string; isHub: boolean;
  grade: string | null; parentPhone: string | null; childPhone: string | null; rosterId: string | null;
};

// 무료탑승 거점 학생 판정 — shuttle-optimize.isFreeHubLabel과 같은 기준(순환 import 회피 위해 여기 복제).
function isFreeHubLabelLocal(label: string | null | undefined): boolean {
  return (label ?? "").replace(/\s/g, "").includes("무료탑승");
}

export type SavedDispatchRoute = {
  vehicles: unknown[];
  classStart: string | null;
  classEnd: string | null;
  savedAt: string | null; // ISO
  /** 저장 노선에 없던 신규·복귀 대상자(그날 유효 명단 기준). 없으면 빈 배열. */
  added: SavedRouteChange[];
  /** 저장 노선에는 있으나 좌표가 바뀐 대상자. 없으면 빈 배열. */
  locationChanged: SavedRouteChange[];
};

function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function normDir(v: unknown): "PICKUP" | "DROPOFF" | null {
  return v === "PICKUP" || v === "DROPOFF" ? v : null;
}

// 날짜가 속한 시즌이 하나일 때만 요일 노선을 공유한다. 겹치는 시즌은 추측하지 않는다.
async function seasonalRouteScope(date: string): Promise<{ first: string; last: string }> {
  const rows = await prisma.$queryRawUnsafe<{ first: string; last: string }[]>(
    `SELECT ("startsAt" AT TIME ZONE 'Asia/Seoul')::date::text AS first,
            ("endsAt" AT TIME ZONE 'Asia/Seoul')::date::text AS last
       FROM "SpecialProgramSeason"
      WHERE $1::date BETWEEN ("startsAt" AT TIME ZONE 'Asia/Seoul')::date
                         AND ("endsAt" AT TIME ZONE 'Asia/Seoul')::date`, date);
  if (rows.length !== 1) throw new Error("운행 날짜의 특강 기간을 확인해 주세요.");
  return rows[0];
}

/**
 * 그 날짜·방향의 저장된 노선. 없으면 null.
 *
 * @param date  **노선을 꺼낼 날짜**. 노선은 요일 단위로 관리되므로 보통 그 요일의 대표일(첫 운행일)이 들어온다.
 * @param opts.attendanceDate
 *   **출결을 볼 날짜**(화면이 실제로 보여 주는 날짜). 생략하면 date와 같다.
 *   노선 자체는 요일 대표일 것을 쓰지만, "오늘 누가 결석인가"는 대표일이 아니라 **오늘** 기준이어야 한다.
 *   이 둘을 분리하지 않으면 8/10 화면에서 7/27의 결석자가 매주 결석으로 뜬다.
 */
export async function getSavedDispatchRoute(
  date: string | null,
  direction: string,
  opts?: { attendanceDate?: string | null; strict?: boolean; raw?: boolean },
): Promise<SavedDispatchRoute | null> {
  const d = normDate(date), dir = normDir(direction);
  const attendanceDate = normDate(opts?.attendanceDate) ?? d;
  if (!d || !dir) return null;
  try {
    const scope = await seasonalRouteScope(d);
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      // 노선은 **요일 단위**다. 그 날짜에 저장 행이 없으면 같은 요일의 대표일(가장 이른 날) 것을 쓴다.
      //   이게 없으면 화면에서 날짜를 바꾸는 순간(예: 8/10 월요일) 저장 행이 없다고 판단해
      //   저장 노선을 버리고 새로 계산해 버린다 — 요일별 노선 재사용이 첫 진입 때만 동작하고,
      //   '신규·복귀' 배너도 사라져 중간 합류자를 배정할 방법이 없어진다(2026-08-03 실측).
      // ORDER BY: 정확히 일치하는 날짜를 최우선, 없으면 같은 요일 중 가장 이른 날.
      `SELECT "payload", "classStart", "classEnd", "updatedAt"
         FROM "SeasonalDispatchRoute"
        -- ⚠️ serviceDate 컬럼은 date가 아니라 **text**다. 캐스팅 없이 EXTRACT를 쓰면
        --    "operator does not exist: text = date"로 쿼리가 통째로 실패하고,
        --    바깥 try/catch가 이를 삼켜 "저장 노선 없음"으로 보인다(노선이 화면에서 사라진다).
        WHERE "direction" = $2
          AND "serviceDate" BETWEEN $3 AND $4
          AND ("serviceDate" = $1
               OR EXTRACT(DOW FROM "serviceDate"::date) = EXTRACT(DOW FROM $1::date))
        ORDER BY "serviceDate" ASC
        LIMIT 1`,
      d, dir, scope.first, scope.last,
    );
    const r = rows[0];
    if (!r) return null;
    const payload = r.payload as { vehicles?: unknown[] } | null;
    const savedVehicles = Array.isArray(payload?.vehicles) ? payload!.vehicles! : [];

    // reconcile-on-read: d(날짜)가 있을 때만 그날 유효 명단으로 필터한다.
    // date가 null이면 애초에 위에서 return null이라 여기 오지 않지만, 방어적으로 스킵 조건을 둔다.
    // ★ DB는 절대 건드리지 않는다(읽기 필터만). 학생이 다시 유효해지면 자동으로 다시 나타난다(자가치유).
    let vehicles = savedVehicles;
    // 변동 감지 결과(Phase 2a). 명단 조회가 안 되면 빈 배열로 둔다(배너가 안 뜰 뿐, 저장본은 그대로 보인다).
    let added: SavedRouteChange[] = [];
    let locationChanged: SavedRouteChange[] = [];
    if (d && !opts?.raw) {
      try {
        // ★ 노선 소속(validIds) = **그 요일에 수업이 하나라도 있는 사람**.
        //   대표일 하루로 판정하면 시즌 중간 합류자가 그 요일 노선에 영원히 못 들어간다
        //   (대표일 좌석이 없어 걸러지고, 넣어도 reconcile이 매번 지운다 — 2026-08-03 실제 사고).
        const members = await getWeekdayMembers(d, dir);
        const validIds = new Set(members.map((m) => m.shuttleRequestId));
        // 그날 실제로 타는 사람(출결·좌석 반영). 화면이 보여 주는 **실제 날짜** 기준이어야 한다 —
        // 대표일로 보면 "오늘의 결석"이 아니라 "첫 주의 결석"이 매주 반복 표시된다.
        const todayDate = attendanceDate ?? d;
        const plan = await getConfirmedShuttleRosterForDate(todayDate, dir, { includeAbsent: true });
        // 라벨 갱신용 명단은 대표일 기준으로도 한 벌 필요하다(그날 좌석이 없는 소속자의 라벨 보강).
        const canonPlan = todayDate === d
          ? plan
          : await getConfirmedShuttleRosterForDate(d, dir, { includeAbsent: true }).catch(() => plan);

        // 오늘 타는 사람 = 오늘 좌석이 있고(SCHEDULED) 결석이 아닌 사람.
        const ridingToday = new Set(
          plan.riders.filter((r) => !r.isAbsent).map((r) => r.shuttleRequestId),
        );
        // 결석 표시 = **소속인데 오늘 안 타는 사람** 전부.
        //   그날 결석 처리된 사람뿐 아니라, 아직 시작 전이거나 이미 종료한 사람도 여기 들어간다
        //   (김윤처럼 8/10부터 등원하는 학생은 그 전 월·수에 자동으로 결석 표시된다).
        const absentIds = new Set([...validIds].filter((id) => !ridingToday.has(id)));

        // requestId → 현재 명단 라벨. reconcile이 저장본의 얼어붙은 정차 라벨을 이걸로 갱신한다(텍스트만·자가치유).
        const labelByRequestId = new Map<string, string>();
        for (const rider of canonPlan.riders) labelByRequestId.set(rider.shuttleRequestId, rider.placeLabel);
        for (const rider of plan.riders) labelByRequestId.set(rider.shuttleRequestId, rider.placeLabel);

        vehicles = reconcileSavedVehicles(savedVehicles, validIds, labelByRequestId, absentIds);
        // diff(신규·복귀)는 **그 요일 소속자 전체** 기준으로 본다. "오늘 타는 사람"으로 보면 안 된다 —
        //   노선은 요일 단위인데 배정 대상만 날짜 단위로 판정하면, 화면이 열려 있는 날짜에 마침
        //   수업이 없는 소속자(중간 합류자 등)는 영원히 배너에 뜨지 않아 배정할 방법이 없다.
        //   실제로 8/10부터 등원하는 학생이, 기본 화면(시즌 첫 날짜)에서는 안 보여
        //   "월·수 노선에 넣을 수가 없는" 상태였다(2026-08-03 실측).
        // ★ 저장 payload는 절대 바꾸지 않는다 — diff는 순수 읽기 진단이다.
        const diff = diffSavedRoute(vehicles, members);
        // 좌표·라벨·학생정보로 살찌운다(화면의 추천 배정·좌표 자동 반영용). 명단에서 그 학생을 되짚어 채운다.
        // 소속자(members)를 바탕으로 하고, 그날 명단이 있으면 최신 값으로 덮는다.
        const byId = new Map([...members, ...canonPlan.riders, ...plan.riders].map((rider) => [rider.shuttleRequestId, rider]));
        const enrich = (c: { requestId: string; name: string }): SavedRouteChange => {
          const r = byId.get(c.requestId);
          const isHub = isFreeHubLabelLocal(r?.placeLabel);
          return {
            requestId: c.requestId, name: c.name,
            lat: r && !isHub ? (r.place.latitude ?? null) : null,
            lng: r && !isHub ? (r.place.longitude ?? null) : null,
            label: r?.placeLabel ?? "", isHub,
            grade: r?.childGrade ?? null, parentPhone: r?.parentPhone ?? null,
            childPhone: r?.childPhone ?? null, rosterId: r?.rosterId ?? null,
          };
        };
        added = diff.added.map(enrich);
        locationChanged = diff.locationChanged.map(enrich);
      } catch (error) {
        if (opts?.strict) throw error;
        // 유효 명단 조회가 실패하면(테이블 없음 등) 저장본을 그대로 보여 준다 — 화면이 비는 것보다 안전하다.
        vehicles = savedVehicles;
        added = [];
        locationChanged = [];
      }
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

/** 한 학생의 확정 승/하차 시각 라벨. 없으면 null. */
export type ConfirmedDispatchEta = { pickupEtaLabel: string | null; dropoffEtaLabel: string | null };

/**
 * 셔틀 신청 id들에 대해 "확정 승/하차 시각"을 저장된 배차 노선에서 찾아 돌려준다(학부모 마이페이지 T3).
 *
 * 왜 이렇게 조회하나:
 *   방학특강 셔틀의 확정 시각은 정규반처럼 ShuttleRoutePassenger.stop에 있지 않고,
 *   (날짜 × 방향) 단위로 저장된 SeasonalDispatchRoute.payload의 각 정차 etaLabel에 들어 있다.
 *   노선은 날짜별로 여러 건이지만 시각은 대체로 일정하므로 방향별 **대표 1건**만 쓴다.
 *   → 최근 저장분(updatedAt DESC)부터 훑어 그 학생이 처음 나타난 정차의 라벨을 채운다.
 *
 * 권한: 조회 함수는 인증하지 않는다(게이트웨이 조회 함수와 동일 원칙). 호출부(parent.ts)가
 *   이미 본인 자녀의 shuttleRequestId만 넘기므로 여기서 학생을 다시 필터하지 않는다(IDOR 안전).
 *   requestId 목록에 없는 학생 것은 애초에 결과에 담기지 않는다.
 */
export async function getConfirmedDispatchEtas(
  requestIds: string[],
): Promise<Map<string, ConfirmedDispatchEta>> {
  const result = new Map<string, ConfirmedDispatchEta>();
  const ids = [...new Set((requestIds ?? []).filter((x): x is string => typeof x === "string" && x !== ""))];
  if (ids.length === 0) return result;
  const want = new Set(ids);
  for (const id of ids) result.set(id, { pickupEtaLabel: null, dropoffEtaLabel: null });

  try {
    // 저장 노선은 시즌당 (운행일 × 2방향) 수십 행 수준이라 전체를 훑어도 가볍다.
    // 최근 저장분을 먼저 만나도록 정렬 → 아래에서 "아직 비어 있을 때만" 채워 대표 1건을 고른다.
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT "direction", "payload" FROM "SeasonalDispatchRoute" ORDER BY "updatedAt" DESC`,
    );
    for (const r of rows) {
      const dir = normDir(r.direction);
      if (!dir) continue;
      const payload = r.payload as { vehicles?: unknown } | null;
      const byId = extractEtaByRequestId(payload?.vehicles, dir);
      if (byId.size === 0) continue;
      for (const id of want) {
        const label = byId.get(id);
        if (!label) continue;
        const cur = result.get(id)!;
        if (dir === "PICKUP" && cur.pickupEtaLabel == null) cur.pickupEtaLabel = label;
        if (dir === "DROPOFF" && cur.dropoffEtaLabel == null) cur.dropoffEtaLabel = label;
      }
    }
  } catch {
    // 테이블이 없는 구버전 DB 등 → 시각 없음으로 둔다(학부모 화면은 종전과 동일하게 보인다).
  }
  return result;
}

/**
 * 저장 직전 payload에서 **파생값**을 떼어낸다.
 *
 * `isAbsent`(그날의 결석 표시)는 화면을 그리려고 읽는 시점에 매번 새로 계산되는 값이지,
 * 노선에 속한 성질이 아니다. 이게 payload에 섞여 저장되면 다음 주 같은 요일에도
 * "결석"이 그대로 따라와 기사 화면과 인원수가 계속 틀어진다.
 * 저장은 되돌리기 어려우므로, reconcile 쪽 방어와 **이중으로** 막는다.
 */
function stripDerivedFlags(vehicles: unknown[]): unknown[] {
  return vehicles.map((v) => {
    const run = (v ?? {}) as Record<string, unknown>;
    const stops = Array.isArray(run.stops) ? run.stops : [];
    return {
      ...run,
      stops: stops.map((s) => {
        const stop = (s ?? {}) as Record<string, unknown>;
        const students = Array.isArray(stop.students) ? stop.students : [];
        return {
          ...stop,
          students: students.map((st) => {
            const { isAbsent: _derived, ...rest } = (st ?? {}) as Record<string, unknown>;
            return rest;
          }),
        };
      }),
    };
  });
}

/** 조정된 노선을 저장(덮어쓰기). 원장/관리자만. */
export async function saveDispatchRoute(input: {
  date: string; direction: string; vehicles: unknown[]; classStart?: string | null; classEnd?: string | null; expectedSavedAt?: string | null;
}): Promise<{ savedAt: string | null }> {
  const admin = await requireAdmin();
  const d = normDate(input.date), dir = normDir(input.direction);
  if (!d || !dir) throw new Error("날짜 또는 방향이 올바르지 않습니다.");
  const vehicles = stripDerivedFlags(Array.isArray(input.vehicles) ? input.vehicles : []);
  const payloadJson = JSON.stringify({ vehicles });

  const scope = await seasonalRouteScope(d);
  const existing = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "serviceDate" AS d FROM "SeasonalDispatchRoute"
      WHERE "direction" = $2 AND "serviceDate" BETWEEN $3 AND $4
        AND EXTRACT(DOW FROM "serviceDate"::date) = EXTRACT(DOW FROM $1::date)
      ORDER BY "serviceDate" ASC LIMIT 1`, d, dir, scope.first, scope.last,
  );
  // 신규 노선은 기간 안의 첫 같은 요일을 정본 키로 삼아 동시 첫 저장도 한 행에 모은다.
  const firstWeekdayDate = addDaysKst(scope.first, (kstDow(d) - kstDow(scope.first) + 7) % 7);
  const targetDate = normDate(existing[0]?.d) ?? firstWeekdayDate;

  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `INSERT INTO "SeasonalDispatchRoute" ("serviceDate","direction","payload","classStart","classEnd","savedByUserId","updatedAt")
     SELECT $1, $2, $3::jsonb, $4, $5, $6, now()
     WHERE NOT $7::boolean OR $8::timestamptz IS NULL OR EXISTS (
       SELECT 1 FROM "SeasonalDispatchRoute" WHERE "serviceDate"=$1 AND "direction"=$2
         AND date_trunc('milliseconds',"updatedAt")=$8::timestamptz)
     ON CONFLICT ("serviceDate","direction") DO UPDATE SET
       "payload" = EXCLUDED."payload",
       "classStart" = EXCLUDED."classStart",
       "classEnd" = EXCLUDED."classEnd",
       "savedByUserId" = EXCLUDED."savedByUserId",
       "updatedAt" = now()
     WHERE NOT $7::boolean OR date_trunc('milliseconds',"SeasonalDispatchRoute"."updatedAt")=$8::timestamptz
     RETURNING "updatedAt"`,
    targetDate, dir, payloadJson,
    input.classStart ?? null, input.classEnd ?? null, admin.appUserId ?? null,
    input.expectedSavedAt !== undefined, input.expectedSavedAt ?? null,
  );
  if (!rows.length) throw new Error("다른 창에서 노선이 변경되었습니다. 다시 불러온 뒤 수정해 주세요.");
  return { savedAt: isoOrNull(rows[0]?.updatedAt) };
}

/** 저장된 노선을 삭제한다(그 날짜·방향). 삭제 후에는 자동 제안이 다시 기준이 된다. 원장/관리자만. */
export async function deleteDispatchRoute(date: string, direction: string, expectedSavedAt?: string | null): Promise<{ deleted: number }> {
  await requireAdmin();
  const d = normDate(date), dir = normDir(direction);
  if (!d || !dir) throw new Error("날짜 또는 방향이 올바르지 않습니다.");
  const scope = await seasonalRouteScope(d);
  const n = await prisma.$executeRawUnsafe(
    `DELETE FROM "SeasonalDispatchRoute" WHERE "direction" = $2 AND "serviceDate" BETWEEN $3 AND $4
      AND EXTRACT(DOW FROM "serviceDate"::date) = EXTRACT(DOW FROM $1::date)
      AND (NOT $5::boolean OR date_trunc('milliseconds',"updatedAt")=$6::timestamptz)`, d, dir, scope.first, scope.last, expectedSavedAt !== undefined, expectedSavedAt ?? null,
  );
  if (!Number(n) && expectedSavedAt !== undefined) throw new Error("다른 창에서 노선이 변경되었습니다. 다시 불러온 뒤 수정해 주세요.");
  return { deleted: Number(n) || 0 };
}
