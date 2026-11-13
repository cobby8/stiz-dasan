import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import ts from "typescript";

// 2026-11-14 결석 당일 취소·보강 연결 (원장 점검표)
//   「결석 신고 후 취소나 변경 기능이 없어서 불편하다. 보강 기능이 연결이 제대로 안 됐어.
//     지금 수강하는 반과 학년대가 비슷한 반 중 선택해서 보강할 수 있어야 하는데 연결이 아예 안 돼.」
//
// 이 파일이 못박는 것
//   ① 마감 판정(수업 시작 1시간 전) — 경계·자정·시작 시각 없음·전날·다음 날
//   ② 서버가 마감을 강제한다 — 신고·사유 변경·취소를 가짜 DB 로 «실제 실행»(시계를 고정해서)
//   ③ 사유를 바꿔도 보강권은 다시 생기지 않는다
//   ④ 학년 숫자화·±1 후보·날짜별 정원·예약 트랜잭션 안 정원 재확인
// prisma·알림만 가짜다. 규칙·SQL 문구는 진짜 파일을 그대로 올려 쓴다.

const read = (file) => readFileSync(file, "utf8");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const OVERRIDES = {
  "@/lib/prisma": toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__linkDb[key] });`),
  // 결석 알림(원장·코치·기사) — 누구에게 몇 번 가는지 세기만 한다
  "@/lib/operational-staff-notification": toDataUrl(`export async function notifyOperationalStaff(input) { globalThis.__linkDb.notices.push(input); return { ok: true }; }`),
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
const rules = await import(load("src/lib/regular/regularAbsenceRules.ts"));
const creditRules = await import(load("src/lib/makeup/credit-rules.ts"));
const absence = await import(load("src/lib/regular/parent-regular-absence.ts"));
const makeup = await import(load("src/lib/makeup/parent-makeup.ts"));
// 2026-11-14 복귀 예정: 학부모가 쓸 수 있는 수강 = ACTIVE 또는 복귀 승인된 휴원 반(공용 규칙)
const resumeWindow = await import(load("src/lib/enrollment/resumeWindow.ts"));
const USABLE_SQL = resumeWindow.parentUsableEnrollmentSql("e");
const usable = (e) => e.status === "ACTIVE" || (e.status === "PAUSED" && Boolean(e.resumeFrom));

/** KST 날짜·시각 → 절대 시각(ms). 테스트 시계 고정용 */
const at = (ymd, hm = "00:00") => new Date(`${ymd}T${hm}:00+09:00`).getTime();
/** 시계를 KST 그 시각으로 고정한다(Date.now · new Date() 모두) */
function freeze(ymd, hm) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: at(ymd, hm) });
}
test.afterEach(() => mock.timers.reset());

// ═════════════════════════════════════════════════════════════════════════
// ① 마감 판정 — 순수 함수
// ═════════════════════════════════════════════════════════════════════════
const open = rules.isAbsenceChangeOpen;

test("마감: 수업 시작 1시간 전까지 — 정확히 60분 전은 가능, 59분 전부터 마감", () => {
  assert.equal(rules.ABSENCE_CHANGE_CUTOFF_MINUTES, 60);
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "16:59"), true);
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "17:00"), true, "정확히 1시간 전 = 아직 가능");
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "17:01"), false);
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "18:00"), false, "수업이 시작됐다");
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "23:59"), false, "수업이 끝난 뒤");
  // 오전 수업 — 당일 0시에도 아직 열려 있다
  assert.equal(open("2026-11-16", "09:40", "2026-11-16", "00:00"), true);
  assert.equal(open("2026-11-16", "09:40", "2026-11-16", "08:40"), true);
  assert.equal(open("2026-11-16", "09:40", "2026-11-16", "08:41"), false);
});

test("마감: 전날·다음 날·자정 경계·월말·연말", () => {
  // 전날 밤 23:59 → 다음 날 수업은 열려 있다
  assert.equal(open("2026-11-16", "18:00", "2026-11-15", "23:59"), true);
  // 자정을 막 넘긴 00:00 — 같은 날 저녁 수업은 열려 있다
  assert.equal(open("2026-11-16", "18:00", "2026-11-16", "00:00"), true);
  // 지난 날짜는 항상 마감(하루 지남)
  assert.equal(open("2026-11-16", "18:00", "2026-11-17", "00:00"), false);
  assert.equal(open("2026-11-16", "18:00", "2026-11-17", "09:00"), false);
  // 자정 직후 수업(00:30)은 «전날 23:30»이 마감 — 날짜가 달라도 분으로 이어서 센다
  assert.equal(open("2026-11-16", "00:30", "2026-11-15", "23:30"), true);
  assert.equal(open("2026-11-16", "00:30", "2026-11-15", "23:31"), false);
  assert.equal(open("2026-11-16", "00:30", "2026-11-16", "00:00"), false);
  // 월말·연말·윤년을 넘는 날짜 차이
  assert.equal(open("2026-12-01", "00:30", "2026-11-30", "23:30"), true);
  assert.equal(open("2027-01-01", "00:30", "2026-12-31", "23:31"), false);
  assert.equal(open("2027-01-01", "10:00", "2026-12-31", "23:59"), true);
  assert.equal(open("2028-03-01", "00:30", "2028-02-29", "23:30"), true, "윤년 2/29 다음 날은 3/1");
  assert.equal(open("2028-03-01", "00:30", "2028-02-28", "23:59"), true, "이틀 전");
  // 몇 주 뒤 수업
  assert.equal(open("2026-12-07", "18:00", "2026-11-16", "23:59"), true);
});

test("마감: 시작 시각을 모르는 수업은 당일 0시가 마감(= 전날까지만)", () => {
  for (const unknown of [null, undefined, "", "미정", "25:00", "18시"]) {
    assert.equal(open("2026-11-16", unknown, "2026-11-15", "23:59"), true, `전날은 가능 (${unknown})`);
    assert.equal(open("2026-11-16", unknown, "2026-11-16", "00:00"), false, `당일 0시부터 마감 (${unknown})`);
    assert.equal(open("2026-11-16", unknown, "2026-11-16", "12:00"), false);
  }
});

test("마감: 입력이 잘못되면 안전한 쪽(마감)", () => {
  assert.equal(open("bad", "18:00", "2026-11-16", "10:00"), false);
  assert.equal(open("2026-11-16", "18:00", "bad", "10:00"), false);
  assert.equal(open("2026-11-17", "18:00", "2026-11-16", ""), false, "지금 시각을 모르면 열지 않는다");
  assert.equal(rules.hmToMinutes("9:05"), 545);
  assert.equal(rules.hmToMinutes("18:00:00"), 1080);
  assert.equal(rules.hmToMinutes("24:00"), null);
});

test("서버 검증 isReportableAt: 요일이 맞고 마감 전이어야 한다 — 오늘 수업도 1시간 전까지", () => {
  // 2026-11-16 = 월요일
  assert.equal(rules.isReportableAt("2026-11-16", "Mon", "18:00", "2026-11-16", "17:00"), true, "오늘 수업 신고 가능");
  assert.equal(rules.isReportableAt("2026-11-16", "Mon", "18:00", "2026-11-16", "17:01"), false);
  assert.equal(rules.isReportableAt("2026-11-16", "Tue", "18:00", "2026-11-15", "10:00"), false, "그 반 요일이 아니다");
  assert.equal(rules.isReportableAt("2026-11-09", "Mon", "18:00", "2026-11-16", "10:00"), false, "지난 날짜");
  assert.equal(rules.isReportableAt("2026-11-23", "Mon", "18:00", "2026-11-16", "23:59"), true);
});

test("수업일 목록: includeToday 면 오늘 수업이 맨 앞에 한 줄 더(앞날 N주는 그대로)", () => {
  // 오늘 = 월(2026-11-16), 월요일 반
  assert.deepEqual(rules.computeUpcomingDates("2026-11-16", "Mon", 3, true), ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"]);
  // 기본값(false)은 예전 그대로 — 오늘 제외
  assert.deepEqual(rules.computeUpcomingDates("2026-11-16", "Mon", 3), ["2026-11-23", "2026-11-30", "2026-12-07"]);
  // 오늘이 그 요일이 아니면 차이 없음
  assert.deepEqual(rules.computeUpcomingDates("2026-11-16", "Tue", 2, true), ["2026-11-17", "2026-11-24"]);
  // 연말을 넘는 목록
  assert.deepEqual(rules.computeUpcomingDates("2026-12-28", "Mon", 2, true), ["2026-12-28", "2027-01-04", "2027-01-11"]);
  assert.deepEqual(rules.computeUpcomingDates("2026-11-16", "Mon", 0, true), []);
});

// ═════════════════════════════════════════════════════════════════════════
// ④ 학년 숫자화 · ±1 후보 · 날짜별 정원 — 순수 함수
// ═════════════════════════════════════════════════════════════════════════
test("학년 숫자화: 7세=0 · 초1~초6=1~6 · 중1~중3=7~9 · 고1~고3=10~12", () => {
  const n = creditRules.gradeToNumber;
  assert.deepEqual(["7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3"].map(n), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(n("6세"), -1);
});

test("학년 숫자화: 손입력 표기도 읽는다 — 운영 데이터에 있는 «4학년»·«초등5학년» 등", () => {
  const n = creditRules.gradeToNumber;
  assert.equal(n("4학년"), 4);
  assert.equal(n("5학년"), 5);
  assert.equal(n("초등5학년"), 5);
  assert.equal(n("초등 5학년"), 5);
  assert.equal(n("2026년 초등 5학년"), 5, "연도 숫자를 학년으로 읽지 않는다");
  assert.equal(n(" 초5 "), 5);
  assert.equal(n("초등학교 3학년"), 3);
  assert.equal(n("중학교 2학년"), 8);
  assert.equal(n("중등1"), 7);
  assert.equal(n("고등학교 1학년"), 10);
});

test("학년 숫자화: 성인·빈 값·모르는 값은 null(임의로 짐작하지 않는다)", () => {
  const n = creditRules.gradeToNumber;
  for (const unknown of [null, undefined, "", "  ", "성인", "대학생", "초7", "중4", "고4", "0학년", "7학년", "예비초1", "초등저", "5", "8세"]) {
    assert.equal(n(unknown), null, `${unknown}`);
  }
});

test("반의 대상 학년 범위: 학년 구성 목록 먼저, 비어 있으면 대상 학년 글자", () => {
  const span = creditRules.classGradeSpan;
  assert.deepEqual(span(["초4", "초5", "초6", "중1"]), { min: 4, max: 7 });
  assert.deepEqual(span(["7세", "초1", "초2"]), { min: 0, max: 2 });
  assert.deepEqual(span([], "초4~초6"), { min: 4, max: 6 });
  assert.deepEqual(span([], "초4~중1"), { min: 4, max: 7 }, "시간표 표기(formatGradeRange) 형식");
  assert.deepEqual(span([], "초4~6"), { min: 4, max: 6 }, "뒤쪽 단계 생략은 앞 단계를 이어받는다");
  assert.deepEqual(span([], "7세, 초1·초2"), { min: 0, max: 2 });
  assert.deepEqual(span([], "2026년 초등 5학년"), { min: 5, max: 5 });
  // 목록이 있으면 글자는 보지 않는다
  assert.deepEqual(span(["초1"], "중1~중3"), { min: 1, max: 1 });
  // 읽을 수 없으면 null — 자유 문장은 절대 짐작하지 않는다
  assert.equal(span([], "초등저~고 (일부 중학생 가능)"), null);
  assert.equal(span([], null), null);
  assert.equal(span(["성인"], ""), null);
});

test("±1 후보 판정: 학생 학년이 반의 대상 학년 범위에서 위아래 1학년 안", () => {
  const near = creditRules.isGradeNear;
  const span = { min: 4, max: 6 }; // 초4~초6
  assert.equal(creditRules.MAKEUP_GRADE_TOLERANCE, 1);
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8].map((g) => near(g, span)), [false, true, true, true, true, true, false]);
  assert.equal(near(null, span), false, "학생 학년을 모르면 후보가 아니다");
  assert.equal(near(5, null), false, "반의 학년 정보가 없으면 후보가 아니다");
});

const GRADE_CLASSES = [
  { classId: "low", grades: ["초1", "초2", "초3"] },
  { classId: "mid", grades: ["초4", "초5", "초6"] },
  { classId: "bridge", grades: ["초6", "중1"] },
  { classId: "middle", grades: ["중1", "중2"] },
  { classId: "customText", grades: [], gradeRangeText: "초4~초6" },
  { classId: "noInfo", grades: [], gradeRangeText: null },
  { classId: "freeText", grades: [], gradeRangeText: "초등저~고 (일부 중학생 가능)" },
];

test("후보 고르기: 초5 → 범위 ±1 인 반만, 학년 정보 없는 반·이미 다니는 반·원래 반은 뺀다", () => {
  const ids = (grade, opts) => creditRules.matchClassesByGrade(GRADE_CLASSES, grade, opts).map((c) => c.classId);
  // 초5(5): 초1~3(범위 끝 3 → 4까지)은 아니다 · 초6~중1(6~7 → 5부터)은 된다 · 중1~2(7~8 → 6부터)은 아니다
  assert.deepEqual(ids("초5"), ["mid", "bridge", "customText"]);
  assert.deepEqual(ids("초등 5학년"), ["mid", "bridge", "customText"], "표기가 달라도 같은 결과");
  assert.deepEqual(ids("초4"), ["low", "mid", "customText"]);
  assert.deepEqual(ids("초6"), ["mid", "bridge", "middle", "customText"]);
  assert.deepEqual(ids("초5", { excludeClassId: "mid" }), ["bridge", "customText"]);
  assert.deepEqual(ids("초5", { excludeClassId: "mid", excludeClassIds: ["bridge"] }), ["customText"]);
  // 학생 학년을 모르면 0건
  assert.deepEqual(ids(null), []);
  assert.deepEqual(ids("성인"), []);
});

test("날짜별 정원 집계: 그 날짜의 보강 예약만 센다(정원 +2 기준은 그대로)", () => {
  const c = { capacity: 10, enrolled: 9 }; // 10 + 2 − 9 = 3자리
  const rows = creditRules.remainingSeatsByDate(c, ["2026-11-17", "2026-11-24", "2026-12-01"], { "2026-11-17": 3, "2026-11-24": 1 });
  assert.deepEqual(rows, [
    { ymd: "2026-11-17", remaining: 0 },
    { ymd: "2026-11-24", remaining: 2 },
    { ymd: "2026-12-01", remaining: 3 },
  ]);
  // Map 으로 줘도 같다
  assert.deepEqual(creditRules.remainingSeatsByDate(c, ["2026-11-17"], new Map([["2026-11-17", 4]])), [{ ymd: "2026-11-17", remaining: -1 }]);
  assert.equal(creditRules.MAKEUP_OVER_CAPACITY, 2, "학부모 예약 정원 기준(정원 +2)은 바꾸지 않았다");
});

// ═════════════════════════════════════════════════════════════════════════
// 가짜 DB — SQL 문구를 읽어 그대로 흉내 낸다
// ═════════════════════════════════════════════════════════════════════════
function makeDb(overrides = {}) {
  const db = {
    students: [
      { id: "s1", parentId: "p1", name: "지유", grade: "초5" },
      { id: "s9", parentId: "p9", name: "남의집", grade: "초5" },
    ],
    classes: [
      // 결석 시나리오: 월요일 18:00 반(원래 반)
      { id: "cO", name: "원래반", dayOfWeek: "Mon", startTime: "18:00", endTime: "19:30", capacity: 10, enrolled: 5, grades: ["초5"] },
      // 보강 후보들
      { id: "cA", name: "화요반", dayOfWeek: "Tue", startTime: "17:00", endTime: "18:30", capacity: 10, enrolled: 5, grades: ["초4", "초5", "초6"] },
      { id: "cB", name: "중등반", dayOfWeek: "Wed", startTime: "20:00", endTime: "21:30", capacity: 10, enrolled: 0, grades: ["중1", "중2"] },
      { id: "cC", name: "초6중1반", dayOfWeek: "Wed", startTime: "18:00", endTime: "19:30", capacity: 10, enrolled: 9, grades: ["초6", "중1"] },
      { id: "cD", name: "직접만든반", dayOfWeek: "Thu", startTime: "17:00", endTime: "18:30", capacity: 10, enrolled: 2, grades: null, gradeRangeText: "초4~초6" },
      { id: "cN", name: "학년모름반", dayOfWeek: "Thu", startTime: "19:00", endTime: "20:30", capacity: 10, enrolled: 0, grades: null, gradeRangeText: null },
      { id: "cE", name: "이미다니는반", dayOfWeek: "Fri", startTime: "17:00", endTime: "18:30", capacity: 10, enrolled: 3, grades: ["초5"] },
      { id: "cF", name: "꽉찬반", dayOfWeek: "Fri", startTime: "19:00", endTime: "20:30", capacity: 10, enrolled: 12, grades: ["초5"] },
      { id: "cS", name: "방학특강반", dayOfWeek: "Seasonal", startTime: "10:00", endTime: "12:00", capacity: 10, enrolled: 0, grades: ["초5"] },
      { id: "cX", name: "지운프로그램반", dayOfWeek: "Tue", startTime: "10:00", endTime: "11:00", capacity: 10, enrolled: 0, grades: ["초5"], programDeleted: true },
    ],
    enrollments: [
      { studentId: "s1", classId: "cO", status: "ACTIVE" },
      { studentId: "s1", classId: "cE", status: "ACTIVE" },
      { studentId: "s9", classId: "cO", status: "ACTIVE" },
    ],
    absences: [],   // { id, studentId, classId, date, reason, status }
    credits: [],    // { id, studentId, sourceType, sourceKey, status, absenceDate, expiresAt, originClassId, makeupSessionId }
    sessions: [],   // { id, studentId, makeupClassId, makeupDate(Date), status }
    notices: [],
    seatRechecks: 0,
    raceBooked: {},
    seq: 0,
    ...overrides,
  };
  const student = (id) => db.students.find((row) => row.id === id);
  const cls = (id) => db.classes.find((row) => row.id === id);
  const owns = (studentId, parentId) => student(studentId)?.parentId === parentId;
  const stamp = () => String(20261116000000000000n + BigInt(++db.seq));

  async function $queryRawUnsafe(sql, ...args) {
    // ── 결석: 소유·수강 확인 ──
    if (/FROM "Enrollment" e\s+JOIN "Student" s ON s\.id = e\."studentId"\s+JOIN "Class" c ON c\.id = e\."classId"/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건");
      assert.match(sql, /c\."startTime" AS "startTime"/, "마감 판정에 쓸 시작 시각을 함께 읽는다");
      // 2026-11-14 복귀 예정: 수강 조건은 «ACTIVE» 한 줄이 아니라 공용 조각(resumeWindow)이다 —
      // 다니는 반 + 복귀 승인된 휴원 반(가짜 DB 에선 resumeFrom 이 적힌 PAUSED). 복귀 쪽 실행형 검증은 tests/resume-window.test.mjs
      assert.ok(sql.includes(USABLE_SQL), "수강 조건은 공용 조각(parentUsableEnrollmentSql)");
      const row = owns(args[1], args[0]) ? db.enrollments.find((e) => e.studentId === args[1] && e.classId === args[2] && usable(e)) : null;
      const c = cls(args[2]);
      return row ? [{ dayOfWeek: c.dayOfWeek, startTime: c.startTime, studentName: student(args[1]).name, className: c.name, enrollmentStatus: row.status, resumeFrom: row.resumeFrom ?? null }] : [];
    }
    // ── 결석: 다가오는 수업일 목록 ──
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && sql.includes('c."dayOfWeek" AS "dayOfWeek"')) {
      assert.ok(sql.includes(USABLE_SQL), "목록도 같은 공용 조각");
      return db.enrollments.filter((e) => usable(e) && owns(e.studentId, args[0])).map((e) => {
        const c = cls(e.classId);
        return { studentId: e.studentId, studentName: student(e.studentId).name, classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, enrollmentStatus: e.status, resumeFrom: e.resumeFrom ?? null };
      });
    }
    if (/FROM "RegularAbsence" ra\s+JOIN "Student" s ON s\.id = ra\."studentId"/.test(sql) && /^SELECT/.test(sql.trim())) {
      return db.absences.filter((a) => owns(a.studentId, args[0]) && a.status !== "CANCELLED").map((a) => ({ ...a }));
    }
    if (/FROM "MakeupCredit" mc\s+JOIN "Student" s ON s\.id = mc\."studentId"/.test(sql) && /mc\."sourceType" = 'REGULAR'/.test(sql)) {
      return db.credits.filter((c) => owns(c.studentId, args[0]) && ["AVAILABLE", "RESERVED", "USED", "NO_SHOW"].includes(c.status))
        .map((c) => ({ studentId: c.studentId, sourceKey: c.sourceKey, status: c.status }));
    }
    // ── 결석: 신고 저장(INSERT … ON CONFLICT) — 덮어쓰는 조건을 SQL 문구에서 읽는다 ──
    if (/INSERT INTO "RegularAbsence"/.test(sql)) {
      const [studentId, classId, date, reason] = args;
      const found = db.absences.find((a) => a.studentId === studentId && a.classId === classId && a.date === date);
      if (!found) {
        const row = { id: `ra${++db.seq}`, studentId, classId, date, reason, status: "REPORTED" };
        db.absences.push(row);
        return [{ id: row.id, eventVersion: stamp() }];
      }
      // 확정건 보호: 사유가 달라도 REPORTED 일 때만 덮는다
      const reasonNeedsReported = /"RegularAbsence"\.status = 'REPORTED' AND "RegularAbsence"\.reason IS DISTINCT FROM EXCLUDED\.reason/.test(sql);
      const mayUpdate = found.status === "CANCELLED" || (found.reason !== reason && (!reasonNeedsReported || found.status === "REPORTED"));
      if (!mayUpdate) return [];
      found.reason = reason; found.status = "REPORTED";
      return [{ id: found.id, eventVersion: stamp() }];
    }
    if (/SELECT status, reason FROM "RegularAbsence"/.test(sql)) {
      return db.absences.filter((a) => a.studentId === args[0] && a.classId === args[1] && a.date === args[2]).map((a) => ({ status: a.status, reason: a.reason }));
    }
    // ── 결석: 취소(UPDATE … RETURNING) ──
    if (/UPDATE "RegularAbsence" ra\s+SET status = 'CANCELLED'/.test(sql)) {
      assert.match(sql, /ra\.status = 'REPORTED'/, "확정건은 취소되지 않는다");
      assert.match(sql, /c\."startTime" AS "startTime"/, "마감 판정에 쓸 시작 시각을 돌려받는다");
      const byId = /ra\.id = \$2/.test(sql);
      const row = db.absences.find((a) => a.status === "REPORTED" && owns(a.studentId, args[0])
        && (byId ? a.id === args[1] : a.studentId === args[1] && a.classId === args[2] && a.date === args[3]));
      if (!row) return [];
      row.status = "CANCELLED";
      const c = cls(row.classId);
      return [{ id: row.id, studentName: student(row.studentId).name, className: c.name, classId: c.id, studentId: row.studentId, date: row.date, startTime: c.startTime, eventVersion: stamp() }];
    }
    // ── 보강권 발급·되돌리기 ──
    if (/to_regclass/.test(sql)) return [{ found: null }];
    if (/INSERT INTO "MakeupCredit"/.test(sql)) {
      const found = db.credits.find((c) => c.studentId === args[0] && c.sourceKey === args[1]);
      if (!found) {
        const row = { id: `mc${++db.seq}`, studentId: args[0], sourceType: "REGULAR", sourceKey: args[1], absenceDate: new Date(args[2]), expiresAt: new Date(args[3]), originClassId: args[4], status: "AVAILABLE", makeupSessionId: null };
        db.credits.push(row);
        return [{ id: row.id }];
      }
      assert.match(sql, /"MakeupCredit"\.status = 'REVOKED' AND "MakeupCredit"\."makeupSessionId" IS NULL/);
      if (found.status === "REVOKED" && found.makeupSessionId == null) { found.status = "AVAILABLE"; return [{ id: found.id }]; }
      return [];
    }
    if (/FROM "MakeupCredit" mc/.test(sql) && /FOR UPDATE OF mc/.test(sql)) {
      const c = db.credits.find((x) => x.studentId === args[0] && x.sourceKey === args[1]);
      return c ? [{ id: c.id, status: c.status, makeupSessionId: c.makeupSessionId, bookingPast: false }] : [];
    }
    if (/FROM "Attendance" a/.test(sql)) return [];
    // ── 보강: 보강권 소유 확인 ──
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2 AND mc\.status = 'AVAILABLE' LIMIT 1/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0]);
      return c && owns(c.studentId, args[1]) && c.status === "AVAILABLE" ? [{ ...c, studentGrade: student(c.studentId).grade }] : [];
    }
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2\s+LIMIT 1/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0]);
      return c && owns(c.studentId, args[1]) ? [{ ...c, studentGrade: student(c.studentId).grade }] : [];
    }
    // ── 보강: 반 목록 ──
    if (/FROM "Class" c\s+JOIN "Program" p ON p\.id = c\."programId"\s+LEFT JOIN "ScheduleSlot" ss ON ss\."slotKey" = c\."slotKey"/.test(sql)) {
      assert.doesNotMatch(sql, /(?<!LEFT )JOIN "ScheduleSlot"/, "슬롯이 없는 반이 빠지는 INNER JOIN 이 아니다");
      assert.match(sql, /WHERE c\."dayOfWeek" <> 'Seasonal' AND p\."deletedAt" IS NULL/);
      // 2026-11-14 검수: 숨긴 직접 슬롯 반은 후보에서 뺀다(OR 조건은 괄호로 묶는다)
      assert.match(sql, /FROM "CustomClassSlot" cs\s+WHERE \(cs\.id = c\."slotKey" OR \('custom-' \|\| cs\.id\) = c\."slotKey"\) AND cs\."isHidden" = false/, "직접 만든 슬롯의 대상 학년 글자(숨긴 반 제외)");
      assert.doesNotMatch(sql, /"MakeupSession"/, "보강 예약 수를 반 전체로 세지 않는다(날짜별 조회가 따로 있다)");
      return db.classes.filter((c) => c.dayOfWeek !== "Seasonal" && !c.programDeleted).map((c) => ({
        classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, endTime: c.endTime, capacity: c.capacity,
        gradesJson: c.grades ? JSON.stringify(c.grades) : null, gradeRangeText: c.gradeRangeText ?? null, enrolled: c.enrolled,
      }));
    }
    if (/SELECT e\."classId" AS "classId" FROM "Enrollment" e WHERE e\."studentId" = \$1 AND e\.status = 'ACTIVE'/.test(sql)) {
      return db.enrollments.filter((e) => e.studentId === args[0] && e.status === "ACTIVE").map((e) => ({ classId: e.classId }));
    }
    if (/FROM "MakeupSession" m/.test(sql) && /GROUP BY 1, 2/.test(sql)) {
      // timestamptz → KST 변환은 «한 번»
      assert.match(sql, /to_char\(m\."makeupDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS ymd/);
      assert.doesNotMatch(sql, /AT TIME ZONE 'UTC'/);
      assert.match(sql, /m\.status <> 'CANCELLED'/);
      const counts = new Map();
      for (const row of db.sessions) {
        if (row.status === "CANCELLED" || row.makeupDate.getTime() < new Date(args[0]).getTime()) continue;
        const key = `${row.makeupClassId}|${kst.toKstYmd(row.makeupDate)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts].map(([key, booked]) => ({ classId: key.split("|")[0], ymd: key.split("|")[1], booked }));
    }
    if (/FROM "Class" c WHERE c\.id = \$1 LIMIT 1/.test(sql)) {
      // 예약 트랜잭션 안의 정원 재확인 — 반드시 잠금 뒤에 온다
      assert.ok(db.lockedInTx, "작업대 잠금(lockCompensation) 뒤에 정원을 다시 센다");
      db.seatRechecks += 1;
      const c = cls(args[0]);
      const booked = db.sessions.filter((row) => row.makeupClassId === c.id && row.status !== "CANCELLED" && kst.toKstYmd(row.makeupDate) === args[1]).length
        + (db.raceBooked[`${c.id}|${args[1]}`] ?? 0);
      return [{ capacity: c.capacity, enrolled: c.enrolled, booked }];
    }
    if (/INSERT INTO "MakeupSession"/.test(sql)) {
      const row = { id: `ms${++db.seq}`, studentId: args[0], originalClassId: args[1], makeupClassId: args[3], makeupDate: new Date(args[4]), status: "BOOKED" };
      db.sessions.push(row);
      return [{ id: row.id }];
    }
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  async function $executeRawUnsafe(sql, ...args) {
    if (/pg_advisory_xact_lock/.test(sql)) { db.lockedInTx = true; return 1; }
    if (/UPDATE "MakeupCredit"\s+SET status = 'REVOKED'/.test(sql)) {
      const need = /status = 'RESERVED'/.test(sql) ? "RESERVED" : "AVAILABLE";
      const c = db.credits.find((x) => x.id === args[0] && x.status === need);
      if (!c) return 0;
      c.status = "REVOKED";
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET status='RESERVED'/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0] && x.status === "AVAILABLE" && owns(x.studentId, args[1]));
      if (!c) return 0;
      c.status = "RESERVED";
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET "makeupSessionId"=\$2/.test(sql)) {
      db.credits.find((x) => x.id === args[0]).makeupSessionId = args[1];
      return 1;
    }
    throw new Error(`예상하지 않은 실행: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  /** 트랜잭션: 안에서 오류가 나면 표를 통째로 되돌린다(진짜 DB 의 ROLLBACK 흉내) */
  async function $transaction(fn) {
    const snapshot = structuredClone({ absences: db.absences, credits: db.credits, sessions: db.sessions });
    db.lockedInTx = false;
    try {
      return await fn({ $queryRawUnsafe, $executeRawUnsafe });
    } catch (error) {
      db.absences = snapshot.absences; db.credits = snapshot.credits; db.sessions = snapshot.sessions;
      throw error;
    } finally {
      db.lockedInTx = false;
    }
  }

  Object.assign(db, { $queryRawUnsafe, $executeRawUnsafe, $transaction });
  globalThis.__linkDb = db;
  return db;
}

const MON = "2026-11-16"; // 월요일 — 원래반(월 18:00) 수업일
const REPORT = { studentId: "s1", classId: "cO", date: MON };

// ═════════════════════════════════════════════════════════════════════════
// ②③ 결석 신고·사유 변경·취소 — 서버가 마감을 강제한다(실제 실행)
// ═════════════════════════════════════════════════════════════════════════
test("오늘 수업도 1시간 전까지 신고된다 — 신고 즉시 보강권 1장", async () => {
  const db = makeDb();
  freeze(MON, "16:59");
  const res = await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  assert.equal(res.ok, true);
  assert.equal(res.makeupCreditIssued, true);
  assert.deepEqual(db.absences.map((a) => [a.date, a.reason, a.status]), [[MON, "PERSONAL", "REPORTED"]]);
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("사유 변경: 같은 길(재신고)로 사유만 바뀌고 보강권은 다시 생기지 않는다(한 결석 한 장)", async () => {
  const db = makeDb();
  freeze(MON, "10:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  const creditId = db.credits[0].id;

  freeze(MON, "17:00"); // 정확히 1시간 전 — 아직 가능
  const changed = await absence.reportRegularAbsence("p1", { ...REPORT, reason: "ILLNESS_INJURY" });
  assert.equal(changed.ok, true);
  assert.equal(changed.makeupCreditIssued, false, "사유 변경으로 보강권이 또 나가지 않는다");
  assert.equal(db.absences.length, 1, "결석 행은 하나");
  assert.equal(db.absences[0].reason, "ILLNESS_INJURY");
  assert.equal(db.absences[0].status, "REPORTED");
  assert.deepEqual(db.credits.map((c) => [c.id, c.status]), [[creditId, "AVAILABLE"]], "보강권은 같은 한 장 그대로");

  // 여러 번 바꿔도, 같은 사유를 다시 보내도 한 장
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "SCHOOL_EVENT" });
  const same = await absence.reportRegularAbsence("p1", { ...REPORT, reason: "SCHOOL_EVENT" });
  assert.equal(same.noOp, true);
  assert.equal(same.makeupCreditIssued, false);
  assert.equal(db.credits.length, 1);
});

test("사유 변경: 보강을 이미 예약한(RESERVED) 결석도 보강권·예약은 그대로다", async () => {
  const db = makeDb();
  freeze(MON, "10:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  db.credits[0].status = "RESERVED";
  db.credits[0].makeupSessionId = "ms-booked";
  const changed = await absence.reportRegularAbsence("p1", { ...REPORT, reason: "FAMILY_TRIP" });
  assert.equal(changed.makeupCreditIssued, false);
  assert.deepEqual(db.credits.map((c) => [c.status, c.makeupSessionId]), [["RESERVED", "ms-booked"]]);
  assert.equal(db.absences[0].reason, "FAMILY_TRIP");
});

test("사유 변경 알림(사실 기록): 바꿀 때마다 «결석 사전 신고» 알림이 같은 대상(원장·코치·기사)에게 한 번 더 간다", async () => {
  // 알림 규칙은 이번에 바꾸지 않았다 — 지금 동작을 그대로 적어 둔다(바꾸려면 원장 결정이 필요).
  const db = makeDb();
  freeze(MON, "10:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "ILLNESS_INJURY" });
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "ILLNESS_INJURY" }); // 같은 사유 재전송 = 알림 없음
  assert.equal(db.notices.length, 2);
  assert.deepEqual(db.notices.map((n) => n.eventType), ["REGULAR_ABSENCE_REPORTED", "REGULAR_ABSENCE_REPORTED"]);
  assert.ok(db.notices.every((n) => n.includeCoach === true && n.includeDriver === true));
  assert.notEqual(db.notices[0].stableEventKey, db.notices[1].stableEventKey, "사유가 다르면 다른 알림으로 취급된다");
  assert.match(db.notices[1].message, /질병\/부상/);
});

test("마감 강제(신고·사유 변경): 수업 1시간 전이 지나면 서버가 거절한다 — 저장·보강권·알림 없음", async () => {
  const db = makeDb();
  freeze(MON, "17:01");
  await assert.rejects(() => absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" }), /^Error: ABSENCE_CHANGE_CLOSED$/);
  assert.equal(db.absences.length, 0);
  assert.equal(db.credits.length, 0);
  assert.equal(db.notices.length, 0);

  // 미리 신고해 둔 결석의 사유도 마감 뒤에는 못 바꾼다
  freeze(MON, "09:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  freeze(MON, "17:30");
  await assert.rejects(() => absence.reportRegularAbsence("p1", { ...REPORT, reason: "ETC" }), /ABSENCE_CHANGE_CLOSED/);
  assert.equal(db.absences[0].reason, "PERSONAL", "사유는 그대로");

  // 지난 날짜·다른 요일은 예전처럼 NOT_REPORTABLE_DATE
  await assert.rejects(() => absence.reportRegularAbsence("p1", { ...REPORT, date: "2026-11-09", reason: "ETC" }), /NOT_REPORTABLE_DATE/);
  await assert.rejects(() => absence.reportRegularAbsence("p1", { ...REPORT, date: "2026-11-17", reason: "ETC" }), /NOT_REPORTABLE_DATE/);
});

test("마감 강제(취소): 1시간 전까지는 취소되고 보강권이 회수된다 · 지나면 거절하고 아무것도 바뀌지 않는다", async () => {
  const db = makeDb();
  freeze(MON, "09:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });

  // 마감 뒤: 거절 + 트랜잭션 되돌림(결석은 REPORTED, 보강권은 AVAILABLE 그대로)
  freeze(MON, "17:01");
  await assert.rejects(() => absence.cancelRegularAbsence("p1", REPORT), /^Error: ABSENCE_CHANGE_CLOSED$/);
  assert.equal(db.absences[0].status, "REPORTED");
  assert.equal(db.credits[0].status, "AVAILABLE");
  assert.equal(db.notices.filter((n) => n.eventType === "REGULAR_ABSENCE_CANCELED").length, 0);
  // id 로 지목해도(카카오 대화 경로) 같은 마감
  await assert.rejects(() => absence.cancelRegularAbsence("p1", { id: db.absences[0].id }), /ABSENCE_CHANGE_CLOSED/);
  assert.equal(db.absences[0].status, "REPORTED");
  // 다음 날이 되면 당연히 마감
  freeze("2026-11-17", "08:00");
  await assert.rejects(() => absence.cancelRegularAbsence("p1", REPORT), /ABSENCE_CHANGE_CLOSED/);

  // 마감 전(정확히 1시간 전): 취소되고 보강권 회수
  freeze(MON, "17:00");
  const res = await absence.cancelRegularAbsence("p1", REPORT);
  assert.equal(res.ok, true);
  assert.equal(res.makeupCreditRevoked, true);
  assert.equal(db.absences[0].status, "CANCELLED");
  assert.equal(db.credits[0].status, "REVOKED");

  // 취소 후 다시 신고(= 날짜 변경의 길) — 같은 보강권이 되살아난다(두 장이 되지 않는다)
  const again = await absence.reportRegularAbsence("p1", { ...REPORT, reason: "ETC" });
  assert.equal(again.makeupCreditIssued, true);
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("원장 확정건은 학부모가 사유도 못 바꾸고 취소도 못 한다(유지)", async () => {
  const db = makeDb();
  freeze(MON, "09:00");
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  db.absences[0].status = "CONFIRMED";
  // 다른 사유로 재신고 → 거절, 확정 상태·사유 그대로(예전 SQL 은 사유가 다르면 REPORTED 로 되돌렸다)
  await assert.rejects(() => absence.reportRegularAbsence("p1", { ...REPORT, reason: "ETC" }), /ABSENCE_NOT_CANCELABLE/);
  assert.deepEqual([db.absences[0].status, db.absences[0].reason], ["CONFIRMED", "PERSONAL"]);
  await assert.rejects(() => absence.cancelRegularAbsence("p1", REPORT), /ABSENCE_NOT_CANCELABLE/);
  assert.equal(db.absences[0].status, "CONFIRMED");
});

test("권한: 남의 자녀 결석은 신고·취소되지 않는다(기존 검사 유지)", async () => {
  const db = makeDb();
  freeze(MON, "09:00");
  await assert.rejects(() => absence.reportRegularAbsence("p9", { ...REPORT, reason: "PERSONAL" }), /NOT_OWNER/);
  await absence.reportRegularAbsence("p1", { ...REPORT, reason: "PERSONAL" });
  await assert.rejects(() => absence.cancelRegularAbsence("p9", REPORT), /ABSENCE_NOT_CANCELABLE/);
  assert.equal(db.absences[0].status, "REPORTED");
});

test("목록: 오늘 수업이 보이고, 줄마다 지금 바꿀 수 있는지(changeOpen)를 알려 준다", async () => {
  makeDb();
  freeze(MON, "16:00");
  let child = (await absence.getUpcomingRegularClassDates("p1")).find((c) => c.studentId === "s1");
  let dates = child.classes.find((c) => c.classId === "cO").dates;
  assert.equal(dates[0].date, MON, "오늘 수업이 맨 앞에 있다(예전에는 목록에서 사라졌다)");
  assert.equal(dates.length, 5, "오늘 + 앞으로 4주");
  assert.deepEqual(dates.map((d) => d.changeOpen), [true, true, true, true, true]);

  freeze(MON, "17:30");
  child = (await absence.getUpcomingRegularClassDates("p1")).find((c) => c.studentId === "s1");
  dates = child.classes.find((c) => c.classId === "cO").dates;
  assert.deepEqual(dates.map((d) => d.changeOpen), [false, true, true, true, true], "오늘 줄만 마감");
  // 새벽(서버 UTC 로는 전날) — 오늘은 KST 로 잡힌다
  freeze(MON, "00:30");
  child = (await absence.getUpcomingRegularClassDates("p1")).find((c) => c.studentId === "s1");
  assert.equal(child.classes.find((c) => c.classId === "cO").dates[0].date, MON);
});

// ═════════════════════════════════════════════════════════════════════════
// ④ 보강 후보 조회·예약 — 실제 실행
// ═════════════════════════════════════════════════════════════════════════
const SAT = "2026-11-14"; // 토요일(조회 시점)
function creditFor(db, { studentId = "s1", expiresYmd = "2026-12-20", originClassId = "cO" } = {}) {
  const row = { id: `mc${++db.seq}`, studentId, sourceType: "REGULAR", sourceKey: `REGULAR:${originClassId}:2026-11-09`, status: "AVAILABLE", absenceDate: new Date(at("2026-11-09")), expiresAt: new Date(at(expiresYmd)), originClassId, makeupSessionId: null };
  db.credits.push(row);
  return row;
}

test("후보 조회: 학년대가 비슷한(±1) 반 — 슬롯 없는 반도 대상 학년 글자로, 다니는 반·원래 반·학년 모르는 반·꽉 찬 반은 빠진다", async () => {
  const db = makeDb();
  freeze(SAT, "10:00");
  const credit = creditFor(db);
  const res = await makeup.getMakeupOptionsForCredit("p1", credit.id);
  assert.equal(res.ok, true);
  assert.equal(res.emptyReason, null);
  const ids = res.options.map((o) => o.classId).sort();
  // 초5 학생: 화요반(초4~6) · 초6중1반(±1) · 직접만든반(슬롯 없음, "초4~초6")
  assert.deepEqual(ids, ["cA", "cC", "cD"]);
  const byId = Object.fromEntries(res.options.map((o) => [o.classId, o]));
  assert.equal(byId.cD.gradeLabel, "초4~초6");
  assert.equal(byId.cA.gradeLabel, "초4~초6");
  assert.equal(byId.cC.gradeLabel, "초6~중1");
  // 여유 많은 반이 먼저(쏠림 방지) — 직접만든반(10자리) → 화요반(7) → 초6중1반(3)
  assert.deepEqual(res.options.map((o) => o.classId), ["cD", "cA", "cC"]);
  assert.deepEqual(res.options.map((o) => o.seatLevel), ["AVAILABLE", "AVAILABLE", "LOW"]);
  // 내일부터 사용 기한(12/20)까지 그 요일 날짜 — 화요일
  assert.deepEqual(byId.cA.dates.map((d) => d.ymd), ["2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15"]);
  assert.equal(byId.cA.dates[0].label, "11/17(화)");
  // 학부모 응답에 인원 숫자가 없다(재원생 수 비공개)
  for (const option of res.options) {
    assert.deepEqual(Object.keys(option).sort(), ["classId", "className", "dates", "dayOfWeek", "endTime", "gradeLabel", "grades", "seatLevel", "startTime"]);
    for (const d of option.dates) assert.deepEqual(Object.keys(d).sort(), ["label", "seatLevel", "ymd"]);
  }
});

test("후보 0건의 이유를 나눠 알려 준다: 학년 정보 없음 / 맞는 반 없음 / 날짜 없음 / 자리 없음", async () => {
  freeze(SAT, "10:00");
  // 학년 정보 없음(NULL·성인)
  for (const grade of [null, "성인", ""]) {
    const db = makeDb();
    db.students[0].grade = grade;
    const res = await makeup.getMakeupOptionsForCredit("p1", creditFor(db).id);
    assert.deepEqual([res.ok, res.options.length, res.emptyReason], [true, 0, "NO_GRADE"], `${grade}`);
  }
  // 맞는 반 없음(고2 — 어느 반 범위에서도 2학년 이상 떨어져 있다)
  let db = makeDb();
  db.students[0].grade = "고2";
  assert.equal((await makeup.getMakeupOptionsForCredit("p1", creditFor(db).id)).emptyReason, "NO_MATCH");
  // 날짜 없음(사용 기한이 내일 0시 = 일요일 — 화·수·목 수업이 그 안에 없다)
  db = makeDb();
  assert.equal((await makeup.getMakeupOptionsForCredit("p1", creditFor(db, { expiresYmd: "2026-11-15" }).id)).emptyReason, "NO_DATE");
  // 자리 없음(맞는 반이 꽉 찬 반뿐)
  db = makeDb();
  db.classes = db.classes.filter((c) => ["cO", "cF"].includes(c.id));
  db.enrollments = db.enrollments.filter((e) => e.classId === "cO");
  assert.equal((await makeup.getMakeupOptionsForCredit("p1", creditFor(db).id)).emptyReason, "FULL");
});

test("날짜별 정원: 그 날짜가 찬 날만 빠지고 같은 반의 다른 날은 남는다(예전에는 반이 통째로 빠졌다)", async () => {
  const db = makeDb();
  freeze(SAT, "10:00");
  const credit = creditFor(db);
  // 화요반: 정원 10 + 2 − 수강 5 = 7자리. 11/17 에 보강 7건 → 그날만 마감.
  // 저장 형식이 섞여 있다: 학부모 예약 = KST 자정, 관리자 예약 = UTC 자정(= KST 09:00). 둘 다 같은 KST 날짜로 묶여야 한다.
  for (let i = 0; i < 4; i++) db.sessions.push({ id: `p${i}`, makeupClassId: "cA", makeupDate: new Date(at("2026-11-17")), status: "BOOKED" });
  for (let i = 0; i < 3; i++) db.sessions.push({ id: `a${i}`, makeupClassId: "cA", makeupDate: new Date("2026-11-17T00:00:00Z"), status: "BOOKED" });
  // 11/24: 6건 → 1자리(임박). 취소된 예약은 세지 않는다.
  for (let i = 0; i < 6; i++) db.sessions.push({ id: `b${i}`, makeupClassId: "cA", makeupDate: new Date(at("2026-11-24")), status: "BOOKED" });
  db.sessions.push({ id: "x1", makeupClassId: "cA", makeupDate: new Date(at("2026-11-24")), status: "CANCELLED" });

  const res = await makeup.getMakeupOptionsForCredit("p1", credit.id);
  const cA = res.options.find((o) => o.classId === "cA");
  assert.ok(cA, "반은 후보에 남는다");
  assert.deepEqual(cA.dates.map((d) => d.ymd), ["2026-11-24", "2026-12-01", "2026-12-08", "2026-12-15"], "마감된 11/17 만 빠진다");
  assert.deepEqual(cA.dates.map((d) => d.seatLevel), ["LOW", "AVAILABLE", "AVAILABLE", "AVAILABLE"]);
  assert.equal(cA.seatLevel, "AVAILABLE", "반의 대표 단계는 가장 여유 있는 날 기준");

  // 마감된 날짜로 직접 예약을 보내도 서버가 거절한다(화면 값 불신)
  const full = await makeup.bookMakeup("p1", { creditId: credit.id, classId: "cA", dateYmd: "2026-11-17" });
  assert.equal(full.ok, false);
  assert.equal(credit.status, "AVAILABLE");
});

test("예약: 트랜잭션 안에서(잠금 뒤) 그 반·그 날짜 정원을 다시 센다 — 동시 예약 초과 방지", async () => {
  const db = makeDb();
  freeze(SAT, "10:00");
  const credit = creditFor(db);
  // 후보 조회 때는 자리가 있었지만, 잠금을 기다리는 사이 다른 예약 3건이 먼저 들어온 상황(초6중1반 = 3자리)
  db.raceBooked["cC|2026-11-18"] = 3;
  const lost = await makeup.bookMakeup("p1", { creditId: credit.id, classId: "cC", dateYmd: "2026-11-18" });
  assert.deepEqual(lost, { ok: false, message: "방금 그 날짜가 마감됐습니다. 다른 날짜나 수업을 골라 주세요." });
  assert.equal(db.seatRechecks, 1);
  // (가짜 트랜잭션이 되돌리며 행 객체를 새로 만들므로 표에서 다시 찾는다)
  const current = () => db.credits.find((row) => row.id === credit.id);
  assert.equal(current().status, "AVAILABLE", "보강권은 그대로");
  assert.equal(db.sessions.length, 0, "예약이 만들어지지 않았다");

  // 자리가 있으면 정상 예약 — 보강 날짜는 그 날 KST 자정으로 저장된다
  db.raceBooked = {};
  const ok = await makeup.bookMakeup("p1", { creditId: credit.id, classId: "cC", dateYmd: "2026-11-18" });
  assert.deepEqual(ok, { ok: true, message: "초6중1반 11/18(수) 보강이 예약되었습니다." });
  assert.equal(db.seatRechecks, 2);
  assert.equal(current().status, "RESERVED");
  assert.equal(db.sessions[0].makeupDate.toISOString(), "2026-11-17T15:00:00.000Z");
  assert.equal(current().makeupSessionId, db.sessions[0].id);
});

test("예약 검증: 없는 날짜·그 반 요일이 아닌 날·갈 수 없는 반·남의 보강권은 거절", async () => {
  const db = makeDb();
  freeze(SAT, "10:00");
  const credit = creditFor(db);
  const book = (input, parent = "p1") => makeup.bookMakeup(parent, { creditId: credit.id, classId: "cA", dateYmd: "2026-11-17", ...input });
  assert.equal((await book({ dateYmd: "2026-02-30" })).message, "날짜가 올바르지 않습니다.");
  assert.equal((await book({ dateYmd: "2026-11-18" })).ok, false, "화요반인데 수요일");
  assert.equal((await book({ dateYmd: "2026-11-14" })).ok, false, "오늘은 예약할 수 없다(내일부터)");
  assert.equal((await book({ classId: "cE", dateYmd: "2026-11-20" })).message, "이 학생이 갈 수 있는 수업이 아닙니다.", "이미 다니는 반");
  assert.equal((await book({ classId: "cB", dateYmd: "2026-11-18" })).ok, false, "학년대가 다른 반");
  assert.equal((await book({}, "p9")).message, "예약할 수 있는 보강권이 아닙니다.");
  assert.equal(db.sessions.length, 0);
  assert.equal(credit.status, "AVAILABLE");
});

// ═════════════════════════════════════════════════════════════════════════
// 화면·연결부 — 소스 계약
// ═════════════════════════════════════════════════════════════════════════
test("결석 화면: 보강 예약으로 이어지는 버튼 · 사유 변경 · 마감 글 · 옛 문구 삭제", () => {
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  // 보강권이 있으면 보강 화면으로(그 아이를 맨 위에)
  assert.match(client, /d\.reported && d\.makeupCredit === "AVAILABLE" && \(\s*<Link\s+href=\{`\/mypage\/makeup\?studentId=\$\{encodeURIComponent\(d\.studentId\)\}`\}\s+className="academy-button-tonal shrink-0"\s*>\s*보강 예약하기/);
  assert.doesNotMatch(client, /AVAILABLE: "보강권 1장"/, "글자뿐이던 «보강권 1장»은 버튼이 됐다");
  assert.doesNotMatch(client, /보강 일정은 학원에서 지정합니다/, "지금 사실과 다른 옛 문구");
  assert.match(client, /보강권으로 비슷한 학년 반의 빈자리를 골라 예약할 수 있습니다/);
  // 사유 변경 — 지금 사유를 채워 같은 칸을 연다, 폼은 신고된 줄에서도 열린다
  assert.match(client, /setReason\(\(prev\) => \(\{ \.\.\.prev, \[key\]: d\.reason \|\| "" \}\)\);\s*setOpenKey\(key\);[\s\S]{0,200}사유 변경/);
  assert.match(client, /\{d\.reported \? "사유 바꾸기" : "신고하기"\}/);
  assert.doesNotMatch(client, /openKey === key && !d\.reported && \(/, "신고된 줄에 폼을 안 열던 조건은 없다");
  assert.match(client, /날짜를 바꾸려면 취소한 뒤 다시 신고해 주세요/);
  // 마감 글 = 서버 문구와 같은 글, 마감이면 버튼 대신 글
  assert.ok(client.includes(`const CHANGE_CLOSED_TEXT = "${rules.ABSENCE_CHANGE_CLOSED_MESSAGE}";`));
  assert.match(client, /d\.locked \? null : !changeOpen\(d\) \? \(/);
  assert.match(client, /if \(j\?\.code === "ABSENCE_CHANGE_CLOSED"\) await reload\(\);/);
  // 아이콘·굵은 글씨 규칙
  assert.doesNotMatch(client, /font-(extrabold|black)|material-symbols/);
});

test("결석 API: 마감 오류를 학부모 말로 돌려준다(코드도 함께 — 화면이 다시 읽는다)", () => {
  const route = read("src/app/api/mypage/regular-absence/route.ts");
  assert.match(route, /ABSENCE_CHANGE_CLOSED: ABSENCE_CHANGE_CLOSED_MESSAGE/);
  assert.equal(rules.ABSENCE_CHANGE_CLOSED_MESSAGE, "수업 1시간 전이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요.");
});

test("서버: 신고·취소 양쪽이 같은 마감 함수를 쓴다 — 화면 숨김만으로 끝내지 않는다", () => {
  const source = read("src/lib/regular/parent-regular-absence.ts");
  const body = (name) => source.slice(source.indexOf(`export async function ${name}`));
  const report = body("reportRegularAbsence").slice(0, body("reportRegularAbsence").indexOf("export async function cancelRegularAbsence"));
  const cancel = body("cancelRegularAbsence");
  assert.match(report, /isReportableAt\(date, owned\.dayOfWeek, owned\.startTime, now\.ymd, now\.hm\)/);
  assert.match(cancel, /isAbsenceChangeOpen\(canceled\[0\]\.date, canceled\[0\]\.startTime, now\.ymd, now\.hm\)/);
  // 취소의 마감 검사는 트랜잭션 안(UPDATE 뒤, 보강권 되돌리기 앞) — 던지면 함께 되돌려진다
  assert.ok(cancel.indexOf("isAbsenceChangeOpen(") > cancel.indexOf("prisma.$transaction"));
  assert.ok(cancel.indexOf("isAbsenceChangeOpen(") < cancel.indexOf("settleCreditOnAbsenceCancel(tx"));
  // «지금»은 공용 날짜 모듈로만
  assert.match(source, /return \{ ymd: todayKst\(nowMs\), hm: kstHm\(nowMs\) \};/);
  assert.doesNotMatch(source, /Intl\.DateTimeFormat/);
});

test("보강 화면: 0건이면 이유별 글, 후보 행에 대상 학년·자리 단계(숫자 없음)", () => {
  const client = read("src/app/mypage/makeup/MakeupClient.tsx");
  for (const key of ["NO_GRADE", "NO_MATCH", "NO_DATE", "FULL"]) assert.match(client, new RegExp(`${key}: "`));
  assert.match(client, /NO_GRADE: "학년 정보가 없어[^"]*학원으로 문의/);
  assert.match(client, /\{EMPTY_REASON_TEXT\[emptyReason\] \?\? EMPTY_DEFAULT_TEXT\}/);
  assert.match(client, /setEmptyReason\(r\.emptyReason \|\| ""\)/);
  assert.match(client, /대상 \{o\.gradeLabel \|\| o\.grades\.join\("·"\)\}/);
  assert.match(client, /SEAT_LEVEL_LABEL\[o\.seatLevel\]/);
  assert.doesNotMatch(client, /remaining|enrolled|capacity/, "인원 숫자를 화면에 쓰지 않는다");
  assert.doesNotMatch(client, /font-(extrabold|black)|material-symbols/);
  const action = read("src/app/actions/parent-makeup.ts");
  assert.match(action, /return \{ ok: true, options: r\.options, emptyReason: r\.emptyReason \};/);
});

test("보강 날짜 계산은 공용 모듈로 — 손으로 조립한 T00:00:00+09:00 이 없다", () => {
  for (const file of ["src/lib/makeup/parent-makeup.ts", "src/lib/makeup/credit-service.ts"]) {
    const source = read(file);
    // 코드에서 날짜 글자에 시각·시간대를 이어 붙이는 조립(주석의 설명 글은 제외)
    assert.doesNotMatch(source, /\$\{[^`\n]*\}T00:00:00\+09:00/, file);
    assert.doesNotMatch(source, /function\s+(kstYmd|dayLabel)\s*\(/, file);
    assert.match(source, /from "@\/lib\/datetime\/kst"/, file);
  }
  // 옮긴 뒤에도 같은 시각·같은 글자
  assert.equal(new Date(kst.kstAt("2026-11-17")).toISOString(), new Date("2026-11-17T00:00:00+09:00").toISOString());
  assert.equal(new Date(kst.kstAt("2026-11-17")).toISOString(), "2026-11-16T15:00:00.000Z");
  assert.equal(new Date(kst.kstAt("2027-01-01")).toISOString(), "2026-12-31T15:00:00.000Z", "연초 자정 = 전날 15시(UTC)");
  assert.equal(kst.toKstYmd(new Date("2026-12-31T15:00:00.000Z")), "2027-01-01", "연말 자정 경계");
  assert.equal(kst.kstLabel(new Date("2026-11-16T15:00:00.000Z")), "11/17(화)");
});
