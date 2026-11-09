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
      { studentId: "new1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규", runsShuttle: true },
      { studentId: "walk1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규", runsShuttle: true },
      { studentId: "other1", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규", runsShuttle: true },
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
      // 보드 확장(2026-11-09): 그 달 명단에 행이 있는 학생(신청서 없음 포함) — 명단 행의 학생 id 로 흉내 낸다.
      if (sql.includes(`FROM "RegularShuttleStop" r WHERE r."serviceMonth"=$1`)) {
        const ids = [...new Set(state.stops.filter((s) => s.serviceMonth === args[0] && s.studentId).map((s) => s.studentId))];
        return ids.filter((id) => args[1] == null || id === args[1]).map((id) => {
          const s = state.stops.find((x) => x.studentId === id);
          return { studentId: id, name: s.studentName, grade: null, parentPhone: s.parentPhone };
        });
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
    // 셔틀 운행 반 판정은 청구와 같은 실제 함수(가짜로 바꾸지 않는다).
    get "@/lib/billing/workbench-pricing"() { return load("src/lib/billing/workbench-pricing.ts"); },
    "@/lib/seasonal/shuttle-optimize": { getSettings: async () => ({ academy: { lat: 37.6, lng: 127.1 }, depot: { lat: 37.64, lng: 127.1 }, hub: null, hubDropoff: null }) },
    "src/lib/shuttle/regularRosterEdit": {
      async addRosterStudentAs(actorId, input, opts) {
        // 실제 함수처럼 잠금 안 마지막 확인(guard)을 그 달 행으로 부른다.
        opts.guard?.(state.stops.filter((s) => s.serviceMonth === input.serviceMonth));
        state.adds.push({ actorId, input, via: opts.via, replaceRowIds: opts.replaceRowIds });
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
  // 휴원도 읽는다(재배정 판정용, 2026-11-09) — 칸 만들기·저장 재검사는 다니는 수업만(순수 로직이 거른다).
  assert.match(classSql, /e\."status" IN \('ACTIVE','PAUSED'\)/);
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

test("감사 기록 via: 관리자 정규배차(source=ADMIN_DISPATCH)만 ADMIN_DISPATCH · 기사가 같은 표시를 보내도 DRIVER_ASSIGN", async () => {
  const { state, mod } = fixture();
  const board = await mod.getDriverAssignBoard({ appUserId: "admin" }, "2026-11");
  const leg = board.students[0].legs[0];
  const body = { month: "2026-11", studentId: "new1", weekday: 1, direction: "BOARD", choice: { kind: "JOIN", stopIndex: 1 }, routeVersion: leg.routeVersion, includeNextMonth: true };
  await mod.assignDriverCell({ appUserId: "admin" }, { ...body, source: "ADMIN_DISPATCH" });
  await mod.assignDriverCell({ appUserId: "driver" }, { ...body, source: "ADMIN_DISPATCH" });
  await mod.assignDriverCell({ appUserId: "admin" }, body);
  assert.deepEqual(state.adds.map((a) => [a.actorId, a.via]), [["admin", "ADMIN_DISPATCH"], ["driver", "DRIVER_ASSIGN"], ["admin", "DRIVER_ASSIGN"]]);
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
  // 한 칸 배정 화면은 관리자 정규배차 모달과 같이 쓰는 공용 컴포넌트로 옮겼다(2026-11-05) — 두 파일을 합쳐 본다.
  const page = read("src/app/staff/shuttle/assign/DriverAssignClient.tsx");
  assert.match(page, /import AssignLegView, \{ monthLabel \} from "@\/components\/shuttle\/assign\/AssignLegView"/);
  assert.match(page, /<AssignLegView key=/);
  assert.doesNotMatch(page, /function AssignView\(/); // 사본을 남기지 않는다(한쪽만 고쳐지는 사고 방지)
  const ui = page + read("src/components/shuttle/assign/AssignLegView.tsx");
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

// 2026-11-09 원장 발견: 허재원(금7 + 토2 «통쾌한 주말경기반», runsShuttle=false)에게 «토 등원/토 하원» 칸이 생김.
test("셔틀 미운행 반(토요일 주말경기반·성인반)은 남은 칸에서 빠지고 평일 운행 반 칸은 그대로 · 그 요일 저장도 거절", async () => {
  const { state, mod } = fixture();
  state.stops.push({ ...state.stops[0], id: "r5", weekday: 5, classTime: "19:00~20:00", stopName: "C", studentId: "c1", studentName: "다", sortOrder: 1 });
  state.classes = [
    { studentId: "new1", dayOfWeek: "Fri", startTime: "19:00", endTime: "19:55", className: "금7", programName: "주중경기", runsShuttle: true },
    { studentId: "new1", dayOfWeek: "Sat", startTime: "11:00", endTime: "11:55", className: "토2", programName: "통쾌한 주말경기반", runsShuttle: false },
    { studentId: "new1", dayOfWeek: "Wed", startTime: "21:00", endTime: "22:00", className: "성인반", programName: "성인반", runsShuttle: false },
  ];
  const board = JSON.parse(JSON.stringify(await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11")));
  assert.deepEqual(board.students[0].legs.map((l) => l.label), ["금 등원", "금 하원"]);
  assert.equal(board.openLegCount, 2);
  assert.doesNotMatch(board.students[0].classes, /토|수/);
  const classSql = state.sql.find((s) => s.includes(`FROM "Enrollment" e`));
  assert.match(classSql, /p\."runsShuttle"/);
  // 화면을 거치지 않고 토요일 칸을 보내도 서버가 「그 요일 수업 없음」으로 거절한다.
  const body = { month: "2026-11", studentId: "new1", weekday: 6, direction: "BOARD", choice: { kind: "JOIN", stopIndex: 0 }, routeVersion: "x", includeNextMonth: false };
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, body)), "409:NOT_CLASS_DAY");
  assert.equal(state.adds.length, 0);

  // 토요일반만 다니면 칸 0 → 신규 배차 학생 목록에서 빠진다.
  state.classes = state.classes.filter((c) => c.dayOfWeek === "Sat");
  const onlySat = await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11");
  assert.equal(onlySat.students.length, 0);
});

// 2026-11-09 원장 결정 D4: 반 이동(옛 요일 칸이 사라지고 새 요일 칸이 생김) → 신규 배차 보드에 «재배정».
test("반 이동 재배정: 신청서 없는 명단 학생도 보드에 뜨고, 넣기는 새 칸 + 옛 칸 삭제(replaceRowIds, 서버 계산) · 신규 경로로는 거절", async () => {
  const { state, mod } = fixture();
  // 명단에서 월 A 정류장으로 타던 a1(신청서 없음)이 수요일 반으로 옮김.
  state.classes.push({ studentId: "a1", dayOfWeek: "Wed", startTime: "17:00", endTime: "17:55", className: "수반", programName: "정규", runsShuttle: true });
  const board = JSON.parse(JSON.stringify(await mod.getDriverAssignBoard({ appUserId: "driver" }, "2026-11")));
  assert.deepEqual(board.students.map((s) => s.studentId), ["new1", "a1"]); // 신청서 학생 먼저
  const a1 = board.students[1];
  assert.deepEqual(a1.legs.map((l) => l.label), ["수 등원"]);
  assert.equal(a1.legs[0].reassign.label, "월→수 등원 (반 이동)");
  assert.doesNotMatch(JSON.stringify(board), /010-/); // 전화는 내려가지 않는다
  const leg = a1.legs[0];
  const body = { month: "2026-11", studentId: "a1", weekday: 3, direction: "BOARD", choice: leg.defaultChoice, routeVersion: leg.routeVersion, includeNextMonth: true };

  // 신규 경로(reassign 없음)로는 신청서 없는 학생을 넣지 못한다.
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, body)), "404:NOT_ELIGIBLE");
  // 화면이 지울 행을 보내도 쓰지 않는다 — 서버가 다시 계산한 옛 칸(r1)만 지운다.
  const out = await mod.assignDriverCell({ appUserId: "driver" }, { ...body, reassign: true, replaceRowIds: ["r2"] });
  assert.equal(out.replaced, 1);
  assert.equal(state.adds.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.adds[0].replaceRowIds)), ["r1"]);
  assert.equal(state.adds[0].via, "DRIVER_ASSIGN_REASSIGN");
  assert.deepEqual(JSON.parse(JSON.stringify(state.adds[0].input.slots)), [{ weekday: 3, classTime: "17:00~18:00" }]);
  assert.equal(state.adds[0].input.board.stopName, "A"); // 옛 칸 정류장이 기본값
  // 재배정 칸이 아닌 요일·방향은 409
  assert.equal(await status(mod.assignDriverCell({ appUserId: "driver" }, { ...body, reassign: true, direction: "ALIGHT" })), "409:NOT_REASSIGN");
});

test("명단 쓰기: 재배정은 같은 트랜잭션에서 옛 칸 삭제(이 달 + 이후 달 대응 행) · 명단 변경은 커밋 뒤 기사님 알림", () => {
  const edit = read("src/lib/shuttle/regularRosterEdit.ts");
  assert.match(edit, /const replaced = replaceIds\.length > 0 \? await deleteRowsExact\(tx, input\.serviceMonth, replaceIds\) : \[\];/);
  assert.match(edit, /findCounterpartRows\(identityOf\(d\), laterRows\)/);
  // 알림은 트랜잭션 밖(커밋 뒤) — 함수마다 flushNotices
  for (const fn of ["addRosterStudentAs", "removeRosterRows", "moveRosterRows", "editRosterStop", "editStudentRoster", "reorderRosterStops"]) {
    const body = edit.slice(edit.indexOf(`export async function ${fn}(`));
    const end = body.indexOf("\nexport ", 10);
    assert.match(end > 0 ? body.slice(0, end) : body, /\}\);\s*await flushNotices\(notices\);\s*return result;/, `${fn} 알림 누락`);
  }
  const notify = read("src/lib/shuttle/regularRosterNotify.ts");
  assert.match(notify, /deliverOperationalNotification\(/);
  assert.match(notify, /u\."withdrawnAt" IS NULL/);
  assert.match(notify, /g\.role='DRIVER' AND g\.status='ACTIVE'/);
  assert.match(notify, /u\.id <> \$1/); // 바꾼 기사님 본인에게는 보내지 않는다
  assert.doesNotMatch(notify, /toISOString\(\)\.slice\(0, ?10\)|getDay\(\)|getHours\(\)/);
});

test("학생 상세 위치 저장: 장소명 필수(도로명 대체 없음) · 명단 반영은 같은 트랜잭션 · 알림은 커밋 뒤", () => {
  const service = read("src/lib/shuttle/service.ts");
  const fn = service.slice(service.indexOf("export async function updateStudentShuttleLocation"), service.indexOf("export async function assignPassenger"));
  assert.match(fn, /if \(!hasShuttlePlaceName\(rawName\)\)/);
  assert.match(fn, /SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE, 400, "PLACE_NAME_REQUIRED"/);
  assert.doesNotMatch(fn, /\?\? roadAddress \?\? address;/); // 예전 대체 규칙 제거
  // 위치 저장(INSERT … ON CONFLICT)과 명단 반영이 한 $transaction 안, 알림은 그 밖
  const tx = fn.slice(fn.indexOf("prisma.$transaction"), fn.indexOf("isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted"));
  assert.match(tx, /INSERT INTO "StudentShuttleLocation"[\s\S]*applyLocationToRosterInTx\(tx, actor\.appUserId,[^\n]*lockedLaterMonths\)/);
  // 리뷰 S-2: 명단 잠금이 트랜잭션 첫 쿼리(학생 조회·위치 INSERT 보다 앞) + 잠금 뒤 최신 커밋을 보는 ReadCommitted
  assert.match(tx, /async \(tx\) => \{\s*(\/\/[^\n]*\n\s*)*const lockedLaterMonths = await lockRosterForLocationInTx\(tx\);\s*const student =/);
  assert.match(fn, /ReadCommitted \}\);\s*\/\/[^\n]*\n\s*await flushRosterNotices\(saved\.roster\.notices\);/);
  // 리뷰 S-1: 이름 칸 = 주소(공백·대소문자 무시)면 장소명 아님 → 거부
  assert.match(fn, /\[address, roadAddress\]\.some\(\(a\) => a && squash\(a\) === squash\(name\)\)/);
  // 명단 반영은 행 id 유지 UPDATE(지우고 다시 넣지 않음), 이번 달부터
  const edit = read("src/lib/shuttle/regularRosterEdit.ts");
  const apply = edit.slice(edit.indexOf("export async function applyLocationToRosterInTx"), edit.indexOf("export async function flushRosterNotices"));
  assert.match(apply, /UPDATE "RegularShuttleStop" SET "stopName"=\$1,"latitude"=\$2,"longitude"=\$3/);
  assert.doesNotMatch(apply, /DELETE FROM|INSERT INTO "RegularShuttleStop"/);
  assert.match(apply, /lockedLaterMonths \? \[\.\.\.lockedLaterMonths\] : await lockForEdit\(tx, currentMonth, "FROM_THIS_MONTH"\)/);
  assert.match(edit, /export async function lockRosterForLocationInTx\(tx: Tx, currentMonth: string = koreaServiceMonth\(\)\): Promise<string\[\]> \{\s*return lockForEdit\(tx, currentMonth, "FROM_THIS_MONTH"\);/);
});
