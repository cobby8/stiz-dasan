import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import ts from "typescript";

// 2026-11-15 관리자용 «셔틀 당일 변경» 입력 (원장 요청 「관리자용 셔틀 변경 입력도 만들어줘」)
//
// 학부모는 수업 시작 1시간 전이 지나면 사이트에서 못 바꾼다. 그 뒤 전화로 온 요청을 원장·부원장이 대신 넣는다.
// 이 파일이 못박는 것
//   ① 권한 — 원장·부원장만(선생님·기사·학부모·비로그인은 서버 액션에서 끝난다)
//   ② 마감 뒤에도 저장된다(같은 시각에 학부모 경로는 거절) · 지난 날짜·14일 밖은 거절
//   ③ 같은 표·같은 덮어쓰기 규칙(같은 날·같은 방향은 한 건, 같은 내용이면 그대로)
//   ④ 누가 넣었나 = requestedByUserId(관리자 계정) → 목록에 «학원 입력» / 알림 문구 끝에 «학원 입력»
//   ⑤ 취소(학부모 입력분 포함) · 지난 날짜의 변경은 손대지 않는다
// prisma·권한 확인·알림·next/cache 만 가짜다. 서버 액션과 규칙·SQL 문구는 진짜 파일을 그대로 올려 실행한다.

const read = (file) => readFileSync(file, "utf8");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const OVERRIDES = {
  "@/lib/prisma": toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__adminShuttleDb[key] });`),
  "@/lib/operational-staff-notification": toDataUrl(`export async function notifyOperationalStaff(input) { globalThis.__adminShuttleDb.notices.push(input); return { ok: true }; }`),
  // 권한 확인 — 진짜 requireAdmin 과 같은 규칙(로그인 + DB 역할이 ADMIN·VICE_ADMIN)을 가짜 계정으로 흉내 낸다.
  // 진짜 함수의 규칙 자체는 아래 «권한 규칙» 테스트가 소스로 확인한다.
  "@/lib/auth-guard": toDataUrl(`export async function requireAdmin() {
    const actor = globalThis.__adminShuttleDb.actor;
    if (!actor) throw new Error("인증이 필요합니다.");
    if (actor.role !== "ADMIN" && actor.role !== "VICE_ADMIN") throw new Error("관리자 권한이 필요합니다.");
    return { appUserId: actor.id, appUserRole: actor.role };
  }`),
  "next/cache": toDataUrl(`export function revalidatePath(p) { globalThis.__adminShuttleDb.revalidated.push(p); }`),
};

/** @/ 와 상대경로 import(동적 import 포함)를 따라가며 올린다. */
const cache = new Map();
function load(file) {
  const key = file.replace(/\\/g, "/");
  if (cache.has(key)) return cache.get(key);
  let out = transpile(file);
  const specs = new Set([
    ...[...out.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...out.matchAll(/\bimport\(["']([^"']+)["']\)/g)].map((m) => m[1]),
  ]);
  for (const spec of specs) {
    let url = OVERRIDES[spec];
    if (!url && (spec.startsWith("@/") || spec.startsWith("."))) {
      const base = spec.startsWith("@/") ? path.join("src", spec.slice(2)) : path.join(path.dirname(file), spec);
      url = load(`${base}.ts`);
    }
    if (url) out = out.split(`"${spec}"`).join(`"${url}"`);
  }
  const url = toDataUrl(out);
  cache.set(key, url);
  return url;
}

const kst = await import(load("src/lib/datetime/kst.ts"));
const actions = await import(load("src/app/actions/shuttle-exception-admin.ts"));
const parentShuttle = await import(load("src/lib/shuttle/parent-shuttle-exception.ts"));

const at = (ymd, hm = "00:00") => new Date(`${ymd}T${hm}:00+09:00`).getTime();
function freeze(ymd, hm = "00:00") {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: at(ymd, hm) });
}
test.afterEach(() => mock.timers.reset());

const MON = "2026-11-16"; // s1 의 월요반(18:00) 수업일
const NEXT_MON = "2026-11-23";
const CLOSED = "마감 시간이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요.";
const DENIED = { ok: false, message: "관리자 권한이 필요합니다." };

const ADMIN = { id: "u-admin", role: "ADMIN" };
const VICE = { id: "u-vice", role: "VICE_ADMIN" };

// ═════════════════════════════════════════════════════════════════════════
// 가짜 DB — SQL 문구를 읽어 그대로 흉내 낸다
// ═════════════════════════════════════════════════════════════════════════
function makeDb(overrides = {}) {
  const db = {
    actor: ADMIN,
    users: [
      { id: "u-admin", role: "ADMIN" }, { id: "u-vice", role: "VICE_ADMIN" },
      { id: "u-coach", role: "INSTRUCTOR" }, { id: "u-driver", role: "DRIVER" }, { id: "p1", role: "PARENT" },
    ],
    students: [
      { id: "s1", parentId: "p1", name: "김지유", merged: false, classes: [{ name: "월요반", dayOfWeek: "Mon", startTime: "18:00", status: "ACTIVE" }] },
      { id: "s2", parentId: "p2", name: "김지호", merged: false, classes: [{ name: "화요반", dayOfWeek: "Tue", startTime: "17:00", status: "PAUSED" }] },
      { id: "s3", parentId: "p3", name: "김합쳐짐", merged: true, classes: [{ name: "월요반", dayOfWeek: "Mon", startTime: "18:00", status: "ACTIVE" }] },
      { id: "s4", parentId: "p4", name: "김퇴원", merged: false, classes: [] },
    ],
    exceptions: [], // { id, studentId, serviceDate, direction, kind, location, note, requestedByUserId, canceled }
    notices: [],
    revalidated: [],
    seq: 0,
    ...overrides,
  };
  const student = (id) => db.students.find((row) => row.id === id);
  const notMerged = (sql) => assert.match(sql, /s\."mergedIntoStudentId" IS NULL/, "통합돼 사라진 학생은 뺀다");

  async function $queryRawUnsafe(sql, ...args) {
    // ── 관리자: 학생 찾기 ──
    if (/s\.name ILIKE \$1/.test(sql)) {
      notMerged(sql);
      assert.match(sql, /e\.status IN \('ACTIVE','PAUSED'\)/, "수강 기록이 있는 학생만");
      assert.match(sql, /LIMIT 10/);
      const needle = String(args[0]).replace(/^%|%$/g, "").replace(/\\(.)/g, "$1");
      return db.students.filter((s) => !s.merged && s.name.includes(needle) && s.classes.length > 0)
        .map((s) => ({ id: s.id, name: s.name, classNames: s.classes.map((c) => c.name).join(", ") }));
    }
    // ── 관리자: 들어와 있는 변경 목록 ──
    if (/u\.role::text AS "requesterRole"/.test(sql)) {
      notMerged(sql);
      assert.match(sql, /x\."canceledAt" IS NULL AND x\."serviceDate" >= \$1::date/);
      assert.doesNotMatch(sql, /"serviceDate"[^\n]*AT TIME ZONE/, "date 열은 변환 없이");
      return db.exceptions.filter((x) => !x.canceled && x.serviceDate >= args[0] && !student(x.studentId).merged)
        .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || student(a.studentId).name.localeCompare(student(b.studentId).name))
        .map((x) => ({ ...x, studentName: student(x.studentId).name, requesterRole: db.users.find((u) => u.id === x.requestedByUserId)?.role ?? null }));
    }
    // ── 관리자: 학생 확인(없는 id·통합된 학생 거절) ──
    if (/SELECT s\.id, s\.name FROM "Student" s WHERE s\.id = \$1/.test(sql)) {
      notMerged(sql);
      const s = student(args[0]);
      return s && !s.merged ? [{ id: s.id, name: s.name }] : [];
    }
    // ── 관리자: 취소 ──
    if (/UPDATE "ShuttleDayException" x/.test(sql) && /x\."serviceDate" >= \$2::date/.test(sql)) {
      notMerged(sql);
      assert.match(sql, /x\.id = \$1 AND x\."canceledAt" IS NULL/);
      const row = db.exceptions.find((x) => x.id === args[0] && !x.canceled && x.serviceDate >= args[1]);
      if (!row) return [];
      row.canceled = true;
      return [{ ...row, studentName: student(row.studentId).name }];
    }
    // ── 공용 저장(학부모·관리자 같은 문장): 같은 내용이면 그대로, 아니면 같은 날·방향의 살아 있는 것을 취소하고 새로 ──
    if (/WITH guard AS MATERIALIZED/.test(sql)) {
      const [studentId, serviceDate, direction, kind, location, note, requestedByUserId] = args;
      const live = db.exceptions.filter((x) => !x.canceled && x.studentId === studentId && x.serviceDate === serviceDate && x.direction === direction);
      const same = live.find((x) => x.kind === kind && (x.location ?? null) === (location ?? null) && (x.note ?? null) === (note ?? null));
      if (same) return [{ id: same.id, changed: false }];
      for (const x of live) x.canceled = true;
      const row = { id: `x${++db.seq}`, studentId, serviceDate, direction, kind, location: location ?? null, note: note ?? null, requestedByUserId, canceled: false };
      db.exceptions.push(row);
      return [{ id: row.id, changed: true }];
    }
    // ── 학부모 경로(대조용): 소유 검증 · 마감 기준 반 시각 ──
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && /WHERE s\.id = \$1/.test(sql)) {
      const s = student(args[0]);
      return s && s.parentId === args[1] ? s.classes.filter((c) => c.status === "ACTIVE").map(() => ({ id: s.id, name: s.name, status: "ACTIVE", resumeFrom: null })) : [];
    }
    if (/WHERE e\."studentId" = ANY\(\$1::text\[\]\)/.test(sql)) {
      return args[0].flatMap((id) => (student(id)?.classes ?? []).filter((c) => c.status === "ACTIVE")
        .map((c) => ({ studentId: id, dayOfWeek: c.dayOfWeek, startTime: c.startTime, status: c.status, resumeFrom: null })));
    }
    // 학부모 경로(대조용): 취소 전 한 건 읽기(소유 확인)
    if (/\(x\."canceledAt" IS NOT NULL\) AS canceled/.test(sql)) {
      const row = db.exceptions.find((x) => x.id === args[0] && student(x.studentId).parentId === args[1]);
      return row ? [{ ...row, studentName: student(row.studentId).name }] : [];
    }
    if (/to_regclass/.test(sql)) return [{ ready: false }];
    if (/FROM "NotificationDelivery" d/.test(sql)) return [];
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  Object.assign(db, { $queryRawUnsafe });
  globalThis.__adminShuttleDb = db;
  return db;
}

const live = (db) => db.exceptions.filter((x) => !x.canceled).map((x) => [x.studentId, x.serviceDate, x.direction, x.kind, x.location, x.requestedByUserId]);
const SKIP = { studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "SKIP" };

// ═════════════════════════════════════════════════════════════════════════
// ① 권한
// ═════════════════════════════════════════════════════════════════════════
test("권한: 원장·부원장은 네 액션 모두 쓸 수 있다", async () => {
  for (const actor of [ADMIN, VICE]) {
    const db = makeDb({ actor });
    freeze(MON, "10:00");
    assert.equal((await actions.searchShuttleExceptionStudentsAction("김")).ok, true, actor.role);
    assert.equal((await actions.loadShuttleExceptionBoardAction()).ok, true);
    const saved = await actions.submitShuttleExceptionByAdminAction(SKIP);
    assert.equal(saved.ok, true);
    assert.equal(db.exceptions[0].requestedByUserId, actor.id, "입력한 사람 = 서버가 확인한 그 관리자 계정");
    assert.equal((await actions.cancelShuttleExceptionByAdminAction(saved.id)).ok, true);
  }
});

test("권한: 선생님·기사·학부모·비로그인은 네 액션 모두 거부 — 조회도 저장도 취소도 일어나지 않는다", async () => {
  for (const actor of [{ id: "u-coach", role: "INSTRUCTOR" }, { id: "u-driver", role: "DRIVER" }, { id: "p1", role: "PARENT" }, null]) {
    const db = makeDb({ actor, exceptions: [{ id: "x1", studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "SKIP", location: null, note: null, requestedByUserId: "p1", canceled: false }] });
    // 거부되면 DB 를 아예 읽지 않아야 한다 — 읽으면 바로 실패하게 막아 둔다
    db.$queryRawUnsafe = async () => { throw new Error("권한 없는 요청이 DB 에 닿았다"); };
    freeze(MON, "10:00");
    const who = actor?.role ?? "비로그인";
    assert.deepEqual(await actions.searchShuttleExceptionStudentsAction("김"), DENIED, who);
    assert.deepEqual(await actions.loadShuttleExceptionBoardAction(), DENIED, who);
    assert.deepEqual(await actions.submitShuttleExceptionByAdminAction({ ...SKIP, serviceDate: NEXT_MON }), DENIED, who);
    assert.deepEqual(await actions.cancelShuttleExceptionByAdminAction("x1"), DENIED, who);
    assert.equal(db.exceptions.length, 1);
    assert.equal(db.exceptions[0].canceled, false);
    assert.equal(db.notices.length, 0);
    assert.equal(db.revalidated.length, 0);
  }
});

test("권한 규칙: 모든 액션이 맨 먼저 requireAdmin 을 지나고, requireAdmin 은 DB 역할이 원장·부원장일 때만 통과시킨다", () => {
  const action = read("src/app/actions/shuttle-exception-admin.ts");
  assert.match(action, /^"use server";/);
  const exported = [...action.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ["cancelShuttleExceptionByAdminAction", "loadShuttleExceptionBoardAction", "searchShuttleExceptionStudentsAction", "submitShuttleExceptionByAdminAction"]);
  for (const name of exported) {
    const body = action.slice(action.indexOf(`export async function ${name}(`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /\{\s*const adminId = await adminIdOrNull\(\);\s*if \(!adminId\) return DENIED;/, `${name}: 첫 줄에서 권한 확인`);
  }
  assert.match(action, /const admin = await requireAdmin\(\);\s*return admin\.appUserId \|\| null;/);
  // 입력한 사람은 화면이 보낸 값이 아니라 서버가 확인한 계정
  assert.match(action, /submitShuttleExceptionByAdmin\(adminId, input\)/);
  assert.doesNotMatch(action, /input\.(adminUserId|requestedByUserId)/);
  // 진짜 requireAdmin 의 규칙(이 테스트의 가짜와 같은 조건)
  const guard = read("src/lib/auth-guard.ts");
  assert.match(guard, /if \(!appUser \|\| \(appUser\.role !== "ADMIN" && appUser\.role !== "VICE_ADMIN"\)\) \{\s*throw new Error\("관리자 권한이 필요합니다\."\);/);
  // 새 액션은 새 파일에 — admin.ts 에 넣지 않았다
  assert.doesNotMatch(read("src/app/actions/admin.ts"), /ShuttleExceptionByAdmin/);
});

// ═════════════════════════════════════════════════════════════════════════
// ② 마감 뒤에도 저장 · 날짜 규칙
// ═════════════════════════════════════════════════════════════════════════
test("마감 뒤에도 저장된다 — 같은 시각에 학부모 경로는 거절되고, 관리자 입력은 들어간다", async () => {
  for (const hm of ["17:01", "17:59", "18:30", "23:59"]) {
    const db = makeDb();
    freeze(MON, hm);
    // 학부모(마감 = 수업 시작 1시간 전)
    assert.deepEqual(await parentShuttle.submitShuttleException("p1", SKIP), { ok: false, message: CLOSED }, `학부모 ${hm}`);
    assert.equal(db.exceptions.length, 0);
    // 관리자
    const saved = await actions.submitShuttleExceptionByAdminAction(SKIP);
    assert.equal(saved.ok, true, `관리자 ${hm}`);
    assert.deepEqual(live(db), [["s1", MON, "PICKUP", "SKIP", null, "u-admin"]]);
    assert.deepEqual(db.revalidated, ["/admin/shuttle/regular-dispatch"]);
  }
});

test("복귀일·수강 상태 검사 없이 저장된다(휴원 중인 학생도) — 없는 학생·통합된 학생만 거절", async () => {
  const db = makeDb();
  freeze(MON, "10:00");
  assert.equal((await actions.submitShuttleExceptionByAdminAction({ ...SKIP, studentId: "s2" })).ok, true, "휴원 중");
  assert.deepEqual(await actions.submitShuttleExceptionByAdminAction({ ...SKIP, studentId: "s3" }), { ok: false, message: "학생을 찾을 수 없습니다." }, "통합된 학생");
  assert.deepEqual(await actions.submitShuttleExceptionByAdminAction({ ...SKIP, studentId: "nope" }), { ok: false, message: "학생을 찾을 수 없습니다." });
  assert.deepEqual(await actions.submitShuttleExceptionByAdminAction({ ...SKIP, studentId: "" }), { ok: false, message: "학생을 선택해 주세요." });
  assert.equal(db.exceptions.length, 1);
});

test("날짜: 지난 날짜·14일 밖·없는 날짜는 거절(«오늘»은 서버의 KST) — 자정 경계", async () => {
  let db = makeDb();
  freeze(MON, "10:00");
  const submit = (extra) => actions.submitShuttleExceptionByAdminAction({ ...SKIP, ...extra });
  assert.deepEqual(await submit({ serviceDate: "2026-11-15" }), { ok: false, message: "지난 날짜는 바꿀 수 없습니다." });
  assert.deepEqual(await submit({ serviceDate: "2026-12-01" }), { ok: false, message: "14일 이내로 선택해 주세요." });
  assert.deepEqual(await submit({ serviceDate: "2026-11-31" }), { ok: false, message: "날짜를 다시 확인해 주세요." });
  assert.equal((await submit({ serviceDate: "2026-11-30" })).ok, true, "14일째");
  assert.equal(db.exceptions.length, 1);
  // KST 00:30 (= UTC 로는 전날 15:30) — 서버 시계가 UTC 여도 «오늘»은 11-16 이다: 11-15 는 지난 날짜, 11-16 은 저장
  db = makeDb();
  freeze(MON, "00:30");
  assert.equal((await submit({ serviceDate: "2026-11-15" })).ok, false);
  assert.equal((await submit({ serviceDate: MON })).ok, true);
  // 방향·종류·장소 규칙은 학부모와 같은 함수
  assert.deepEqual(await submit({ direction: "SIDEWAYS" }), { ok: false, message: "등원·하원 중 어느 쪽인지 선택해 주세요." });
  assert.deepEqual(await submit({ kind: "LOCATION" }), { ok: false, message: "어디에서 타실지 적어 주세요." });
});

// ═════════════════════════════════════════════════════════════════════════
// ③④ 같은 표·같은 덮어쓰기 · 작성자 · 알림
// ═════════════════════════════════════════════════════════════════════════
test("같은 키(학생·날짜·방향) 덮어쓰기: 학부모가 넣은 것을 관리자가 바꾸면 살아 있는 것은 한 건 — 같은 내용이면 그대로", async () => {
  const db = makeDb();
  freeze(MON, "10:00");
  assert.equal((await parentShuttle.submitShuttleException("p1", SKIP)).ok, true, "학부모가 먼저(마감 전)");
  freeze(MON, "17:30"); // 마감 뒤 전화가 왔다 — «안 탐»이 아니라 다른 곳에서 탄다
  const changed = await actions.submitShuttleExceptionByAdminAction({ ...SKIP, kind: "LOCATION", location: "  다산초 정문 앞  ", note: "전화 요청" });
  assert.equal(changed.ok, true);
  assert.equal(db.exceptions.length, 2);
  assert.deepEqual(live(db), [["s1", MON, "PICKUP", "LOCATION", "다산초 정문 앞", "u-admin"]]);
  assert.equal(db.exceptions[1].note, "전화 요청");
  // 같은 내용을 다시 저장 — 새로 만들지 않고 알림도 다시 가지 않는다
  const notices = db.notices.length;
  const again = await actions.submitShuttleExceptionByAdminAction({ ...SKIP, kind: "LOCATION", location: "다산초 정문 앞", note: "전화 요청" });
  assert.equal(again.ok, true);
  assert.equal(again.noOp, true);
  assert.equal(db.exceptions.length, 2);
  assert.equal(db.notices.length, notices);
  // 다른 방향은 따로 산다(기존 규칙 그대로)
  assert.equal((await actions.submitShuttleExceptionByAdminAction({ ...SKIP, direction: "DROPOFF" })).ok, true);
  assert.equal(live(db).length, 2);
  // 저장 문장은 학부모와 같은 함수 하나
  const lib = read("src/lib/shuttle/admin-shuttle-exception.ts");
  assert.match(lib, /await saveShuttleException\(prisma, \{ studentId, serviceDate, direction, kind, location, note \}, adminUserId\)/);
  assert.doesNotMatch(lib, /INSERT INTO "ShuttleDayException"/, "저장 SQL 을 두 벌 만들지 않는다");
  assert.doesNotMatch(lib, /isShuttleChangeOpen|shuttleOpen|resumeWindow/, "마감·복귀일 검사를 하지 않는다");
});

test("작성자·알림: 목록에 «학원 입력»/«학부모»가 나뉘고, 알림은 학부모 때와 같은 대상에 문구 끝 «학원 입력»", async () => {
  const db = makeDb();
  freeze(MON, "10:00");
  await parentShuttle.submitShuttleException("p1", { ...SKIP, serviceDate: NEXT_MON });
  await actions.submitShuttleExceptionByAdminAction({ ...SKIP, kind: "LOCATION", location: "다산초 정문 앞" });
  const board = (await actions.loadShuttleExceptionBoardAction()).board;
  assert.equal(board.today, MON);
  assert.equal(board.maxDate, "2026-11-30");
  assert.deepEqual(board.rows.map((row) => [row.serviceDate, row.studentName, row.kind, row.byAcademy]), [[MON, "김지유", "LOCATION", true], [NEXT_MON, "김지유", "SKIP", false]]);
  // 알림 2통(학부모 1 + 학원 1) — 제목·종류·대상은 같고 학원 것만 문구가 다르다
  assert.equal(db.notices.length, 2);
  const [byParent, byAdmin] = db.notices;
  for (const key of ["eventType", "title", "type", "linkUrl", "staffLinkUrl", "includeDriver"]) assert.equal(byAdmin[key], byParent[key], key);
  assert.equal(byAdmin.eventType, "SHUTTLE_DAY_EXCEPTION_SUBMITTED");
  assert.equal(byAdmin.includeDriver, true);
  assert.deepEqual(byAdmin.driverContext, { studentId: "s1", serviceDate: MON, direction: "PICKUP" });
  assert.match(byAdmin.message, /^김지유 · 2026-11-16 · .* · 다른 곳에서 타요 \(다산초 정문 앞\) · 학원 입력$/);
  assert.doesNotMatch(byParent.message, /학원 입력/);
  assert.match(byAdmin.stableEventKey, /^shuttle-day-exception:x\d+:SUBMITTED:[0-9a-f]{64}$/);
});

test("학생 찾기: 이름으로, 수강 기록이 있는 학생만(통합된 학생·수강 없는 학생 제외) — 반 이름을 함께 준다", async () => {
  makeDb();
  freeze(MON, "10:00");
  const found = await actions.searchShuttleExceptionStudentsAction("  김지 ");
  assert.deepEqual(found.students, [{ id: "s1", name: "김지유", classNames: "월요반" }, { id: "s2", name: "김지호", classNames: "화요반" }]);
  assert.deepEqual((await actions.searchShuttleExceptionStudentsAction("김")).students.map((s) => s.id), ["s1", "s2"], "s3 통합됨 · s4 수강 없음");
  assert.deepEqual((await actions.searchShuttleExceptionStudentsAction("   ")).students, []);
  // 학생 수 같은 집계는 주지 않는다 · LIKE 특수문자는 글자 그대로
  assert.deepEqual((await actions.searchShuttleExceptionStudentsAction("%")).students, []);
});

// ═════════════════════════════════════════════════════════════════════════
// ⑤ 취소
// ═════════════════════════════════════════════════════════════════════════
test("취소: 학부모가 넣은 것도 관리자가 취소한다(마감 뒤에도) — 알림은 «취소 · 학원 입력», 다시 누르면 거절", async () => {
  const db = makeDb({ exceptions: [{ id: "x1", studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "SKIP", location: null, note: null, requestedByUserId: "p1", canceled: false }] });
  freeze(MON, "17:30");
  // 같은 시각 학부모는 취소할 수 없다
  assert.deepEqual(await parentShuttle.cancelShuttleException("p1", "x1"), { ok: false, message: CLOSED });
  const result = await actions.cancelShuttleExceptionByAdminAction("x1");
  assert.deepEqual(result, { ok: true, id: "x1" });
  assert.equal(db.exceptions[0].canceled, true);
  assert.equal(db.notices.length, 1);
  assert.equal(db.notices[0].eventType, "SHUTTLE_DAY_EXCEPTION_CANCELED");
  assert.equal(db.notices[0].title, "셔틀 당일 변경 취소");
  assert.match(db.notices[0].message, / · 취소 · 학원 입력$/);
  assert.equal(db.notices[0].stableEventKey, "shuttle-day-exception:x1:CANCELED:canceled");
  // 다시 누르면 거절되고 알림은 늘지 않는다
  const again = await actions.cancelShuttleExceptionByAdminAction("x1");
  assert.equal(again.ok, false);
  assert.match(again.message, /이미 취소됐거나 지난 날짜의 변경입니다/);
  assert.equal(db.notices.length, 1);
  assert.equal((await actions.cancelShuttleExceptionByAdminAction("")).ok, false);
  assert.equal((await actions.loadShuttleExceptionBoardAction()).board.rows.length, 0);
});

test("취소: 지난 날짜의 변경은 손대지 않는다(이미 운행이 끝났다)", async () => {
  const db = makeDb({ exceptions: [{ id: "x1", studentId: "s1", serviceDate: "2026-11-15", direction: "PICKUP", kind: "SKIP", location: null, note: null, requestedByUserId: "p1", canceled: false }] });
  freeze(MON, "00:30"); // KST 로는 11-16 — 11-15 는 어제다(서버 시계 UTC 로는 아직 11-15)
  assert.equal((await actions.cancelShuttleExceptionByAdminAction("x1")).ok, false);
  assert.equal(db.exceptions[0].canceled, false);
  assert.equal(db.notices.length, 0);
});

// ═════════════════════════════════════════════════════════════════════════
// 화면 — 정규 배차(그날 운행표) 위에 목록 + «당일 변경 입력» 버튼 하나 + 모달
// ═════════════════════════════════════════════════════════════════════════
test("화면: 정규 배차 화면에 패널이 걸려 있고, 입력은 버튼 하나 + 모달, 목록은 한 줄 행 + «취소» 글자 버튼", () => {
  const page = read("src/app/admin/shuttle/regular-dispatch/page.tsx");
  assert.match(page, /await requireAdmin\(\);/, "화면도 관리자 확인");
  assert.match(page, /<ShuttleSectionTabs \/>\s*<ShuttleDayExceptionAdminPanel initial=\{/);
  assert.match(page, /getShuttleExceptionBoardForAdmin\(\)\.catch\(/, "조회가 실패해도 운행표는 뜬다");
  const ui = read("src/app/admin/shuttle/regular-dispatch/ShuttleDayExceptionAdminPanel.tsx");
  assert.match(ui, /<button type="button" onClick=\{openForm\} className="academy-button-secondary shrink-0">\s*당일 변경 입력\s*<\/button>/);
  assert.match(ui, /<AdminModal titleId="shuttle-day-exception-form-title"/);
  assert.match(ui, /<li key=\{row\.id\} className="flex min-h-11 /, "한 줄 행 · 터치 44px");
  assert.match(ui, /className="academy-button-text shrink-0"\s*>\s*취소\s*<\/button>/);
  assert.match(ui, /\{row\.byAcademy \? "학원 입력" : "학부모"\}/);
  // 날짜는 오늘~14일(서버가 준 값) · 방향·변경 종류는 학부모 화면과 같은 선택지
  assert.match(ui, /min=\{board\.today\}\s*max=\{board\.maxDate\}/);
  assert.match(ui, /SHUTTLE_DIRECTIONS\.map\(/);
  assert.match(ui, /SHUTTLE_EXCEPTION_KINDS\.map\(/);
  // 화면 규칙: 아이콘·이모지·굵은 글씨·색 코드 없음, 색은 학원 테마 변수
  assert.doesNotMatch(ui, /font-(extrabold|black)|material-symbols|lucide|#[0-9a-fA-F]{6}\b/);
  assert.doesNotMatch(ui, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  // 달력 값(오늘)은 화면에서 만들지 않는다 — 서버가 KST 로 준 값만 쓴다
  assert.doesNotMatch(ui, /new Date\(|toISOString/);
  // 기사님 명단이 읽는 길은 그대로 — 같은 표에서 살아 있는 변경을 날짜로 읽는다(작성자를 가리지 않는다)
  const parentLib = read("src/lib/shuttle/parent-shuttle-exception.ts");
  assert.match(parentLib, /WHERE x\."serviceDate" = \$1::date AND x\."canceledAt" IS NULL AND \$\{notMergedStudent\("s"\)\}/);
  assert.equal(kst.kstLabel(MON), "11/16(월)");
});
