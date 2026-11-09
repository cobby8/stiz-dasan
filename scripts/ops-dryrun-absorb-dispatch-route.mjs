// 정규 셔틀 «저장 노선(RegularDispatchRoute) → 셔틀 명단(RegularShuttleStop) 흡수» 드라이런 (읽기 전용)
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가?
//   설계(2026-11-09 «하나의 운행표») 3단계: 저장 노선을 없애기 전에, 그 노선이 정한 순서·시각·정류장을
//   명단 행에 옮겨 적어야 기사님 화면이 배포 전후로 한 글자도 안 바뀐다.
//   옮기기 전에 «무엇이 바뀌는지(차이 목록)»를 원장·PM 이 먼저 봐야 하므로 이 스크립트는 **계산만** 한다.
//
// 🔒 안전
//   - DB 연결은 `BEGIN READ ONLY` 트랜잭션 안에서 SELECT 만 하고 ROLLBACK 한다. INSERT/UPDATE/DELETE 문이 없다.
//   - 적용 SQL 은 «글자»로만 만들어 파일에 쓴다(실행하지 않는다). 실제 적용은 PM 이 원장 확인 후 MCP 로.
//
// 🧩 기사님 화면과 같은 계산을 보장하는 법
//   흡수 매핑(학생 → 명단 행 id)은 기사님 화면 조립 함수 `buildSavedDriverSections` 를 **그대로 불러** 얻는다.
//   그래서 «기사님이 지금 보는 노선의 각 학생이 어느 명단 행(=탑승 체크 키)인지»가 화면과 똑같다.
//   흡수 전/후 화면은 `assembleRegularDriverClasses` + `buildRegularRows` + `sortUnifiedRows`(기사님 통합 화면 순서)로
//   만들어 비교한다. 결석·오늘만 변경은 날마다 다르므로 끈다(«월 + 요일» 기본형).
//
// 사용법 (worktree 에 node_modules 가 없으면 pg 를 찾도록 cwd 를 본 저장소로 두고 실행)
//   node scripts/ops-dryrun-absorb-dispatch-route.mjs [--month 2026-11] [--day Thu] [--direction PICKUP]
//        [--also-month 2026-12] [--env <.env 경로>] [--out <결과 폴더>] [--stamp 20261109]
//   --also-month: 그 달 명단이 흡수 전 복사본이면 같은 변경을 거울 적용(짝 행 1개 + 값 동일할 때만)
//   결과: <out>/absorb-dryrun.json (차이 목록·전후 화면 스냅샷) · <out>/absorb-apply.sql · <out>/absorb-rollback.sql

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assembleRegularDriverClasses,
  buildSavedDriverSections,
  normalizeStopName,
  pickRegularRouteSource,
  savedStopTimeLabel,
  selectDriverDayRows,
} from "../src/lib/shuttle/regularDriverRouteLogic.ts";
import { buildRegularRows, sortUnifiedRows } from "../src/lib/shuttle/unifiedDriverRunLogic.ts";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── 인자·환경 ───────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** .env 파일에서 DATABASE_URL 만 읽는다(값은 화면에 찍지 않는다). */
function readDatabaseUrl() {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const candidates = [arg("env"), path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env")].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    const v = line?.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    if (v) return v;
  }
  return null;
}

/** pg 모듈: 스크립트 옆 node_modules 가 없으면(worktree) 현재 폴더 기준으로 찾는다. */
async function loadPg() {
  try {
    return (await import("pg")).default;
  } catch {
    return createRequire(path.join(process.cwd(), "noop.js"))("pg");
  }
}

// ── 읽기 쿼리(SELECT 만) ────────────────────────────────────────────────────
const SQL_ROUTES = `
  SELECT "id", "serviceMonth", "dayOfWeek", "direction", "payload", "classStart", "classEnd", "updatedAt"
    FROM "RegularDispatchRoute"
   ORDER BY "serviceMonth", "dayOfWeek", "direction"`;

const SQL_DAY_STOPS = `
  SELECT "id", "serviceMonth", "weekday", "classTime", "arriveTime", "stopName", "direction",
         "studentName", "studentId", "studentPhone", "parentPhone", "note", "sortOrder", "latitude", "longitude"
    FROM "RegularShuttleStop"
   WHERE "serviceMonth" = $1 AND "weekday" = $2
   ORDER BY "sortOrder" ASC, "id" ASC`;

// 기사님 화면의 loadRowIdsByStudentId → getRegularShuttleRiders 와 **같은 식별키 계산**(shuttleRoster.ts 그대로).
const SQL_RIDER_KEYS = `
  SELECT COALESCE(rss."studentId", st."id", 'stop:' || rss."id") AS "studentId",
         rss."id" AS "stopRowId"
    FROM "RegularShuttleStop" rss
    LEFT JOIN LATERAL (
      SELECT s."id"
        FROM "Student" s
        JOIN "User" u ON u."id" = s."parentId"
       WHERE rss."studentId" IS NULL
         AND s."mergedIntoStudentId" IS NULL
         AND regexp_replace(lower(s."name"), '\\s', '', 'g') = regexp_replace(lower(rss."studentName"), '\\s', '', 'g')
       ORDER BY
         CASE WHEN rss."parentPhone" IS NOT NULL AND (
           regexp_replace(COALESCE(u."phone", ''), '[^0-9]', '', 'g') = regexp_replace(rss."parentPhone", '[^0-9]', '', 'g')
           OR EXISTS (SELECT 1 FROM "Guardian" g WHERE g."studentId" = s."id"
                       AND regexp_replace(COALESCE(g."phone", ''), '[^0-9]', '', 'g') = regexp_replace(rss."parentPhone", '[^0-9]', '', 'g'))
         ) THEN 0 ELSE 1 END,
         s."createdAt" ASC
       LIMIT 1
    ) st ON true
   WHERE rss."weekday" = $1 AND rss."direction" = $2 AND rss."serviceMonth" = $3
     AND rss."studentName" IS NOT NULL AND btrim(rss."studentName") <> ''
   ORDER BY rss."sortOrder" ASC, rss."stopName" ASC`;

// ── 순수 계산 ───────────────────────────────────────────────────────────────
const noAbsence = () => false;

/** 기사님 통합 화면에서 그 방향 줄만, 비교에 필요한 글자만 남긴다(= 스냅샷 형식). */
function screenOf(classes, direction) {
  return sortUnifiedRows(buildRegularRows(classes))
    .filter((r) => r.direction === direction)
    .map((r) => ({ group: r.groupLabel, time: r.time, label: r.label, riders: r.riders.map((x) => ({ rowId: x.checkId, name: x.name })) }));
}

/** 줄 순서·시각·정류장·학생 rowId 가 같은지(묶음 제목은 «차량→수업시간»으로 바뀌는 게 정상이라 뺀다). */
function compareScreens(before, after) {
  const key = (r) => `${r.time ?? "-"}|${normalizeStopName(r.label)}|${r.riders.map((x) => x.rowId).join(",")}`;
  const diffs = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    const b = before[i], a = after[i];
    if (!b || !a || key(b) !== key(a)) diffs.push({ index: i, before: b ?? null, after: a ?? null });
  }
  return diffs;
}

/**
 * 흡수 계획: 저장 노선 순서대로 명단 행에 sortOrder·arriveTime·stopName·좌표를 정한다.
 * sortOrder 는 «그 수업시간 칸이 이미 쓰던 번호만» 돌려 쓴다(요일 전체 한 줄의 다른 행 번호는 그대로).
 */
function planAbsorb({ route, dayRows, allDayStops, rowIdsByStudentId }) {
  const stopDir = route.direction === "PICKUP" ? "BOARD" : "ALIGHT";
  const { sections, leftoverRows } = buildSavedDriverSections({
    vehicles: route.payload?.vehicles,
    direction: route.direction,
    rowIdsByStudentId,
    sheetRows: dayRows.filter((r) => r.direction === stopDir),
    isAbsent: noAbsence,
  });
  const rowById = new Map(allDayStops.map((r) => [r.id, r]));

  // 노선 순서대로 (행 id, 정차 정보)
  const ordered = [];
  const unmatched = [];
  sections.forEach((sec, vi) => {
    for (const stop of sec[stopDir === "BOARD" ? "board" : "alight"]) {
      for (const r of stop.rows) {
        if (r.rowId.startsWith("route:")) { unmatched.push({ vehicle: sec.title, stop: stop.label, time: stop.arriveTime, name: r.name, key: r.rowId }); continue; }
        ordered.push({ rowId: r.rowId, vehicleIndex: vi, vehicle: sec.title, label: stop.label, time: stop.arriveTime, lat: stop.lat, lng: stop.lng });
      }
    }
  });

  // 수업시간별로 그 칸이 쓰던 sortOrder 묶음을 오름차순으로 돌려 쓴다.
  const byClass = new Map();
  for (const o of ordered) {
    const ct = rowById.get(o.rowId)?.classTime ?? "(수업시간 없음)";
    if (!byClass.has(ct)) byClass.set(ct, []);
    byClass.get(ct).push(o);
  }
  const updates = [];
  const vehiclesPerClass = {};
  const tieWarnings = [];
  const matchedIds = new Set(ordered.map((o) => o.rowId));
  // 흡수 대상이 아닌 행(PIVOT·하원·다른 반 등)이 쓰는 번호 — 겹치면 안 된다.
  const usedByOthers = new Set(allDayStops.filter((r) => !matchedIds.has(r.id)).map((r) => r.sortOrder));
  // 좌표는 JSON ↔ float8 표현 차이(소수 15자리)만 있는 경우가 많다 → 약 0.1m(1e-6도) 넘게 다를 때만 바꾼다.
  const coord = (route, cur) => (route != null && (cur == null || Math.abs(route - cur) > 1e-6) ? route : cur);
  for (const [ct, list] of byClass) {
    const slots = list.map((o) => rowById.get(o.rowId).sortOrder).sort((a, b) => a - b);
    // 같은 번호가 겹치면(명단 원본에 sortOrder 중복) 화면 순서가 id 순으로 정해져 노선 순서가 깨진다.
    // 바로 다음 번호가 비어 있으면 그 번호로 벌린다. 비어 있지 않으면 경고만 남긴다.
    for (let i = 1; i < slots.length; i++) {
      if (slots[i] > slots[i - 1]) continue;
      const cand = slots[i - 1] + 1;
      if (!usedByOthers.has(cand) && !slots.slice(i + 1).includes(cand)) slots[i] = cand;
      else tieWarnings.push({ classTime: ct, sortOrder: slots[i], note: "번호 중복을 벌릴 빈 번호가 없음 — 노선 순서가 id 순으로 바뀔 수 있음" });
    }
    vehiclesPerClass[ct] = [...new Set(list.map((o) => o.vehicle))];
    list.forEach((o, i) => {
      const cur = rowById.get(o.rowId);
      const next = {
        sortOrder: slots[i],
        arriveTime: o.time ?? cur.arriveTime,
        stopName: o.label,
        latitude: coord(o.lat, cur.latitude),
        longitude: coord(o.lng, cur.longitude),
      };
      const changed = Object.keys(next).filter((k) => (k === "stopName" ? next[k] !== cur[k] : String(next[k] ?? "") !== String(cur[k] ?? "")));
      updates.push({
        rowId: o.rowId, studentId: cur.studentId, direction: cur.direction, name: cur.studentName, classTime: cur.classTime, vehicle: o.vehicle,
        before: { sortOrder: cur.sortOrder, arriveTime: cur.arriveTime, stopName: cur.stopName, latitude: cur.latitude, longitude: cur.longitude },
        after: next,
        changed,
        stopNameOnlyWhitespace: next.stopName !== cur.stopName && normalizeStopName(next.stopName) === normalizeStopName(cur.stopName),
      });
    });
  }

  // 흡수 후 명단(메모리 사본)
  const patched = allDayStops.map((r) => {
    const u = updates.find((x) => x.rowId === r.id);
    return u ? { ...r, ...u.after } : r;
  });

  return {
    updates,
    unmatched,
    leftover: leftoverRows.map((r) => ({ rowId: r.id, name: r.studentName, classTime: r.classTime, stopName: r.stopName, arriveTime: r.arriveTime, sortOrder: r.sortOrder })),
    mixedClassVehicles: Object.entries(vehiclesPerClass).filter(([, v]) => v.length > 1).map(([ct, v]) => ({ classTime: ct, vehicles: v })),
    tieWarnings,
    patched,
  };
}

/**
 * 다음 달(예: 12월) 명단이 흡수 전 11월 명단을 그대로 복사한 경우, 같은 변경을 거울처럼 적용할 계획.
 * 짝 = 같은 학생(studentId)·수업시간·방향·요일 행이 «정확히 1개»이고, 그 행 값이 원본의 흡수 전 값과 같을 때만.
 * (다음 달에 누가 이미 고친 행은 건드리지 않고 «건너뜀»으로 보고한다.)
 */
function planMirror(updates, targetStops) {
  const mirrored = [];
  const skipped = [];
  const touched = new Set();
  for (const u of updates.filter((x) => x.changed.length > 0)) {
    const hits = targetStops.filter((r) => u.studentId && r.studentId === u.studentId && r.classTime === u.classTime && r.direction === u.direction);
    if (hits.length !== 1) { skipped.push({ name: u.name, reason: `짝 행 ${hits.length}개` }); continue; }
    const t = hits[0];
    const same = t.sortOrder === u.before.sortOrder && (t.arriveTime ?? null) === (u.before.arriveTime ?? null) && t.stopName === u.before.stopName;
    if (!same) { skipped.push({ name: u.name, reason: "다음 달 행이 이미 다른 값(따로 고친 것으로 보고 건드리지 않음)" }); continue; }
    touched.add(t.id);
    mirrored.push({ ...u, rowId: t.id, sourceRowId: u.rowId });
  }
  // 새 번호가 다음 달의 다른 행 번호와 겹치면 위험 → 경고
  const others = new Set(targetStops.filter((r) => !touched.has(r.id)).map((r) => r.sortOrder));
  const collisions = mirrored.filter((m) => m.after.sortOrder !== m.before.sortOrder && others.has(m.after.sortOrder)).map((m) => ({ name: m.name, sortOrder: m.after.sortOrder }));
  return { mirrored, skipped, collisions };
}

// ── SQL 글자 만들기(실행하지 않는다) ─────────────────────────────────────────
const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? "NULL" : String(Number(v)));

/** 적용할 변경 전체 = 저장 노선 달의 바뀌는 행 + (선택) 다음 달 거울 행. */
function changeSet(plans) {
  return plans.flatMap((p) => [
    ...p.plan.updates.filter((u) => u.changed.length > 0).map((u) => ({ ...u, month: p.route.serviceMonth })),
    ...(p.mirror?.mirrored ?? []).map((u) => ({ ...u, month: p.mirror.month })),
  ]);
}

function buildApplySql(stamp, plans) {
  const all = changeSet(plans);
  const months = [...new Set(all.map((u) => u.month))];
  const values = all.map((u) =>
    `    (${q(u.rowId)}, ${u.after.sortOrder}, ${q(u.after.arriveTime)}, ${q(u.after.stopName)}, ${num(u.after.latitude)}::double precision, ${num(u.after.longitude)}::double precision)`,
  ).join(",\n");
  const expected = all.length;
  return `-- 저장 노선 → 셔틀 명단 흡수 «적용» SQL (드라이런 ${stamp} 생성 · 실행 전 원장 확인 필수)
-- 🔒 행 id 유지 UPDATE 만(탑승 체크 키 보존). INSERT/DELETE 없음. RegularDispatchRoute 는 건드리지 않는다.
-- 이 시점엔 기사님 화면이 아직 저장 노선을 우선 읽으므로 적용해도 화면 변화 없음(읽기 끊기 배포 후 동일해야 정상).
BEGIN;

-- 1) 백업 표(이미 있으면 실패 → 같은 날 두 번 적용 방지)
CREATE TABLE "_bak_${stamp}_regular_dispatch_route" AS SELECT * FROM "RegularDispatchRoute";
CREATE TABLE "_bak_${stamp}_regular_shuttle_stop" AS
  SELECT * FROM "RegularShuttleStop" WHERE "serviceMonth" IN (${months.map(q).join(", ")});

-- 2) 사전 검증: 바꿀 행이 모두 있고, 드라이런 때 값 그대로인지(그 사이 누가 고쳤으면 0행 → 아래 검사에서 중단)
CREATE TEMP TABLE _absorb_plan ("id" text PRIMARY KEY, "sortOrder" int, "arriveTime" text, "stopName" text, "latitude" double precision, "longitude" double precision) ON COMMIT DROP;
INSERT INTO _absorb_plan VALUES
${values || "    -- (바꿀 행 없음)"}
;
CREATE TEMP TABLE _absorb_before ("id" text PRIMARY KEY, "sortOrder" int, "arriveTime" text, "stopName" text) ON COMMIT DROP;
INSERT INTO _absorb_before VALUES
${all.map((u) => `    (${q(u.rowId)}, ${u.before.sortOrder}, ${q(u.before.arriveTime)}, ${q(u.before.stopName)})`).join(",\n") || "    -- (없음)"}
;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "RegularShuttleStop" s JOIN _absorb_before b ON b."id" = s."id"
   WHERE s."sortOrder" = b."sortOrder" AND s."arriveTime" IS NOT DISTINCT FROM b."arriveTime" AND s."stopName" = b."stopName";
  IF n <> ${expected} THEN RAISE EXCEPTION '드라이런 이후 명단이 바뀌었습니다(일치 % / 예상 ${expected}). 드라이런을 다시 돌리세요.', n; END IF;
END $$;

-- 3) 적용(행 id 유지)
UPDATE "RegularShuttleStop" s
   SET "sortOrder" = p."sortOrder", "arriveTime" = p."arriveTime", "stopName" = p."stopName",
       "latitude" = p."latitude", "longitude" = p."longitude"
  FROM _absorb_plan p
 WHERE s."id" = p."id";

-- 4) 사후 검증: 정확히 ${expected}행이 계획값과 같아야 한다
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM "RegularShuttleStop" s JOIN _absorb_plan p ON p."id" = s."id"
   WHERE s."sortOrder" = p."sortOrder" AND s."arriveTime" IS NOT DISTINCT FROM p."arriveTime" AND s."stopName" = p."stopName";
  IF n <> ${expected} THEN RAISE EXCEPTION '적용 결과 불일치(% / ${expected}) — 롤백', n; END IF;
END $$;

COMMIT;
`;
}

function buildRollbackSql(stamp, plans) {
  const ids = changeSet(plans).map((u) => u.rowId);
  return `-- 저장 노선 흡수 «되돌림» SQL (드라이런 ${stamp} 생성)
-- 백업 표에서 바꾼 행의 sortOrder·arriveTime·stopName·좌표만 원래대로 돌린다(행 id 그대로라 탑승 체크 영향 없음).
-- 저장 노선(RegularDispatchRoute)은 흡수 때 지우지 않으므로 되돌릴 것이 없다. 코드도 되돌려야 하면 이전 커밋 재배포.
BEGIN;
UPDATE "RegularShuttleStop" s
   SET "sortOrder" = b."sortOrder", "arriveTime" = b."arriveTime", "stopName" = b."stopName",
       "latitude" = b."latitude", "longitude" = b."longitude"
  FROM "_bak_${stamp}_regular_shuttle_stop" b
 WHERE s."id" = b."id"
   AND s."id" IN (${ids.map(q).join(", ") || "NULL"});
-- 확인: 아래 결과가 0 이어야 한다
SELECT count(*) AS "still_different"
  FROM "RegularShuttleStop" s JOIN "_bak_${stamp}_regular_shuttle_stop" b ON b."id" = s."id"
 WHERE s."sortOrder" <> b."sortOrder" OR s."arriveTime" IS DISTINCT FROM b."arriveTime" OR s."stopName" <> b."stopName";
COMMIT;
-- 백업 표 정리는 1개월 뒤 원장 승인 후: DROP TABLE "_bak_${stamp}_regular_dispatch_route", "_bak_${stamp}_regular_shuttle_stop";
`;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
async function main() {
  const url = readDatabaseUrl();
  if (!url) { console.error("[실패] DATABASE_URL 을 찾지 못했습니다(--env 로 .env 경로 지정 가능)."); return 1; }
  const filter = { month: arg("month"), day: arg("day"), direction: arg("direction") };
  const outDir = arg("out", process.cwd());
  const stamp = arg("stamp", "20261109");

  const pg = await loadPg();
  const client = new pg.Client({ connectionString: url, application_name: "stiz-absorb-dispatch-dryrun", statement_timeout: 15_000 });
  await client.connect();
  const plans = [];
  let routesAll = [];
  try {
    // 🔒 읽기 전용 트랜잭션 — 이 안에서는 DB 가 쓰기를 거부한다.
    await client.query("BEGIN READ ONLY");
    routesAll = (await client.query(SQL_ROUTES)).rows;

    for (const route of routesAll) {
      if (filter.month && route.serviceMonth !== filter.month) continue;
      if (filter.day && route.dayOfWeek !== filter.day) continue;
      if (filter.direction && route.direction !== filter.direction) continue;
      if (pickRegularRouteSource(route.payload) !== "SAVED") { plans.push({ route, skipped: "학생 없는 빈 저장본(기사님 화면이 이미 명단을 씀)" }); continue; }

      const weekday = DOW.indexOf(route.dayOfWeek);
      const stopDir = route.direction === "PICKUP" ? "BOARD" : "ALIGHT";
      const allDayStops = (await client.query(SQL_DAY_STOPS, [route.serviceMonth, weekday])).rows;
      const dayRows = selectDriverDayRows(allDayStops, weekday);
      const orderIndex = new Map(dayRows.map((r, i) => [r.id, i]));
      const rowIdsByStudentId = new Map();
      for (const k of (await client.query(SQL_RIDER_KEYS, [weekday, stopDir, route.serviceMonth])).rows) {
        const list = rowIdsByStudentId.get(k.studentId) ?? [];
        list.push(k.stopRowId);
        rowIdsByStudentId.set(k.studentId, list);
      }
      for (const list of rowIdsByStudentId.values()) list.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

      // 같은 요일의 반대 방향 저장 노선(있으면 흡수 전후 모두 그대로 둔다)
      const other = routesAll.find((r) => r.serviceMonth === route.serviceMonth && r.dayOfWeek === route.dayOfWeek && r.direction !== route.direction) ?? null;
      const savedBefore = { PICKUP: null, DROPOFF: null, [route.direction]: route.payload, ...(other ? { [other.direction]: other.payload } : {}) };
      const savedAfter = { ...savedBefore, [route.direction]: null };
      const emptyMaps = { PICKUP: new Map(), DROPOFF: new Map(), [route.direction]: rowIdsByStudentId };

      const plan = planAbsorb({ route, dayRows, allDayStops, rowIdsByStudentId });
      const before = screenOf(assembleRegularDriverClasses({ dayRows, isAbsent: noAbsence, saved: savedBefore, rowIdsByStudentId: emptyMaps }), route.direction);
      const afterRows = selectDriverDayRows(plan.patched, weekday);
      const after = screenOf(assembleRegularDriverClasses({ dayRows: afterRows, isAbsent: noAbsence, saved: savedAfter, rowIdsByStudentId: emptyMaps }), route.direction);
      // (선택) 다음 달 거울 적용 — 그 달에 저장 노선이 없고 명단이 흡수 전 복사본일 때.
      let mirror = null;
      const alsoMonth = arg("also-month");
      if (alsoMonth && alsoMonth !== route.serviceMonth) {
        if (routesAll.some((r) => r.serviceMonth === alsoMonth && r.dayOfWeek === route.dayOfWeek && r.direction === route.direction)) {
          mirror = { month: alsoMonth, mirrored: [], skipped: [{ reason: "그 달에도 저장 노선이 따로 있음 — 그 노선으로 따로 드라이런" }], collisions: [] };
        } else {
          const targetStops = (await client.query(SQL_DAY_STOPS, [alsoMonth, weekday])).rows;
          mirror = { month: alsoMonth, ...planMirror(plan.updates, targetStops) };
          // 거울 적용 후 그 달 기사님 화면이 흡수 후(이번 달) 화면과 같은 모양인지(행 id 는 달마다 달라 이름으로 비교)
          const patchedT = targetStops.map((r) => { const m = mirror.mirrored.find((x) => x.rowId === r.id); return m ? { ...r, ...m.after } : r; });
          const screenT = screenOf(assembleRegularDriverClasses({ dayRows: selectDriverDayRows(patchedT, weekday), isAbsent: noAbsence, saved: { PICKUP: null, DROPOFF: null }, rowIdsByStudentId: emptyMaps }), route.direction);
          const byName = (s) => s.map((r) => `${r.time}|${r.label}|${r.riders.map((x) => x.name).join(",")}`);
          mirror.screenSameAsAbsorbedMonth = JSON.stringify(byName(screenT)) === JSON.stringify(byName(after));
          mirror.snapshotAfter = screenT;
        }
      }
      plans.push({ route, plan, before, after, mirror, screenDiffs: compareScreens(before, after) });
    }
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }

  // ── 결과 정리 ──
  const active = plans.filter((p) => p.plan);
  const report = {
    generatedAt: new Date().toISOString(),
    note: "읽기 전용 드라이런. 결석·오늘만 변경은 끈 «월 + 요일» 기본형 화면 기준.",
    savedRoutes: routesAll.map((r) => ({ id: r.id, serviceMonth: r.serviceMonth, dayOfWeek: r.dayOfWeek, direction: r.direction,
      students: (r.payload?.vehicles ?? []).flatMap((v) => (v?.stops ?? []).flatMap((s) => s?.students ?? [])).length,
      vehicles: (r.payload?.vehicles ?? []).length, updatedAt: r.updatedAt })),
    routes: plans.map((p) => p.plan ? {
      route: `${p.route.serviceMonth} ${p.route.dayOfWeek} ${p.route.direction}`,
      changedRows: p.plan.updates.filter((u) => u.changed.length > 0).length,
      unchangedRows: p.plan.updates.filter((u) => u.changed.length === 0).length,
      updates: p.plan.updates.map(({ rowId, name, classTime, vehicle, before, after, changed, stopNameOnlyWhitespace }) => ({ rowId, name, classTime, vehicle, before, after, changed, stopNameOnlyWhitespace })),
      unmatchedRouteStudents: p.plan.unmatched,
      rosterRowsNotInRoute: p.plan.leftover,
      classesSplitAcrossVehicles: p.plan.mixedClassVehicles,
      sortOrderTieWarnings: p.plan.tieWarnings,
      mirror: p.mirror ? {
        month: p.mirror.month,
        rows: p.mirror.mirrored.map(({ rowId, sourceRowId, name, before, after, changed }) => ({ rowId, sourceRowId, name, before, after, changed })),
        skipped: p.mirror.skipped,
        sortOrderCollisions: p.mirror.collisions,
        screenSameAsAbsorbedMonth: p.mirror.screenSameAsAbsorbedMonth ?? null,
        snapshotAfter: p.mirror.snapshotAfter ?? null,
      } : null,
      driverScreenSame: p.screenDiffs.length === 0,
      driverScreenDiffs: p.screenDiffs,
      snapshotBefore: p.before,
      snapshotAfter: p.after,
    } : { route: `${p.route.serviceMonth} ${p.route.dayOfWeek} ${p.route.direction}`, skipped: p.skipped }),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "absorb-dryrun.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(outDir, "absorb-apply.sql"), buildApplySql(stamp, active));
  writeFileSync(path.join(outDir, "absorb-rollback.sql"), buildRollbackSql(stamp, active));

  // 사람이 읽는 요약
  console.log(`저장 노선 ${routesAll.length}건: ${report.savedRoutes.map((r) => `${r.serviceMonth} ${r.dayOfWeek} ${r.direction}(학생 ${r.students})`).join(", ") || "없음"}`);
  for (const r of report.routes) {
    if (r.skipped) { console.log(`- ${r.route}: 건너뜀 — ${r.skipped}`); continue; }
    console.log(`- ${r.route}: 바뀌는 행 ${r.changedRows} · 그대로 ${r.unchangedRows} · 노선에만 있는 학생 ${r.unmatchedRouteStudents.length} · 노선에 없는 명단 행 ${r.rosterRowsNotInRoute.length} · 기사님 화면 동일=${r.driverScreenSame}`);
    for (const u of r.updates.filter((x) => x.changed.length)) {
      const parts = u.changed.map((k) => `${k} ${u.before[k] ?? "∅"}→${u.after[k] ?? "∅"}`);
      console.log(`    · ${u.name} [${u.classTime}] ${parts.join(" / ")}`);
    }
    for (const x of r.unmatchedRouteStudents) console.log(`    ! 노선에만 있음(명단 행 없음 → 흡수 후 화면에서 사라짐): ${x.name} ${x.time ?? ""} ${x.stop}`);
    for (const x of r.sortOrderTieWarnings) console.log(`    ! sortOrder 중복 미해결: ${x.classTime} ${x.sortOrder}`);
    for (const d of r.driverScreenDiffs) {
      const f = (s) => (s ? `${s.time ?? "--:--"} ${s.label} [${s.riders.map((x) => x.name).join(",")}]` : "(없음)");
      console.log(`    ~ 화면 줄 ${d.index + 1}: 전 ${f(d.before)}  →  후 ${f(d.after)}`);
    }
    if (r.mirror) console.log(`  거울(${r.mirror.month}): 적용 ${r.mirror.rows.length} · 건너뜀 ${r.mirror.skipped.length} · 번호충돌 ${r.mirror.sortOrderCollisions.length} · 흡수달과 화면 같음=${r.mirror.screenSameAsAbsorbedMonth}`);
  }
  console.log(`결과 파일: ${path.join(outDir, "absorb-dryrun.json")} · absorb-apply.sql · absorb-rollback.sql (실행 안 함)`);
  return 0;
}

main().then((code) => process.exit(code), (err) => { console.error("[실패]", err?.message ?? err); process.exit(1); });
