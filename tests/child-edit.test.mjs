// 학부모 «아이 정보 수정»·건강 특이사항·연락처 바꾸기·연결된 가족 끊기(2026-11-14 원장 결정 b4~b7·c1) — 실제로 실행·렌더해서 확인한다.
//  ① 입력 규칙: 바로 반영 네 칸 / 변경 신청(이름·생년월일) 검증
//  ② 학년: 임시 생일(2000-01-01)은 계산에서 뺀다 — 보강 판정과 같은 함수
//  ③ 권한·분기: 남의 아이는 못 고친다 · 바로 반영은 네 칸만 · 이름·생년월일은 신청만 · 취소 · 새 칸/표 없는 환경
//  ④ 승인·반려: 승인만 Student 를 바꾼다 · 이미 처리된 신청·다른 학생 신청 거절
//  ⑤ 연결된 가족: 대표 보호자만 끊는다 · 전화번호를 고르지 않는다
//  ⑥ 연락처 바꾸기: 인증 없이는 못 바꾼다 · 이름 다름·중복 번호 거절 · 성공하면 인증된 번호로
//  ⑦ 건강 특이사항 노출 범위: 알림·로그에 쓰지 않는다 · 선생님=자기 반 명단 · 기사님=그날 운행표 승객
//  ⑧ 화면 렌더: 수정 버튼·확인 중 줄·시트·막다른 문구 3곳
//  ⑨ 마이그레이션·서버 동작 가드
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 파일을 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const TODAY = "2026-11-16";
const rules = load("src/lib/parent/childEditRules.ts");
const profileRules = load("src/lib/parent/childProfileRules.ts");
const grade = load("src/lib/makeup/student-grade.ts");

// ── ① 입력 규칙 ─────────────────────────────────────────────────────────────

test("① 바로 반영 네 칸: 정리·전화 형식·300자", () => {
  const ok = rules.cleanChildDirect({ school: "  다산\n초등학교 ", phone: "010-1234-5678", address: " 다산로 1 ", healthNote: " 천식\r\n\r\n\r\n견과류 알레르기 " });
  assert.deepEqual(ok, { ok: true, value: { school: "다산 초등학교", phone: "01012345678", address: "다산로 1", healthNote: "천식\n견과류 알레르기" } });
  assert.deepEqual(rules.cleanChildDirect({}).value, { school: null, phone: null, address: null, healthNote: null }, "비우면 null");
  assert.equal(rules.cleanChildDirect({ phone: "031-123-4567" }).ok, false, "학생 전화는 휴대폰만");
  assert.equal(rules.cleanChildDirect({ phone: "0101234" }).ok, false);
  assert.equal(rules.cleanChildDirect({ healthNote: "가".repeat(300) }).ok, true, "300자까지");
  assert.equal(rules.cleanChildDirect({ healthNote: "가".repeat(301) }).ok, false, "301자는 거절");
  assert.equal(rules.cleanChildDirect({ school: "가".repeat(41) }).ok, false);
  assert.equal(rules.cleanChildDirect({ address: "가".repeat(201) }).ok, false);
  assert.deepEqual([...rules.DIRECT_FIELDS], ["school", "phone", "address", "healthNote"]);
  assert.deepEqual([...rules.REQUEST_FIELDS], ["name", "birthDate"]);
});

test("① 변경 신청: 이름·생년월일만, 지금 값과 같으면 거절, 날짜 범위", () => {
  const current = { name: "홍길동", birthYmd: "2015-05-01" };
  assert.deepEqual(rules.checkChangeRequest("name", " 홍길순 ", current, TODAY), { ok: true, field: "name", oldValue: "홍길동", newValue: "홍길순" });
  assert.equal(rules.checkChangeRequest("name", "홍길동", current, TODAY).ok, false, "같은 이름");
  assert.equal(rules.checkChangeRequest("name", "", current, TODAY).ok, false);
  assert.equal(rules.checkChangeRequest("name", "가".repeat(31), current, TODAY).ok, false);
  assert.deepEqual(rules.checkChangeRequest("birthDate", "2014-05-01", current, TODAY), { ok: true, field: "birthDate", oldValue: "2015-05-01", newValue: "2014-05-01" });
  assert.equal(rules.checkChangeRequest("birthDate", "2015-05-01", current, TODAY).ok, false, "같은 생일");
  assert.equal(rules.checkChangeRequest("birthDate", "2026-11-17", current, TODAY).ok, false, "내일은 안 된다");
  assert.equal(rules.checkChangeRequest("birthDate", "2026-11-16", current, TODAY).ok, true, "오늘까지");
  assert.equal(rules.checkChangeRequest("birthDate", "1929-12-31", current, TODAY).ok, false);
  assert.equal(rules.checkChangeRequest("birthDate", "2015-02-30", current, TODAY).ok, false, "없는 날짜");
  // 학년·학교·메모는 신청 항목이 아니다
  for (const field of ["grade", "school", "memo", "parentId", "healthNote"]) {
    assert.equal(rules.checkChangeRequest(field, "x", current, TODAY).ok, false, field);
  }
  assert.equal(rules.changeLine({ field: "birthDate", oldValue: "2015-05-01", newValue: "2014-12-03" }), "생년월일 2015.5.1 → 2014.12.3");
  assert.equal(rules.changeLine({ field: "name", oldValue: "홍길동", newValue: "홍길순" }), "이름 홍길동 → 홍길순");
});

// ── ② 학년 ─────────────────────────────────────────────────────────────────

test("② 임시 생일(2000-01-01)은 학년·나이 계산에서 뺀다 — 보강 판정과 같은 함수", () => {
  assert.equal(grade.realBirthYmd("2000-01-01"), null);
  assert.equal(grade.realBirthYmd(""), null);
  assert.equal(grade.realBirthYmd(null), null);
  assert.equal(grade.realBirthYmd("2015-05-01"), "2015-05-01");
  // 예전에는 «성인»으로 나왔다 → 적힌 학년, 그것도 없으면 «-»
  assert.equal(profileRules.gradeLine("2000-01-01", "초5", TODAY), "초5");
  assert.equal(profileRules.gradeLine("2000-01-01", null, TODAY), "-");
  assert.equal(profileRules.koreanAge("2000-01-01", TODAY), null);
  assert.equal(profileRules.birthLine("2000-01-01", TODAY), "-");
  assert.equal(profileRules.birthLine("2015-05-01", TODAY), "2015.5.1 · 만 11세");
  // 진짜 생일은 그대로
  assert.equal(profileRules.gradeLine("2015-05-01", "초5", TODAY), "초5");
  // 보강 판정(학년 숫자)과 같은 결론: 임시 생일이면 글자, 진짜 생일이면 계산
  assert.equal(grade.studentMakeupGrade("2000-01-01", "초5", TODAY), 5);
  assert.equal(grade.studentMakeupGrade("2015-05-01", null, TODAY), 5);
  // 두 곳이 같은 함수를 쓴다
  assert.match(read("src/lib/parent/childProfileRules.ts"), /realBirthYmd/);
  assert.match(read("src/lib/makeup/student-grade.ts"), /const birth = realBirthYmd\(birthYmd\)/);
});

// ── ③④ 가짜 DB ─────────────────────────────────────────────────────────────

// 권한식은 «대표 보호자» 한 줄로 흉내 낸다(진짜 식은 child-access.ts — 연결 가족 포함). 가짜 DB 는 world.access 로 판정한다.
const ACCESS_MARK = `s."parentId" = $1`;
const editMocks = {
  "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}`, childConnectionsAvailable: async () => true },
};
const edit = load("src/lib/parent/childEdit.ts", editMocks);

function world() {
  const calls = [];
  const state = {
    students: { kid: { name: "홍길동", birthYmd: "2015-05-01", school: "다산초", phone: null, address: null, healthNote: null } },
    // 이 아이에 접근할 수 있는 보호자: 엄마(대표)·아빠(연결 가족)
    access: { kid: ["mom", "dad"] },
    requests: [],
    healthColumn: true,
    requestTable: true,
    seq: 0,
  };
  const can = (userId, studentId) => (state.access[studentId] ?? []).includes(userId);
  const guard = (sql) => {
    if (sql.includes(`"healthNote"`) && !state.healthColumn) throw new Error(`column "healthNote" does not exist`);
    if (sql.includes(`"StudentProfileChangeRequest"`) && !state.requestTable) throw new Error(`relation "StudentProfileChangeRequest" does not exist`);
  };
  const view = (r) => ({ ...r, createdYmd: TODAY, decidedYmd: r.status === "PENDING" ? null : TODAY });
  const db = {
    async $queryRawUnsafe(sql, ...v) {
      calls.push({ kind: "query", sql, v });
      guard(sql);
      if (/^SELECT s\.phone, s\.address FROM "Student" s/.test(sql)) return can(v[0], v[1]) ? [{ phone: state.students[v[1]].phone, address: state.students[v[1]].address }] : [];
      if (/^SELECT s\."healthNote" FROM "Student" s/.test(sql)) return can(v[0], v[1]) ? [{ healthNote: state.students[v[1]].healthNote }] : [];
      if (/^SELECT s\.name, to_char/.test(sql)) return can(v[0], v[1]) ? [{ name: state.students[v[1]].name, birthYmd: state.students[v[1]].birthYmd }] : [];
      if (/^INSERT INTO "StudentProfileChangeRequest"/.test(sql)) {
        const [userId, studentId, field, oldValue, newValue] = v;
        if (!can(userId, studentId)) return [];
        if (state.requests.some((r) => r.studentId === studentId && r.field === field && r.status === "PENDING")) return [];
        const row = { id: `req${++state.seq}`, studentId, requestedByUserId: userId, field, oldValue, newValue, status: "PENDING", note: null };
        state.requests.push(row);
        return [{ id: row.id }];
      }
      if (/FROM "StudentProfileChangeRequest" r\s+JOIN "Student" s/.test(sql)) {
        return can(v[0], v[1]) ? state.requests.filter((r) => r.studentId === v[1] && r.status !== "CANCELED").map(view) : [];
      }
      if (/FROM "StudentProfileChangeRequest" r\s+LEFT JOIN "User" u/.test(sql)) {
        return state.requests.filter((r) => r.studentId === v[0]).map((r) => ({ ...view(r), requesterName: "엄마" }));
      }
      if (/FROM "StudentProfileChangeRequest" WHERE id = \$1 AND "studentId" = \$2 FOR UPDATE/.test(sql)) {
        return state.requests.filter((r) => r.id === v[0] && r.studentId === v[1]);
      }
      if (/^SELECT s\.name FROM "Student" s WHERE s\.id = \$1/.test(sql)) return state.students[v[0]] ? [{ name: state.students[v[0]].name }] : [];
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      calls.push({ kind: "write", sql, v });
      guard(sql);
      if (/^UPDATE "Student" AS s SET school = \$3, phone = \$4, address = \$5/.test(sql)) {
        if (!can(v[0], v[1])) return 0;
        Object.assign(state.students[v[1]], { school: v[2], phone: v[3], address: v[4] });
        return 1;
      }
      if (/^UPDATE "Student" AS s SET "healthNote" = \$3/.test(sql)) {
        if (!can(v[0], v[1])) return 0;
        state.students[v[1]].healthNote = v[2];
        return 1;
      }
      if (/^UPDATE "StudentProfileChangeRequest" AS r\s+SET status = 'CANCELED'/.test(sql)) {
        const row = state.requests.find((r) => r.id === v[1] && r.status === "PENDING" && can(v[0], r.studentId));
        if (!row) return 0;
        row.status = "CANCELED";
        return 1;
      }
      if (/^UPDATE "Student" SET name = \$1/.test(sql)) { state.students[v[1]].name = v[0]; return 1; }
      if (/^UPDATE "Student" SET "birthDate" = \$1::timestamp/.test(sql)) { state.students[v[1]].birthYmd = v[0]; return 1; }
      if (/^UPDATE "StudentProfileChangeRequest"\s+SET status = \$1/.test(sql)) {
        const row = state.requests.find((r) => r.id === v[3] && r.status === "PENDING");
        if (!row) return 0;
        Object.assign(row, { status: v[0], decidedByUserId: v[1], note: v[2] });
        return 1;
      }
      throw new Error(`예상하지 못한 쓰기: ${sql}`);
    },
  };
  const writes = () => calls.filter((c) => c.kind === "write" || /^INSERT/.test(c.sql));
  return { db, state, calls, writes };
}

// ── ③ 권한·분기 ─────────────────────────────────────────────────────────────

test("③ 바로 반영: 대표·연결 가족은 저장, 남의 가정은 0건 — 네 칸만 건드린다", async () => {
  const w = world();
  const input = { school: "새초등학교", phone: "010-2222-3333", address: "다산로 2", healthNote: "천식" };
  assert.deepEqual(await edit.saveChildDirect(w.db, "mom", "kid", input), { ok: true, healthSaved: true });
  assert.deepEqual(w.state.students.kid, { name: "홍길동", birthYmd: "2015-05-01", school: "새초등학교", phone: "01022223333", address: "다산로 2", healthNote: "천식" });
  // 연결 가족(아빠)도 가능
  assert.equal((await edit.saveChildDirect(w.db, "dad", "kid", { ...input, school: "아빠가 고침" })).ok, true);
  assert.equal(w.state.students.kid.school, "아빠가 고침");
  // 남의 가정
  const before = JSON.stringify(w.state.students.kid);
  assert.deepEqual(await edit.saveChildDirect(w.db, "stranger", "kid", { ...input, school: "해킹" }), { ok: false, error: "아이 정보를 찾지 못했어요." });
  assert.equal(JSON.stringify(w.state.students.kid), before, "남의 아이는 한 글자도 안 바뀐다");
  // 쓰기 SQL 마다 권한식이 «같은 문» 안에 있고, 이름·생년월일·메모·학년·대표 보호자는 SET 에 없다
  for (const call of w.writes()) {
    assert.ok(call.sql.includes(ACCESS_MARK), "권한식이 UPDATE 문 안에 있어야 한다");
    assert.ok(call.sql.includes(`"mergedIntoStudentId" IS NULL`), "병합된 옛 학생 제외");
    const set = call.sql.slice(call.sql.indexOf("SET"), call.sql.indexOf("WHERE"));
    assert.doesNotMatch(set, /\bname\b|birthDate|\bmemo\b|\bgrade\b|parentId|enrollDate|gender/, set);
  }
  // 잘못된 입력은 DB 에 가지 않는다
  const count = w.calls.length;
  assert.equal((await edit.saveChildDirect(w.db, "mom", "kid", { healthNote: "가".repeat(301) })).ok, false);
  assert.equal(w.calls.length, count);
});

test("③ 변경 신청: Student 는 그대로, 신청만 남는다 · 항목당 확인 중 하나 · 남의 아이 불가 · 취소", async () => {
  const w = world();
  const made = await edit.createChangeRequest(w.db, "dad", "kid", "name", "홍길순", TODAY);
  assert.deepEqual(made, { ok: true, requestId: "req1", studentName: "홍길동", field: "name" });
  assert.equal(w.state.students.kid.name, "홍길동", "승인 전에는 이름이 바뀌지 않는다");
  assert.ok(!w.calls.some((c) => /^UPDATE "Student"/.test(c.sql)), "신청은 Student 를 고치지 않는다");
  assert.deepEqual(w.state.requests[0], { id: "req1", studentId: "kid", requestedByUserId: "dad", field: "name", oldValue: "홍길동", newValue: "홍길순", status: "PENDING", note: null });
  const insert = w.calls.find((c) => /^INSERT/.test(c.sql));
  assert.ok(insert.sql.includes(ACCESS_MARK), "INSERT 문 안에서도 권한을 다시 건다");
  // 같은 항목 두 번째 신청은 거절, 다른 항목은 가능
  assert.match((await edit.createChangeRequest(w.db, "mom", "kid", "name", "홍길자", TODAY)).error, /이미 확인 중/);
  assert.equal((await edit.createChangeRequest(w.db, "mom", "kid", "birthDate", "2014-05-01", TODAY)).ok, true);
  // 남의 가정
  assert.deepEqual(await edit.createChangeRequest(w.db, "stranger", "kid", "birthDate", "2013-01-01", TODAY), { ok: false, error: "아이 정보를 찾지 못했어요." });
  assert.equal(w.state.requests.length, 2);
  // 학부모 화면 목록
  const info = await edit.loadChildEditInfo(w.db, "mom", "kid");
  assert.equal(info.requests.length, 2);
  assert.equal(info.requests[0].requesterName, undefined, "학부모 화면에는 신청자 이름을 내리지 않는다");
  assert.equal(await edit.loadChildEditInfo(w.db, "stranger", "kid"), null);
  // 취소: 남은 못 한다, 가족은 누구나
  assert.equal((await edit.cancelChangeRequest(w.db, "stranger", "req1")).ok, false);
  assert.equal(w.state.requests[0].status, "PENDING");
  assert.deepEqual(await edit.cancelChangeRequest(w.db, "mom", "req1"), { ok: true });
  assert.equal(w.state.requests[0].status, "CANCELED");
  assert.equal((await edit.cancelChangeRequest(w.db, "mom", "req1")).ok, false, "이미 취소된 신청");
  // 취소 뒤에는 다시 신청할 수 있다
  assert.equal((await edit.createChangeRequest(w.db, "mom", "kid", "name", "홍길자", TODAY)).ok, true);
});

test("③ 새 칸·새 표가 없는 환경에서도 죽지 않는다", async () => {
  const w = world();
  w.state.healthColumn = false;
  w.state.requestTable = false;
  const info = await edit.loadChildEditInfo(w.db, "mom", "kid");
  assert.deepEqual(info, { healthAvailable: false, healthNote: null, phone: null, address: null, requestsAvailable: false, requests: [] });
  // 건강 칸이 없어도 학교·전화·주소는 저장된다
  assert.deepEqual(await edit.saveChildDirect(w.db, "mom", "kid", { school: "새학교", healthNote: "천식" }), { ok: true, healthSaved: false });
  assert.equal(w.state.students.kid.school, "새학교");
  const made = await edit.createChangeRequest(w.db, "mom", "kid", "name", "홍길순", TODAY);
  assert.equal(made.ok, false);
  assert.match(made.error, /지금은 신청할 수 없어요/);
  assert.equal((await edit.cancelChangeRequest(w.db, "mom", "req1")).ok, false);
  assert.deepEqual(await edit.listProfileChangesForAdmin(w.db, "kid"), { available: false, requests: [] });
});

// ── ④ 승인·반려 ─────────────────────────────────────────────────────────────

test("④ 승인만 Student 를 바꾼다 · 반려는 그대로 · 이미 처리된 신청·다른 학생 신청은 거절", async () => {
  const w = world();
  await edit.createChangeRequest(w.db, "mom", "kid", "name", "홍길순", TODAY);
  await edit.createChangeRequest(w.db, "mom", "kid", "birthDate", "2014-05-01", TODAY);
  // 다른 학생 화면에서 이 신청 id 를 넣어도 0행
  assert.equal((await edit.decideProfileChange(w.db, "admin", "other-kid", "req1", "APPROVE", "", TODAY)).ok, false);
  assert.equal(w.state.students.kid.name, "홍길동");
  // 모르는 처리 방법
  assert.equal((await edit.decideProfileChange(w.db, "admin", "kid", "req1", "DELETE", "", TODAY)).ok, false);
  // 승인: 이름
  assert.deepEqual(await edit.decideProfileChange(w.db, "admin", "kid", "req1", "APPROVE", "", TODAY),
    { ok: true, studentId: "kid", studentName: "홍길동", requestedByUserId: "mom", field: "name", approved: true });
  assert.equal(w.state.students.kid.name, "홍길순");
  assert.equal(w.state.requests[0].status, "APPROVED");
  assert.equal(w.state.requests[0].decidedByUserId, "admin", "누가 처리했는지 남는다");
  // 같은 신청을 다시 누르면 거절(두 번 반영 없음)
  assert.match((await edit.decideProfileChange(w.db, "admin", "kid", "req1", "APPROVE", "", TODAY)).error, /이미 처리/);
  // 반려: 생년월일은 그대로, 사유가 남는다
  const rejected = await edit.decideProfileChange(w.db, "admin", "kid", "req2", "REJECT", "  서류와  달라요 ", TODAY);
  assert.equal(rejected.approved, false);
  assert.equal(w.state.students.kid.birthYmd, "2015-05-01");
  assert.deepEqual([w.state.requests[1].status, w.state.requests[1].note], ["REJECTED", "서류와 달라요"]);
  // 승인: 생년월일 — 관리자 «수정»과 같은 저장 형식(::timestamp)
  await edit.createChangeRequest(w.db, "mom", "kid", "birthDate", "2014-05-01", TODAY);
  assert.equal((await edit.decideProfileChange(w.db, "admin", "kid", "req3", "APPROVE", "", TODAY)).ok, true);
  assert.equal(w.state.students.kid.birthYmd, "2014-05-01");
  // 승인 시점에 다시 검증한다 — 저장된 값이 잘못됐으면 반영도 상태 변경도 없다
  w.state.requests.push({ id: "bad", studentId: "kid", requestedByUserId: "mom", field: "birthDate", oldValue: null, newValue: "2999-01-01", status: "PENDING", note: null });
  assert.equal((await edit.decideProfileChange(w.db, "admin", "kid", "bad", "APPROVE", "", TODAY)).ok, false);
  assert.equal(w.state.students.kid.birthYmd, "2014-05-01");
  assert.equal(w.state.requests.at(-1).status, "PENDING");
  // 관리자 목록에는 신청자 이름이 있다(이력)
  const list = await edit.listProfileChangesForAdmin(w.db, "kid");
  assert.equal(list.available, true);
  assert.equal(list.requests[0].requesterName, "엄마");
  // 신청 행은 잠그고 읽는다(동시에 두 사람이 눌러도 한 번만)
  assert.match(read("src/lib/parent/childEdit.ts"), /FROM "StudentProfileChangeRequest" WHERE id = \$1 AND "studentId" = \$2 FOR UPDATE/);
});

// ── ⑤ 연결된 가족 ───────────────────────────────────────────────────────────

test("⑤ 연결된 가족: 대표 보호자만 끊는다 · 전화번호는 고르지 않는다 · 끊기 id 는 대표에게만", async () => {
  const revoked = [];
  const family = load("src/lib/account/family-access-parent.ts", {
    ...editMocks,
    "@/lib/account/family-access-admin": { revokeFamilyAccess: async (_tx, studentId, accessId) => { revoked.push([studentId, accessId]); return true; } },
  });
  const calls = [];
  const tx = (representative) => ({
    async $queryRawUnsafe(sql, ...v) {
      calls.push({ sql, v });
      // 학생의 parentId 가 로그인 사용자일 때만 한 줄
      if (/s\."parentId" = \$2/.test(sql)) return v[1] === representative ? [{ id: v[0] }] : [];
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
  });
  assert.equal(await family.revokeFamilyAsRepresentative(tx("mom"), "dad", "kid", "acc1"), false, "연결된 가족(대표 아님)은 못 끊는다");
  assert.equal(await family.revokeFamilyAsRepresentative(tx("mom"), "stranger", "kid", "acc1"), false, "남의 가정");
  assert.equal(revoked.length, 0);
  assert.equal(await family.revokeFamilyAsRepresentative(tx("mom"), "mom", "kid", "acc1"), true);
  assert.deepEqual(revoked, [["kid", "acc1"]], "해제는 관리자 화면과 같은 함수로");
  assert.equal(await family.revokeFamilyAsRepresentative(tx("mom"), "mom", "kid", ""), false);
  assert.match(calls[0].sql, /FOR UPDATE/);

  // 목록 — 대표에게만 accessId, 전화 칸은 SELECT 에 없다
  const listDb = (userId) => ({
    async $queryRawUnsafe(sql) {
      calls.push({ sql });
      if (/^SELECT s\.id, s\.name, rep\.name/.test(sql)) return [{ id: "kid", name: "홍길동", repName: "엄마", meIsRep: userId === "mom" }];
      if (/FROM "ParentStudentAccess" a/.test(sql)) return [{ id: "acc1", studentId: "kid", userId: "dad", name: "아빠", relation: "PARENT" }, { id: "acc2", studentId: "kid", userId: "grandma", name: "할머니", relation: null }];
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
  });
  const asMom = await family.loadFamilyForParent(listDb("mom"), "mom");
  assert.deepEqual(asMom[0].members, [
    { accessId: "acc1", name: "아빠", relation: "부모", isMe: false },
    { accessId: "acc2", name: "할머니", relation: "가족", isMe: false },
  ]);
  const asDad = await family.loadFamilyForParent(listDb("dad"), "dad");
  assert.equal(asDad[0].meIsRepresentative, false);
  assert.deepEqual(asDad[0].members.map((m) => [m.accessId, m.isMe]), [[null, true], [null, false]], "대표가 아니면 끊기 id 를 내리지 않는다");
  const source = read("src/lib/account/family-access-parent.ts");
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /phone/i, "전화번호를 고르지 않는다");
  // 화면: 끊기 버튼은 대표 보호자에게만, 그 자리 확인을 거친다. 대표 변경 기능은 없다
  const section = read("src/app/mypage/children/FamilyMembersSection.tsx");
  assert.match(section, /child\.meIsRepresentative && member\.accessId && \(\s*<InlineConfirm/);
  assert.doesNotMatch(section, /setPrimaryGuardian|대표로 지정|대표 바꾸기/);
  assert.match(read("src/app/mypage/children/ChildConnectionsClient.tsx"), /<FamilyMembersSection \/>/);
});

// ── ⑥ 연락처 바꾸기 ─────────────────────────────────────────────────────────

test("⑥ 연락처 판정: 이름 다름·중복 번호 거절, 같은 번호는 변경 없음", () => {
  const { phoneChangeOutcome, PHONE_CHANGE_ID_PREFIX } = load("src/lib/account/phone-change-rules.ts");
  const base = { accountName: "김엄마", verifiedName: "김엄마", currentPhone: "01011112222", verifiedPhone: "01033334444", takenByOther: false };
  assert.deepEqual(phoneChangeOutcome(base), { ok: true, changed: true });
  assert.deepEqual(phoneChangeOutcome({ ...base, verifiedPhone: "01011112222" }), { ok: true, changed: false });
  assert.deepEqual(phoneChangeOutcome({ ...base, currentPhone: "" }), { ok: true, changed: true }, "번호가 없던 계정");
  const mismatch = phoneChangeOutcome({ ...base, verifiedName: "김아빠" });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /이름/);
  const taken = phoneChangeOutcome({ ...base, takenByOther: true });
  assert.deepEqual([taken.ok, taken.status], [false, 409]);
  assert.match(taken.error, /다른 계정/);
  assert.equal(phoneChangeOutcome({ ...base, verifiedPhone: "0311234567" }).ok, false);
  assert.equal(phoneChangeOutcome({ ...base, verifiedName: "" }).ok, false);
  assert.equal(PHONE_CHANGE_ID_PREFIX, "stizphone_");
});

/** confirmPhoneChange 를 가짜 포트원·가짜 DB 로 실행한다 */
function phoneWorld({ available = true, challenge = true, portone = {}, me = { name: "김 엄마", phone: "010-1111-2222" }, taken = false } = {}) {
  const calls = [];
  let fetched = 0;
  const createdAt = new Date(Date.now() - 30_000);
  const db = {
    async $queryRawUnsafe(sql, ...v) {
      calls.push({ sql, v });
      if (/^UPDATE "ChildIdentityChallenge" SET "verifyAttempts"/.test(sql)) return challenge ? [{ id: v[0], createdAt }] : [];
      if (/^SELECT name, phone FROM "User"/.test(sql)) return [me];
      if (/^SELECT id FROM "User"/.test(sql)) return taken ? [{ id: "other" }] : [];
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      calls.push({ sql, v });
      return 1;
    },
    async $transaction(work) { return work(db); },
  };
  class ChildConnectionError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
  process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY = "channel-test";
  const id = "stizphone_abc";
  const mod = load("src/lib/account/phone-change.ts", {
    "server-only": {},
    "@/lib/prisma": { prisma: db },
    "@/lib/identity/portone": {
      getPortoneConfig: () => ({ apiSecret: "s", storeId: "store" }),
      fetchPortoneIdentityVerification: async () => {
        fetched++;
        return { ok: true, data: { id, channel: { key: "channel-test" }, status: "VERIFIED", verifiedAt: new Date().toISOString(), verifiedCustomer: { name: "김엄마", phoneNumber: "010-3333-4444" }, ...portone } };
      },
    },
    "./child-links": { ChildConnectionError, childConnectionsConfigured: () => available },
    "./child-access": { childAccessSql: async () => "", childConnectionsAvailable: async () => available },
  });
  const userUpdates = () => calls.filter((c) => /^UPDATE "User" SET phone/.test(c.sql));
  return { mod, calls, id, userUpdates, fetched: () => fetched };
}
const actor = { id: "mom", authUserId: "auth-mom" };

test("⑥ 본인인증을 통과한 번호로만 바뀐다 — 인증 건 없음·미인증·다른 채널이면 번호를 건드리지 않는다", async () => {
  // 이 기기에서 시작한 인증 건이 없다(만료·다른 계정·이미 씀) → 포트원을 묻지도 않는다
  const none = phoneWorld({ challenge: false });
  await assert.rejects(none.mod.confirmPhoneChange(actor, "hash", none.id), /본인인증을 다시/);
  assert.equal(none.fetched(), 0);
  assert.equal(none.userUpdates().length, 0);
  // 자녀 연결용 인증 건 번호(stizchild_)는 받지 않는다
  await assert.rejects(none.mod.confirmPhoneChange(actor, "hash", "stizchild_abc"), /본인인증을 다시/);
  // 인증이 끝나지 않았다
  const failed = phoneWorld({ portone: { status: "FAILED" } });
  await assert.rejects(failed.mod.confirmPhoneChange(actor, "hash", failed.id), /본인인증 정보를 확인하지 못했습니다/);
  assert.equal(failed.userUpdates().length, 0);
  // 다른 채널·다른 건 번호·오래된 인증
  for (const portone of [{ channel: { key: "other" } }, { id: "stizphone_other" }, { verifiedAt: new Date(Date.now() - 3_600_000).toISOString() }, { verifiedCustomer: { name: "김엄마", phoneNumber: "031-123-4567" } }]) {
    const w = phoneWorld({ portone });
    await assert.rejects(w.mod.confirmPhoneChange(actor, "hash", w.id));
    assert.equal(w.userUpdates().length, 0, JSON.stringify(portone));
  }
  // 본인인증 설정이 꺼진 환경
  const off = phoneWorld({ available: false });
  assert.equal(await off.mod.phoneChangeAvailable(), false);
  await assert.rejects(off.mod.confirmPhoneChange(actor, "hash", off.id), /준비 중/);
  await assert.rejects(off.mod.startPhoneChange(actor, "hash"), /준비 중/);
  assert.equal(off.calls.length, 0);
});

test("⑥ 이름 다름·중복 번호는 거절, 통과하면 인증된 번호로 — 내 아이 보호자 연락처만 함께", async () => {
  const mismatch = phoneWorld({ me: { name: "민준맘", phone: "010-1111-2222" } });
  await assert.rejects(mismatch.mod.confirmPhoneChange(actor, "hash", mismatch.id), /이름/);
  assert.equal(mismatch.userUpdates().length, 0);
  const taken = phoneWorld({ taken: true });
  await assert.rejects(taken.mod.confirmPhoneChange(actor, "hash", taken.id), /다른 계정/);
  assert.equal(taken.userUpdates().length, 0);

  const ok = phoneWorld();
  assert.deepEqual(await ok.mod.confirmPhoneChange(actor, "sess", ok.id), { ok: true, changed: true });
  const update = ok.userUpdates();
  assert.equal(update.length, 1);
  assert.deepEqual(update[0].v, ["01033334444", "mom"], "화면 값이 아니라 포트원이 확인한 번호 · 로그인한 본인만");
  assert.match(update[0].sql, /"phoneVerifiedAt"=NOW\(\)/);
  // 중복 확인은 탈퇴하지 않은 «다른» 계정만
  const takenQuery = ok.calls.find((c) => /^SELECT id FROM "User"/.test(c.sql));
  assert.match(takenQuery.sql, /id<>\$2 AND "withdrawnAt" IS NULL/);
  assert.deepEqual(takenQuery.v, ["01033334444", "mom"]);
  // 인증 건은 1회용 — 가족 연결 요청 증명으로 다시 쓰이지 않게 proofUsedAt 도 찍는다
  const consume = ok.calls.find((c) => /^UPDATE "ChildIdentityChallenge" SET "usedAt"=NOW\(\), "proofUsedAt"=NOW\(\)/.test(c.sql));
  assert.deepEqual(consume.v.slice(0, 3), [ok.id, "mom", "sess"]);
  // 보호자 연락처(Guardian) 는 «옛 내 번호» 줄 + «내 아이» 범위에서만
  const guardian = ok.calls.find((c) => /^UPDATE "Guardian"/.test(c.sql));
  assert.deepEqual(guardian.v, ["01033334444", "01011112222", "mom"]);
  assert.match(guardian.sql, /s\."parentId"=\$3 OR EXISTS\(\s*SELECT 1 FROM "ParentStudentAccess" a WHERE a\."studentId"=s\.id AND a\."userId"=\$3 AND a\.status='ACTIVE'\)/);

  // 같은 번호면 변경 없음(보호자 연락처도 건드리지 않는다)
  const same = phoneWorld({ me: { name: "김엄마", phone: "01033334444" } });
  assert.deepEqual(await same.mod.confirmPhoneChange(actor, "sess", same.id), { ok: true, changed: false });
  assert.ok(!same.calls.some((c) => /^UPDATE "Guardian"/.test(c.sql)));
});

test("⑥ 번호를 화면에서 받는 길이 없다 · 꺼진 환경은 기존 안내 유지", () => {
  const route = read("src/app/api/account/phone-change/route.ts");
  assert.doesNotMatch(route, /body\.(phone|newPhone|number)/, "API 는 번호를 입력으로 받지 않는다");
  assert.match(route, /requireVerifiedParent\(\)/);
  assert.match(route, /request\.headers\.get\("origin"\) !== request\.nextUrl\.origin/);
  // 학부모 설정 서버 동작에는 번호를 바꾸는 함수가 없다
  assert.doesNotMatch(read("src/app/actions/parent-settings.ts"), /phone\s*=\s*\$/);
  assert.doesNotMatch(read("src/app/actions/child-edit.ts"), /UPDATE "User"/);
  // User.phone 을 바꾸는 학부모 경로는 phone-change.ts 한 곳 — 포트원 재조회 뒤에 있다
  const lib = read("src/lib/account/phone-change.ts");
  assert.ok(lib.indexOf("fetchPortoneIdentityVerification(id, config)") < lib.indexOf(`UPDATE "User" SET phone=$1`));
  assert.ok(lib.indexOf("phoneChangeOutcome(") < lib.indexOf(`UPDATE "User" SET phone=$1`));
  const settings = read("src/app/mypage/settings/page.tsx");
  assert.match(settings, /canChangePhone \? "본인 명의 휴대폰 인증 후 바뀌어요" : "변경은 학원 문의"/);
  assert.match(settings, /<PhoneChangeButton enabled=\{canChangePhone\}/);
  const button = read("src/components/account/PhoneChangeButton.tsx");
  assert.match(button, /if \(!available\) return <>\{fallback\}<\/>/);
  assert.doesNotMatch(button, /<input/, "번호를 적는 칸이 없다");
});

// ── ⑦ 건강 특이사항 노출 범위 ────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path.replace(/\\/g, "/"));
  }
  return out;
}

test("⑦ 건강 특이사항은 정해진 파일에서만 다루고, 알림·로그에 쓰지 않는다", () => {
  // 이 목록에 없는 파일이 healthNote 를 쓰면 실패한다 — 새로 쓸 때는 «누가 보는가»를 확인하고 여기에 더한다
  const ALLOWED = [
    "src/app/actions/child-edit.ts",                        // 학부모 저장(입력 전달만)
    "src/app/actions/student-profile-admin.ts",             // 관리자 보기·저장
    "src/app/admin/students/[id]/StudentDetailClient.tsx",  // 관리자 학생 상세
    "src/app/admin/students/[id]/StudentProfilePanels.tsx",
    "src/app/mypage/record/ChildInfoEditSheet.tsx",         // 그 아이의 보호자
    "src/app/mypage/record/ChildProfileSections.tsx",
    "src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", // 선생님(자기 반 명단)
    "src/components/staff/ClassPeopleSheet.tsx",
    "src/components/staff/SessionStudentSheet.tsx",
    "src/components/shuttle/UnifiedDriverClient.tsx",        // 기사님(그날 운행표 승객)
    "src/lib/parent/childEdit.ts",
    "src/lib/parent/childEditRules.ts",
    "src/lib/shuttle/unifiedDriverRun.ts",
    "src/lib/shuttle/unifiedDriverRunLogic.ts",
    "src/lib/staff-class-people.ts",
    "src/lib/student/healthNote.ts",
  ].sort();
  const using = walk("src").filter((path) => /healthNote|HealthNote/.test(read(path))).sort();
  assert.deepEqual(using, ALLOWED);
  // 알림·문자·푸시·로그 호출과 같은 줄·같은 호출 안에 건강 글이 없다
  const SEND = /console\.|notifyAdmins|notifyParents|createNotificationRecord|sendPush|sendTrackedSms|sendParentSms|sendSms|alimtalk/i;
  for (const path of using) {
    for (const line of read(path).split("\n")) {
      if (/healthNote/i.test(line) && SEND.test(line) && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
        assert.fail(`${path}: 건강 특이사항을 알림·로그에 쓰면 안 된다 — ${line.trim()}`);
      }
    }
  }
  // 알림 글은 아이 이름·항목 이름만으로 만든다
  const parentActions = read("src/app/actions/child-edit.ts");
  const notify = parentActions.slice(parentActions.indexOf("await notifyAdmins("), parentActions.indexOf(".catch(() => undefined)"));
  assert.match(notify, /created\.studentName\} · \$\{REQUEST_FIELD_LABEL\[created\.field\]\} 변경 신청/);
  assert.match(notify, /\{ notifyCoaches: false \}/, "선생님 문자 없음");
  assert.doesNotMatch(notify, /adminTrigger|newValue|input/);
  // 바로 반영(건강 포함) 저장은 알림을 만들지 않는다
  const save = parentActions.slice(parentActions.indexOf("export async function saveChildInfo"), parentActions.indexOf("export async function requestChildChange"));
  assert.doesNotMatch(save, /notify|Notification/);
  // 공개 화면·알림 모듈은 건강 칸을 모른다
  assert.doesNotMatch(read("src/lib/notification.ts"), /healthNote/);
});

test("⑦ 읽기: 권한 확인된 학생 id 로만 · 실패하면 빈 값 · 선생님=자기 반 명단 · 기사님=운행표 승객", async () => {
  const health = load("src/lib/student/healthNote.ts");
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...v) { calls.push({ sql, v }); return [{ id: "a", healthNote: "천식" }, { id: "b", healthNote: null }]; } };
  assert.deepEqual(await health.loadHealthNotes(db, ["a", "a", "", "b"]), { a: "천식" });
  assert.deepEqual(calls[0].v, [["a", "b"]], "넘겨받은 id 만(중복·빈 값 제거)");
  assert.match(calls[0].sql, /s\.id = ANY\(\$1::text\[\]\)/);
  assert.deepEqual(await health.loadHealthNotes(db, []), {});
  assert.equal(calls.length, 1, "id 가 없으면 묻지 않는다");
  // 칸이 없는 환경
  assert.deepEqual(await health.loadHealthNotes({ async $queryRawUnsafe() { throw new Error("column does not exist"); } }, ["a"]), {});
  // 관리자 저장
  const writes = [];
  const writer = { async $executeRawUnsafe(sql, ...v) { writes.push({ sql, v }); return 1; } };
  assert.deepEqual(await health.saveHealthNoteAsAdmin(writer, "kid", " 안경 착용 "), { status: "saved" });
  assert.deepEqual(writes[0].v, ["안경 착용", "kid"]);
  assert.equal((await health.saveHealthNoteAsAdmin(writer, "kid", "가".repeat(301))).status, "invalid");
  assert.equal(writes.length, 1);
  assert.deepEqual(await health.saveHealthNoteAsAdmin({ async $executeRawUnsafe() { throw new Error("no column"); } }, "kid", "x"), { status: "unavailable" });

  // 선생님: 반 권한 확인 → 명단 조회 → 그 명단의 id 로만 건강 글
  const people = read("src/lib/staff-class-people.ts");
  const body = people.slice(people.indexOf("export async function getStaffClassPeople"));
  assert.ok(body.indexOf("requireStaffClassAccess(") < body.indexOf("loadHealthNotes("), "권한 확인이 먼저");
  assert.match(body, /loadHealthNotes\(prisma, rows\.map\(\(row\) => row\.id\)\)/);
  // 명단 줄 «특이» 조건과 상세 시트
  assert.match(read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx"), /\(person\?\.memo \|\| person\?\.healthNote \|\| student\.attendanceNote\) && \(/);
  // 기사님: 그날 운행표 승객 줄의 저장 키로만 학생을 되짚는다(전체 학생 조회 없음)
  const run = read("src/lib/shuttle/unifiedDriverRun.ts");
  const attach = run.slice(run.indexOf("async function attachRiderHealthNotes"), run.indexOf("/** 그날 운행 전체"));
  assert.equal((attach.match(/WHERE r\.id = ANY\(\$1::text\[\]\)/g) ?? []).length, 2, "정규·특강 모두 승객 줄 id 로만");
  assert.match(attach, /catch \{/);
  assert.match(run, /await attachRiderHealthNotes\(rows\);/);
});

// ── ⑧ 화면 렌더 ─────────────────────────────────────────────────────────────

const link = { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) };
const passthrough = { __esModule: true, default: ({ children }) => React.createElement("div", null, children) };
const uiMocks = {
  "next/link": link,
  "next/navigation": { useRouter: () => ({ refresh() {} }) },
  // 수정 시트는 눌렀을 때만 내려받는다 — 렌더 테스트에서는 자리만
  "next/dynamic": { __esModule: true, default: () => () => React.createElement("div", { "data-edit-sheet": "" }) },
  "@/components/admin/list/ListDetailPanel": passthrough,
};
const sections = load("src/app/mypage/record/ChildProfileSections.tsx", uiMocks);
const profile = (extra = {}) => ({
  birthYmd: "2015-05-01", gender: "여자", school: "다산초", gradeText: "초5", enrollYmd: "2024-03-02",
  guardians: { representativeName: "엄마", meIsRepresentative: true, me: { name: "엄마", phone: "010-1234-5678" }, familyNames: [] },
  classes: [], makeup: { available: 0, reserved: 0, nearestExpiryYmd: null }, ...extra,
});
const editInfo = (extra = {}) => ({ healthAvailable: true, healthNote: "천식", phone: "01022223333", address: "다산로 2", requestsAvailable: true, requests: [], ...extra });
const infoHtml = (p) => renderToStaticMarkup(React.createElement(sections.ChildInfoSection, { profile: p, today: TODAY, studentId: "kid" }));

test("⑧ 아이 정보 칸: 수정 버튼·새 줄·확인 중·반려 사유 · 수정용 값을 못 읽으면 버튼 없음", () => {
  const html = infoHtml(profile({
    edit: editInfo({ requests: [
      { id: "r1", field: "name", oldValue: "홍길동", newValue: "홍길순", status: "PENDING", note: null, createdYmd: TODAY, decidedYmd: null },
      { id: "r2", field: "birthDate", oldValue: "2015-05-01", newValue: "2014-05-01", status: "REJECTED", note: "서류와 달라요", createdYmd: TODAY, decidedYmd: TODAY },
    ] }),
  }));
  assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*>수정<\/button>/);
  assert.match(html, /학생 전화<\/span><span[^>]*>010-2222-3333/);
  assert.match(html, /주소<\/span><span[^>]*>다산로 2/);
  assert.match(html, /건강·특이<\/span>.*천식/);
  assert.match(html, /확인 중<\/span><span[^>]*>이름 홍길동 → 홍길순/);
  assert.match(html, /반려<\/span>.*생년월일 2015\.5\.1 → 2014\.5\.1.*서류와 달라요/);
  // 수정용 값이 없으면(조회 실패·옛 모양) 버튼·새 줄 없이 기존 줄만
  const plain = infoHtml(profile());
  assert.doesNotMatch(plain, />수정<\/button>/);
  assert.doesNotMatch(plain, /학생 전화|건강·특이/);
  assert.match(plain, /생년월일<\/span><span[^>]*>2015\.5\.1 · 만 11세/);
  // 건강 칸이 없는 환경
  assert.doesNotMatch(infoHtml(profile({ edit: editInfo({ healthAvailable: false }) })), /건강·특이/);
  // 임시 생일 — «-» 와 적힌 학년
  const placeholder = infoHtml(profile({ birthYmd: "2000-01-01" }));
  assert.match(placeholder, /생년월일<\/span><span[^>]*>-<\/span>/);
  assert.match(placeholder, /학년<\/span><span[^>]*>초5<\/span>/);
  assert.doesNotMatch(placeholder, /성인|만 26세/);
  // 막다른 링크였던 «내 연락처 바꾸기»는 그 자리 버튼(본인인증)으로
  const source = read("src/app/mypage/record/ChildProfileSections.tsx");
  assert.match(source, /<PhoneChangeButton\s+label="내 연락처 바꾸기"/);
  assert.doesNotMatch(source, /\{ href: "\/mypage\/settings", label: "내 연락처 바꾸기" \}/);
});

test("⑧ 수정 시트: 바로 반영 칸·예시 글·변경 신청·확인 중 취소 · 없는 칸은 숨김", () => {
  const Sheet = load("src/app/mypage/record/ChildInfoEditSheet.tsx", {
    ...uiMocks,
    "@/app/actions/child-edit": { saveChildInfo: async () => ({ ok: true }), requestChildChange: async () => ({ ok: true }), cancelChildChange: async () => ({ ok: true }) },
  }).default;
  const render = (edit) => renderToStaticMarkup(React.createElement(Sheet, { studentId: "kid", name: "홍길동", birthYmd: "2015-05-01", school: "다산초", gradeText: "초5", edit, onClose() {} }));
  const html = render(editInfo());
  assert.match(html, /홍길동 정보 수정/);
  for (const label of ["학교", "학생 전화", "주소", "건강·알레르기·특이사항"]) assert.match(html, new RegExp(label));
  assert.match(html, /placeholder="천식, 견과류 알레르기, 안경 착용"/);
  assert.match(html, /maxLength="300"/);
  assert.match(html, /2\/300/, "글자 수");
  assert.match(html, /value="010-2222-3333"/);
  assert.match(html, /학원이 확인한 뒤 바뀌어요/);
  assert.equal((html.match(/>변경 신청<\/button>/g) ?? []).length, 2, "이름·생년월일");
  assert.match(html, /학년 초5 · 생년월일로 계산해요/);
  assert.doesNotMatch(html, /aria-label="새 학년"|name="grade"/, "학년 입력칸은 없다");
  // 확인 중이면 입력칸 대신 한 줄 + 취소
  const waiting = render(editInfo({ requests: [{ id: "r1", field: "name", oldValue: "홍길동", newValue: "홍길순", status: "PENDING", note: null, createdYmd: TODAY, decidedYmd: null }] }));
  assert.match(waiting, /확인 중 · 이름 홍길동 → 홍길순/);
  assert.match(waiting, /신청 취소/);
  assert.equal((waiting.match(/>변경 신청<\/button>/g) ?? []).length, 1, "생년월일만 신청 가능");
  // 새 칸·새 표가 없는 환경
  const bare = render(editInfo({ healthAvailable: false, requestsAvailable: false }));
  assert.doesNotMatch(bare, /건강·알레르기·특이사항|변경 신청/);
  assert.match(bare, />저장<\/button>/);
});

test("⑧ 막다른 곳 3곳: 셔틀 «학원 확인 중» · 방학특강 연락처 버튼+문의 · 자녀 없음 화면 학원 번호는 설정값", () => {
  // 셔틀 — 학부모에게 행동을 요구하지 않는다
  const day = { ymd: TODAY, classTime: "18:00", status: "CHECK", statusText: "확인 필요", className: null, board: null, alight: null, planMissing: false };
  const shuttle = { regular: { rosterMonth: "2026-11", weekly: [{ weekday: 1, dayLabel: "월", classTime: "18:00~19:20", board: { stopName: "A", time: "17:45" }, alight: null }], days: [day] }, others: [], driver: null };
  const html = renderToStaticMarkup(React.createElement(sections.ChildShuttleSection, { shuttle, studentId: "kid" }));
  assert.match(html, /학원 확인 중/);
  assert.doesNotMatch(html, /학원에 확인해 주세요/);
  // 방학특강
  const seasonal = read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx");
  const block = seasonal.slice(seasonal.indexOf("if (!ctx.phoneKnown)"), seasonal.indexOf("<h1 className=\"academy-heading mb-1\">"));
  assert.match(block, /<PhoneChangeButton label="연락처 바꾸기"/);
  assert.match(block, /href="\/mypage#parent-request-form"[^>]*>학원에 문의</);
  assert.doesNotMatch(block, /학원에 문의해 주세요/);
  // 자녀 없음 화면
  const emptySource = read("src/components/account/EmptyParentState.tsx");
  assert.doesNotMatch(emptySource, /07088245712|tel:0\d+/, "번호를 코드에 박지 않는다");
  const Empty = load("src/components/account/EmptyParentState.tsx", {
    ...uiMocks,
    "@/components/pwa/useInstalledApp": { useInstalledApp: () => false },
    "./child-link-api": { childLinkRequest: async () => ({}), isChildLinkState: () => false },
  }).default;
  const withPhone = renderToStaticMarkup(React.createElement(Empty, { pendingSeasonalChildren: [], academyPhone: "070-1234-5678" }));
  assert.match(withPhone, /href="tel:07012345678"[^>]*>학원에 전화하기</);
  const noPhone = renderToStaticMarkup(React.createElement(Empty, { pendingSeasonalChildren: [], academyPhone: null }));
  assert.doesNotMatch(noPhone, /href="tel:/);
  assert.match(noPhone, /학원에 문의해 주세요/);
  const page = read("src/app/mypage/page.tsx");
  assert.match(page, /getAcademySettings\(\)\.then\(\(s\) => s\?\.contactPhone \?\? null\)/);
  assert.match(page, /academyPhone=\{usablePhone\}/);
});

test("⑧ 선생님 상세 시트·기사님 줄·관리자 칸에 건강 특이사항이 보인다", () => {
  const Sheet = load("src/components/staff/SessionStudentSheet.tsx", {
    "@/components/staff/ClassPeopleSheet": { ContactLink: () => null },
    "@/components/staff/StaffMonthlyFeeSummary": { monthlyFeeLabel: () => "" },
    "@/components/staff/useStaffDialog": { useStaffDialog() {} },
  }).SessionStudentSheet;
  const person = { id: "kid", name: "홍길동", school: null, grade: null, memo: null, healthNote: "견과류 알레르기", studentPhone: null, guardians: [], recentAttendance: { present: 0, late: 0, absent: 0, total: 0 }, todayStatus: null, billing: null };
  const props = { className: "월 6시", student: { id: "kid", name: "홍길동", status: null }, peopleState: "ready", onReloadPeople() {}, showFees: false, feeLoading: false, feeError: "", feeMonth: null, fee: undefined, onReloadFees() {}, onOpenBilling() {}, onClose() {} };
  const html = renderToStaticMarkup(React.createElement(Sheet, { ...props, person }));
  assert.match(html, /메모·특이사항/);
  assert.match(html, /건강·알레르기 <\/span>견과류 알레르기/);
  // 값이 없으면 칸 자체가 없다
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(Sheet, { ...props, person: { ...person, healthNote: null } })), /메모·특이사항/);
  // 기사님: 이름 옆 글자 «특이»(44px) → 누르면 줄 아래 글
  const driver = read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(driver, /\{rider\.healthNote && \(\s*<button type="button" aria-expanded=\{healthKey === rowKey\}/);
  assert.match(driver, /min-h-11 min-w-11[^"]*">\s*<span[^>]*>특이<\/span>/);
  assert.match(driver, /\{rider\.healthNote && healthKey === rowKey && \(/);
  // 관리자 학생 상세: 변경 요청 칸(승인·반려) + 건강 칸
  const detail = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(detail, /profileExtras\?\.requestsAvailable && \(\s*<ProfileChangeRequestsPanel/);
  assert.match(detail, /profileExtras\?\.healthAvailable && \(\s*<StudentHealthNotePanel/);
  const panels = read("src/app/admin/students/[id]/StudentProfilePanels.tsx");
  assert.match(panels, /정보 변경 요청/);
  assert.match(panels, /"APPROVE"\)\} className="academy-button-primary/);
  assert.match(panels, />\s*반려\s*<\/button>/);
});

// ── ⑨ 마이그레이션·서버 동작 가드 ─────────────────────────────────────────────

test("⑨ 마이그레이션: 멱등·RLS·timestamptz·제약이 코드 상수와 같은 집합", () => {
  const sql = read("prisma/migrations/20261114140000_child_profile_edit/migration.sql");
  assert.match(sql, /ALTER TABLE public\."Student" ADD COLUMN IF NOT EXISTS "healthNote" TEXT;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."StudentProfileChangeRequest"/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."StudentProfileChangeRequest" FROM anon, authenticated;/);
  assert.match(sql, /-- DROP TABLE IF EXISTS public\."StudentProfileChangeRequest";/, "되돌림 주석");
  assert.match(sql, /-- ALTER TABLE public\."Student" DROP COLUMN IF EXISTS "healthNote";/);
  // 시간 칸은 timestamptz 만
  const body = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  assert.equal((body.match(/TIMESTAMPTZ\(6\)/g) ?? []).length, 2);
  assert.doesNotMatch(body, /TIMESTAMP\(|TIMESTAMP\s+(NOT|DEFAULT|,)/);
  assert.doesNotMatch(body, /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/, "파괴 명령 없음(ON DELETE CASCADE 는 외래키 규칙)");
  // 항목 CHECK = REQUEST_FIELDS, 300자 = HEALTH_NOTE_MAX
  const fields = /CHECK \(field IN \(([^)]+)\)\)/.exec(body)[1].split(",").map((v) => v.trim().replace(/'/g, "")).sort();
  assert.deepEqual(fields, [...rules.REQUEST_FIELDS].sort());
  const statuses = /CHECK \(status IN \(([^)]+)\)\)/.exec(body)[1].split(",").map((v) => v.trim().replace(/'/g, "")).sort();
  assert.deepEqual(statuses, Object.keys(rules.CHANGE_STATUS_LABEL).sort());
  assert.equal(Number(/char_length\("healthNote"\) <= (\d+)/.exec(body)[1]), rules.HEALTH_NOTE_MAX);
  assert.match(body, /CREATE UNIQUE INDEX IF NOT EXISTS "StudentProfileChangeRequest_pending_unique"[\s\S]*WHERE status = 'PENDING';/);
  // schema.prisma 사본
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /healthNote\s+String\?/);
  assert.match(schema, /model StudentProfileChangeRequest \{[\s\S]*decidedAt\s+DateTime\? @db\.Timestamptz\(6\)/);
});

test("⑨ 서버 동작: 학부모는 로그인 보호자 확인, 관리자는 requireAdmin · 고객 발송 없음 · ORM 메서드 없음", () => {
  const exported = (source) => source.split(/\nexport async function /).slice(1);
  const parent = read("src/app/actions/child-edit.ts");
  for (const fn of exported(parent)) assert.match(fn, /await requireVerifiedParent\(\)\.catch\(\(\) => null\)/, fn.slice(0, 40));
  assert.equal(exported(parent).length, 6);
  const admin = read("src/app/actions/student-profile-admin.ts");
  for (const fn of exported(admin)) assert.match(fn.slice(0, 600), /await requireAdmin\(\)/, fn.slice(0, 40));
  assert.equal(exported(admin).length, 3);
  // 승인·반려는 트랜잭션 안에서
  assert.match(admin, /prisma\.\$transaction\(\(tx\) => decideProfileChange\(tx, admin\.appUserId/);
  // 문자·알림톡을 새로 만들지 않는다(앱 안 알림만)
  const files = ["src/app/actions/child-edit.ts", "src/app/actions/student-profile-admin.ts", "src/lib/parent/childEdit.ts", "src/lib/account/phone-change.ts", "src/lib/account/family-access-parent.ts", "src/app/api/account/phone-change/route.ts", "src/lib/student/healthNote.ts"];
  for (const path of files) {
    const source = read(path);
    assert.doesNotMatch(source, /sendTrackedSms|sendParentSms|sendFailClosed|alimtalk|adminTrigger|coachTrigger/, path);
    assert.doesNotMatch(source, /\.(findMany|findFirst|findUnique|create|update|upsert|delete|deleteMany|updateMany)\(/, `${path}: ORM 메서드 금지`);
  }
  // 날짜는 공용 모듈로만
  for (const path of [...files, "src/lib/parent/childEditRules.ts"]) {
    assert.doesNotMatch(read(path), /toISOString\(\)\.slice\(0, ?10\)|\.getDay\(\)|\.getDate\(\)|\.getHours\(\)/, path);
  }
  // 무tz 칼럼(Student.birthDate)은 두 번, 새 timestamptz 칼럼은 한 번
  const lib = read("src/lib/parent/childEdit.ts");
  assert.match(lib, /\(s\."birthDate" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'/);
  assert.match(lib, /to_char\(r\."createdAt" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\)/);
  assert.doesNotMatch(lib, /r\."createdAt" AT TIME ZONE 'UTC'/);
});
