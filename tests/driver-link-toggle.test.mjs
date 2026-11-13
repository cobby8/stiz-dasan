import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// f5 (2026-11-13) 기사님 운행 링크(문자 주소) 정리.
// 가장 무서운 사고: ① 원장이 링크를 «껐는데» 옛 주소로 명단·연락처가 계속 열리는 것,
// ② «새로 만들었는데» 옛 주소가 계속 통하는 것, ③ 셔틀 권한 없는 로그인 사용자가 운행표를 보는 것.
// 모듈을 실제로 실행해서 확인한다(DB·로그인은 가짜로 격리).

function load(file, deps) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, Date, Intl, URL, Request, Response, console: { error() {}, log() {} },
    require(name) {
      if (!Object.hasOwn(deps, name)) throw new Error(`허용하지 않은 테스트 의존성: ${name}`);
      return deps[name];
    },
  });
  return exports;
}

const nextServer = {
  NextResponse: {
    json(body, options = {}) {
      return new Response(JSON.stringify(body), { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
    },
  },
};
const roles = load("src/lib/account/roles.ts", {});
const staffWith = (role, grants = []) => ({
  roles: roles.effectiveRoles({ primaryRole: role, grants: grants.map((g) => ({ role: g, status: "ACTIVE" })), hasStudents: false }),
});

// 가짜 DB — 운행 링크·앱 세션·위치·설정을 들고, 실제 SQL 모양으로 분기한다.
function fakeDb({ enabled = true, settingsError = null } = {}) {
  const state = {
    enabled,
    links: [
      { token: "a".repeat(32), serviceDate: "ROLLING", direction: "REGULAR" },
      { token: "b".repeat(32), serviceDate: "2026-01-12", direction: "ALL" },
    ],
    sessions: [{ token: "a".repeat(32) }],
    locations: [{ token: "a".repeat(32), sharing: true }],
    ops: [],
  };
  const prisma = {
    async $queryRawUnsafe(sql, ...v) {
      if (/FROM "AcademySettings"/.test(sql)) {
        if (settingsError) throw settingsError;
        return [{ enabled: state.enabled }];
      }
      if (/SELECT token FROM "ShuttleRunLink" FOR UPDATE/.test(sql)) return state.links.map((l) => ({ token: l.token }));
      if (/to_regclass/.test(sql)) return [{ ready: true }];
      if (/SELECT "direction" FROM "ShuttleRunLink" WHERE "token" = \$1/.test(sql)) {
        return state.links.filter((l) => l.token === v[0]).map((l) => ({ direction: l.direction }));
      }
      if (/SELECT "serviceDate", "direction" FROM "ShuttleRunLink" WHERE "token" = \$1/.test(sql)) {
        return state.links.filter((l) => l.token === v[0]).map((l) => ({ serviceDate: l.serviceDate, direction: l.direction }));
      }
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      if (/UPDATE "AcademySettings" SET "driverRunLinkEnabled" = \$1/.test(sql)) { state.enabled = v[0]; state.ops.push("setting"); return 1; }
      if (/DELETE FROM "DriverMobileTrackingSession" WHERE token = ANY/.test(sql)) {
        state.sessions = state.sessions.filter((s) => !v[0].includes(s.token)); state.ops.push("sessions"); return 1;
      }
      if (/UPDATE "DriverLocation" SET sharing = false WHERE token = ANY/.test(sql)) {
        for (const l of state.locations) if (v[0].includes(l.token)) l.sharing = false;
        state.ops.push("location"); return 1;
      }
      if (/UPDATE "ShuttleRunLink" SET token = replace\(gen_random_uuid\(\)::text, '-', ''\)/.test(sql)) {
        // 외래키(ON UPDATE 없음) 흉내 — 세션이 옛 열쇠를 아직 가리키면 DB 가 거부한다.
        if (state.sessions.some((s) => state.links.some((l) => l.token === s.token))) throw new Error("외래키 위반");
        for (const l of state.links) l.token = crypto.randomUUID().replaceAll("-", "");
        state.ops.push("rotate"); return state.links.length;
      }
      throw new Error(`예상하지 못한 쓰기: ${sql}`);
    },
    async $transaction(fn) { return fn(prisma); },
  };
  return { state, prisma };
}

function loadAccess({ db, staff = null, admin = true }) {
  const calls = { requireStaff: 0, requireAdmin: 0 };
  const access = load("src/lib/shuttle/driverLinkAccess.ts", {
    "next/server": nextServer,
    "@/lib/prisma": { prisma: db.prisma },
    "@/lib/auth-guard": {
      async requireStaff() { calls.requireStaff++; if (!staff) throw new Error("인증이 필요합니다. 로그인해주세요."); return staff; },
      async requireAdmin() { calls.requireAdmin++; if (!admin) throw new Error("관리자 권한이 필요합니다."); return { appUserId: "admin" }; },
    },
    "@/lib/account/roles": roles,
  });
  return { access, calls };
}

test("스위치 읽기: 켜짐/꺼짐/설정 없음/칸 없음(마이그레이션 전)/그 밖의 오류", async () => {
  assert.equal(await loadAccess({ db: fakeDb({ enabled: true }) }).access.isDriverRunLinkEnabled(), true);
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }) }).access.isDriverRunLinkEnabled(), false);
  // 칸이 아직 없으면(배포가 마이그레이션보다 먼저) 기존 동작(켜짐)을 유지해 운행이 끊기지 않는다.
  const missing = fakeDb({ settingsError: new Error('column "driverRunLinkEnabled" does not exist') });
  assert.equal(await loadAccess({ db: missing }).access.isDriverRunLinkEnabled(), true);
  // 그 밖의 조회 실패는 닫힌 쪽(false).
  const broken = fakeDb({ settingsError: new Error("connection reset") });
  assert.equal(await loadAccess({ db: broken }).access.isDriverRunLinkEnabled(), false);
});

test("문지기: 켜져 있으면 로그인 조회 없이 통과, 꺼지면 셔틀 권한 있는 로그인만 통과", async () => {
  const on = loadAccess({ db: fakeDb({ enabled: true }) });
  assert.equal(await on.access.driverLinkBlocked(), false);
  assert.equal(on.calls.requireStaff, 0, "켜짐일 때는 지금 동작·속도 그대로");

  // 꺼짐 + 로그인 안 함 → 막힘
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }) }).access.driverLinkBlocked(), true);
  // 꺼짐 + 선생님만(셔틀 권한 없음) → 막힘
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }), staff: staffWith("INSTRUCTOR") }).access.driverLinkBlocked(), true);
  // 꺼짐 + 학부모(직원 아님) — requireStaff 가 던진다 → 막힘
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }), staff: null }).access.driverLinkBlocked(), true);
  // 꺼짐 + 기사님 역할(승인된 추가 역할 포함)·관리자 → 통과
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }), staff: staffWith("DRIVER") }).access.driverLinkBlocked(), false);
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }), staff: staffWith("PARENT", ["DRIVER"]) }).access.driverLinkBlocked(), false);
  assert.equal(await loadAccess({ db: fakeDb({ enabled: false }), staff: staffWith("ADMIN") }).access.driverLinkBlocked(), false);
});

test("스위치 끔 → 토큰 API 가 410 으로 거부하고 DB(명단·탑승 기록)를 읽거나 쓰지 않는다", async () => {
  const db = fakeDb({ enabled: false });
  const { access } = loadAccess({ db });
  let touched = 0;
  const api = load("src/app/api/shuttle/regular-boarding/route.ts", {
    "next/server": nextServer,
    "@/lib/shuttle/regularRun": { async setRegularBoarding() { touched++; return { ok: true }; } },
    "@/lib/shuttle/driverToken": { async isAnyDriverRunToken(t) { return t === "a".repeat(32); } },
    "@/lib/shuttle/driverStatusRead": { async readDriverBoarding() { touched++; return { boarding: {}, checkedAt: {} }; } },
    "@/lib/shuttle/driverLinkAccess": access,
  });
  const get = await api.GET(new Request(`http://t/api?token=${"a".repeat(32)}&date=2026-11-13`));
  assert.equal(get.status, 410);
  assert.equal((await get.json()).code, "DRIVER_LINK_DISABLED");
  const post = await api.POST(new Request("http://t/api", { method: "POST", body: JSON.stringify({ token: "a".repeat(32), rowId: "r1", status: "BOARDED", date: "2026-11-13" }) }));
  assert.equal(post.status, 410);
  assert.equal(touched, 0, "막힌 요청이 명단을 읽거나 탑승 기록을 썼다");
  // 다시 켜면 그대로 동작(기존 동작 보존)
  db.state.enabled = true;
  assert.equal((await api.GET(new Request(`http://t/api?token=${"a".repeat(32)}&date=2026-11-13`))).status, 200);
});

test("링크 새로 만들기 → 옛 주소는 즉시 무효, 새 주소만 통한다(앱 세션 먼저 끊고 열쇠 교체)", async () => {
  const db = fakeDb();
  const { access, calls } = loadAccess({ db });
  const auth = { async requireAdmin() { return { appUserId: "admin" }; } };
  const regularRun = load("src/lib/shuttle/regularRun.ts", { crypto, "@/lib/prisma": { prisma: db.prisma }, "@/lib/studentVisibility": { notMergedStudent: () => "TRUE" }, "@/lib/auth-guard": auth });
  const shuttleRun = load("src/lib/seasonal/shuttleRun.ts", { crypto, "@/lib/prisma": { prisma: db.prisma }, "@/lib/auth-guard": auth });
  const driverToken = load("src/lib/shuttle/driverToken.ts", { "@/lib/seasonal/shuttleRun": shuttleRun, "./regularRun": regularRun });

  const oldRegular = "a".repeat(32), oldDated = "b".repeat(32);
  assert.equal(await driverToken.isAnyDriverRunToken(oldRegular), true);
  assert.equal(await driverToken.isAnyDriverRunToken(oldDated), true);

  const result = await access.rotateDriverRunLinks();
  assert.equal(result.rotated, 2);
  assert.equal(calls.requireAdmin, 1, "원장 확인 없이 열쇠를 바꾸면 안 된다");
  assert.deepEqual(db.state.ops, ["sessions", "location", "rotate"]);

  // 옛 주소(정규 고정·특강 날짜별 모두) 거부
  assert.equal(await driverToken.isAnyDriverRunToken(oldRegular), false);
  assert.equal(await driverToken.isAnyDriverRunToken(oldDated), false);
  // 새 열쇠는 기존 형식 검사를 통과해 그대로 쓰인다
  for (const link of db.state.links) {
    assert.match(link.token, /^[a-f0-9]{16,64}$/);
    assert.equal(await driverToken.isAnyDriverRunToken(link.token), true);
  }
  // 옛 열쇠의 위치 공유는 꺼지고, 앱 위치 세션은 끊긴다
  assert.equal(db.state.locations[0].sharing, false);
  assert.equal(db.state.sessions.length, 0);
});

test("관리자 API: 권한 없으면 403, 스위치 값은 참/거짓만 받는다", async () => {
  const db = fakeDb();
  const make = (admin) => {
    const { access } = loadAccess({ db, admin });
    return load("src/app/api/admin/shuttle/driver-link/route.ts", {
      "next/server": nextServer,
      "@/lib/auth-guard": { async requireAdmin() { if (!admin) throw new Error("관리자 권한이 필요합니다."); return {}; } },
      "@/lib/shuttle/driverLinkAccess": access,
    });
  };
  const denied = make(false);
  assert.equal((await denied.GET()).status, 403);
  assert.equal((await denied.PATCH(new Request("http://t", { method: "PATCH", body: JSON.stringify({ enabled: false }) }))).status, 403);
  assert.equal((await denied.POST(new Request("http://t", { method: "POST", body: JSON.stringify({ action: "rotate" }) }))).status, 403);
  assert.equal(db.state.enabled, true);
  assert.deepEqual(db.state.ops, []);

  const api = make(true);
  assert.equal((await api.PATCH(new Request("http://t", { method: "PATCH", body: JSON.stringify({ enabled: "false" }) }))).status, 400);
  assert.equal(db.state.enabled, true, "문자열 'false' 로 스위치가 바뀌면 안 된다");
  const off = await api.PATCH(new Request("http://t", { method: "PATCH", body: JSON.stringify({ enabled: false }) }));
  assert.equal(off.status, 200);
  assert.equal(db.state.enabled, false);
  // 응답에 열쇠(토큰) 값을 담지 않는다
  const rotated = await api.POST(new Request("http://t", { method: "POST", body: JSON.stringify({ action: "rotate" }) }));
  const text = await rotated.text();
  for (const link of db.state.links) assert.ok(!text.includes(link.token));
});

// ── 소스 고정: 새 토큰 경로가 생겨도 문지기를 빠뜨리지 않게 ──
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

test("토큰으로 인증하는 API 는 전부 운행 링크 문지기를 거친다", () => {
  const tokenApis = walk("src/app/api")
    .filter((f) => !f.startsWith("src/app/api/admin/"))
    .filter((f) => /isAnyDriverRunToken|isRegularRunToken|resolveRunToken|FROM "ShuttleRunLink"/.test(fs.readFileSync(f, "utf8")));
  assert.ok(tokenApis.length >= 6, `토큰 API 목록이 비정상적으로 적다: ${tokenApis.join(", ")}`);
  // 예외 한 곳: 앱 위치 세션은 위치 «쓰기» 전용(명단·연락처 미노출)이고, 안드로이드 기사님 앱이 쿠키 없이 부르므로
  // 스위치를 걸면 로그인 기사님의 위치 전송이 멈춘다. 옛 열쇠 차단은 «링크 새로 만들기»가 맡는다.
  const EXEMPT = ["src/app/api/driver/mobile/session/route.ts"];
  for (const f of EXEMPT) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /driverLinkBlocked\(\)/, "예외 파일에 스위치가 다시 걸렸다 — 기사님 앱 위치 전송이 멈춘다");
  const missing = tokenApis.filter((f) => !EXEMPT.includes(f)).filter((f) => !/driverLinkBlocked\(\)/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(missing, [], `운행 링크 스위치를 확인하지 않는 토큰 API: ${missing.join(", ")}`);
});

test("토큰 주소 화면은 스위치를 먼저 보고, 건너뛰기(viaAccount)는 권한 확인한 계정 화면 한 곳만", () => {
  const page = fs.readFileSync("src/components/shuttle/UnifiedDriverRunPage.tsx", "utf8");
  const gateAt = page.indexOf("if (!viaAccount && !(await isDriverRunLinkEnabled()))");
  assert.ok(gateAt > 0 && gateAt < page.indexOf("await isAnyDriverRunToken(token)") && gateAt < page.indexOf("loadUnifiedDriverRun(viewDate)"),"명단을 읽기 전에 스위치를 봐야 한다");
  assert.match(page, /이 주소는 더 이상 쓰지 않습니다|DRIVER_LINK_DISABLED_MESSAGE/);
  const users = walk("src").filter((f) => !f.endsWith("UnifiedDriverRunPage.tsx")).filter((f) => /\bviaAccount\b/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(users, ["src/app/staff/run/page.tsx"]);
  const run = fs.readFileSync("src/app/staff/run/page.tsx", "utf8");
  assert.ok(run.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff");') < run.indexOf("viaAccount />"));
});

test("관리자 화면·스키마: 원장 확인, 기본값 켜짐(기존 동작 유지)", () => {
  const adminPage = fs.readFileSync("src/app/admin/shuttle/regular/page.tsx", "utf8");
  assert.match(adminPage, /await requireAdmin\(\);/);
  assert.match(adminPage, /<DriverRunLinkControls initialEnabled=/);
  const ui = fs.readFileSync("src/app/admin/shuttle/regular/DriverRunLinkControls.tsx", "utf8");
  assert.match(ui, /useAdminConfirm/);
  assert.match(fs.readFileSync("prisma/schema.prisma", "utf8"), /driverRunLinkEnabled\s+Boolean\s+@default\(true\)/);
  const sql = fs.readFileSync("prisma/migrations/20261113220000_driver_link_toggle/migration.sql", "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "driverRunLinkEnabled" BOOLEAN NOT NULL DEFAULT true/);
  // 토큰 값을 로그로 남기지 않는다
  const lib = fs.readFileSync("src/lib/shuttle/driverLinkAccess.ts", "utf8");
  assert.doesNotMatch(lib, /console\.\w+\([^)]*token/i);
});
