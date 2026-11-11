import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isKstYmd } from "../src/lib/datetime/kst.ts";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");
const source = readFileSync(new URL("../src/app/api/staff/shuttle/regular-boarding/route.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const origin = "https://stiz.example";
const path = origin + "/api/staff/shuttle/regular-boarding";
const date = "2026-11-11";

function fixture({ loggedIn = true, access = true, readFails = false } = {}) {
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
        return { appUserId: "staff" };
      },
    },
    "@/lib/datetime/kst": { isKstYmd },
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
          board: [{ rows: [{ rowId: "pickup-row", name: "명단 이름" }] }],
          alight: [{ rows: [{ rowId: "dropoff-row", name: "명단 이름" }] }],
        }] : [];
      },
    },
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
    { date, rowId: "dropoff-row", status: "BOARDED", studentName: "명단 이름" },
    { date, rowId: "pickup-row", status: null, studentName: "명단 이름" },
  ]);
});
