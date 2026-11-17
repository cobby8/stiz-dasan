import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// R-7②(2026-11-10): 확정 여부를 «시즌마다» 판정하는지 실제로 돌려 본다.
// 예전엔 보관 안 된 시즌 중 하나라도 확정본이 있으면 전체를 확정본으로만 읽어,
// 다음 방학 시즌(확정 전) 셔틀 신청자가 기사님 명단·학부모 화면·안내에서 통째로 빠졌다.
// 여기서는 가짜 DB 로 «여름 = 확정, 겨울 = 확정 전»을 만들어 결과를 본다.

function makeLoader(mocks) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    cache.set(file, module.exports);
    const js = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const req = (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith("./")) return load(path.join(path.dirname(file), name).replace(/\\/g, "/") + ".ts");
      throw new Error(`unexpected import ${name}`);
    };
    vm.runInNewContext(js, { module, exports: module.exports, require: req, console, Math, JSON, Number, String, Array, Object, Set, Map, Error, Promise, Date });
    cache.set(file, module.exports);
    return module.exports;
  }
  return load;
}

function row(seasonId, id, name, extra = {}) {
  return { seasonId, shuttleRequestId: id, rosterId: `ro-${id}`, studentName: name, ride: true, classStart: "10:00", ...extra };
}

function fixture({ mode = true, confirmedSeasons = ["summer"], confirmed = [], fallback = [] } = {}) {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ sql, args });
      if (sql.includes(`"shuttleRosterConfirmedMode" AS mode`)) return [{ mode }];
      if (sql.includes(`SELECT DISTINCT sr."seasonId"`)) {
        const only = args[0];
        return confirmedSeasons.filter((s) => !only || s === only).map((s) => ({ seasonId: s }));
      }
      if (sql.includes(`FROM "SeasonalShuttleRoster" sr`) && sql.includes(`ANY($1::text[])`)) {
        return confirmed.filter((r) => args[0].includes(r.seasonId));
      }
      if (sql.includes(`FROM "SpecialProgramShuttleRequest" r`)) {
        // 폴백: 시즌 지정($1) 또는 확정 시즌 제외(마지막 인자 배열)를 흉내 낸다.
        const exclude = sql.includes(`NOT (a."seasonId" = ANY(`) ? args[args.length - 1] : [];
        const only = sql.includes(`a."seasonId" = $1`) ? args[0] : null;
        return fallback.filter((r) => (!only || r.seasonId === only) && !exclude.includes(r.seasonId));
      }
      throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
    },
  };
  const load = makeLoader({ "@/lib/prisma": { prisma }, "@/lib/auth-guard": { requireAdmin: async () => ({}) } });
  return { calls, mod: load("src/lib/seasonal/shuttleRoster.ts") };
}

const SUMMER = [row("summer", "s1", "가"), row("summer", "s2", "나")];
const WINTER_SRC = [row("winter", "w1", "다", { requestStatus: "APPROVED", classStart: "09:00" }), row("winter", "w2", "라", { requestStatus: "APPROVED" })];
const SUMMER_SRC = [row("summer", "s3", "마", { requestStatus: "APPROVED" })]; // 여름 확정 뒤 들어온 신청

test("여름 확정 + 겨울 확정 전 → 여름은 확정본만, 겨울은 신청 원본(다른 시즌이 확정됐다고 사라지지 않음)", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  const out = await mod.getConfirmedShuttleRoster();
  const byId = Object.fromEntries(out.map((e) => [e.shuttleRequestId, e.origin]));
  assert.deepEqual(byId, { s1: "CONFIRMED", s2: "CONFIRMED", w1: "FALLBACK", w2: "FALLBACK" });
  assert.ok(!("s3" in byId), "확정한 여름 시즌에 확정 뒤 들어온 신청이 섞이면 안 된다");
  // 합친 결과도 탑승·수업 시작·이름 순서
  assert.deepEqual(Array.from(out, (e) => e.shuttleRequestId), ["w1", "s1", "s2", "w2"]);
});

test("확정 시즌만 있을 때는 예전과 같다(확정본만)", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: SUMMER_SRC });
  const out = await mod.getConfirmedShuttleRoster();
  assert.deepEqual(out.map((e) => [e.shuttleRequestId, e.origin]), [["s1", "CONFIRMED"], ["s2", "CONFIRMED"]]);
});

test("R-7① 유지: 확정 시즌에서 전원을 빼도(보이는 행 0) 폴백이 되살아나지 않는다", async () => {
  const { mod } = fixture({ confirmed: [], fallback: SUMMER_SRC });
  assert.deepEqual(await mod.getConfirmedShuttleRoster("summer"), []);
  assert.deepEqual(await mod.getConfirmedShuttleRoster(), []);
});

test("킬 스위치가 꺼져 있거나 확정본이 없으면 전체 원본(예전 그대로)", async () => {
  const off = fixture({ mode: false, confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  assert.equal((await off.mod.getConfirmedShuttleRoster()).every((e) => e.origin === "FALLBACK"), true);
  const none = fixture({ confirmedSeasons: [], fallback: WINTER_SRC });
  assert.deepEqual((await none.mod.getConfirmedShuttleRoster()).map((e) => e.shuttleRequestId), ["w1", "w2"]);
});

test("시즌을 지정하면 그 시즌 기준만 본다", async () => {
  const { mod } = fixture({ confirmed: SUMMER, fallback: [...WINTER_SRC, ...SUMMER_SRC] });
  assert.deepEqual((await mod.getConfirmedShuttleRoster("winter")).map((e) => e.origin), ["FALLBACK", "FALLBACK"]);
  assert.deepEqual((await mod.getConfirmedShuttleRoster("summer")).map((e) => e.origin), ["CONFIRMED", "CONFIRMED"]);
});

// ────────────────────────────────────────────────────────────────
// R-8②(2026-11-17): «뺀 학생» 목록과 되돌리기.
// 예전엔 되돌리기가 «방금 뺀 한 명»에게만 떠서, 새로고침하거나 두 명을 연달아 빼면 먼저 뺀 학생을
// 이 화면에서 되돌릴 길이 없었다. 여기서는 가짜 DB 로 조회·되돌리기를 실제로 돌려 본다.
// ────────────────────────────────────────────────────────────────

function removedFixture({ mode = true, removedRows = [], rosterRow = null, tableMissing = false, role = "ADMIN", signedIn = true } = {}) {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ kind: "query", sql, args });
      if (sql.includes(`"shuttleRosterConfirmedMode" AS mode`)) return [{ mode }];
      if (sql.includes(`sr."removedAt" IS NOT NULL`)) {
        if (tableMissing) throw new Error(`relation "SeasonalShuttleRoster" does not exist`);
        return removedRows;
      }
      // 되돌리기가 «지우기 전에» 이유·수강 취소 여부를 읽는 조회
      if (sql.includes(`"removedReason" AS "removedReason"`) && sql.includes(`WHERE sr.id = $1`)) return rosterRow ? [rosterRow] : [];
      throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ kind: "exec", sql, args });
      return 1;
    },
  };
  const requireAdmin = async () => {
    if (!signedIn) throw new Error("Unauthorized");
    return { appUserRole: role, appUserId: "u1" };
  };
  const load = makeLoader({ "@/lib/prisma": { prisma }, "@/lib/auth-guard": { requireAdmin } });
  const execs = () => calls.filter((c) => c.kind === "exec");
  const originalUpdates = () => execs().filter((c) => c.sql.includes(`UPDATE "SpecialProgramShuttleRequest"`));
  return { calls, execs, originalUpdates, mod: load("src/lib/seasonal/shuttleRoster.ts") };
}

test("뺀 학생 조회: removedAt 이 찍힌 행만, 명단과 같은 시즌 범위(보관 시즌 제외)로 읽는다", async () => {
  const removedAt = new Date("2026-11-16T15:30:00Z"); // KST 로는 11-17 00:30
  const { mod, calls } = removedFixture({
    removedRows: [
      { rosterId: "ro-1", studentName: "가", offeringTitle: "오전반", removedAt, removedReason: null, enrollmentCancelled: false },
      { rosterId: "ro-2", studentName: "나", offeringTitle: null, removedAt, removedReason: "신청관리에서 취소", enrollmentCancelled: true },
    ],
  });
  const out = await mod.removedShuttleRosterRows();
  const q = calls.find((c) => c.sql.includes(`sr."removedAt" IS NOT NULL`));
  assert.match(q.sql, /FROM "SeasonalShuttleRoster" sr/);
  assert.match(q.sql, /s\.status <> 'ARCHIVED'/, "보관 시즌은 빼야 한다(명단 조회와 같은 seasonScope)");
  assert.doesNotMatch(q.sql, /sr\."removedAt" IS NULL/, "살아 있는 행을 섞으면 안 된다");
  assert.equal(q.args.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), [
    { rosterId: "ro-1", studentName: "가", offeringTitle: "오전반", removedAt: "2026-11-16T15:30:00.000Z", removedReason: null, enrollmentCancelled: false },
    { rosterId: "ro-2", studentName: "나", offeringTitle: null, removedAt: "2026-11-16T15:30:00.000Z", removedReason: "신청관리에서 취소", enrollmentCancelled: true },
  ]);

  // 시즌을 지정하면 그 시즌만
  const one = removedFixture();
  await one.mod.removedShuttleRosterRows("summer");
  const q2 = one.calls.find((c) => c.sql.includes(`sr."removedAt" IS NOT NULL`));
  assert.match(q2.sql, /sr\."seasonId" = \$1/);
  assert.deepEqual(Array.from(q2.args), ["summer"]);
});

test("뺀 학생 조회: 확정 모드가 꺼져 있거나 표가 없으면 빈 목록(화면이 깨지지 않는다)", async () => {
  const off = removedFixture({ mode: false, removedRows: [{ rosterId: "ro-1", studentName: "가", removedAt: new Date() }] });
  assert.equal((await off.mod.removedShuttleRosterRows()).length, 0);
  assert.equal(off.calls.some((c) => c.sql.includes(`"SeasonalShuttleRoster"`)), false, "모드가 꺼졌으면 확정본을 읽지도 않는다");
  const missing = removedFixture({ tableMissing: true });
  assert.equal((await missing.mod.removedShuttleRosterRows()).length, 0);
});

test("뺀 학생 조회: 관리자가 아니면 읽지 못한다(권한 오류를 빈 목록으로 삼키지 않는다)", async () => {
  const { mod, calls } = removedFixture({ signedIn: false });
  await assert.rejects(() => mod.removedShuttleRosterRows(), /Unauthorized/);
  assert.equal(calls.length, 0);
});

test("되돌리기: 신청관리에서 취소한 학생이면 원본 신청서 status 도 함께 돌려놓는다", async () => {
  const { mod, execs, originalUpdates } = removedFixture({ rosterRow: { shuttleRequestId: "req-9", removedReason: "신청관리에서 취소" } });
  await mod.restoreConfirmedShuttleRosterRow("ro-9");
  assert.match(execs()[0].sql, /UPDATE "SeasonalShuttleRoster"\s+SET "removedAt" = NULL, "removedReason" = NULL/);
  const original = originalUpdates();
  assert.equal(original.length, 1, "원본 신청서가 CANCELLED 로 남으면 신청관리 화면과 명단이 어긋난다");
  assert.match(original[0].sql, /"status" = 'REQUESTED'/);
  assert.match(original[0].sql, /WHERE id = \$1 AND "status" = 'CANCELLED'/, "그 사이 다른 상태로 바뀐 신청서는 덮지 않는다");
  // 좁은 경합: 두 UPDATE 사이에 누가 다시 뺐으면 원본만 REQUESTED 로 남는다 → 확정본 행이 살아 있을 때만.
  assert.ok(
    original[0].sql.includes(`AND EXISTS (SELECT 1 FROM "SeasonalShuttleRoster" sr WHERE sr.id = $2 AND sr."removedAt" IS NULL)`),
    "원본 신청서 복구는 확정본 행이 지금도 살아 있을 때만 해야 한다",
  );
  // 인자 번호: $1 = 원본 신청서 id, $2 = 확정본 행 id
  assert.deepEqual(Array.from(original[0].args), ["req-9", "ro-9"]);
});

// 수강이 취소된 학생은 되돌려도 명단 조회가 숨긴다 → «명단»에도 «뺀 학생»에도 없는 학생이 된다.
// 그래서 목록은 그 사실을 표시하고, 되돌리기는 서버가 거부한다. 두 곳의 판정식이 갈리면 안 된다.
const CLOSED_ITEM = `ai.status NOT IN ('CANCELLED', 'REJECTED')`;

test("수강 취소 판정식: 뺀 학생 목록과 되돌리기가 같은 상수를 쓰고, 명단 조회의 제외 조건과 정확히 반대다", async () => {
  const list = removedFixture();
  const flag = list.mod.ROSTER_ENROLLMENT_CANCELLED_SQL;
  assert.equal(flag, `(ai.id IS NOT NULL AND NOT (${CLOSED_ITEM}))`);
  // 명단 조회(confirmedSeasonRoster)가 «보이는 학생»으로 남기는 조건 — 위 식의 정확한 부정이다.
  const source = readFileSync("src/lib/seasonal/shuttleRoster.ts", "utf8");
  assert.ok(source.includes(`AND (ai.id IS NULL OR ${CLOSED_ITEM})`), "명단 조회의 제외 조건이 바뀌었다 — 판정식도 같이 맞춰야 한다");

  // ① 뺀 학생 목록
  await list.mod.removedShuttleRosterRows();
  const listSql = list.calls.find((c) => c.sql.includes(`sr."removedAt" IS NOT NULL`)).sql;
  assert.ok(listSql.includes(`${flag} AS "enrollmentCancelled"`));
  assert.ok(listSql.includes(`LEFT JOIN "SpecialProgramApplicationItem" ai ON ai.id = sr."applicationItemId"`));

  // ② 되돌리기가 먼저 읽는 조회
  const restore = removedFixture({ rosterRow: { shuttleRequestId: "req-1", removedReason: null, enrollmentCancelled: false } });
  await restore.mod.restoreConfirmedShuttleRosterRow("ro-1");
  const beforeSql = restore.calls.find((c) => c.kind === "query" && c.sql.includes(`WHERE sr.id = $1`)).sql;
  assert.ok(beforeSql.includes(`${flag} AS "enrollmentCancelled"`));
  assert.ok(beforeSql.includes(`LEFT JOIN "SpecialProgramApplicationItem" ai ON ai.id = sr."applicationItemId"`));

  // 소스에도 식을 다시 적지 않았다(상수 정의 한 곳뿐).
  assert.equal(source.split("ai.id IS NOT NULL AND NOT").length - 1, 1);
});

test("되돌리기: 수강이 취소된 학생은 거부하고 UPDATE 가 한 건도 나가지 않는다", async () => {
  // 이유가 «신청관리에서 취소»여도(원본 복구 대상) 수강이 취소됐으면 아무것도 바꾸지 않는다.
  for (const removedReason of ["수강 취소", "신청관리에서 취소", null]) {
    const { mod, execs } = removedFixture({ rosterRow: { shuttleRequestId: "req-9", removedReason, enrollmentCancelled: true } });
    await assert.rejects(
      () => mod.restoreConfirmedShuttleRosterRow("ro-9"),
      (e) => e.message === "수강이 취소된 학생입니다. 수강을 되살린 뒤 다시 넣어 주세요." && e.message === mod.RESTORE_BLOCKED_ENROLLMENT_CANCELLED,
    );
    assert.equal(execs().length, 0, "거부했으면 확정본도 원본 신청서도 건드리면 안 된다");
  }
  // 수강이 살아 있으면(이유 글자에만 «수강 취소») 그대로 되돌린다.
  const alive = removedFixture({ rosterRow: { shuttleRequestId: "req-9", removedReason: "수강 취소", enrollmentCancelled: false } });
  await alive.mod.restoreConfirmedShuttleRosterRow("ro-9");
  assert.equal(alive.execs().length, 1);
});

// 게이트웨이가 던진 거부 문구가 API 를 거쳐 원장에게 한글 그대로(4xx) 내려가는지 실제로 돌려 본다.
test("PATCH restore: 수강 취소 거부는 500 «저장하지 못했습니다»가 아니라 409 + 한글 이유로 내려간다", async () => {
  const message = removedFixture().mod.RESTORE_BLOCKED_ENROLLMENT_CANCELLED;
  const load = makeLoader({
    "next/server": { NextResponse: { json: (body, init) => ({ body, init }) } },
    "@/lib/seasonal/shuttle-roster": {},
    "@/lib/seasonal/shuttleRoster": { restoreConfirmedShuttleRosterRow: async () => { throw new Error(message); } },
  });
  const route = load("src/app/api/admin/seasonal/shuttle-roster/route.ts");
  const quiet = console.error;
  console.error = () => {}; // route 가 남기는 오류 로그(의도한 실패)로 테스트 출력이 어지럽지 않게
  try {
    const res = await route.PATCH({ json: async () => ({ rosterId: "ro-9", action: "restore" }) });
    assert.equal(res.init.status, 409);
    assert.equal(res.body.error, message);
  } finally { console.error = quiet; }
});

test("되돌리기: 이 화면에서 뺀 학생(이유 없음)은 원본 신청서를 건드리지 않는다 — 빼기와 대칭", async () => {
  const restore = removedFixture({ rosterRow: { shuttleRequestId: "req-1", removedReason: null } });
  await restore.mod.restoreConfirmedShuttleRosterRow("ro-1");
  assert.equal(restore.execs().length, 1);
  assert.equal(restore.originalUpdates().length, 0);
  // 이 화면의 «명단에서 빼기»도 원본을 건드리지 않는다
  const remove = removedFixture();
  await remove.mod.removeConfirmedShuttleRosterRow("ro-1");
  assert.equal(remove.originalUpdates().length, 0);
  assert.equal(remove.execs()[0].args[1], null, "이 화면의 빼기는 이유를 남기지 않는다");
});

test("신청관리 취소 길이 남기는 이유와 되돌리기가 보는 이유는 같은 값이다", async () => {
  const { mod, execs, originalUpdates } = removedFixture();
  await mod.setConfirmedShuttleRideByRequestId("req-9", false);
  assert.equal(mod.REMOVED_BY_REQUEST_CANCEL, "신청관리에서 취소");
  assert.ok(execs()[0].sql.includes(`"removedReason" = '${mod.REMOVED_BY_REQUEST_CANCEL}'`));
  assert.deepEqual(Array.from(originalUpdates()[0].args), ["req-9", "CANCELLED"]);
});

test("되돌리기는 원장(ADMIN)만 — 부원장은 아무것도 바꾸지 못한다", async () => {
  const { mod, calls } = removedFixture({ role: "VICE_ADMIN", rosterRow: { shuttleRequestId: "req-9", removedReason: "신청관리에서 취소" } });
  await assert.rejects(() => mod.restoreConfirmedShuttleRosterRow("ro-9"), /원장/);
  assert.equal(calls.length, 0);
});

// GET 응답을 실제로 만들어 본다 — 기존 키는 그대로, 새 키 removed 만 덧붙는다.
test("GET 응답: 기존 키(roster·confirmed·confirmedCount·confirmedAt)는 그대로이고 removed 가 덧붙는다", async () => {
  const confirmedAt = new Date("2026-07-20T01:00:00Z");
  const removed = [{ rosterId: "ro-2", studentName: "나", offeringTitle: null, removedAt: confirmedAt, removedReason: null, enrollmentCancelled: false }];
  const load = makeLoader({
    "next/server": { NextResponse: { json: (body, init) => ({ body, init }) } },
    "@/lib/seasonal/shuttle-roster": { getSeasonalShuttleRoster: async () => [{ origin: "CONFIRMED", rosterId: "ro-1" }], updateShuttleRosterRow: async () => ({}) },
    "@/lib/seasonal/shuttleRoster": {
      shuttleRosterConfirmationInfo: async () => ({ confirmed: true, count: 3, confirmedAt }),
      removedShuttleRosterRows: async () => removed,
    },
  });
  const route = load("src/app/api/admin/seasonal/shuttle-roster/route.ts");
  const res = await route.GET();
  assert.deepEqual(Object.keys(res.body), ["roster", "confirmed", "confirmedCount", "confirmedAt", "removed"]);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.roster)), [{ origin: "CONFIRMED", rosterId: "ro-1" }]);
  assert.equal(res.body.confirmed, true);
  assert.equal(res.body.confirmedCount, 3);
  assert.equal(res.body.confirmedAt, confirmedAt);
  assert.equal(res.body.removed, removed);
});

// ────────────────────────────────────────────────────────────────
// R-8③(2026-11-17): 신청관리에서 취소한 학생을 신청관리에서 다시 «이용»으로 돌리는 길.
// 예전엔 route 가 «살아 있는 확정본 행이 있나»만 보고 갈래를 정해, 뺀 행뿐인 신청서는 «확정 전»으로 보고
// 원본 신청서만 REQUESTED 로 고쳤다 → 신청관리엔 «요청»인데 기사님 명단(확정본)에는 없는 학생이 생겼다.
// 여기서는 실제 route + 실제 게이트웨이 + 실제 원본 편집 모듈을 가짜 DB 위에서 돌려 나가는 SQL 을 본다.
// ────────────────────────────────────────────────────────────────

// roster: null = 확정본 행 없음 / { removed, enrollmentCancelled } = 확정본 행의 상태
function rideRouteFixture({ mode = true, roster = null, role = "ADMIN" } = {}) {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ kind: "query", sql, args });
      if (sql.includes(`"shuttleRosterConfirmedMode" AS mode`)) return [{ mode }];
      // 원본 편집 모듈이 저장 뒤 «하원=등원 동일»을 읽는 조회
      if (sql.includes(`FROM "SpecialProgramShuttleRequest" WHERE id = $1`)) return [{ same: false, lat: null }];
      if (sql.includes(`FROM "SeasonalShuttleRoster"`) && sql.includes(`"shuttleRequestId" = $1`)) {
        // 살아 있는 행 확인(isShuttleRequestConfirmed)
        if (!sql.includes(`"removedAt" IS NOT NULL`)) return roster && !roster.removed ? [{ one: 1 }] : [];
        // 뺀 행 확인 — 수강 취소 제외 조건이 SQL 에 있을 때만 그 조건을 흉내 낸다(없으면 취소 학생도 걸린다)
        const excludesCancelled = sql.includes(`ai.id IS NOT NULL AND NOT`);
        const hit = roster && roster.removed && !(excludesCancelled && roster.enrollmentCancelled);
        return hit ? [{ one: 1 }] : [];
      }
      throw new Error(`unexpected sql ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ kind: "exec", sql, args });
      return 1;
    },
  };
  const requireAdmin = async () => ({ appUserRole: role, appUserId: "u1" });
  const load = makeLoader({ "@/lib/prisma": { prisma }, "@/lib/auth-guard": { requireAdmin } });
  const gateway = load("src/lib/seasonal/shuttleRoster.ts");
  const original = load("src/lib/seasonal/shuttle-roster.ts"); // 같은 loader 라 게이트웨이를 다시 읽지 않는다
  const route = makeLoader({
    "next/server": { NextResponse: { json: (body, init) => ({ body, init }) } },
    "@/lib/seasonal/shuttle-roster": original,
    "@/lib/seasonal/shuttleRoster": gateway,
  })("src/app/api/admin/seasonal/shuttle-roster/route.ts");
  const execs = () => calls.filter((c) => c.kind === "exec");
  return {
    calls, gateway,
    rosterWrites: () => execs().filter((c) => c.sql.includes(`"SeasonalShuttleRoster"`)),
    originalWrites: () => execs().filter((c) => c.sql.includes(`UPDATE "SpecialProgramShuttleRequest"`)),
    execs,
    // 신청관리 드로어(SeasonalAdminClient 의 ShuttleRequestBox)가 보내는 그대로
    patchRide: (ride) => route.PATCH({ json: async () => ({ requestId: "req-9", patch: { ride } }) }),
  };
}

test("신청관리 복구: 뺀 확정본(신청관리에서 취소) + 원본 CANCELLED → 확정본도 되살리고 원본도 REQUESTED", async () => {
  const fx = rideRouteFixture({ roster: { removed: true, enrollmentCancelled: false } });
  const res = await fx.patchRide(true);
  assert.equal(res.body.ok, true);
  const roster = fx.rosterWrites();
  assert.equal(roster.length, 1, "확정본 행이 빠진 채면 신청관리엔 «요청»인데 기사님 명단에는 없는 학생이 된다");
  assert.match(roster[0].sql, /UPDATE "SeasonalShuttleRoster"\s+SET "removedAt" = NULL, "removedReason" = NULL/);
  assert.match(roster[0].sql, /WHERE "shuttleRequestId" = \$1 AND "removedAt" IS NOT NULL/);
  assert.deepEqual(Array.from(roster[0].args), ["req-9"]);
  assert.doesNotMatch(roster[0].sql, /INSERT/);
  const original = fx.originalWrites();
  assert.equal(original.length, 1);
  assert.deepEqual(Array.from(original[0].args), ["req-9", "REQUESTED"]);

  // 갈래 판단은 서버가 확정본을 직접 읽어서 한다 — 수강 취소 판정은 «뺀 학생» 목록·되돌리기와 같은 상수.
  const check = fx.calls.find((c) => c.kind === "query" && c.sql.includes(`"removedAt" IS NOT NULL`));
  assert.ok(check, "뺀 확정본 행이 있는지 서버가 읽어야 한다");
  assert.ok(check.sql.includes(`AND NOT ${fx.gateway.ROSTER_ENROLLMENT_CANCELLED_SQL}`));
  assert.ok(check.sql.includes(`LEFT JOIN "SpecialProgramApplicationItem" ai ON ai.id = sr."applicationItemId"`));
  assert.deepEqual(Array.from(check.args), ["req-9"]);
});

test("신청관리 복구: 확정본이 없는 신청서는 예전 그대로 — 확정본 INSERT/UPDATE 가 한 건도 없다", async () => {
  // 확정 전 시즌·확정 뒤 새로 들어온 신청. 확정은 원장이 «확정하기»를 눌렀을 때만 일어난다.
  const fx = rideRouteFixture({ roster: null });
  const res = await fx.patchRide(true);
  assert.equal(res.body.ok, true);
  assert.equal(fx.rosterWrites().length, 0, "복구가 새 확정본 행을 만들거나 고치면 안 된다");
  assert.equal(fx.execs().length, 1);
  assert.match(fx.execs()[0].sql, /UPDATE "SpecialProgramShuttleRequest" SET "status" = \$2, "updatedAt" = now\(\) WHERE id = \$1/);
  assert.deepEqual(Array.from(fx.execs()[0].args), ["req-9", "REQUESTED"]);

  // 확정 모드(킬 스위치)가 꺼져 있으면 원본이 정본이다 — 뺀 행이 있어도 확정본을 건드리지 않는다.
  const off = rideRouteFixture({ mode: false, roster: { removed: true, enrollmentCancelled: false } });
  await off.patchRide(true);
  assert.equal(off.rosterWrites().length, 0);
  assert.deepEqual(Array.from(off.originalWrites()[0].args), ["req-9", "REQUESTED"]);
});

test("신청관리 복구: 수강이 취소된 학생은 확정본을 되살리지 않는다(원본 신청서만 예전처럼 바뀐다)", async () => {
  const fx = rideRouteFixture({ roster: { removed: true, enrollmentCancelled: true } });
  const res = await fx.patchRide(true);
  assert.equal(res.body.ok, true);
  assert.equal(fx.rosterWrites().length, 0, "수강 취소 학생의 확정본 행을 되살리면 «명단»에도 «뺀 학생»에도 없는 학생이 된다");
  assert.equal(fx.originalWrites().length, 1);
  assert.deepEqual(Array.from(fx.originalWrites()[0].args), ["req-9", "REQUESTED"]);
});

test("신청관리 취소 방향은 예전과 같은 SQL — 확정된 학생은 확정본 soft remove + 원본 CANCELLED", async () => {
  const fx = rideRouteFixture({ roster: { removed: false, enrollmentCancelled: false } });
  await fx.patchRide(false);
  assert.equal(fx.execs().length, 2);
  assert.ok(fx.execs()[0].sql.includes(
    `SET "removedAt" = now(), "removedReason" = '신청관리에서 취소', "updatedAt" = now()\n          WHERE "shuttleRequestId" = $1 AND "removedAt" IS NULL`,
  ));
  assert.deepEqual(Array.from(fx.execs()[0].args), ["req-9"]);
  assert.deepEqual(Array.from(fx.execs()[1].args), ["req-9", "CANCELLED"]);
  assert.equal(fx.calls.some((c) => c.sql.includes(`"removedAt" IS NOT NULL`)), false, "취소 방향은 뺀 행을 찾지 않는다");

  // 확정본이 없는(또는 이미 빠진) 신청서의 취소도 예전 그대로 원본만 CANCELLED.
  for (const roster of [null, { removed: true, enrollmentCancelled: false }]) {
    const plain = rideRouteFixture({ roster });
    await plain.patchRide(false);
    assert.equal(plain.rosterWrites().length, 0);
    assert.equal(plain.execs().length, 1);
    assert.deepEqual(Array.from(plain.execs()[0].args), ["req-9", "CANCELLED"]);
    assert.equal(plain.calls.some((c) => c.sql.includes(`"removedAt" IS NOT NULL`)), false);
  }
});

test("신청관리 복구: 뺀 확정본을 되살리는 것은 원장만 — 부원장은 원본만 고쳐 어긋나게 만들지 못한다", async () => {
  const fx = rideRouteFixture({ role: "VICE_ADMIN", roster: { removed: true, enrollmentCancelled: false } });
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await fx.patchRide(true);
    assert.equal(res.init.status, 403);
    assert.match(res.body.error, /원장/);
    assert.equal(fx.execs().length, 0);
  } finally { console.error = quiet; }
});
