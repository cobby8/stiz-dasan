import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isKstYmd } from "../src/lib/datetime/kst.ts";
import { loadTsModule } from "./_ts-module.mjs";

// 휴원·휴무 줄 잠금 판정(실제 모듈) — 2026-11-14 원장 지시
const dayRules = await loadTsModule("src/lib/shuttle/regularRunDayRules.ts");

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const source = readFileSync(new URL("../src/app/api/staff/shuttle/regular-boarding/route.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const origin = "https://stiz.example";
const path = origin + "/api/staff/shuttle/regular-boarding";
const date = "2026-11-11";

function fixture({ loggedIn = true, access = true, readFails = false, teacherOnly = false, today = date } = {}) {
  class DriverAssignError extends Error {
    status = 403;
  }
  const reads = [];
  const writes = [];
  const dependencies = {
    "next/server": { NextRequest, NextResponse },
    "@/lib/auth-guard": {
      async requireStaff() {
        if (!loggedIn) throw new Error("로그인 필요");
        return { appUserId: "staff", roles: { teacherOnly } };
      },
    },
    "@/lib/datetime/kst": { isKstYmd, todayKst: () => today },
    "@/lib/shuttle/driverAssign": {
      DriverAssignError,
      async authorizeAssign() {
        if (!access) throw new DriverAssignError();
      },
    },
    "@/lib/shuttle/driverStatusRead": {
      async readDriverBoarding(...args) {
        reads.push(args);
        if (readFails) throw new Error("조회 실패");
        return { boarding: { "dropoff-row": "BOARDED" }, checkedAt: {} };
      },
    },
    "@/lib/shuttle/regularDriverRoute": {
      async getRegularDriverClasses(requestDate) {
        return requestDate === date ? [{
          board: [{ rows: [{ rowId: "pickup-row", name: "명단 이름" }, { rowId: "paused-row", name: "휴원 학생", blockedLabel: "휴원" }] }],
          alight: [{ rows: [{ rowId: "dropoff-row", name: "명단 이름" }] }],
        }] : [];
      },
    },
    "@/lib/shuttle/regularRunDayRules": dayRules,
    // 2026-11-16: 일반 선생님(관리자·기사 역할 없음)은 «선생님 운행»으로 체크한다 — 판정 함수 대역
    "@/lib/shuttle/teacherShuttleView": { staffShuttleAccess: (roles) => ({ canOpen: true, teacherOnly: Boolean(roles?.teacherOnly) }) },
    "@/lib/shuttle/regularRun": {
      async setRegularBoarding(input) {
        writes.push(input);
        return { ok: true };
      },
    },
  };
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(name in dependencies, "unexpected dependency: " + name);
      return dependencies[name];
    },
  });
  return { ...exports, reads, writes };
}

function get(day = date) {
  return new NextRequest(path + "?token=unused&date=" + day);
}

function post(body = {}, headers = {}) {
  return new NextRequest(path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify({ date, rowId: "dropoff-row", status: "BOARDED", ...body }),
  });
}

test("일반 선생님은 기사 권한이 없어도 읽고 체크할 수 있다(선생님 운행, 2026-11-16 원장 지시)", async () => {
  const api = fixture({ access: false, teacherOnly: true });
  assert.equal((await api.GET(get())).status, 200);
  assert.equal((await api.POST(post())).status, 200);
  assert.equal(api.writes.length, 1);
  // 기록에 «선생님»으로 남는다
  assert.equal(api.writes[0].via, "teacher");
  // 오늘이 아닌 날짜는 선생님이 체크하지 못한다(기사님·관리자는 예전과 같다)
  const other = fixture({ access: false, teacherOnly: true, today: "2099-01-01" });
  assert.equal((await other.POST(post())).status, 409);
  assert.deepEqual(other.writes, []);
  const driver = fixture({ today: "2099-01-01" });
  assert.equal((await driver.POST(post())).status, 200);
  assert.equal(driver.writes[0].via, "driver");
});

test("로그아웃과 기사 권한 없는 계정의 읽기 및 쓰기를 막는다", async () => {
  for (const [state, code] of [[{ loggedIn: false }, 401], [{ access: false }, 403]]) {
    const api = fixture(state);
    assert.equal((await api.GET(get())).status, code);
    assert.equal((await api.POST(post())).status, code);
    assert.deepEqual(api.reads, []);
    assert.deepEqual(api.writes, []);
  }
});

test("다른 사이트에서 온 승하차 요청을 막는다", async () => {
  const api = fixture();
  assert.equal((await api.POST(post({}, { origin: "https://other.example" }))).status, 403);
  assert.equal((await api.POST(post({}, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.deepEqual(api.writes, []);
});

test("운행일의 정규 탑승 상태만 비공개 응답으로 반환한다", async () => {
  const api = fixture();
  const response = await api.GET(get());
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true, boarding: { "dropoff-row": "BOARDED" }, checkedAt: {} });
  assert.deepEqual(api.reads, [[date, "REGULAR"]]);
  assert.equal((await fixture({ readFails: true }).GET(get())).status, 503);
});

test("잘못된 날짜, 저장 상태, 날짜에 없는 학생 행은 저장하지 않는다", async () => {
  const api = fixture();
  assert.equal((await api.GET(get("2026-02-30"))).status, 400);
  assert.equal((await api.POST(post({ date: "2026-02-30" }))).status, 400);
  assert.equal((await api.POST(post({ status: "unknown" }))).status, 400);
  assert.equal((await api.POST(post({ status: undefined }))).status, 400);
  assert.equal((await api.POST(post({ rowId: "unknown-row" }))).status, 404);
  assert.equal((await api.POST(post({ date: "2026-11-12" }))).status, 404);
  assert.deepEqual(api.writes, []);
});

test("정규 명단의 실제 이름으로 승하차를 기록하고 대기로 되돌린다", async () => {
  const api = fixture();
  assert.deepEqual(await (await api.POST(post({ studentName: "임의 이름" }))).json(), { ok: true });
  assert.deepEqual(await (await api.POST(post({ rowId: "pickup-row", status: null }))).json(), { ok: true });
  assert.deepEqual(api.writes.map((write) => ({ ...write })), [
    { date, rowId: "dropoff-row", status: "BOARDED", studentName: "명단 이름", via: "driver" },
    { date, rowId: "pickup-row", status: null, studentName: "명단 이름", via: "driver" },
  ]);
});

test("휴원·휴무로 잠긴 줄은 체크를 409 로 거부하고, 대기로 되돌리기(null)만 받는다", async () => {
  const api = fixture();
  for (const status of ["BOARDED", "NOSHOW", "SELF"]) {
    const response = await api.POST(post({ rowId: "paused-row", status }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /휴원 학생은 체크하지 않습니다/);
  }
  assert.deepEqual(api.writes, []);
  assert.deepEqual(await (await api.POST(post({ rowId: "paused-row", status: null }))).json(), { ok: true });
  assert.deepEqual(api.writes.map((write) => ({ ...write })), [{ date, rowId: "paused-row", status: null, studentName: "휴원 학생", via: "driver" }]);
});
