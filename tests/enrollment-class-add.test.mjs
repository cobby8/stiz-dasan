// 학부모 «반 추가» 신청(2026-11-14 결정표 c8) — 지금 다니는 반은 그대로 두고 다른 요일·시간 반을 하나 더.
//  ① 규칙: 후보(학년·이미 다니는 반·이미 신청한 반)·접수 판정·승인 판정을 실제로 실행
//  ② 접수: 내 아이만(childAccessSql)·학생 행 잠금·후보를 서버가 다시 계산·정원이 차면 대기로 접수·중복 차단
//  ③ 승인: 같은 트랜잭션에서 수강 등록(개시일 = 시작일)·운영 원장 «수강 등록»·신청 APPLIED, 막히면 아무것도 안 쓴다
//  ④ 기존 흐름 불변: 반 변경·휴원·퇴원·복귀 종류 목록과 접수 길은 그대로, 적용일 크론은 반 추가를 집지 않는다
//  ⑤ 화면: 종류 칩·후보·검토 중 줄·취소
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";
import * as seatLevelModule from "../src/lib/seats/seatLevel.ts";

const read = (p) => readFileSync(p, "utf8");
const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : nodeRequire(name);
  module._compile(compiled, absolute);
  return module.exports;
};

const rules = await loadTsModule("src/lib/enrollment/classAddRules.ts");
const changeRules = await loadTsModule("src/lib/enrollment/changeRequestRules.ts");
const status = await loadTsModule("src/lib/enrollment/parentChangeStatus.ts");
const studentGrade = await loadTsModule("src/lib/makeup/student-grade.ts");
const duePlan = await loadTsModule("src/lib/enrollment/due-change-plan.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");

// 합성 반: 초1~초2 / 초3~초4 / 초5~초6 / 학년 모름 / 성인
const CLASSES = [
  { classId: "c-12", className: "월 1교시", grades: ["초1", "초2"], gradeRangeText: null },
  { classId: "c-34", className: "수 2교시", grades: ["초3", "초4"], gradeRangeText: null },
  { classId: "c-56", className: "금 3교시", grades: [], gradeRangeText: "초5~초6" },
  { classId: "c-unknown", className: "토 자유", grades: [], gradeRangeText: null },
  { classId: "c-adult", className: "화 8교시(성인)", grades: ["성인"], gradeRangeText: null },
];

test("① 종류 값·이름: 반 추가는 CHANGE_KINDS 밖(기존 세 종류 그대로) · 이름은 한 표", () => {
  assert.equal(rules.CLASS_ADD_KIND, "CLASS_ADD");
  assert.equal(changeRules.CLASS_ADD_KIND, rules.CLASS_ADD_KIND, "규칙 파일 두 곳의 값이 같다");
  assert.deepEqual([...changeRules.CHANGE_KINDS], ["CLASS_CHANGE", "PAUSE", "WITHDRAW"], "기존 종류 목록 불변");
  assert.equal(changeRules.isChangeKind("CLASS_ADD"), false, "기존 접수 길(submitEnrollmentChangeRequest)은 반 추가를 받지 않는다");
  assert.equal(changeRules.REQUEST_KIND_LABEL.CLASS_ADD, "반 추가");
  assert.equal(changeRules.REQUEST_KIND_LABEL.CLASS_CHANGE, "반·요일 변경");
  assert.equal(status.parentKindName("CLASS_ADD"), "반 추가");
  const notice = status.buildChangeDecisionNotice({ event: "APPROVED", studentName: "합성", className: "수 2교시", kind: "CLASS_ADD", effectiveFrom: "2026-12-01" });
  assert.equal(notice.message, "합성 수 2교시 반 추가 신청이 승인됐어요(12/1부터)");
});

test("① 후보: 학년이 포함되는 반 먼저 → 가까운 학년 · 다니는 반·신청한 반 제외 · 학년 모르는 반 제외", () => {
  // 초3(3): 포함 = c-34 / 가까운 학년(±1) = c-12(초2 까지) / c-56 은 초5 부터라 2학년 차 → 제외
  const g3 = rules.classAddCandidateIds({ studentGrade: 3, classes: CLASSES, enrolledClassIds: [], pendingClassIds: [] });
  assert.deepEqual(g3, { classIds: ["c-34", "c-12"], gradeKnown: true });
  // 이미 다니는 반(휴원 중 포함)·이미 신청한 반은 빠진다
  assert.deepEqual(rules.classAddCandidateIds({ studentGrade: 3, classes: CLASSES, enrolledClassIds: ["c-34"], pendingClassIds: [] }).classIds, ["c-12"]);
  assert.deepEqual(rules.classAddCandidateIds({ studentGrade: 3, classes: CLASSES, enrolledClassIds: ["c-34"], pendingClassIds: ["c-12"] }).classIds, []);
  // 성인은 성인반끼리
  assert.deepEqual(rules.classAddCandidateIds({ studentGrade: 13, classes: CLASSES, enrolledClassIds: [], pendingClassIds: [] }).classIds, ["c-adult"]);
  // 생년월일 → 학년 계산(보강 예약과 같은 함수)과 이어 붙여도 같은 답
  const grade = studentGrade.studentMakeupGrade("2017-05-05", null, "2026-11-14"); // 2017년생 = 2026학년도 초3
  assert.equal(grade, 3);
});

test("① 학생 학년을 끝내 모르면 거르지 않고 모두 보인다(막다른 길 금지) — 다니는 반·신청한 반만 뺀다", () => {
  const unknown = rules.classAddCandidateIds({ studentGrade: null, classes: CLASSES, enrolledClassIds: ["c-12"], pendingClassIds: ["c-34"] });
  assert.equal(unknown.gradeKnown, false);
  assert.deepEqual(unknown.classIds, ["c-56", "c-unknown", "c-adult"]);
});

test("① 접수 판정: 반 선택·사유 길이·다니는 반 있어야·중복(다니는 반/신청한 반)·없는 반·학년 밖", () => {
  const base = {
    toClassId: "c-34", reason: "", enrollments: [{ classId: "c-12", status: "ACTIVE" }],
    pendingClassIds: [], targetExists: true, candidateIds: ["c-34"],
  };
  assert.deepEqual(rules.validateClassAdd(base), { ok: true, toClassId: "c-34" });
  assert.deepEqual(rules.validateClassAdd({ ...base, toClassId: "  c-34 " }), { ok: true, toClassId: "c-34" });
  const err = (over) => rules.validateClassAdd({ ...base, ...over }).error;
  assert.equal(err({ toClassId: "" }), "TO_CLASS_REQUIRED");
  assert.equal(err({ toClassId: 7 }), "TO_CLASS_REQUIRED");
  assert.equal(err({ reason: "가".repeat(501) }), "REASON_TOO_LONG");
  assert.equal(err({ enrollments: [{ classId: "c-12", status: "PAUSED" }] }), "NO_ACTIVE_CLASS", "휴원 중인 반만 있으면 복귀가 먼저");
  assert.equal(err({ enrollments: [] }), "NO_ACTIVE_CLASS");
  assert.equal(err({ toClassId: "c-12" }), "ALREADY_ENROLLED");
  assert.equal(err({ enrollments: [{ classId: "c-12", status: "ACTIVE" }, { classId: "c-34", status: "PAUSED" }] }), "ALREADY_ENROLLED", "휴원 중인 반도 «추가»가 아니다");
  assert.equal(err({ pendingClassIds: ["c-34"] }), "ALREADY_REQUESTED", "같은 반 중복 신청 차단");
  assert.equal(err({ targetExists: false }), "CLASS_NOT_FOUND");
  assert.equal(err({ candidateIds: ["c-12"] }), "GRADE_NOT_MATCHED");
  for (const key of ["TO_CLASS_REQUIRED", "REASON_TOO_LONG", "NO_ACTIVE_CLASS", "ALREADY_ENROLLED", "ALREADY_REQUESTED", "CLASS_NOT_FOUND", "GRADE_NOT_MATCHED"]) {
    assert.ok(rules.CLASS_ADD_MESSAGE[key], `${key} 문구`);
    assert.doesNotMatch(rules.CLASS_ADD_MESSAGE[key], /학원에 문의|학원으로 문의/, "막다른 문구 금지");
  }
});

test("① 승인 판정: 자리 있으면 등록(개시일 = 시작일, 지났으면 오늘) · 정원 차면 막고 대기 · 이미 다니면 닫기만", () => {
  const target = { name: "수 2교시", capacity: 10, activeCount: 9, deleted: false, seasonal: false };
  const today = "2026-11-14";
  assert.deepEqual(rules.planClassAddApproval({ target, existingStatus: null, effectiveFrom: "2026-12-01", today }), { action: "CREATE", startsOn: "2026-12-01" });
  assert.deepEqual(rules.planClassAddApproval({ target, existingStatus: "WITHDRAWN", effectiveFrom: "2026-12-01", today }), { action: "CREATE", startsOn: "2026-12-01" }, "그만둔 반은 되살린다");
  assert.deepEqual(rules.planClassAddApproval({ target, existingStatus: null, effectiveFrom: "2026-11-10", today }), { action: "CREATE", startsOn: today }, "늦게 승인하면 오늘부터(지난 수업이 열리지 않게)");
  assert.deepEqual(rules.planClassAddApproval({ target, existingStatus: null, effectiveFrom: today, today }), { action: "CREATE", startsOn: today });
  assert.deepEqual(rules.planClassAddApproval({ target, existingStatus: "ACTIVE", effectiveFrom: "2026-12-01", today }), { action: "ALREADY" });
  const full = rules.planClassAddApproval({ target: { ...target, activeCount: 10 }, existingStatus: null, effectiveFrom: "2026-12-01", today });
  assert.equal(full.action, "BLOCK");
  assert.match(full.message, /수 2교시 정원이 찼어요.*대기/);
  assert.equal(rules.planClassAddApproval({ target, existingStatus: "PAUSED", effectiveFrom: "2026-12-01", today }).action, "BLOCK");
  for (const bad of [null, { ...target, deleted: true }, { ...target, seasonal: true }]) {
    assert.equal(rules.planClassAddApproval({ target: bad, existingStatus: null, effectiveFrom: "2026-12-01", today }).action, "BLOCK");
  }
});

// ── ② 접수(실제 실행 — 가짜 DB) ─────────────────────────────────────────────────
function submitHarness(over = {}) {
  const state = {
    students: [{ id: "student-a", parent: "parent-a", name: "합성", grade: null, birthYmd: "2017-05-05" }],
    enrollments: [{ studentId: "student-a", classId: "c-12", status: "ACTIVE", className: "월 1교시" }],
    pending: [],
    classRows: CLASSES.map((c) => ({ classId: c.classId, className: c.className, gradesJson: JSON.stringify(c.grades), gradeRangeText: c.gradeRangeText, capacity: 10, enrolled: 3 })),
    inserts: [], notices: [], sql: [],
    ...over,
  };
  const db = {
    async $queryRawUnsafe(sql, ...values) {
      state.sql.push(sql);
      if (sql.includes('FROM "Student" s') && sql.includes("FOR UPDATE OF s")) {
        return state.students.filter((s) => s.id === values[0] && s.parent === values[1]);
      }
      if (sql.includes('FROM "Enrollment" e JOIN "Class" c')) {
        return state.enrollments.filter((e) => e.studentId === values[0]);
      }
      if (sql.includes('SELECT "toClassId" FROM "EnrollmentChangeRequest"')) {
        return state.pending.filter((p) => p.studentId === values[0]).map((p) => ({ toClassId: p.toClassId }));
      }
      if (sql.includes("count(*)::int AS n")) {
        assert.match(sql, /\("createdAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/, "timestamptz 는 변환 한 번");
        assert.match(sql, /"studentId" = \$1 AND kind = 'CLASS_ADD'/);
        assert.doesNotMatch(sql, /status/, "취소한 것도 센다");
        return [{ n: state.todayCount ?? state.inserts.length }];
      }
      if (sql.includes('ss."gradesJSON"')) return state.classRows;
      if (sql.includes('INSERT INTO "EnrollmentChangeRequest"')) {
        state.inserts.push(values);
        state.pending.push({ studentId: values[0], toClassId: values[1] });
        return [{ id: values[6] }];
      }
      throw new Error(`예상 밖 SQL: ${sql.slice(0, 60)}`);
    },
  };
  const prisma = { ...db, $transaction: async (fn) => fn(db) };
  const api = load("src/lib/enrollment/parent-class-add.ts", {
    "@/lib/account/child-access": { childAccessSql: async (alias, param) => `${alias}."parentId" = ${param}` },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
    "@/lib/datetime/kst": { ...kst, todayKst: () => "2026-11-14" },
    "@/lib/enrollment/changeRequestRules": changeRules,
    "@/lib/enrollment/classAddRules": rules,
    "@/lib/makeup/student-grade": studentGrade,
    "@/lib/operational-staff-notification": { notifyOperationalStaff: async (input) => { state.notices.push(input); } },
  });
  return { api, state };
}

test("② 접수: 내 아이·학년 맞는 반이면 «검토 중» 한 건 — 수강 등록에 묶지 않고(enrollmentId NULL) 추가할 반만", async () => {
  const { api, state } = submitHarness();
  const result = await api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01", reason: " 형과 같이 " });
  assert.equal(result.ok, true);
  assert.deepEqual({ kind: result.kind, effectiveFrom: result.effectiveFrom, toClassId: result.toClassId, toClassName: result.toClassName, waitlisted: result.waitlisted },
    { kind: "CLASS_ADD", effectiveFrom: "2026-12-01", toClassId: "c-34", toClassName: "수 2교시", waitlisted: false });
  assert.equal(state.inserts.length, 1);
  const [studentId, toClassId, from, reason, waitlisted, requestedBy, id] = state.inserts[0];
  assert.deepEqual([studentId, toClassId, from, reason, waitlisted, requestedBy], ["student-a", "c-34", "2026-12-01", "형과 같이", false, "parent-a"]);
  assert.equal(id, result.id);
  const insert = state.sql.find((s) => s.includes('INSERT INTO "EnrollmentChangeRequest"'));
  assert.match(insert, /VALUES \(\$1,NULL,NULL,\$2,'CLASS_ADD',\$3::date,NULL/, "떠나는 반이 없다 — enrollmentId·fromClassId 는 비운다");
  // 원장 알림은 앱 알림 경로 한 번(문자·알림톡 아님)
  assert.equal(state.notices.length, 1);
  assert.match(state.notices[0].message, /합성 학생 반 추가 신청 \(수 2교시, 2026-12-01부터\)/);
  assert.equal(state.notices[0].type, "ENROLLMENT_CHANGE");
});

test("② 권한: 남의 아이·없는 아이는 접수되지 않는다(SQL 로 재검증 + 학생 행 잠금)", async () => {
  const { api, state } = submitHarness();
  const other = await api.submitClassAddRequest("parent-b", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01" });
  assert.deepEqual(other, { ok: false, message: "본인 자녀만 반 추가를 신청할 수 있습니다." });
  assert.equal((await api.submitClassAddRequest("parent-a", { studentId: "", toClassId: "c-34" })).ok, false);
  assert.equal(state.inserts.length, 0);
  assert.equal(state.notices.length, 0);
  const src = read("src/lib/enrollment/parent-class-add.ts");
  const fn = src.slice(src.indexOf("export async function submitClassAddRequest"));
  assert.match(fn, /childAccessSql\("s", "\$2"\)/);
  assert.match(fn, /WHERE s\.id = \$1 AND \$\{access\} AND \$\{notMergedStudent\("s"\)\}\s+FOR UPDATE OF s/, "같은 학생의 동시 접수를 줄 세운다");
  assert.match(src, /getClassAddOptions[\s\S]*childAccessSql\("s", "\$1"\)/, "후보 조회도 내 아이만");
  assert.doesNotMatch(src, /sendSms|alimtalk|sendTrackedSms/i, "문자·알림톡 신규 금지");
});

test("② 중복·후보: 같은 반 두 번·이미 다니는 반·학년 밖 반·없는 반은 거절, 다른 반은 또 신청할 수 있다", async () => {
  const { api, state } = submitHarness();
  const send = (toClassId) => api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId, effectiveFrom: "2026-12-01" });
  assert.equal((await send("c-34")).ok, true);
  assert.match((await send("c-34")).message, /이미 추가 신청한 반/);
  assert.match((await send("c-12")).message, /이미 다니고 있는 반/);
  assert.match((await send("c-56")).message, /아이 학년에 맞는 반만/);
  assert.match((await send("c-none")).message, /선택한 반을 찾을 수 없습니다/);
  assert.equal(state.inserts.length, 1, "거절된 신청은 아무것도 쓰지 않는다");
});

test("② 정원이 찬 반은 대기로 접수(반 변경과 같은 규칙) · 휴원 중인 반만 있으면 거절 · 날짜 범위는 반 변경과 같다", async () => {
  const full = submitHarness();
  full.state.classRows.find((c) => c.classId === "c-34").enrolled = 10;
  const waited = await full.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01" });
  assert.equal(waited.ok, true);
  assert.equal(waited.waitlisted, true);
  assert.equal(full.state.inserts[0][4], true);
  assert.match(full.state.notices[0].message, /희망 반 정원이 찼습니다/);

  const paused = submitHarness({ enrollments: [{ studentId: "student-a", classId: "c-12", status: "PAUSED", className: "월 1교시" }] });
  assert.match((await paused.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01" })).message, /지금 다니는 반이 있어야/);

  const dates = submitHarness();
  const at = (effectiveFrom) => dates.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom });
  assert.match((await at("2026-11-14")).message, /내일 이후/, "오늘은 안 된다");
  assert.match((await at("2027-02-15")).message, /3개월 이내/);
  assert.match((await at("2026-02-30")).message, /시작일을 다시 확인/);
  assert.equal(dates.state.inserts.length, 0);
  const tomorrow = await at("2026-11-15");
  assert.equal(tomorrow.ok, true);
  // 날짜를 비우면 다음 달 1일(반 변경과 같다)
  const blank = submitHarness();
  assert.equal((await blank.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34" })).effectiveFrom, "2026-12-01");
});

test("② 상한(보안 검수 L1·L2): 아이당 «검토 중» 3건 · 하루 5건(취소 포함) — 넘으면 쓰지 않고 거절, 하루 상한은 code 와 전화 안내", async () => {
  assert.equal(rules.CLASS_ADD_MAX_PENDING, 3);
  assert.equal(rules.CLASS_ADD_DAILY_LIMIT, 5);
  const base = { toClassId: "c-34", reason: "", enrollments: [{ classId: "c-12", status: "ACTIVE" }], targetExists: true, candidateIds: ["c-34"] };
  assert.equal(rules.validateClassAdd({ ...base, pendingClassIds: ["a", "b"] }).ok, true, "2건까지는 더 낼 수 있다");
  assert.equal(rules.validateClassAdd({ ...base, pendingClassIds: ["a", "b", "c"] }).error, "TOO_MANY_PENDING");
  assert.match(rules.CLASS_ADD_MESSAGE.TOO_MANY_PENDING, /검토 중인 신청이 있어요/);
  assert.equal(rules.validateClassAdd({ ...base, pendingClassIds: [], todayCount: 4 }).ok, true);
  assert.equal(rules.validateClassAdd({ ...base, pendingClassIds: [], todayCount: 5 }).error, "DAILY_LIMIT");
  assert.equal(rules.CLASS_ADD_MESSAGE.DAILY_LIMIT, "오늘은 더 신청할 수 없어요. 학원에 전화해 주세요.");

  // 접수(실행): 검토 중 3건이면 네 번째는 거절
  const many = submitHarness({ pending: [{ studentId: "student-a", toClassId: "x1" }, { studentId: "student-a", toClassId: "x2" }, { studentId: "student-a", toClassId: "x3" }], todayCount: 3 });
  const fourth = await many.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01" });
  assert.equal(fourth.ok, false);
  assert.match(fourth.message, /검토 중인 신청이 있어요/);
  assert.equal(fourth.code, undefined);
  assert.equal(many.state.inserts.length, 0);

  // 접수(실행): 신청→취소를 되풀이해 오늘 5건을 채웠으면(검토 중은 0건이어도) 거절 + code
  const spam = submitHarness({ todayCount: 5 });
  const sixth = await spam.api.submitClassAddRequest("parent-a", { studentId: "student-a", toClassId: "c-34", effectiveFrom: "2026-12-01" });
  assert.deepEqual(sixth, { ok: false, message: "오늘은 더 신청할 수 없어요. 학원에 전화해 주세요.", code: "DAILY_LIMIT" });
  assert.equal(spam.state.inserts.length, 0);
  assert.equal(spam.state.notices.length, 0, "원장 알림도 가지 않는다");
  // 세는 곳은 학생 행 잠금 «뒤» — 동시에 눌러도 상한을 못 넘는다
  const src = read("src/lib/enrollment/parent-class-add.ts");
  assert.ok(src.indexOf("FOR UPDATE OF s") < src.indexOf("count(*)::int AS n"));
  // API 가 code 를 내려 주고, 화면은 그 답일 때만 전화 버튼(번호가 있을 때)을 보인다
  assert.match(read("src/app/api/mypage/enrollment-change/route.ts"), /"code" in result && result\.code \? \{ code: result\.code \} : \{\}/);
  const client = read("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx");
  assert.match(client, /setLimitHit\(data\?\.code === "DAILY_LIMIT"\)/);
  assert.match(client, /\{limitHit && academyTel && <a href=\{`tel:\$\{academyTel\}`\} className="academy-button-secondary">학원에 전화하기<\/a>\}/);
  assert.match(read("src/app/mypage/enrollment-change/page.tsx"), /academyTel=\{academyTel\(academyPhone\)\}/, "번호 판정은 규칙 한 곳(academyPhoneRules)");
});

test("⑤ 화면: 하루 상한 답을 받으면 안내 옆에 «학원에 전화하기»(번호가 있을 때만)", async () => {
  const h = screen();
  h.set({ kind: "CLASS_ADD", toClassId: "c-34" });
  globalThis.fetch = async () => ({ status: 400, ok: false, json: async () => ({ error: "오늘은 더 신청할 수 없어요. 학원에 전화해 주세요.", code: "DAILY_LIMIT" }) });
  findButton(h.render({ initial: initial(), classAdd: classAdd(), academyTel: "0311234567" }), "반 추가 신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(h.state.limitHit, true);
  const withTel = h.render({ initial: initial(), classAdd: classAdd(), academyTel: "0311234567" });
  assert.match(allText(withTel), /오늘은 더 신청할 수 없어요/);
  assert.ok(withTel.some((x) => x.el?.type === "a" && x.el.props.href === "tel:0311234567"), "전화 버튼");
  const noTel = h.render({ initial: initial(), classAdd: classAdd() });
  assert.ok(!noTel.some((x) => x.el?.type === "a" && String(x.el.props.href).startsWith("tel:")), "번호가 없으면 글자만");
  // 다른 거절(예: 이미 신청한 반)에는 전화 버튼이 없다
  globalThis.fetch = async () => ({ status: 400, ok: false, json: async () => ({ error: "이미 추가 신청한 반이에요." }) });
  h.set({ toClassId: "c-34" });
  findButton(h.render({ initial: initial(), classAdd: classAdd(), academyTel: "0311234567" }), "반 추가 신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(h.state.limitHit, false);
});

// ── ③ 승인(실제 실행 — 가짜 거래) ────────────────────────────────────────────────
function approveHarness(over = {}) {
  const state = {
    request: { studentId: "student-a", studentName: "합성", toClassId: "c-34", effectiveFrom: "2026-12-01" },
    target: { id: "c-34", name: "수 2교시", capacity: 10, activeCount: 9, deleted: false, seasonal: false },
    existing: null,
    writes: [], events: [], order: [], today: "2026-11-14",
    ...over,
  };
  const tx = {
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes('FROM "EnrollmentChangeRequest" r')) {
        assert.match(sql, /r\.kind = 'CLASS_ADD' AND r\.status = 'APPROVED' AND r\."appliedAt" IS NULL\s+FOR UPDATE OF r, s/);
        return state.request ? [state.request] : [];
      }
      if (sql.includes('FROM "Class" c JOIN "Program" p')) {
        assert.match(sql, /FOR UPDATE OF c/);
        assert.doesNotMatch(sql, /COUNT\(/i, "R3: 잠그는 문장에서 인원을 세지 않는다");
        state.order.push("lock");
        return state.target ? [state.target] : [];
      }
      if (sql.includes('COUNT(*)::int AS n FROM "Enrollment" e JOIN "Student" s')) {
        assert.match(sql, /e\.status = 'ACTIVE' AND s\."mergedIntoStudentId" IS NULL/, "병합된 학생은 세지 않는다");
        state.order.push("count");
        return [{ n: state.target.activeCount }];
      }
      if (sql.startsWith('SELECT id, status FROM "Enrollment"')) return state.existing ? [state.existing] : [];
      if (sql.includes('INSERT INTO "Enrollment"')) {
        state.writes.push({ kind: "enrollment", sql, values });
        return [{ id: state.existing?.id ?? "enrollment-new", updatedAt: new Date("2026-11-14T03:00:00Z") }];
      }
      throw new Error(`예상 밖 SQL: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...values) {
      state.writes.push({ kind: "request", sql, values });
      return 1;
    },
  };
  const hooks = load("src/lib/operations-events/admin-hooks.ts");
  const api = load("src/lib/enrollment/admin-class-add.ts", {
    "@/lib/datetime/kst": { ...kst, todayKst: () => state.today },
    "@/lib/enrollment/classAddRules": rules,
    "@/lib/operations-events/admin-hooks": hooks,
    "@/lib/operations-events": { enqueueWebsiteOperationsEventInTransaction: async (_tx, event) => { state.events.push(event); } },
    "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
  });
  return { api, state, tx };
}

test("③ 승인: 수강 등록(ACTIVE·개시일 = 시작일) + 운영 원장 «수강 등록» 한 건 + 신청 APPLIED — 기존 등록 경로와 같은 모양", async () => {
  const { api, state, tx } = approveHarness();
  const result = await api.applyApprovedClassAddInTx(tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.deepEqual(result, { ok: true, created: true, enrollmentId: "enrollment-new", startsOn: "2026-12-01", studentId: "student-a", classId: "c-34" });
  const enrollment = state.writes.find((w) => w.kind === "enrollment");
  assert.match(enrollment.sql, /VALUES \(gen_random_uuid\(\)::text, \$1, \$2, 'ACTIVE', \$3::date, NOW\(\), NOW\(\)\)/);
  assert.match(enrollment.sql, /ON CONFLICT \("studentId", "classId"\) DO UPDATE SET status = 'ACTIVE', "startsOn" = EXCLUDED\."startsOn"/);
  assert.deepEqual(enrollment.values, ["student-a", "c-34", "2026-12-01"]);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "CLASS_ADD", "관리자 수강 등록(enrollStudent)과 같은 운영 원장 종류");
  assert.equal(state.events[0].eventType, "ENROLLMENT_CREATED");
  assert.equal(state.events[0].effectiveDate, "2026-12-01");
  assert.equal(state.events[0].after.enrollmentChangeRequestId, "request-a", "수강 변경 화면이 이 값으로 원장을 찾는다");
  assert.equal(state.events[0].actorUserId, "admin-a");
  const marked = state.writes.find((w) => w.kind === "request");
  assert.match(marked.sql, /SET status = 'APPLIED', "appliedAt" = now\(\)[\s\S]*WHERE id = \$1 AND status = 'APPROVED' AND "appliedAt" IS NULL/);
  // 수강료·청구를 직접 건드리지 않는다 — 청구 준비가 개시일을 보고 계산한다(기존 등록과 같다)
  const src = read("src/lib/enrollment/admin-class-add.ts");
  assert.doesNotMatch(src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"), /"Payment"|Billing|Invoice/);
});

test("③ 정원이 찼거나 반이 없으면 아무것도 쓰지 않고 막는다(= 승인이 되돌려져 대기로 남는다)", async () => {
  const full = approveHarness({ target: { id: "c-34", name: "수 2교시", capacity: 10, activeCount: 10, deleted: false, seasonal: false } });
  const blocked = await full.api.applyApprovedClassAddInTx(full.tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /정원이 찼어요/);
  assert.equal(full.state.writes.length, 0);
  assert.equal(full.state.events.length, 0);

  const gone = approveHarness({ target: null });
  assert.equal((await gone.api.applyApprovedClassAddInTx(gone.tx, { requestId: "request-a", adminUserId: "admin-a" })).ok, false);
  assert.equal(gone.state.writes.length, 0);
  const missing = approveHarness({ request: null });
  assert.equal((await missing.api.applyApprovedClassAddInTx(missing.tx, { requestId: "request-a", adminUserId: "admin-a" })).ok, false);
});

test("③ 이미 그 반에 다니는 중이면 수강은 건드리지 않고 신청만 닫는다 · 그만둔 반은 되살린다(«수강 복귀» 원장)", async () => {
  const already = approveHarness({ existing: { id: "enrollment-old", status: "ACTIVE" } });
  const done = await already.api.applyApprovedClassAddInTx(already.tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.deepEqual({ ok: done.ok, created: done.created }, { ok: true, created: false });
  assert.deepEqual(already.state.writes.map((w) => w.kind), ["request"], "수강 행을 다시 쓰지 않는다(개시일 보존)");
  assert.equal(already.state.events.length, 0);

  const revived = approveHarness({ existing: { id: "enrollment-old", status: "WITHDRAWN" } });
  const back = await revived.api.applyApprovedClassAddInTx(revived.tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.equal(back.enrollmentId, "enrollment-old");
  assert.equal(revived.state.events[0].kind, "RESUME");
});

test("③ 리뷰 R3·R4·R5·R6: 잠금 뒤에 인원 세기 · 수강 행 칼럼은 관리자 수강 등록과 같은 집합 · 늦은 승인은 실제 개시일로 · 접수 정원도 병합 학생 제외", async () => {
  // R3: 반 행을 먼저 잠그고(다른 승인이 끝나길 기다린 뒤) 인원을 센다 — 한 문장이면 정원을 1명 넘길 수 있다
  const { api, state, tx } = approveHarness();
  await api.applyApprovedClassAddInTx(tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.deepEqual(state.order, ["lock", "count"]);
  // 제때 승인: 신청한 시작일 그대로 → 신청의 시작일 칸을 건드리지 않는다($2 = null → COALESCE 가 원래 값)
  assert.deepEqual(state.writes.find((w) => w.kind === "request").values, ["request-a", null]);

  // R5: 시작일(11/10)이 지난 뒤 승인(11/14) → 개시일·운영 원장·신청의 시작일 모두 오늘
  const late = approveHarness({ request: { studentId: "student-a", studentName: "합성", toClassId: "c-34", effectiveFrom: "2026-11-10" } });
  const done = await late.api.applyApprovedClassAddInTx(late.tx, { requestId: "request-a", adminUserId: "admin-a" });
  assert.equal(done.startsOn, "2026-11-14");
  assert.deepEqual(late.state.writes.find((w) => w.kind === "enrollment").values, ["student-a", "c-34", "2026-11-14"]);
  assert.equal(late.state.events[0].effectiveDate, "2026-11-14");
  const marked = late.state.writes.find((w) => w.kind === "request");
  assert.match(marked.sql, /"effectiveFrom" = COALESCE\(\$2::date, "effectiveFrom"\)/);
  assert.deepEqual(marked.values, ["request-a", "2026-11-14"], "학부모 알림·신청 내역이 읽는 날짜도 실제 개시일");
  // 알림은 신청 행의 시작일을 읽는다 → 위 UPDATE 뒤라 «11/14부터»로 나간다
  assert.match(read("src/lib/enrollment/change-decision-notify.ts"), /to_char\(r\."effectiveFrom",'YYYY-MM-DD'\) AS "effectiveFrom"/);
  assert.match(read("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx"), /개시일 \{row\.effectiveDateReached \? "오늘" : row\.effectiveFrom\}/);

  // R4: 수강 행 INSERT 의 칼럼 집합이 관리자 수강 등록(enrollStudent)과 같다 — 한쪽에만 칸이 늘면 여기서 걸린다
  const columnsOf = (source, from) => {
    const at = source.indexOf('INSERT INTO "Enrollment" (', from);
    assert.ok(at >= 0, "수강 행 INSERT 를 찾지 못했다");
    return source.slice(at + 'INSERT INTO "Enrollment" ('.length, source.indexOf(")", at)).split(",").map((c) => c.trim().replaceAll('"', "")).sort();
  };
  const adminActions = read("src/app/actions/admin.ts");
  const enrollColumns = columnsOf(adminActions, adminActions.indexOf("export async function enrollStudent("));
  const addColumns = columnsOf(read("src/lib/enrollment/admin-class-add.ts"), 0);
  assert.deepEqual(addColumns, enrollColumns);
  assert.deepEqual(addColumns, ["classId", "createdAt", "id", "startsOn", "status", "studentId", "updatedAt"]);
  // 반 이동(같은 모양의 또 다른 등록 경로)도 같은 집합
  assert.deepEqual(columnsOf(read("src/app/actions/enrollment-admin-edit.ts"), 0), enrollColumns);

  // R6: 접수 때 정원 셈도 병합된 학생 제외(승인과 같은 기준)
  const parentSrc = read("src/lib/enrollment/parent-class-add.ts");
  assert.match(parentSrc, /FROM "Enrollment" x JOIN "Student" xs ON xs\.id = x\."studentId"\s+WHERE x\."classId" = c\.id AND x\.status = 'ACTIVE' AND \$\{notMergedStudent\("xs"\)\}\) AS enrolled/);
});

test("③ 승인 함수 연결: 승인과 같은 트랜잭션·막히면 승인까지 되돌림·적용 건수에 포함(캐시 비움)", () => {
  const admin = read("src/lib/enrollment/admin-change-request.ts");
  const decide = admin.slice(admin.indexOf("export async function decideEnrollmentChangeRequest"), admin.indexOf("async function notifyOwnerOfDeferredMoneyWork"));
  assert.match(decide, /if \(decided\[0\] && input\.approve && decided\[0\]\.kind === CLASS_ADD_KIND\) \{[\s\S]{0,260}applyApprovedClassAddInTx\(tx, \{ requestId: input\.requestId, adminUserId: input\.adminUserId \}\)/);
  assert.match(decide, /if \(!added\.ok\) throw new SettlementRejected\(added\.message\)/, "던져야 승인 UPDATE 까지 되돌려진다");
  assert.match(decide, /appliedNow: holder\.classAdded \|\|/);
  assert.match(decide, /appliedCount: \(summary\?\.applied \?\? 0\) \+ \(holder\.classAdded \? 1 : 0\)/);
  // 거절은 반 추가 등록을 타지 않는다(approve 일 때만)
  assert.doesNotMatch(decide, /decided\[0\]\.kind === CLASS_ADD_KIND\) \{[\s\S]{0,40}REJECTED/);
  // 원장 권한은 서버 액션(requireAdmin) 그대로 — 새 액션을 만들지 않았다
  assert.match(read("src/app/actions/enrollment-changes.ts"), /export async function decideEnrollmentChange\([\s\S]{0,900}await requireAdmin\(\)/);
  assert.match(admin, /row\.kind === "RESUME" \? "복귀" : REQUEST_KIND_LABEL\[row\.kind\] \?\? row\.kind/);
});

test("④ 기존 흐름 불변: 적용일 크론은 승인·미적용만 집고, 혹시 남은 반 추가는 손대지 않고 보류로 남긴다", () => {
  const plan = duePlan.planDueEnrollmentChange({
    kind: "CLASS_ADD", studentId: "s", fromClassId: null, enrollment: null, parentConfirmed: true,
  });
  assert.equal(plan.action, "HOLD");
  // 휴원·퇴원·복귀 자동 적용 판정은 그대로
  const enrollment = { studentId: "s", classId: "c", status: "ACTIVE" };
  assert.deepEqual(duePlan.planDueEnrollmentChange({ kind: "PAUSE", studentId: "s", fromClassId: "c", enrollment, parentConfirmed: true }),
    { action: "APPLY", expectedStatus: "ACTIVE", nextStatus: "PAUSED" });
  assert.equal(duePlan.planDueEnrollmentChange({ kind: "CLASS_CHANGE", studentId: "s", fromClassId: "c", enrollment, parentConfirmed: true }).action, "HOLD");
  // 접수 길: API 가 종류로 가른다 — 반 추가만 새 함수, 나머지는 예전 함수 그대로
  const route = read("src/app/api/mypage/enrollment-change/route.ts");
  assert.match(route, /body\?\.kind === CLASS_ADD_KIND\s+\? await submitClassAddRequest\(parent\.appUserId, body \?\? \{\}\)\s+: await submitEnrollmentChangeRequest\(parent\.appUserId, body \?\? \{\}\)/);
  assert.match(route, /requireVerifiedParent\(\)/);
  const parentLib = read("src/lib/enrollment/parent-change-request.ts");
  assert.doesNotMatch(parentLib, /CLASS_ADD/, "기존 접수·조회 모듈은 반 추가를 모른다(건드리지 않았다)");
  // 검토 중 한 건 제약(수강 등록당)과 무관 — 반 추가는 enrollmentId 가 비어 있어 휴원·반 변경 신청을 막지 않는다
  assert.match(parentLib, /WHERE "enrollmentId" = \$1 AND status = 'PENDING'/);
});

test("④ 표시: 신청함·학부모 신청 내역·결정 알림이 «추가할 반» 이름으로 부른다", () => {
  const inbox = read("src/lib/requests/admin-inbox.ts");
  assert.match(inbox, /const CHANGE_KIND[^\n]*CLASS_ADD: "반 추가"/);
  assert.match(inbox, /text\(e\.changeKind\) === "CLASS_ADD"\s+\? text\(e\.toClass\)/);
  assert.match(read("src/lib/requests/parent-timeline.ts"), /r\.kind === "CLASS_ADD"\s+\? \(r\.toClassName \?\? ""\)/);
  assert.match(read("src/lib/enrollment/change-decision-notify.ts"), /COALESCE\(fc\.name, CASE WHEN r\.kind = 'CLASS_ADD' THEN tc\.name END\) AS "className"/);
  const adminClient = read("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx");
  assert.match(adminClient, /row\.kind === "CLASS_ADD"\s+\? `\$\{row\.toClassName \?\? "반 확인 필요"\} 추가`/);
  assert.match(adminClient, /승인하면 바로 수강이 등록돼요/);
});

// ── ⑤ 화면(컴포넌트 함수를 직접 불러 요소 트리를 본다) ─────────────────────────────
const realReact = nodeRequire("react");
const STATE_NAMES = ["childIdx", "kind", "toClassId", "effectiveFrom", "resumeOn", "reason", "error", "done", "uncertainSource", "submittedFor", "localPending", "canceledId", "resumeFrom", "pauseFrom", "additionalPauseIds", "cancelRequested", "addState", "limitHit"];
function screen() {
  const state = {};
  let calls = 0;
  const transitions = [];
  const fakeReact = {
    ...realReact,
    useState(initial) {
      const name = STATE_NAMES[calls++];
      if (!(name in state)) state[name] = initial;
      return [state[name], (value) => { state[name] = typeof value === "function" ? value(state[name]) : value; }];
    },
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useTransition: () => [false, (fn) => { transitions.push(fn()); }],
  };
  const Client = load("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx", {
    react: fakeReact,
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/enrollment/changeRequestRules": load("src/lib/enrollment/changeRequestRules.ts"),
    "@/lib/enrollment/parentChangeStatus": load("src/lib/enrollment/parentChangeStatus.ts"),
    "@/lib/seats/seatLevel": seatLevelModule,
    "@/components/parent/InlineConfirm": { __esModule: true, default: function InlineConfirm() { return null; } },
    "@/lib/mypage/requestPreset": { presetIndex: () => 0 },
    "@/components/parent/customerMessage": { customerMessage: (raw, fallback) => (typeof raw === "string" && raw) || fallback },
  }).default;
  const render = (props) => {
    calls = 0;
    const tree = Client(props);
    assert.equal(calls, STATE_NAMES.length, "useState 개수가 바뀌었다 — STATE_NAMES 순서를 맞출 것");
    return flatten(tree);
  };
  return { render, state, transitions, set: (patch) => Object.assign(state, patch) };
}
function flatten(node, out = []) {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const item of node) flatten(item, out); return out; }
  if (typeof node !== "object") { out.push({ text: String(node) }); return out; }
  out.push({ el: node });
  flatten(node.props?.children, out);
  return out;
}
const textOf = (node) => flatten(node).filter((x) => x.text).map((x) => x.text).join("");
const allText = (list) => list.filter((x) => x.text).map((x) => x.text).join("");
const buttons = (list) => list.filter((x) => x.el?.type === "button").map((x) => x.el);
const findButton = (list, label) => buttons(list).find((b) => textOf(b.props.children).includes(label));

const cls = (classId, dayOfWeek, full = false) => ({ classId, className: classId, programName: "합성", dayOfWeek, startTime: "16:00", endTime: "17:00", seatLevel: full ? "FULL" : "OPEN", full });
const initial = () => ({
  effectiveFrom: "2026-12-01", minEffectiveFrom: "2026-11-15", maxEffectiveFrom: "2027-02-14", minResumeFrom: "2026-11-14", maxResumeFrom: "2027-02-14",
  classes: [cls("c-12", "Mon"), cls("c-34", "Wed"), cls("c-56", "Fri", true)], history: [],
  children: [{ studentId: "student-a", studentName: "합성", enrollmentId: "enrollment-a", currentClassId: "c-12", currentClassName: "월 1교시", currentProgramName: "합성", enrollmentStatus: "ACTIVE", scheduled: null, pending: null }],
});
const classAdd = (over = {}) => ({ byStudent: { "student-a": { classIds: ["c-34", "c-56"], gradeKnown: true } }, pending: [], ...over });

test("⑤ 화면: 종류 칩에 «반 추가»(자료가 있을 때만) — 없으면 예전 세 칩 그대로", () => {
  const withAdd = screen().render({ initial: initial(), classAdd: classAdd() });
  assert.deepEqual(buttons(withAdd).filter((b) => "aria-pressed" in b.props).map((b) => textOf(b.props.children)), ["반·요일 변경", "반 추가", "휴원", "퇴원"]);
  for (const props of [{ initial: initial() }, { initial: initial(), classAdd: { byStudent: {}, pending: [] } }]) {
    const without = screen().render(props);
    assert.deepEqual(buttons(without).filter((b) => "aria-pressed" in b.props).map((b) => textOf(b.props.children)), ["반·요일 변경", "휴원", "퇴원"]);
  }
  // 이름 규칙·굵기: 800·900 금지, 색은 토큰만
  const src = read("src/app/mypage/enrollment-change/EnrollmentChangeClient.tsx");
  assert.doesNotMatch(src, /font-extrabold|font-black|#[0-9a-fA-F]{6}\b/);
});

test("⑤ 화면: 반 추가를 고르면 학년 맞는 반만 보이고, 고른 반·시작일을 보낸다 → «검토 중» 줄이 생기고 그 반은 후보에서 빠진다", async () => {
  const h = screen();
  h.set({ kind: "CLASS_ADD" });
  const list = h.render({ initial: initial(), classAdd: classAdd() });
  const select = list.find((x) => x.el?.props?.id === "add-class").el;
  const options = flatten(select.props.children).filter((x) => x.el?.type === "option").map((x) => x.el.props.value);
  assert.deepEqual(options, ["", "c-34", "c-56"], "지금 다니는 반(c-12)은 없다");
  assert.match(allText(list), /정원 마감 · 대기/, "정원이 찬 반도 고를 수 있다(대기)");
  assert.equal(findButton(list, "반 추가 신청하기").props.disabled, true, "반을 고르기 전엔 못 누른다");
  assert.match(allText(list), /수강료가 달라지면 학원에서 다시 안내드려요/);

  h.set({ toClassId: "c-34", effectiveFrom: "2026-12-08", reason: "형과 같이" });
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/mypage/enrollment-change");
    bodies.push(JSON.parse(init.body));
    return { status: 200, ok: true, json: async () => ({ ok: true, id: "request-add", kind: "CLASS_ADD", effectiveFrom: "2026-12-08", toClassId: "c-34", toClassName: "수 2교시", waitlisted: false }) };
  };
  findButton(h.render({ initial: initial(), classAdd: classAdd() }), "반 추가 신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.deepEqual(bodies, [{ studentId: "student-a", kind: "CLASS_ADD", toClassId: "c-34", effectiveFrom: "2026-12-08", reason: "형과 같이" }]);

  // 서버 자료가 아직 옛것이어도: 검토 중 줄이 보이고, 방금 신청한 반은 후보에서 빠진다(중복 신청 차단)
  const after = h.render({ initial: initial(), classAdd: classAdd() });
  assert.match(allText(after), /반 추가 · 수 2교시 · 12\/8부터/);
  assert.match(allText(after), /검토 중/);
  const optionsAfter = flatten(after.find((x) => x.el?.props?.id === "add-class").el.props.children).filter((x) => x.el?.type === "option").map((x) => x.el.props.value);
  assert.deepEqual(optionsAfter, ["", "c-56"]);
  assert.equal(h.state.toClassId, "");
});

test("⑤ 화면: 검토 중인 반 추가는 그 자리에서 취소(같은 cancel 액션) · 범위 밖 날짜는 보내기 전에 막는다 · 후보가 없으면 버튼 대신 한 줄", async () => {
  const pending = [{ id: "request-add", studentId: "student-a", toClassId: "c-34", toClassName: "수 2교시", effectiveFrom: "2026-12-01", waitlisted: true }];
  const h = screen();
  const list = h.render({ initial: initial(), classAdd: classAdd({ pending }) });
  assert.match(allText(list), /반 추가 · 수 2교시 · 12\/1부터/);
  assert.match(allText(list), /자리가 나면 배정/);
  const cancel = list.find((x) => x.el?.props?.label === "신청 취소" && typeof x.el.props.onConfirm === "function").el;
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
  cancel.props.onConfirm();
  await Promise.all(h.transitions);
  assert.deepEqual(bodies, [{ action: "cancel", id: "request-add" }]);
  assert.doesNotMatch(allText(h.render({ initial: initial(), classAdd: classAdd({ pending }) })), /반 추가 · 수 2교시/, "늦게 온 서버 내역에도 취소한 줄은 다시 안 보인다");

  // 아이폰은 날짜 min·max 를 무시한다 → 보내기 전에 알려 준다
  const d = screen();
  d.set({ kind: "CLASS_ADD", toClassId: "c-34", effectiveFrom: "2026-11-14" });
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { status: 200, ok: true, json: async () => ({ ok: true }) }; };
  findButton(d.render({ initial: initial(), classAdd: classAdd() }), "반 추가 신청하기").props.onClick();
  await Promise.all(d.transitions);
  assert.equal(fetched, 0);
  assert.match(d.state.error, /시작일은 2026-11-15부터 2027-02-14 사이/);

  // 후보 0건: 제출 버튼 없이 한 줄 + 그 자리에서 갈 곳(아이 학년 확인) — «학원에 문의»로 끝나지 않는다
  const e = screen();
  e.set({ kind: "CLASS_ADD" });
  const empty = e.render({ initial: initial(), classAdd: classAdd({ byStudent: { "student-a": { classIds: [], gradeKnown: true } } }) });
  assert.equal(findButton(empty, "반 추가 신청하기"), undefined);
  assert.match(allText(empty), /아이 학년에 맞는 다른 반이 없어요/);
  assert.match(allText(empty), /아이 학년 확인/);
});

test("⑤ 화면: 반 추가를 고른 채 반 추가를 못 하는 아이로 바꾸면 기본 종류(반 변경)로 보이고, 그 신청은 예전 길로 간다", async () => {
  const data = initial();
  data.children.push({ ...data.children[0], studentId: "student-b", studentName: "둘째", enrollmentId: "enrollment-b", currentClassId: "c-34" });
  const h = screen();
  h.set({ kind: "CLASS_ADD", childIdx: 1, toClassId: "c-12" });
  const list = h.render({ initial: data, classAdd: classAdd() });
  assert.deepEqual(buttons(list).filter((b) => "aria-pressed" in b.props).map((b) => [textOf(b.props.children), b.props["aria-pressed"]]),
    [["반·요일 변경", true], ["휴원", false], ["퇴원", false]]);
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, ok: true, json: async () => ({ ok: true, id: "r", kind: "CLASS_CHANGE", effectiveFrom: "2026-12-01" }) }; };
  findButton(list, "신청하기").props.onClick();
  await Promise.all(h.transitions);
  assert.equal(bodies.length, 1);
  assert.deepEqual({ enrollmentId: bodies[0].enrollmentId, kind: bodies[0].kind, toClassId: bodies[0].toClassId }, { enrollmentId: "enrollment-b", kind: "CLASS_CHANGE", toClassId: "c-12" });
});
