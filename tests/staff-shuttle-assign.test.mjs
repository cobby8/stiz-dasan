// 기사님 「새 학생 배정」 서버·API 가드 — 2026-11-05
// 서버 모듈(driverAssign.ts)을 가짜 DB 로 **실제로 실행**해 자격 재검사를 본다:
//   권한 없음 403 · 남의 학생(승인된 셔틀 신청 없음) 404 · 셔틀 미신청 404 · 이미 있는 칸 409 · 정상 저장(기사 id 로 감사 기록).
// API·화면은 소스 문자열로 401/403·원문 비노출·링크를 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const read = (file) => readFileSync(file, "utf8");

/** TS → CJS 로 바꿔 실행. 상대 경로는 실제 파일을, 바깥 의존은 mocks 로 바꾼다. */
function makeLoader(mocks) {
  const cache = new Map();
  function load(file) {
    const key = file.replace(/\\/g, "/");
    if (cache.has(key)) return cache.get(key);
    const module = { exports: {} };
    cache.set(key, module.exports);
    const js = ts.transpileModule(read(key), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const req = (name) => {
      if (name in mocks) return mocks[name];
      if (name.startsWith("./") || name.startsWith("../")) {
        const base = path.join(path.dirname(key), name).replace(/\\/g, "/").replace(/\.ts$/, "");
        if (base in mocks) return mocks[base];
        return load(`${base}.ts`);
      }
      throw new Error(`unexpected import ${name} in ${key}`);
    };
    vm.runInNewContext(js, { module, exports: module.exports, require: req, console, Math, JSON, Number, String, Array, Object, Set, Map, Error, Infinity, Promise });
    cache.set(key, module.exports);
    return module.exports;
  }
  return load;
}

function fixture() {
  const state = {
    roles: { driver: { admin: false, driver: true }, admin: { admin: true, driver: false }, teacher: { admin: false, driver: false } },
    apps: [
      { studentId: "new1", status: "APPROVED", shuttleNeeded: true, name: "신입", grade: "초3", shuttleTime: "16:40", parentPhone: "010-5555-7777", createdAt: "2026-11-01" },
      { studentId: "walk1", status: "APPROVED", shuttleNeeded: false, name: "도보", grade: "초2", shuttleTime: null, parentPhone: null, createdAt: "2026-11-01" },
    ],
    classes: [
      { studentId: "new1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규" },
      { studentId: "walk1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규" },
      { studentId: "other1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규" },
    ],
    places: [{ studentId: "new1", kind: "PICKUP", name: "B 근처", address: "다산동 1", latitude: 37.6205, longitude: 127.1 }],
    stops: [
      { id: "r1", serviceMonth: "2026-11", weekday: 1, classTime: "17:00~18:00", arriveTime: "16:30", stopName: "A", direction: "BOARD", studentName: "가", studentId: "a1", studentPhone: null, parentPhone: "010-1000-0001", note: null, sortOrder: 1, latitude: 37.63, longitude: 127.1 },
      { id: "r2", serviceMonth: "2026-11", weekday: 1, classTime: "17:00~18:00", arriveTime: "16:40", stopName: "B", direction: "BOARD", studentName: "나", studentId: "b1", studentPhone: null, parentPhone: "010-1000-0002", note: null, sortOrder: 2, latitude: 37.62, longitude: 127.1 },
    ],
    sql: [],
    adds: [],
  };
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      state.sql.push(sql);
      if (sql.includes(" AS admin,")) return state.roles[args[0]] ? [state.roles[args[0]]] : [];
      if (sql.includes(`FROM "EnrollmentApplication" a`)) {
        // 실제 SQL 의 조건(APPROVED + shuttleNeeded + 학생 지정)을 그대로 흉내 낸다 — 아래 테스트가 SQL 에 그 조건이 있는지도 본다.
        return state.apps.filter((a) => a.status === "APPROVED" && a.shuttleNeeded && (args[1] == null || a.studentId === args[1]));
      }
      if (sql.includes(`FROM "Enrollment" e`)) return state.classes.filter((c) => args[0].includes(c.studentId));
      if (sql.includes(`FROM "StudentShuttleLocation"`)) return state.places.filter((p) => args[0].includes(p.studentId));
      if (sql.includes(`DISTINCT "serviceMonth"`)) return [{ m: "2026-12" }];
      if (sql.includes(`FROM "RegularShuttleStop" WHERE "serviceMonth"=$1`)) return state.stops.filter((s) => s.serviceMonth === args[0]);
      throw new Error(`unexpected sql ${sql.slice(0, 60)}`);
    },
  };
  const load = makeLoader({
    "server-only": {},
    "@/lib/prisma": { prisma },
    // 「이번 달」을 고정해 날짜에 따라 결과가 바뀌지 않게 한다.
    "@/lib/regular/serviceMonth": { koreaServiceMonth: () => "2026-11" },
    "@/lib/studentVisibility": { notMergedStudent: (a) => `${a}."mergedIntoStudentId" IS NULL` },
    "@/lib/seasonal/shuttle-optimize": { getSettings: async () => ({ academy: { lat: 37.6, lng: 127.1 }, depot: { lat: 37.64, lng: 127.1 }, hub: null, hubDropoff: null }) },
    "src/lib/shuttle/regularRosterEdit": {
      async addRosterStudentAs(actorId, input, opts) {
        // 실제 함수처럼 잠금 안 마지막 확인(guard)을 그 달 행으로 부른다.
        opts.guard?.(state.stops.filter((s) => s.serviceMonth === input.serviceMonth));
        state.adds.push({ actorId, input, via: opts.via });
        return { added: 1, appliedMonths: ["2026-11", "2026-12"], skippedMonths: [] };
      },
    },
  });
  return { state, mod: load("src/lib/shuttle/driverAssign.ts") };
}

async function status(promise) {
  try { await promise; return "ok"; } catch (e) { return `${e.status}:${e.code}`; }
}

test("목록: 기사·관리자만, 남은 칸이 있는 승인 셔틀 신청 학생만(셔틀 미신청 제외), 다른 학생은 이름만", async () => {
  const { state, mod } = fixture();
  assert.equal(await status(mod.getDriverAssignBoard({ appUserId: "teacher" }, "2026-11")), "403:FORBIDDEN");
  assert.equal(await status(mod.getDriverAssignBoard({ appUserId: "ghost" }, "2026-11")), "403:FORBIDDEN");
  // vm 안에서 만든 배열은 원형이 달라 deepEqual 전에 평범한 값으로 바꾼다.
  const board = JSON.parse(JSON.stringify(await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11")));
  assert.deepEqual(board.students.map((s) => s.studentId), ["new1"]);
  assert.equal(board.openLegCount, 2);
  assert.deepEqual(board.laterMonths, ["2026-12"]);
  assert.deepEqual(board.students[0].legs[0].route.map((s) => s.riders), [["가"], ["나"]]);
  assert.doesNotMatch(JSON.stringify(board), /010-|parentPhone/);
  // 권한 SQL 은 현재 DB 역할(탈퇴 제외, DRIVER 주 역할 또는 승인된 추가 역할)
  const roleSql = state.sql.find((s) => s.includes(" AS admin,"));
  assert.match(roleSql, /"withdrawnAt" IS NULL/);
  assert.match(roleSql, /UserRoleGrant/);
  assert.ok((await mod.getDriverAssignBoard({ appUserId: "admin" }, "2026-11")).students.length === 1);
});

test("저장 재검사: 권한 없음 403 · 남의 학생 404 · 셔틀 미신청 404 · 이미 있는 칸 409 — 어느 경우도 명단에 쓰지 않는다", async () => {
  const { state, mod } = fixture();
  const board = await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11");
  const leg = board.students[0].legs[0];
  const body = { month: "2026-11", studentId: "new1", weekday: 1, direction: "BOARD", choice: { kind: "JOIN", stopIndex: 1 }, routeVersion: leg.routeVersion, includeNextMonth: true };

  assert.equal(await status(mod.assignDriverCell({ appUserId: "teacher" }, body)), "403:FORBIDDEN");
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, studentId: "other1" })), "404:NOT_ELIGIBLE");
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, studentId: "walk1" })), "404:NOT_ELIGIBLE");
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, weekday: 3 })), "409:NOT_CLASS_DAY");
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, routeVersion: "old" })), "409:ROUTE_CHANGED");
  // 이번 달·다음 달만 — 지난 달·두 달 뒤는 거절
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, month: "2026-10" })), "409:MONTH_OUT_OF_RANGE");
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, month: "2027-01" })), "409:MONTH_OUT_OF_RANGE");
  state.stops.push({ ...state.stops[1], id: "r9", studentId: "new1", studentName: "신입", sortOrder: 3 });
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, body)), "409:ALREADY_ASSIGNED");
  assert.equal(state.adds.length, 0);
  // 승인 셔틀 신청 조건이 실제 SQL 에 있다(가짜 DB 흉내와 같은 조건)
  const appSql = state.sql.find((s) => s.includes(`FROM "EnrollmentApplication" a`));
  assert.match(appSql, /a\."status"='APPROVED' AND a\."shuttleNeeded"=true/);
  assert.match(appSql, /mergedIntoStudentId" IS NULL/);
  const classSql = state.sql.find((s) => s.includes(`FROM "Enrollment" e`));
  assert.match(classSql, /e\."status"='ACTIVE'/);
  assert.match(classSql, /e\."startsOn" IS NULL OR to_char\(e\."startsOn",'YYYY-MM'\) <= \$2/);
});

test("저장 정상: 기사 userId 로 addRosterStudentAs(via DRIVER_ASSIGN) — 잠금 안 확인(guard)도 함께 넘긴다", async () => {
  const { state, mod } = fixture();
  const board = await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11");
  const leg = board.students[0].legs[0];
  const out = await mod.assignDriverCell({ appUserId: "driver" }, { month: "2026-11", studentId: "new1", weekday: 1, direction: "BOARD", choice: { kind: "JOIN", stopIndex: 1 }, routeVersion: leg.routeVersion, includeNextMonth: true });
  assert.equal(out.added, 1);
  assert.equal(state.adds.length, 1);
  assert.equal(state.adds[0].actorId, "driver");
  assert.equal(state.adds[0].via, "DRIVER_ASSIGN");
  assert.equal(state.adds[0].input.scope, "FROM_THIS_MONTH");
  assert.equal(state.adds[0].input.placements[0].rowId, "r2");
});

test("명단 쓰기 경로: 원장 addRosterStudent 는 requireAdmin 그대로, 본문은 addRosterStudentAs 하나 · 감사 기록에 actorId·via", () => {
  const edit = read("src/lib/shuttle/regularRosterEdit.ts");
  assert.match(edit, /export async function addRosterStudent\(raw: unknown\)[^\n]*\{\s*const admin = await requireAdmin\(\);\s*return addRosterStudentAs\(admin\.appUserId, raw\);/);
  assert.match(edit, /opts\.guard\?\.\(existing\)/);
  assert.match(edit, /await audit\(tx, actorId, "REGULAR_ROSTER_ADD", null, \{\s*\.\.\.\(opts\.via \? \{ via: opts\.via \} : \{\}\)/);
  // 관리자 API 는 그대로 addRosterStudent 를 부른다
  assert.match(read("src/app/api/admin/shuttle/regular-roster/route.ts"), /await addRosterStudent\(b\)/);
});

test("API: 로그인 없음 401 · 오류 원문 비노출 · 화면 링크와 문구", () => {
  const route = read("src/app/api/staff/shuttle/assign/route.ts");
  assert.match(route, /status: 401/);
  assert.match(route, /e instanceof DriverAssignError/);
  assert.doesNotMatch(route, /error: String\(|\(e as Error\)\.message|e\?\.message/);
  assert.match(route, /처리하지 못했어요\. 잠시 뒤 다시 해 주세요\./);
  assert.match(read("src/lib/shuttle/driverAssign.ts"), /\$queryRawUnsafe/);
  assert.doesNotMatch(read("src/lib/shuttle/driverAssign.ts"), /prisma\.\w+\.(findMany|findFirst|create|update|upsert)\(/);

  assert.match(read("src/app/staff/shuttle/page.tsx"), /href="\/staff\/shuttle\/assign"[\s\S]*새 학생 배정/);
  const ui = read("src/app/staff/shuttle/assign/DriverAssignClient.tsx");
  for (const text of ["새 학생 배정", "배정할 학생", "남은 칸", "배정 시작", "이미 운행표에 있는 학생은 여기 나오지 않아요.", "학생 위치에 새 정류장", "한 칸 위로", "한 칸 아래로", "운행표에 같이 넣기", "넣는 중…", "넣지 못했어요. 잠시 뒤 다시 해 주세요.", "에 넣었어요", "다시 시도"]) {
    assert.ok(ui.includes(text), `문구 없음: ${text}`);
  }
  assert.doesNotMatch(ui, /이 칸은 못 태워요/);
  // 하드코딩 색·작은 글자 금지, 아이콘은 Material Symbols
  assert.doesNotMatch(ui, /#[0-9a-fA-F]{3,6}\b|(bg|text|border)-(red|green|blue|gray|amber|orange|black|white)-?\d*\b/);
  assert.doesNotMatch(ui, /text-\[(1[01]|[0-9])(\.\d+)?px\]/);
  assert.match(ui, /material-symbols-outlined/);
  // 오류 원문을 그대로 띄우지 않는다(코드로 고른 안내만)
  assert.doesNotMatch(ui, /value\?\.error|\.message\)/);
});
