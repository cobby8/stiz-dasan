import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import ts from "typescript";

// 2026-11-15 마감 통일·날짜 바꾸기 (원장 요청)
//   「셔틀·보강의 취소 마감 규칙 확인과 «날짜 바꾸기» 기능 함께 진행해」
//
// 이 파일이 못박는 것
//   ① 마감 공용 함수(changeDeadline) — 120분/119분, 60분/59분, 0분, 자정, 지난 날짜, 시작 시각 없음
//   ② 보강 = «KST 날짜 글자 + 보강 가는 반의 시작 시각» — 관리자(UTC 자정 저장)·학부모(KST 자정 저장) 보강 모두 같은 답
//   ③ 셔틀 신청·취소의 서버 마감(수업 없는 날은 전날까지·지난 날짜)
//   ★ 2026-11-15 마감 1시간 전 통일(원장 결정 «학부모 마감은 수업시작 한시간전으로 하자. 보강도 마찬가지야»):
//     셔틀(등원·하원·둘 다)·보강(예약·취소·날짜 바꾸기) 모두 «수업 시작 60분 전»까지 — 60분 전 열림·59분 전 닫힘.
//     그 전의 결정(셔틀 등원 120분·하원 0분, 보강 «전날까지»)을 못박았던 단언은 새 결정으로 고쳤다.
//   ④ 날짜 바꾸기 3종(결석·셔틀·보강) — 성공·마감 뒤 거절·남의 자녀 거절·실패 시 옛 신청 유지·
//      보강권 상태 불변·정원 꽉 찬 날 거절·결석에 예약된 보강이 있으면 거절·다시 눌러도 알림 중복 없음
// prisma·알림만 가짜다. 규칙·SQL 문구는 진짜 파일을 그대로 올려 실행한다(시계는 고정).

const read = (file) => readFileSync(file, "utf8");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const OVERRIDES = {
  "@/lib/prisma": toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__moveDb[key] });`),
  // 운영 알림(원장·코치·기사) — 무엇이 몇 통 가는지 세기만 한다
  // 여러 날 결석(2026-11-15): 연간 일정(next/cache·DB)은 가짜 — 수업일 = 그 달의 그 요일 전부에서 휴무일(db.holidays)을 뺀 것
  "@/lib/regular/absence-period-runner": toDataUrl(`export const ABSENCE_PERIOD_TX_OPTIONS = {};
    export async function absencePeriodContext(actorUserId) { return { todayYmd: "", actorUserId, classDatesForMonth: (ym, dow) => globalThis.__moveDb.classDates(ym, dow) }; }`),
  "@/lib/operational-staff-notification": toDataUrl(`export async function notifyOperationalStaff(input) { globalThis.__moveDb.notices.push(input); return { ok: true }; }`),
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
const deadline = await import(load("src/lib/parent/changeDeadline.ts"));
const rules = await import(load("src/lib/regular/regularAbsenceRules.ts"));
const absence = await import(load("src/lib/regular/parent-regular-absence.ts"));
const makeup = await import(load("src/lib/makeup/parent-makeup.ts"));
const shuttle = await import(load("src/lib/shuttle/parent-shuttle-exception.ts"));

/** KST 날짜·시각 → 절대 시각(ms) */
const at = (ymd, hm = "00:00") => new Date(`${ymd}T${hm}:00+09:00`).getTime();
/** 시계를 KST 그 시각으로 고정한다(Date.now · new Date() 모두) */
function freeze(ymd, hm = "00:00") {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: at(ymd, hm) });
}
test.afterEach(() => mock.timers.reset());

const CLOSED = "마감 시간이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요.";
const BOOK_CLOSED = /보강은 수업 시작 1시간 전까지 예약할 수 있습니다/;

// ═════════════════════════════════════════════════════════════════════════
// ① 마감 공용 함수 — 순수
// ═════════════════════════════════════════════════════════════════════════
const open = deadline.isChangeOpen;
const D = "2026-11-16"; // 월요일

// 2026-11-15 마감 1시간 전 통일: 예전에는 셔틀 등원 120분·하원 0분, 보강 «전날까지»였다
test("마감 상수: 학부모 마감은 한 줄(60분) — 결석·셔틀·보강이 모두 그 값을 따른다", () => {
  assert.equal(deadline.PARENT_CHANGE_CUTOFF_MINUTES, 60);
  assert.equal(deadline.ABSENCE_CUTOFF_MINUTES, 60);
  assert.equal(deadline.SHUTTLE_CUTOFF_MINUTES, 60);
  assert.equal(deadline.MAKEUP_CUTOFF_MINUTES, 60);
  assert.equal(deadline.PARENT_CHANGE_CUTOFF_TEXT, "1시간");
  // 등원·하원을 나누던 상수와 «보강 당일» 문구는 없앴다
  assert.equal(deadline.SHUTTLE_PICKUP_CUTOFF_MINUTES, undefined);
  assert.equal(deadline.SHUTTLE_DROPOFF_CUTOFF_MINUTES, undefined);
  assert.equal(deadline.shuttleCutoffMinutes, undefined);
  assert.equal(deadline.MAKEUP_SAME_DAY_MESSAGE, undefined);
  assert.equal(deadline.CHANGE_CLOSED_MESSAGE, CLOSED);
  const source = read("src/lib/parent/changeDeadline.ts");
  // 숫자는 한 곳에만 적는다 — 기능별 이름은 그 값을 가리킬 뿐
  assert.equal((source.match(/= 60;/g) || []).length, 1);
  for (const name of ["ABSENCE", "SHUTTLE", "MAKEUP"]) {
    assert.match(source, new RegExp(`export const ${name}_CUTOFF_MINUTES = PARENT_CHANGE_CUTOFF_MINUTES;`));
  }
  // 이 파일은 다른 모듈을 끌어오지 않는다(화면·서버·테스트가 그대로 쓴다)
  assert.doesNotMatch(source, /^import /m);
});

test("마감 경계: 120분 전은 가능·119분 전은 마감 / 60분 전은 가능·59분 전은 마감", () => {
  assert.equal(open(D, "18:00", D, "16:00", 120), true, "정확히 120분 전");
  assert.equal(open(D, "18:00", D, "16:01", 120), false, "119분 전");
  assert.equal(open(D, "18:00", D, "15:59", 120), true);
  assert.equal(open(D, "18:00", D, "17:00", 60), true, "정확히 60분 전");
  assert.equal(open(D, "18:00", D, "17:01", 60), false, "59분 전");
});

test("마감 경계: 0분 = 수업 시작 전까지 — 1분 전은 가능, 시작 시각 정각부터 마감", () => {
  assert.equal(open(D, "18:00", D, "17:59", 0), true);
  assert.equal(open(D, "18:00", D, "18:00", 0), false, "수업이 시작됐다");
  assert.equal(open(D, "18:00", D, "18:01", 0), false);
  assert.equal(open(D, "18:00", D, "00:00", 0), true, "당일 0시");
});

test("마감 경계: 자정을 넘는 계산·지난 날짜·월말·연말·윤년", () => {
  // 자정 직후 수업(01:00)의 120분 전 = 전날 23:00
  assert.equal(open(D, "01:00", "2026-11-15", "23:00", 120), true);
  assert.equal(open(D, "01:00", "2026-11-15", "23:01", 120), false);
  assert.equal(open(D, "01:00", D, "00:00", 120), false, "당일 0시는 이미 60분 전");
  // 전날 밤 → 다음 날 저녁 수업은 열려 있다
  assert.equal(open(D, "18:00", "2026-11-15", "23:59", 120), true);
  // 지난 날짜는 마감 분과 상관없이 항상 닫힘
  for (const cutoff of [0, 60, 120]) {
    assert.equal(open(D, "18:00", "2026-11-17", "00:00", cutoff), false, `하루 지남(${cutoff})`);
    assert.equal(open(D, "23:59", "2026-11-17", "00:00", cutoff), false);
  }
  // 월말·연말·윤년
  assert.equal(open("2026-12-01", "01:00", "2026-11-30", "23:00", 120), true);
  assert.equal(open("2027-01-01", "01:00", "2026-12-31", "23:01", 120), false);
  assert.equal(open("2028-03-01", "01:00", "2028-02-29", "23:00", 120), true, "윤년 2/29 다음 날은 3/1");
  assert.equal(open("2027-03-01", "01:00", "2027-02-28", "23:00", 120), true, "평년 2/28 다음 날은 3/1");
});

test("마감: 시작 시각을 모르면 전날까지(당일 0시부터 닫힘) · 입력이 잘못되면 닫힘", () => {
  for (const unknown of [null, undefined, "", "미정", "25:00"]) {
    for (const cutoff of [0, 60, 120]) {
      assert.equal(open(D, unknown, "2026-11-15", "23:59", cutoff), true, `전날은 가능(${unknown})`);
      assert.equal(open(D, unknown, D, "00:00", cutoff), false, `당일은 닫힘(${unknown})`);
    }
  }
  assert.equal(open("bad", "18:00", D, "10:00", 60), false);
  assert.equal(open("2026-02-30", "18:00", "2026-02-01", "10:00", 60), false, "없는 날짜");
  assert.equal(open(D, "18:00", "bad", "10:00", 60), false);
  assert.equal(open("2026-11-17", "18:00", D, "", 60), false, "지금 시각을 모르면 열지 않는다");
  assert.equal(open("2026-11-17", "18:00", D, "10:00", Number.NaN), false);
  assert.equal(open("2026-11-17", "18:00", D, "10:00", -1), false);
});

test("결석의 옛 함수(isAbsenceChangeOpen)는 공용 함수에 60분을 넣어 부르는 껍데기 — 답이 같다", () => {
  const source = read("src/lib/regular/regularAbsenceRules.ts");
  assert.match(source, /return isChangeOpen\(classYmd, startTime, nowYmd, nowHm, ABSENCE_CHANGE_CUTOFF_MINUTES\);/);
  assert.equal(rules.ABSENCE_CHANGE_CUTOFF_MINUTES, 60);
  assert.equal(rules.ABSENCE_CHANGE_CLOSED_MESSAGE, CLOSED);
  for (const [classYmd, start, nowYmd, nowHm] of [
    [D, "18:00", D, "17:00"], [D, "18:00", D, "17:01"], [D, "00:30", "2026-11-15", "23:30"], [D, "00:30", "2026-11-15", "23:31"],
    [D, null, "2026-11-15", "23:59"], [D, null, D, "00:00"], [D, "18:00", "2026-11-17", "09:00"], ["bad", "18:00", D, "10:00"],
  ]) {
    assert.equal(rules.isAbsenceChangeOpen(classYmd, start, nowYmd, nowHm), open(classYmd, start, nowYmd, nowHm, 60));
  }
});

// 2026-11-15 마감 1시간 전 통일: 예전 «등원·둘 다 = 2시간 전 / 하원 = 수업 시작 전» → 방향과 상관없이 1시간 전
test("셔틀 마감(순수): 가장 이른 수업 1시간 전까지(등원·하원 구분 없음) / 수업 없는 날 = 전날까지", () => {
  const s = deadline.isShuttleChangeOpen;
  assert.equal(s.length, 4, "방향 인자가 없다 — 등원·하원·둘 다 같은 마감");
  // 그 날 수업이 둘(18:00·16:00)이면 가장 이른 16:00 기준
  assert.equal(deadline.earliestStartTime(["18:00", "16:00", null, "미정"]), "16:00");
  assert.equal(s(D, ["18:00", "16:00"], D, "15:00"), true, "정확히 60분 전");
  assert.equal(s(D, ["18:00", "16:00"], D, "15:01"), false, "59분 전");
  assert.equal(s(D, ["18:00"], D, "17:00"), true);
  assert.equal(s(D, ["18:00"], D, "17:01"), false);
  assert.equal(s(D, ["18:00"], D, "16:01"), true, "예전 등원 마감(2시간 전)이 지난 시각도 이제 열려 있다");
  assert.equal(s(D, ["18:00"], D, "17:59"), false, "예전 하원 마감(수업 시작 전)이던 시각은 이제 닫혀 있다");
  // 그 날짜에 수업이 없다(요일이 안 맞는다) → 전날까지
  assert.equal(s(D, [], "2026-11-15", "23:59"), true);
  assert.equal(s(D, [], D, "00:00"), false, "당일은 닫힘");
  assert.equal(s(D, ["18:00"], "2026-11-17", "00:00"), false, "지난 날짜");
});

// 2026-11-15 마감 1시간 전 통일: 예전 «전날까지(당일 닫힘)» → 보강 수업 시작 1시간 전까지(당일도 그 전이면 열림)
test("보강 마감(순수): 보강 수업 시작 1시간 전까지 — 당일 60분 전 열림·59분 전 닫힘, 지난 날은 닫힘", () => {
  const m = deadline.isMakeupChangeOpen;
  assert.equal(m("2026-11-16", "17:00", "2026-11-15", "23:59"), true, "전날");
  assert.equal(m("2026-11-16", "17:00", "2026-11-16", "00:00"), true, "당일 0시");
  assert.equal(m("2026-11-16", "17:00", "2026-11-16", "16:00"), true, "정확히 60분 전");
  assert.equal(m("2026-11-16", "17:00", "2026-11-16", "16:01"), false, "59분 전");
  assert.equal(m("2026-11-16", "17:00", "2026-11-16", "17:00"), false);
  assert.equal(m("2026-11-16", "17:00", "2026-11-17", "00:00"), false, "지난 보강");
  assert.equal(m("2027-01-01", "00:30", "2026-12-31", "23:30"), true, "연말·자정 넘김");
  assert.equal(m("2027-01-01", "00:30", "2026-12-31", "23:31"), false);
  assert.equal(m("2028-03-01", "10:00", "2028-02-29", "23:59"), true, "윤년");
  // 반 시작 시각을 모르면 전날까지(당일 닫힘)
  for (const unknown of [null, undefined, "", "미정"]) {
    assert.equal(m("2026-11-16", unknown, "2026-11-15", "23:59"), true);
    assert.equal(m("2026-11-16", unknown, "2026-11-16", "00:00"), false);
  }
  assert.equal(m(null, "17:00", "2026-11-16", "10:00"), false);
  assert.equal(m("bad", "17:00", "2026-11-16", "10:00"), false);
  // 문구: 마감 뒤(당일)면 공통 마감 글, 날짜가 지났으면 «지난 보강» — 틀린 말을 하지 않는다
  assert.equal(deadline.makeupClosedMessage("2026-11-16", "2026-11-16"), CLOSED);
  assert.match(deadline.makeupClosedMessage("2026-11-16", "2026-11-17"), /이미 지난 보강/);
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
      { id: "cO", name: "월요반", dayOfWeek: "Mon", startTime: "18:00", endTime: "19:30", capacity: 10, enrolled: 5, grades: ["초5"] },
      { id: "cA", name: "화요반", dayOfWeek: "Tue", startTime: "17:00", endTime: "18:30", capacity: 10, enrolled: 5, grades: ["초4", "초5", "초6"] },
      { id: "cW", name: "수요반", dayOfWeek: "Wed", startTime: "17:00", endTime: "18:30", capacity: 10, enrolled: 5, grades: ["초5"] },
    ],
    enrollments: [
      { studentId: "s1", classId: "cO", status: "ACTIVE" },
      { studentId: "s9", classId: "cO", status: "ACTIVE" },
    ],
    absences: [],    // { id, studentId, classId, date, reason, status }
    credits: [],     // { id, studentId, sourceKey, status, absenceDate, expiresAt, originClassId, makeupSessionId }
    sessions: [],    // { id, studentId, makeupClassId, makeupDate(Date), status }
    exceptions: [],  // { id, studentId, serviceDate, direction, kind, location, note, canceled }
    notices: [],
    periods: [],     // 기간 결석 { id, studentId, reason, startDate, returnDate, status, reportedByUserId, openEnded }
    periodReady: false, // true = 학부모 «여러 날 결석» 칸이 있는 운영(마이그레이션 20261115100000 적용 뒤)
    holidays: [],    // 연간 일정 휴무일("YYYY-MM-DD")
    reviews: [],     // 질병·부상 이월 검토 { absenceId, status, source, reasonText }
    evidence: [],    // 증빙 사진 { id, absenceId, removed }
    illnessReady: false, // true = 검토 표가 있는 운영(마이그레이션 적용 뒤)
    creditStatusLog: [], // 보강권 상태가 바뀔 때마다 적는다 — «AVAILABLE 로 돌아간 순간»이 없었는지 본다
    seatRechecks: 0,
    raceBooked: {},
    failOn: null,    // 이 정규식에 맞는 문장에서 DB 오류를 낸다(트랜잭션 되돌림 확인용)
    seq: 0,
    ...overrides,
  };
  const student = (id) => db.students.find((row) => row.id === id);
  const cls = (id) => db.classes.find((row) => row.id === id);
  const owns = (studentId, parentId) => student(studentId)?.parentId === parentId;
  const stamp = () => String(20261116000000000000n + BigInt(++db.seq));
  const setCredit = (credit, status) => { credit.status = status; db.creditStatusLog.push(status); };
  const boom = (sql) => { if (db.failOn && db.failOn.test(sql)) throw new Error("synthetic DB failure"); };
  const kstOnce = (sql) => {
    // timestamptz → KST 변환은 «한 번»(두 번 걸면 9시간 밀린다)
    assert.match(sql, /"makeupDate" AT TIME ZONE 'Asia\/Seoul'/);
    // (main 병합: 같은 문장이 학생 생년월일 — 시간대 없는 timestamp — 을 «두 번» 변환해 읽는다. 그쪽은 맞는 규칙이라 makeupDate 만 본다)
    assert.doesNotMatch(sql, /"makeupDate" AT TIME ZONE 'UTC'|"makeupDate"\) AT TIME ZONE/);
  };

  // 가짜 연간 일정: 그 달(YYYY-MM)의 그 요일 날짜 전부 − 휴무일
  db.classDates = (ym, dow) => {
    const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dow);
    const out = [];
    for (let ymd = `${ym}-01`; ymd.slice(0, 7) === ym; ymd = kst.addDaysKst(ymd, 1)) if (kst.kstDow(ymd) === index && !db.holidays.includes(ymd)) out.push(ymd);
    return out;
  };

  async function $queryRawUnsafe(sql, ...args) {
    // ── 여러 날 결석(기간) ──
    // 내 아이의 쓸 수 있는 반(하루 알리기 목록과 같은 조회 — listParentUsableClasses)
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && sql.includes('c."dayOfWeek" AS "dayOfWeek"')) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건");
      return db.enrollments.filter((e) => e.status === "ACTIVE" && owns(e.studentId, args[0])).map((e) => {
        const c = cls(e.classId);
        return { studentId: e.studentId, studentName: student(e.studentId).name, classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, enrollmentStatus: e.status, resumeFrom: null };
      });
    }
    if (/information_schema\.columns/.test(sql)) return [{ n: db.periodReady ? 3 : 0 }];
    if (/to_regclass/.test(sql) && /RegularAbsencePeriod/.test(sql)) return [{ found: db.periodReady ? "present" : null }];
    if (/FROM "RegularAbsence" ra\s+WHERE ra\."studentId" = \$1 AND ra\.date BETWEEN \$2::date AND \$3::date AND ra\.status <> 'CANCELLED'/.test(sql)) {
      return db.absences.filter((a) => a.studentId === args[0] && a.date >= args[1] && a.date <= args[2] && a.status !== "CANCELLED").map((a) => ({ classId: a.classId, date: a.date }));
    }
    if (/FROM "RegularAbsencePeriod" WHERE "studentId" = \$1 AND status IN \('ACTIVE','ENDED'\)/.test(sql)) {
      return db.periods.filter((p) => p.studentId === args[0] && ["ACTIVE", "ENDED"].includes(p.status)).map((p) => ({ startDate: p.startDate, returnDate: p.returnDate }));
    }
    // 오늘(KST) 그 아이로 만든 학부모 기간 수 — 취소한 것도 센다
    if (/SELECT COUNT\(\*\)::int AS n FROM "RegularAbsencePeriod"/.test(sql)) {
      assert.match(sql, /"reportedByUserId" IS NOT NULL\s+AND \("createdAt" AT TIME ZONE 'Asia\/Seoul'\)::date = \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/, "timestamptz → KST 변환은 한 번");
      return [{ n: db.periods.filter((p) => p.studentId === args[0] && p.reportedByUserId && p.createdYmd === kst.todayKst()).length }];
    }
    if (/INSERT INTO "RegularAbsencePeriod"/.test(sql)) {
      assert.ok(db.lockedInTx, "작업대 잠금 뒤에 기간을 만든다");
      const row = { id: `per${++db.seq}`, studentId: args[0], reason: args[1], startDate: args[2], returnDate: args[3], coveredUntil: args[4], status: "ACTIVE", createdByUserId: args[5], reportedByUserId: args[5], openEnded: args[6], createdYmd: kst.todayKst() };
      db.periods.push(row);
      return [{ id: row.id, version: stamp() }];
    }
    if (/FROM "RegularAbsencePeriod" p\s+JOIN "Student" s ON s\.id = p\."studentId"/.test(sql) && /FOR UPDATE OF p/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건");
      assert.match(sql, /p\."reportedByUserId" IS NOT NULL/, "학부모가 알린 기간만(관리자 기간은 건드리지 못한다)");
      return db.periods.filter((p) => p.id === args[1] && p.reportedByUserId && owns(p.studentId, args[0]))
        .map((p) => ({ id: p.id, studentId: p.studentId, studentName: student(p.studentId).name, startDate: p.startDate, returnDate: p.returnDate, status: p.status }));
    }
    if (/WHERE ra\."periodId" = \$1 AND ra\."studentId" = \$2 AND ra\.date >= \$3::date AND ra\.status = 'REPORTED'/.test(sql)) {
      return db.absences.filter((a) => a.periodId === args[0] && a.studentId === args[1] && a.date >= args[2] && a.status === "REPORTED")
        .sort((a, b) => a.date.localeCompare(b.date)).map((a) => ({ id: a.id, classId: a.classId, date: a.date, startTime: cls(a.classId).startTime }));
    }
    if (/UPDATE "RegularAbsencePeriod"\s+SET status = '(ENDED|CANCELLED)'/.test(sql)) {
      const p = db.periods.find((x) => x.id === args[0]);
      if (!p) return [];
      if (/SET status = 'ENDED'/.test(sql)) Object.assign(p, { status: "ENDED", returnDate: args[1], endedByUserId: args[2] });
      else Object.assign(p, { status: "CANCELLED", endedByUserId: args[2] });
      return [{ version: stamp() }];
    }
    boom(sql);
    // ── 결석: 소유·수강 확인 ──
    if (/FROM "Enrollment" e\s+JOIN "Student" s ON s\.id = e\."studentId"\s+JOIN "Class" c ON c\.id = e\."classId"/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건");
      const row = owns(args[1], args[0]) ? db.enrollments.find((e) => e.studentId === args[1] && e.classId === args[2] && e.status === "ACTIVE") : null;
      const c = cls(args[2]);
      return row ? [{ dayOfWeek: c.dayOfWeek, startTime: c.startTime, studentName: student(args[1]).name, className: c.name, enrollmentStatus: row.status, resumeFrom: null }] : [];
    }
    // ── 결석: 옛 신고 취소(UPDATE … RETURNING) — 날짜 바꾸기 ──
    if (/UPDATE "RegularAbsence" ra\s+SET status = 'CANCELLED'/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "소유 검사는 기존과 같은 조건");
      assert.match(sql, /ra\.status = 'REPORTED'/, "확정건은 옮겨지지 않는다");
      const row = db.absences.find((a) => a.status === "REPORTED" && owns(a.studentId, args[0])
        && a.studentId === args[1] && a.classId === args[2] && a.date === args[3]);
      if (!row) return [];
      row.status = "CANCELLED";
      const c = cls(row.classId);
      return [{ id: row.id, reason: row.reason, studentName: student(row.studentId).name, className: c.name, classId: c.id, studentId: row.studentId, date: row.date, startTime: c.startTime, eventVersion: stamp(), resumeFrom: null }];
    }
    if (/SELECT status, reason FROM "RegularAbsence"/.test(sql)) {
      return db.absences.filter((a) => a.studentId === args[0] && a.classId === args[1] && a.date === args[2]).map((a) => ({ status: a.status, reason: a.reason }));
    }
    if (/INSERT INTO "RegularAbsence"/.test(sql)) {
      const [studentId, classId, date, reason] = args;
      const found = db.absences.find((a) => a.studentId === studentId && a.classId === classId && a.date === date);
      if (!found) {
        const row = { id: `ra${++db.seq}`, studentId, classId, date, reason, status: "REPORTED" };
        db.absences.push(row);
        return [{ id: row.id, eventVersion: stamp() }];
      }
      if (found.status !== "CANCELLED") return [];
      found.reason = reason; found.status = "REPORTED";
      return [{ id: found.id, eventVersion: stamp() }];
    }
    // ── 보강권 발급·되돌리기 ──
    // 질병·부상 이월 검토 표(2026-11-14) — 기본은 표 없음(예전 방식)
    if (/to_regclass/.test(sql)) return /RegularAbsenceCarryReview/.test(sql) && db.illnessReady ? [{ review: "present", evidence: "present" }] : [{ found: null, ready: false }];
    if (/FROM "RegularAbsenceCarryReview" WHERE "absenceId" = \$1 FOR UPDATE/.test(sql)) {
      return db.reviews.filter((r) => r.absenceId === args[0]).map((r) => ({ status: r.status, source: r.source, reasonText: r.reasonText }));
    }
    if (/SELECT status FROM "MakeupCredit" WHERE "studentId" = \$1 AND "sourceKey" = \$2 FOR UPDATE/.test(sql)) {
      return db.credits.filter((c) => c.studentId === args[0] && c.sourceKey === args[1]).map((c) => ({ status: c.status }));
    }
    if (/FROM "RegularAbsence" WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return db.absences.filter((a) => a.id === args[0]).map((a) => ({ studentId: a.studentId, classId: a.classId, absenceYmd: a.date, reason: a.reason, status: a.status }));
    }
    if (/INSERT INTO "MakeupCredit"/.test(sql)) {
      const found = db.credits.find((c) => c.studentId === args[0] && c.sourceKey === args[1]);
      if (!found) {
        const row = { id: `mc${++db.seq}`, studentId: args[0], sourceKey: args[1], absenceDate: new Date(args[2]), expiresAt: new Date(args[3]), originClassId: args[4], status: "AVAILABLE", makeupSessionId: null };
        db.credits.push(row);
        return [{ id: row.id }];
      }
      if (found.status === "REVOKED" && found.makeupSessionId == null) { found.status = "AVAILABLE"; return [{ id: found.id }]; }
      return [];
    }
    if (/FROM "MakeupCredit" mc/.test(sql) && /FOR UPDATE OF mc/.test(sql)) {
      // 2026-11-15 마감 1시간 전 통일: SQL 은 «보강 날짜(KST 글자)·반 시작 시각»만 주고, 판정은 앱이 공용 함수로 한다
      kstOnce(sql);
      assert.match(sql, /to_char\(ms\."makeupDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "bookingYmd"/);
      assert.match(sql, /bc\."startTime" AS "bookingStartTime"/);
      assert.doesNotMatch(sql, /"makeupDate" < now\(\)|::date <= \(now\(\)/);
      const c = db.credits.find((x) => x.studentId === args[0] && x.sourceKey === args[1]);
      const session = c ? db.sessions.find((row) => row.id === c.makeupSessionId) : null;
      return c ? [{ id: c.id, status: c.status, makeupSessionId: c.makeupSessionId, bookingYmd: session ? kst.toKstYmd(session.makeupDate) : null, bookingStartTime: session ? cls(session.makeupClassId).startTime : null }] : [];
    }
    if (/FROM "Attendance" a/.test(sql)) return [];
    // ── 보강: 내 보강권 목록 ──
    if (/bc\.name AS "bookedClassName"/.test(sql)) {
      kstOnce(sql);
      assert.match(sql, /to_char\(ms\."makeupDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "bookedYmd"/);
      return db.credits.filter((c) => owns(c.studentId, args[0])).map((c) => {
        const session = db.sessions.find((row) => row.id === c.makeupSessionId);
        return {
          id: c.id, studentId: c.studentId, studentName: student(c.studentId).name, studentGrade: student(c.studentId).grade,
          sourceType: "REGULAR", absenceDate: c.absenceDate, expiresAt: c.expiresAt, status: c.status, makeupSessionId: c.makeupSessionId,
          bookedDate: session?.makeupDate ?? null, bookedClassName: session ? cls(session.makeupClassId).name : null,
          bookedClassId: session?.makeupClassId ?? null, bookedYmd: session ? kst.toKstYmd(session.makeupDate) : null,
          bookedStartTime: session ? cls(session.makeupClassId).startTime : null,
        };
      });
    }
    // ── 보강: 취소·날짜 바꾸기의 소유 확인(예약 중인 보강권 + 보강 날짜의 KST 글자) ──
    if (/AS "makeupYmd"/.test(sql)) {
      kstOnce(sql);
      assert.match(sql, /s\."parentId" = \$2 AND mc\.status = 'RESERVED' LIMIT 1/);
      const c = db.credits.find((x) => x.id === args[0]);
      if (!c || !owns(c.studentId, args[1]) || c.status !== "RESERVED") return [];
      const session = db.sessions.find((row) => row.id === c.makeupSessionId);
      assert.match(sql, /bc\."startTime" AS "makeupStartTime"/, "마감 판정에 쓸 보강 반 시작 시각");
      return [{ ...c, bookedClassId: session?.makeupClassId ?? null, makeupYmd: session ? kst.toKstYmd(session.makeupDate) : null, makeupStartTime: session ? cls(session.makeupClassId).startTime : null }];
    }
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2 AND mc\.status = 'AVAILABLE' LIMIT 1/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0]);
      return c && owns(c.studentId, args[1]) && c.status === "AVAILABLE" ? [{ ...c, studentGrade: student(c.studentId).grade }] : [];
    }
    // ── 보강: 후보 조회의 소유 확인(지금 예약한 반·날짜도 함께) ──
    if (/WHERE mc\.id = \$1 AND s\."parentId" = \$2\s+LIMIT 1/.test(sql)) {
      kstOnce(sql);
      const c = db.credits.find((x) => x.id === args[0]);
      if (!c || !owns(c.studentId, args[1])) return [];
      const session = db.sessions.find((row) => row.id === c.makeupSessionId);
      return [{ ...c, studentGrade: student(c.studentId).grade, bookedClassId: session?.makeupClassId ?? null, bookedYmd: session ? kst.toKstYmd(session.makeupDate) : null }];
    }
    if (/FROM "Class" c\s+JOIN "Program" p ON p\.id = c\."programId"/.test(sql)) {
      return db.classes.map((c) => ({
        classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, endTime: c.endTime, capacity: c.capacity,
        gradesJson: JSON.stringify(c.grades), gradeRangeText: null, enrolled: c.enrolled,
      }));
    }
    // main 병합: 수강 중인 반 = 다니는 반 + 휴원 중인 자기 반(ACTIVE·PAUSED) — 둘 다 보강 후보에서 뺀다
    if (/SELECT e\."classId" AS "classId" FROM "Enrollment" e WHERE e\."studentId" = \$1 AND e\.status IN \('ACTIVE', 'PAUSED'\)/.test(sql)) {
      return db.enrollments.filter((e) => e.studentId === args[0] && ["ACTIVE", "PAUSED"].includes(e.status)).map((e) => ({ classId: e.classId }));
    }
    if (/FROM "MakeupSession" m/.test(sql) && /GROUP BY 1, 2/.test(sql)) {
      const counts = new Map();
      for (const row of db.sessions) {
        if (row.status === "CANCELLED" || row.makeupDate.getTime() < new Date(args[0]).getTime()) continue;
        const key = `${row.makeupClassId}|${kst.toKstYmd(row.makeupDate)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts].map(([key, booked]) => ({ classId: key.split("|")[0], ymd: key.split("|")[1], booked }));
    }
    if (/SELECT id FROM "MakeupCredit" WHERE id=\$1 AND status='RESERVED'/.test(sql)) {
      assert.match(sql, /FOR UPDATE/);
      assert.match(sql, /s\."parentId" = \$3/, "잠금 조회에도 소유 조건");
      const c = db.credits.find((x) => x.id === args[0] && x.status === "RESERVED" && (x.makeupSessionId ?? null) === (args[1] ?? null) && owns(x.studentId, args[2]));
      return c ? [{ id: c.id }] : [];
    }
    if (/FROM "Class" c WHERE c\.id = \$1 LIMIT 1/.test(sql)) {
      // 트랜잭션 안의 정원 재확인 — 반드시 잠금 뒤에 온다
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
    // ── 셔틀: 자녀 목록 / 소유 검증 ──
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && /e\.status AS status/.test(sql)) {
      const single = /WHERE s\.id = \$1/.test(sql);
      const parentId = single ? args[1] : args[0];
      return db.enrollments
        .filter((e) => e.status === "ACTIVE" && owns(e.studentId, parentId) && (!single || e.studentId === args[0]))
        .map((e) => ({ id: e.studentId, name: student(e.studentId).name, studentId: e.studentId, studentName: student(e.studentId).name, status: e.status, resumeFrom: null }));
    }
    // ── 셔틀: 마감 기준 — 쓸 수 있는 수강 반의 요일·시작 시각 ──
    if (/FROM "Enrollment" e\s+JOIN "Class" c ON c\.id = e\."classId"\s+WHERE e\."studentId" = ANY\(\$1::text\[\]\)/.test(sql)) {
      return db.enrollments.filter((e) => e.status === "ACTIVE" && args[0].includes(e.studentId)).map((e) => {
        const c = cls(e.classId);
        return { studentId: e.studentId, dayOfWeek: c.dayOfWeek, startTime: c.startTime, status: e.status, resumeFrom: null };
      });
    }
    // ── 셔틀: 한 건 읽기(취소·옮기기의 마감 판정 / 결과 재확인) ──
    if (/\(x\."canceledAt" IS NOT NULL\) AS canceled/.test(sql)) {
      assert.match(sql, /s\."parentId"\s*=\s*\$2/, "남의 자녀 것은 읽히지 않는다");
      const row = db.exceptions.find((x) => x.id === args[0] && owns(x.studentId, args[1]));
      return row ? [{ ...row, studentName: student(row.studentId).name }] : [];
    }
    // ── 셔틀: 예정 변경 목록 ──
    if (/FROM "ShuttleDayException" x\s+JOIN "Student" s ON s\.id = x\."studentId"/.test(sql) && /x\."serviceDate" >= \$2::date/.test(sql)) {
      return db.exceptions.filter((x) => !x.canceled && owns(x.studentId, args[0]) && x.serviceDate >= args[1])
        .map((x) => ({ ...x, studentName: student(x.studentId).name }));
    }
    // ── 셔틀: 취소(UPDATE … RETURNING) — 취소·옮기기 공용 ──
    if (/UPDATE "ShuttleDayException" x/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "소유 검사는 기존과 같은 조건");
      assert.match(sql, /x\.id = \$2 AND x\."canceledAt" IS NULL/);
      const row = db.exceptions.find((x) => x.id === args[1] && !x.canceled && owns(x.studentId, args[0]));
      if (!row) return [];
      row.canceled = true;
      return [{ ...row, studentName: student(row.studentId).name }];
    }
    // ── 셔틀: 저장(같은 내용이면 그대로, 아니면 같은 날·방향의 살아 있는 것을 취소하고 새로) ──
    if (/WITH guard AS MATERIALIZED/.test(sql)) {
      const [studentId, serviceDate, direction, kind, location, note] = args;
      const live = db.exceptions.filter((x) => !x.canceled && x.studentId === studentId && x.serviceDate === serviceDate && x.direction === direction);
      const same = live.find((x) => x.kind === kind && (x.location ?? null) === (location ?? null) && (x.note ?? null) === (note ?? null));
      if (same) return [{ id: same.id, changed: false }];
      for (const x of live) x.canceled = true;
      const row = { id: `x${++db.seq}`, studentId, serviceDate, direction, kind, location: location ?? null, note: note ?? null, canceled: false };
      db.exceptions.push(row);
      return [{ id: row.id, changed: true }];
    }
    if (/FROM "NotificationDelivery" d/.test(sql)) return [];
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  async function $executeRawUnsafe(sql, ...args) {
    boom(sql);
    if (/pg_advisory_xact_lock/.test(sql)) { db.lockedInTx = true; return 1; }
    if (/UPDATE "RegularAbsence" SET "periodId" = \$2, note = \$3 WHERE id = \$1/.test(sql)) {
      const a = db.absences.find((x) => x.id === args[0]);
      if (!a) return 0;
      a.periodId = args[1]; a.note = args[2];
      return 1;
    }
    if (/UPDATE "RegularAbsence" SET status = 'CANCELLED', "updatedAt" = NOW\(\) WHERE id = \$1 AND status = 'REPORTED'/.test(sql)) {
      const a = db.absences.find((x) => x.id === args[0] && x.status === "REPORTED");
      if (!a) return 0;
      a.status = "CANCELLED";
      return 1;
    }
    // 기간의 마지막 살아 있는 검토가 닫히면 그 기간 결석들에 붙은 사진을 전부 뺀다(하루 결석은 0행)
    if (/UPDATE "RegularAbsenceEvidence" e SET "removedAt" = now\(\)\s+FROM "RegularAbsence" me\s+JOIN "RegularAbsence" member ON member\."periodId" = me\."periodId"/.test(sql)) {
      assert.match(sql, /lr\.status IN \('PENDING', 'APPROVED', 'MAKEUP'\)\s+WHERE live\."periodId" = me\."periodId" AND live\.status <> 'CANCELLED'/);
      const me = db.absences.find((a) => a.id === args[0]);
      if (!me?.periodId) return 0;
      const members = db.absences.filter((a) => a.periodId === me.periodId);
      const alive = members.some((a) => a.status !== "CANCELLED" && ["PENDING", "APPROVED", "MAKEUP"].includes(db.reviews.find((r) => r.absenceId === a.id)?.status));
      if (alive) return 0;
      let n = 0;
      for (const e of db.evidence) if (members.some((m) => m.id === e.absenceId) && !e.removed) { e.removed = true; n += 1; }
      return n;
    }
    // 여러 날 결석(2026-11-15): 옮긴 날을 같은 기간에 묶는다 — 기간 없는 하루 신고는 0행
    if (/UPDATE "RegularAbsence" n SET "periodId" = o\."periodId", note = o\.note/.test(sql)) {
      const from = db.absences.find((a) => a.id === args[0]);
      const to = db.absences.find((a) => a.id === args[1]);
      if (!from?.periodId || !to) return 0;
      to.periodId = from.periodId; to.note = from.note;
      return 1;
    }
    // ── 질병·부상 이월 검토 ──
    if (/UPDATE "MakeupCredit"\s+SET status = 'REVOKED'/.test(sql) && /"sourceKey" = \$2 AND status = 'AVAILABLE'/.test(sql)) {
      const c = db.credits.find((x) => x.studentId === args[0] && x.sourceKey === args[1] && x.status === "AVAILABLE");
      if (!c) return 0;
      setCredit(c, "REVOKED");
      return 1;
    }
    if (/UPDATE "RegularAbsenceEvidence" SET "absenceId" = \$2 WHERE "absenceId" = \$1 AND "removedAt" IS NULL/.test(sql)) {
      let n = 0;
      for (const e of db.evidence) if (e.absenceId === args[0] && !e.removed) { e.absenceId = args[1]; n += 1; }
      return n;
    }
    if (/UPDATE "RegularAbsenceEvidence" SET "removedAt" = now\(\) WHERE "absenceId" = \$1/.test(sql)) {
      let n = 0;
      for (const e of db.evidence) if (e.absenceId === args[0] && !e.removed) { e.removed = true; n += 1; }
      return n;
    }
    if (/UPDATE "RegularAbsenceCarryReview"\s+SET status = 'CLOSED'/.test(sql)) {
      const found = db.reviews.find((r) => r.absenceId === args[0] && args[1].includes(r.status));
      if (!found) return 0;
      found.status = "CLOSED";
      return 1;
    }
    if (/INSERT INTO "RegularAbsenceCarryReview"/.test(sql)) {
      const toMakeup = /VALUES \(\$1, 'MAKEUP'/.test(sql);
      const found = db.reviews.find((r) => r.absenceId === args[0]);
      const next = toMakeup ? { status: "MAKEUP", source: "STAFF", reasonText: null } : { status: "PENDING", source: args[1], reasonText: args[2] };
      if (!found) { db.reviews.push({ absenceId: args[0], ...next }); return 1; }
      if (!["PENDING", "CLOSED"].includes(found.status)) return 0;
      Object.assign(found, toMakeup ? { status: "MAKEUP" } : next);
      return 1;
    }
    if (/UPDATE "MakeupCredit"\s+SET status = 'REVOKED'/.test(sql)) {
      const need = /status = 'RESERVED'/.test(sql) ? "RESERVED" : "AVAILABLE";
      const c = db.credits.find((x) => x.id === args[0] && x.status === need);
      if (!c) return 0;
      setCredit(c, "REVOKED");
      return 1;
    }
    if (/UPDATE "MakeupSession" SET status\s*=\s*'CANCELLED'/.test(sql)) {
      const row = db.sessions.find((x) => x.id === args[0]);
      if (!row || (/status\s*=\s*'BOOKED'/.test(sql) && row.status !== "BOOKED")) return 0;
      row.status = "CANCELLED";
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET status='RESERVED'/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0] && x.status === "AVAILABLE" && owns(x.studentId, args[1]));
      if (!c) return 0;
      setCredit(c, "RESERVED");
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET status='AVAILABLE', "makeupSessionId"=NULL/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0]);
      setCredit(c, "AVAILABLE"); c.makeupSessionId = null;
      return 1;
    }
    if (/UPDATE "MakeupCredit" SET "makeupSessionId"=\$2/.test(sql)) {
      const c = db.credits.find((x) => x.id === args[0] && (!/status='RESERVED'/.test(sql) || x.status === "RESERVED"));
      if (!c) return 0;
      c.makeupSessionId = args[1];
      return 1;
    }
    throw new Error(`예상하지 않은 실행: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  /** 트랜잭션: 안에서 오류가 나면 표를 통째로 되돌린다(진짜 DB 의 ROLLBACK 흉내) */
  async function $transaction(fn) {
    const snapshot = structuredClone({ absences: db.absences, credits: db.credits, sessions: db.sessions, exceptions: db.exceptions, reviews: db.reviews, evidence: db.evidence, periods: db.periods });
    db.lockedInTx = false;
    db.transactions = (db.transactions ?? 0) + 1;
    try {
      return await fn({ $queryRawUnsafe, $executeRawUnsafe });
    } catch (error) {
      Object.assign(db, snapshot);
      throw error;
    } finally {
      db.lockedInTx = false;
    }
  }

  Object.assign(db, { $queryRawUnsafe, $executeRawUnsafe, $transaction });
  globalThis.__moveDb = db;
  return db;
}

const SUN = "2026-11-15"; // 일요일 — 대부분의 시나리오가 «전날»에서 시작한다
const MON = "2026-11-16"; // 월요반(18:00) 수업일
const NEXT_MON = "2026-11-23";
const TUE = "2026-11-17"; // 화요반(17:00) 수업일
const NEXT_TUE = "2026-11-24";

/** 사진 찍기 — 실패한 뒤 «아무것도 안 바뀌었다»를 비교한다 */
const picture = (db) => JSON.stringify({ absences: db.absences, credits: db.credits, sessions: db.sessions, exceptions: db.exceptions });

// ═════════════════════════════════════════════════════════════════════════
// ② 보강 — KST 날짜 비교(예약·취소)
// ═════════════════════════════════════════════════════════════════════════
/** 예약된 보강 한 건(보강권 RESERVED + 예약 BOOKED). stored = 보강 날짜가 저장된 절대 시각 */
function seedBooking(db, { stored, classId = "cA", studentId = "s1", expiresYmd = "2026-12-20", creditId = "mcB" } = {}) {
  const session = { id: `ms-${creditId}`, studentId, originalClassId: "cO", makeupClassId: classId, makeupDate: new Date(stored), status: "BOOKED" };
  const credit = { id: creditId, studentId, sourceKey: "REGULAR:cO:2026-11-09", status: "RESERVED", absenceDate: new Date(at("2026-11-09")), expiresAt: new Date(at(expiresYmd)), originClassId: "cO", makeupSessionId: session.id };
  db.sessions.push(session); db.credits.push(credit);
  return { session, credit };
}
// 같은 «11월 17일 보강»이 두 가지 시각으로 저장돼 있다
const STORED = {
  "학부모 예약(KST 자정)": at(TUE),
  "관리자 예약(UTC 자정 = KST 09:00)": new Date(`${TUE}T00:00:00Z`).getTime(),
};

// 2026-11-15 마감 1시간 전 통일: 예전에는 «당일은 0시부터 하루 종일 거절»이었다. 이제 화요반(17:00) 보강은 당일 16:00 까지 취소된다.
for (const [label, stored] of Object.entries(STORED)) {
  test(`보강 취소 — ${label}: 당일도 수업 시작 1시간 전(16:00)까지는 취소되고, 16:01 부터 거절`, async () => {
    // 열려 있는 시각: 전날 밤 · 당일 0시 · 08:59 · 09:01(UTC 자정 저장분의 저장 시각 앞뒤) · 정확히 60분 전
    for (const [ymd, hm] of [[MON, "23:59"], [TUE, "00:00"], [TUE, "08:59"], [TUE, "09:01"], [TUE, "16:00"]]) {
      const db = makeDb();
      seedBooking(db, { stored });
      freeze(ymd, hm);
      const result = await makeup.cancelMakeupBooking("p1", "mcB");
      assert.equal(result.ok, true, `${ymd} ${hm}: ${result.message}`);
      assert.equal(db.sessions[0].status, "CANCELLED");
      assert.equal(db.credits[0].status, "AVAILABLE", "보강권은 그대로 돌아온다");
      assert.equal(db.credits[0].makeupSessionId, null);
    }
    // 닫힌 시각: 59분 전 · 수업 시작 · 수업 뒤 — 공통 마감 글, 아무것도 바뀌지 않는다
    for (const hm of ["16:01", "17:00", "23:59"]) {
      const db = makeDb();
      seedBooking(db, { stored });
      freeze(TUE, hm);
      const before = picture(db);
      assert.deepEqual(await makeup.cancelMakeupBooking("p1", "mcB"), { ok: false, message: CLOSED }, `당일 ${hm}`);
      assert.equal(picture(db), before);
    }
  });

  test(`보강 취소 — ${label}: 지난 보강은 «이미 지난 보강» 문구로 거절`, async () => {
    const db = makeDb();
    seedBooking(db, { stored });
    freeze("2026-11-18", "00:00");
    const result = await makeup.cancelMakeupBooking("p1", "mcB");
    assert.equal(result.ok, false);
    assert.match(result.message, /이미 지난 보강은 취소할 수 없습니다/);
    assert.equal(db.credits[0].status, "RESERVED");
  });

  test(`보강 목록 — ${label}: 줄마다 changeOpen(당일 60분 전 true · 59분 전 false)과 KST 날짜를 내려 준다`, async () => {
    const db = makeDb();
    seedBooking(db, { stored });
    freeze(TUE, "16:00");
    let booking = (await makeup.getMakeupOverviewForParent("p1")).credits[0].booking;
    assert.equal(booking.dateYmd, TUE, "저장 시각이 달라도 같은 KST 날짜");
    assert.equal(booking.classId, "cA");
    assert.equal(booking.changeOpen, true);
    freeze(TUE, "16:01");
    booking = (await makeup.getMakeupOverviewForParent("p1")).credits[0].booking;
    assert.equal(booking.changeOpen, false);
    assert.ok(db.credits.length === 1);
  });
}

test("보강 취소: 남의 자녀 예약은 취소되지 않는다(기존 검사 유지)", async () => {
  const db = makeDb();
  seedBooking(db, { stored: at(TUE), studentId: "s9" });
  freeze(SUN, "10:00");
  assert.deepEqual(await makeup.cancelMakeupBooking("p1", "mcB"), { ok: false, message: "취소할 예약이 없습니다." });
  assert.equal(db.credits[0].status, "RESERVED");
});

// 2026-11-15 마감 1시간 전 통일: 예전에는 «오늘은 받지 않는다(전날까지)»였다. 이제 오늘 수업도 시작 1시간 전까지 후보·예약이 된다.
test("보강 예약: 오늘 수업도 시작 1시간 전까지는 후보에 있고 예약된다 — 59분 전부터는 후보에서 빠지고 서버가 거절", async () => {
  const seed = () => {
    const db = makeDb();
    db.credits.push({ id: "mcA", studentId: "s1", sourceKey: "REGULAR:cO:2026-11-09", status: "AVAILABLE", absenceDate: new Date(at("2026-11-09")), expiresAt: new Date(at("2026-12-20")), originClassId: "cO", makeupSessionId: null });
    return db;
  };
  const datesOf = async (classId) => (await makeup.getMakeupOptionsForCredit("p1", "mcA")).options.find((o) => o.classId === classId)?.dates.map((d) => d.ymd) ?? [];
  // 화요일 16:00(화요반 17:00 의 정확히 60분 전) — 오늘이 후보 맨 앞에 있고 예약된다
  let db = seed();
  freeze(TUE, "16:00");
  assert.equal((await datesOf("cA"))[0], TUE);
  assert.equal((await makeup.bookMakeup("p1", { creditId: "mcA", classId: "cA", dateYmd: TUE })).ok, true);
  assert.equal(kst.toKstYmd(db.sessions[0].makeupDate), TUE);
  assert.equal(db.sessions[0].makeupDate.getTime(), at(TUE), "저장은 그 날 KST 자정 그대로");
  // 16:01 — 오늘은 후보에서 빠지고(다음 주부터), 직접 보내도 거절
  db = seed();
  freeze(TUE, "16:01");
  assert.equal((await datesOf("cA"))[0], NEXT_TUE);
  let result = await makeup.bookMakeup("p1", { creditId: "mcA", classId: "cA", dateYmd: TUE });
  assert.equal(result.ok, false);
  assert.match(result.message, BOOK_CLOSED);
  // 지난 날짜
  result = await makeup.bookMakeup("p1", { creditId: "mcA", classId: "cA", dateYmd: "2026-11-10" });
  assert.equal(result.ok, false);
  assert.match(result.message, BOOK_CLOSED);
  assert.equal(db.sessions.length, 0);
});

// 2026-11-15 마감 1시간 전 통일: 예전에는 «보강 당일이면 막힌다»였다. 이제 보강 수업 시작 1시간 전까지는 함께 취소되고, 그 뒤에 막힌다.
test("결석 신고 취소의 «예약한 보강의 취소 마감»도 같은 규칙 — 보강 수업 1시간 전까지는 함께 취소, 그 뒤는 막힌다(저장 시각 무관)", async () => {
  for (const stored of Object.values(STORED)) {
    const seed = () => {
      const db = makeDb();
      // 11-23(월) 결석을 신고했고, 그 보강권으로 11-17(화 17:00) 보강이 잡혀 있다
      db.absences.push({ id: "raX", studentId: "s1", classId: "cO", date: NEXT_MON, reason: "PERSONAL", status: "REPORTED" });
      const { credit } = seedBooking(db, { stored });
      credit.sourceKey = `REGULAR:cO:${NEXT_MON}`;
      return db;
    };
    const cancel = () => absence.cancelRegularAbsence("p1", { studentId: "s1", classId: "cO", date: NEXT_MON, confirmMakeupCancel: true });
    // 보강 59분 전 — «보강 예약도 함께 취소»를 확인하고 눌러도 막힌다
    let db = seed();
    freeze(TUE, "16:01");
    await assert.rejects(cancel, /^Error: MAKEUP_BOOKING_PAST$/);
    assert.equal(db.absences[0].status, "REPORTED");
    assert.equal(db.sessions[0].status, "BOOKED");
    // 보강 당일 오전·정확히 60분 전 — 함께 취소된다
    for (const hm of ["08:00", "16:00"]) {
      db = seed();
      freeze(TUE, hm);
      const result = await cancel();
      assert.equal(result.makeupBookingCanceled, true, hm);
      assert.equal(db.absences[0].status, "CANCELLED");
      assert.equal(db.sessions[0].status, "CANCELLED");
      assert.equal(db.credits[0].status, "REVOKED");
    }
  }
  assert.match(read("src/app/api/mypage/regular-absence/route.ts"), /MAKEUP_BOOKING_PAST: "예약한 보강의 취소 마감\(수업 시작 1시간 전\)이 지나 결석 신고를 취소할 수 없어요/);
  // 판정은 SQL 이 아니라 학부모 보강 취소와 같은 함수
  assert.match(read("src/lib/makeup/absence-report-credit.ts"), /!isMakeupChangeOpen\(credit\.bookingYmd, credit\.bookingStartTime, todayKst\(nowMs\), kstHm\(nowMs\)\)/);
});

test("카카오 보강 취소도 같은 판정 함수 — 마감 여부를 따로 비교하지 않는다", () => {
  const source = read("src/lib/kakao-makeup-flow.ts");
  assert.match(source, /import \{ isMakeupChangeOpen, PARENT_CHANGE_CUTOFF_TEXT \} from "@\/lib\/parent\/changeDeadline";/);
  assert.match(source, /return isMakeupChangeOpen\(item\.dateYmd, item\.startTime \?\? null, todayKst\(nowMs\), kstHm\(nowMs\)\);/);
  assert.equal((source.match(/if \(!reservationOpen\(item\)\) \{/g) || []).length, 2, "번호 고를 때 + 확정 순간");
  assert.doesNotMatch(source, /item\.dateYmd <= today|item\.dateYmd === today/);
  // 2026-11-15 마감 1시간 전 통일: «당일 취소 불가» 문구는 없다 — 안내는 «수업 시작 1시간 전까지»
  assert.doesNotMatch(source, /당일 취소 불가|당일 취소는 안|하루 전까지/);
  assert.match(source, /취소는 수업 시작 \$\{PARENT_CHANGE_CUTOFF_TEXT\} 전까지 할 수 있어요/);
  // 웹 서버 함수는 시각 비교를 버렸다
  const web = read("src/lib/makeup/parent-makeup.ts");
  assert.doesNotMatch(web, /makeupDate\)\.getTime\(\) < Date\.now\(\)/);
  assert.match(web, /if \(row\.makeupYmd && !isMakeupChangeOpen\(row\.makeupYmd, row\.makeupStartTime, clock\.ymd, clock\.hm\)\) \{\s*return \{ ok: false, message: makeupClosedMessage\(row\.makeupYmd, clock\.ymd\) \};/);
  assert.doesNotMatch(web, /하루 전까지|전날까지\)/);
});

// ═════════════════════════════════════════════════════════════════════════
// ③ 셔틀 — 신청·취소의 서버 마감
// ═════════════════════════════════════════════════════════════════════════
const SKIP = { studentId: "s1", kind: "SKIP" };

// 2026-11-15 마감 1시간 전 통일: 예전 «등원·둘 다 16:00 까지 / 하원 17:59 까지» → 방향과 상관없이 17:00 까지
test("셔틀 신청: 등원·하원·둘 다 모두 수업 시작 1시간 전까지 — 지나면 저장·알림 없이 거절", async () => {
  // s1 은 월요반(18:00)을 다닌다
  for (const direction of ["PICKUP", "DROPOFF", "BOTH"]) {
    for (const [hm, ok] of [["16:01", true], ["17:00", true], ["17:01", false], ["17:59", false], ["18:00", false], ["23:00", false]]) {
      const db = makeDb();
      freeze(MON, hm);
      const result = await shuttle.submitShuttleException("p1", { ...SKIP, serviceDate: MON, direction });
      assert.equal(result.ok, ok, `${direction} ${hm}`);
      if (!ok) assert.equal(result.message, CLOSED);
      assert.equal(db.exceptions.length, ok ? 1 : 0);
      assert.equal(db.notices.length, ok ? 1 : 0);
    }
  }
});

test("셔틀 신청: 그 날짜에 수업이 없으면(요일이 안 맞으면) 전날까지 — 예전에는 당일 밤에도 저장됐다", async () => {
  // 화요일(11-17)은 s1 의 수업이 없는 날
  let db = makeDb();
  freeze(MON, "23:59");
  assert.equal((await shuttle.submitShuttleException("p1", { ...SKIP, serviceDate: TUE, direction: "PICKUP" })).ok, true, "전날 밤");
  assert.equal(db.exceptions.length, 1);
  for (const hm of ["00:00", "08:00", "22:00"]) {
    db = makeDb();
    freeze(TUE, hm);
    assert.deepEqual(await shuttle.submitShuttleException("p1", { ...SKIP, serviceDate: TUE, direction: "DROPOFF" }), { ok: false, message: CLOSED }, hm);
    assert.equal(db.exceptions.length, 0);
  }
});

test("셔틀 취소: 지난 날짜·마감 뒤에는 서버가 거절한다(예전에는 소유만 보고 취소됐다) — 줄은 그대로 남는다", async () => {
  const row = (extra) => ({ id: "x1", studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "SKIP", location: null, note: null, canceled: false, ...extra });
  // 지난 날짜
  let db = makeDb({ exceptions: [row({ serviceDate: "2026-11-13" })] });
  freeze(SUN, "10:00");
  assert.deepEqual(await shuttle.cancelShuttleException("p1", "x1"), { ok: false, message: CLOSED });
  assert.equal(db.exceptions[0].canceled, false);
  assert.equal(db.notices.length, 0);
  // 2026-11-15 마감 1시간 전 통일: 당일 수업 1시간 전이 지나면 등원·하원·둘 다 모두 닫힌다(예전: 하원은 17:59 까지 취소됐다)
  for (const direction of ["PICKUP", "DROPOFF", "BOTH"]) {
    db = makeDb({ exceptions: [row({ direction })] });
    freeze(MON, "17:01");
    assert.deepEqual(await shuttle.cancelShuttleException("p1", "x1"), { ok: false, message: CLOSED }, direction);
    assert.equal(db.exceptions[0].canceled, false);
    // 정확히 1시간 전에는 취소된다
    freeze(MON, "17:00");
    assert.equal((await shuttle.cancelShuttleException("p1", "x1")).ok, true, direction);
    assert.equal(db.exceptions[0].canceled, true);
    assert.equal(db.notices.length, 1);
  }
  // 이미 취소한 것을 다시 누르면 실패가 아니다(기존 동작 유지) · 남의 자녀 것은 찾을 수 없다
  assert.equal((await shuttle.cancelShuttleException("p1", "x1")).noOp, true);
  assert.deepEqual(await shuttle.cancelShuttleException("p9", "x1"), { ok: false, message: "취소할 신청을 찾을 수 없습니다." });
});

test("셔틀 목록: 줄마다 changeOpen 을 내려 준다 — 화면이 버튼 대신 마감 글을 보인다", async () => {
  makeDb({ exceptions: [
    { id: "x1", studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "SKIP", location: null, note: null, canceled: false },
    { id: "x2", studentId: "s1", serviceDate: MON, direction: "DROPOFF", kind: "SKIP", location: null, note: null, canceled: false },
    { id: "x3", studentId: "s1", serviceDate: TUE, direction: "PICKUP", kind: "SKIP", location: null, note: null, canceled: false },
  ] });
  // 2026-11-15 마감 1시간 전 통일: 예전(16:30 — 등원만 닫힘·하원 열림) → 방향 구분 없이 1시간 전
  freeze(MON, "17:00");
  assert.deepEqual((await shuttle.getShuttleExceptionOptions("p1")).upcoming.map((row) => [row.id, row.changeOpen]), [["x1", true], ["x2", true], ["x3", true]]);
  freeze(MON, "17:01"); // 오늘(월) 것은 등원·하원 모두 닫히고, 내일(화) 것은 열려 있다
  const options = await shuttle.getShuttleExceptionOptions("p1");
  assert.deepEqual(options.upcoming.map((row) => [row.id, row.changeOpen]), [["x1", false], ["x2", false], ["x3", true]]);
  const client = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(client, /item\.changeOpen === false \? \(\s*\/\/[^\n]*\n\s*<span className="basis-full text-xs[^"]*">\{CHANGE_CLOSED_MESSAGE\}<\/span>/);
});

test("카카오 셔틀 경로는 같은 서버 함수를 지난다 — 마감 문구가 그대로 전달된다", () => {
  const kakao = read("src/lib/kakao-shuttle-flow.ts");
  assert.match(kakao, /const result = await submitShuttleException\(state\.parentUserId, \{/);
  assert.match(kakao, /const result = await cancelShuttleException\(flow\.state\.parentUserId, item\.id\);/);
  assert.match(kakao, /셔틀 변경을 못 했어요: \$\{result\.message\}/);
  assert.match(kakao, /셔틀 변경 취소를 못 했어요: \$\{result\.message\}/);
  // 서버: 신청·취소·옮기기 세 곳 모두 같은 판정(shuttleOpen → changeDeadline.isShuttleChangeOpen)
  const web = read("src/lib/shuttle/parent-shuttle-exception.ts");
  assert.ok((web.match(/!shuttleOpen\(/g) || []).length >= 4, "신청 1 + 취소 1 + 옮기기 2(옛 날짜·새 날짜)");
  assert.match(web, /return isShuttleChangeOpen\(ymd, startTimesOn\(rows, ymd\), now\.ymd, now\.hm\);/);
  // 운행 시각 글자(arriveTime)는 형식이 불확실해 기준으로 쓰지 않는다 — 반 시작 시각만
  assert.doesNotMatch(web, /arriveTime/);
});

// ═════════════════════════════════════════════════════════════════════════
// ④-1 결석 신고 날짜 바꾸기
// ═════════════════════════════════════════════════════════════════════════
/** 신고된 결석 한 건 + 그 보강권(사용 가능) */
function seedAbsence(db, { date = MON, status = "REPORTED", reason = "FAMILY_TRIP", creditStatus = "AVAILABLE", studentId = "s1" } = {}) {
  const row = { id: `ra-${date}`, studentId, classId: "cO", date, reason, status };
  db.absences.push(row);
  if (creditStatus) {
    db.credits.push({ id: `mc-${date}`, studentId, sourceKey: `REGULAR:cO:${date}`, status: creditStatus, absenceDate: new Date(at(date)), expiresAt: new Date(at("2027-01-16")), originClassId: "cO", makeupSessionId: null });
  }
  return row;
}
const MOVE = { studentId: "s1", classId: "cO", date: MON, toDate: NEXT_MON };

test("결석 날짜 바꾸기: 한 트랜잭션에서 옛 신고 취소 + 새 날짜 신고 — 사유는 그대로, 보강권은 옛 것 회수·새 것 발급", async () => {
  const db = makeDb();
  seedAbsence(db);
  freeze(SUN, "10:00");
  const result = await absence.moveRegularAbsence("p1", MOVE);
  assert.equal(result.ok, true);
  assert.equal(result.to, NEXT_MON);
  assert.equal(db.transactions, 1, "한 트랜잭션");
  assert.deepEqual(db.absences.map((a) => [a.date, a.status, a.reason]), [[MON, "CANCELLED", "FAMILY_TRIP"], [NEXT_MON, "REPORTED", "FAMILY_TRIP"]]);
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [[`REGULAR:cO:${MON}`, "REVOKED"], [`REGULAR:cO:${NEXT_MON}`, "AVAILABLE"]]);
  assert.equal(kst.toKstYmd(db.credits[1].absenceDate), NEXT_MON, "새 보강권의 결석일·만료는 새 날짜 기준");
});

// ═════════════════════════════════════════════════════════════════════════
// ④-2 학부모 «여러 날 결석»(2026-11-15 원장 결정: 한도 4주·모든 사유) — 실제 실행
//   월요반(cO, 18:00) 아이가 11/16(월)부터 쉰다. 오늘 = 11/15(일).
// ═════════════════════════════════════════════════════════════════════════
const period = await import(load("src/lib/regular/parent-absence-period.ts"));
const LAST_MON = "2026-11-30";
const PERIOD_IN = { studentId: "s1", startDate: MON, endDate: "2026-12-06", reason: "FAMILY_TRIP" };

test("여러 날 결석: 그 사이 수업일을 한 번에 알린다 — 날짜마다 하루 신고와 같은 결과(보강권 1장씩), 알림은 기간당 1회", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  const preview = await period.previewParentAbsencePeriod("p1", PERIOD_IN);
  assert.deepEqual([preview.count, preview.datesLabel, preview.skippedNote], [3, "11/16(월) · 11/23(월) · 11/30(월) 3회", null]);
  assert.equal(db.absences.length, 0, "미리보기는 아무것도 저장하지 않는다");

  const result = await period.createParentAbsencePeriod("p1", PERIOD_IN);
  assert.deepEqual([result.ok, result.count, result.makeupCredits, result.carryPending, result.evidenceAbsenceId], [true, 3, 3, false, null]);
  assert.equal(db.transactions, 1, "기간·결석·보강권이 한 트랜잭션");
  assert.deepEqual(db.periods.map((p) => [p.studentId, p.reason, p.startDate, p.returnDate, p.coveredUntil, p.status, p.reportedByUserId, p.openEnded]),
    [["s1", "FAMILY_TRIP", MON, "2026-12-07", "2026-12-06", "ACTIVE", "p1", false]], "끝일(마지막으로 쉬는 날) 다음 날이 복귀일");
  assert.deepEqual(db.absences.map((a) => [a.date, a.status, a.reason, a.periodId]), [MON, NEXT_MON, LAST_MON].map((d) => [d, "REPORTED", "FAMILY_TRIP", db.periods[0].id]));
  assert.ok(db.absences.every((a) => a.note === "여러 날 결석 · 11/16(월)~12/6(일)"), "note 머리말 = 알림 재조정이 날짜마다 다시 알리지 않게 하는 표시");
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [MON, NEXT_MON, LAST_MON].map((d) => [`REGULAR:cO:${d}`, "AVAILABLE"]));
  // 원장·코치·기사 알림은 날짜마다가 아니라 한 번
  assert.equal(db.notices.length, 1);
  assert.deepEqual([db.notices[0].eventType, db.notices[0].includeCoach, db.notices[0].includeDriver], ["REGULAR_ABSENCE_REPORTED", true, true]);
  assert.match(db.notices[0].message, /지유 학생이 11\/16\(월\)~11\/30\(월\) 3회 결석 예정입니다\. \(가족 여행\)/);
  assert.deepEqual(db.notices[0].driverContext, { studentId: "s1", serviceDate: MON });
  assert.match(db.notices[0].stableEventKey, new RegExp(`^regular-absence-period:${db.periods[0].id}:REPORTED:`));
});

test("여러 날 결석: 휴무일·이미 알린 날·마감 지난 오늘 수업은 자동으로 빼고 그 사실을 한 줄로 알린다", async () => {
  const db = makeDb({ periodReady: true, holidays: [NEXT_MON] });
  seedAbsence(db, { date: LAST_MON }); // 11/30 은 이미 하루로 알렸다
  freeze(MON, "17:30"); // 오늘(11/16) 18:00 수업 — 마감(1시간 전) 지남
  const preview = await period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-12-13" });
  assert.equal(preview.datesLabel, "12/7(월) 1회");
  assert.equal(preview.skippedNote, "휴무일 1회 · 이미 알린 날 1회 · 마감 지난 오늘 수업 1회는 뺐어요.");
  const result = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-12-13" });
  assert.equal(result.count, 1);
  assert.deepEqual(db.absences.filter((a) => a.periodId).map((a) => a.date), ["2026-12-07"]);
  // 알릴 수업이 하나도 없으면 기간도 만들지 않는다
  const none = makeDb({ periodReady: true, holidays: [MON] });
  freeze(SUN, "10:00");
  await assert.rejects(() => period.createParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-11-20" }), /^Error: PERIOD_NO_DATES$/);
  assert.equal(none.periods.length, 0);
});

test("여러 날 결석 한도: 4주(28일)까지 — 넘으면 휴원 안내 코드, 끝일 «아직 몰라요»는 4주까지만 잡는다", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  // 오늘 11/15 → 알릴 수 있는 마지막 날 12/12(오늘 +27일). 시작일이 11/16 이어도 12/13 은 넘는다
  await assert.rejects(() => period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-12-13" }), /^Error: PERIOD_TOO_LONG$/, "오늘 +28일");
  assert.equal((await period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-12-12" })).count, 4, "오늘 +27일까지는 된다");
  await assert.rejects(() => period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, startDate: "2026-11-14" }), /^Error: PERIOD_START_PAST$/);
  await assert.rejects(() => period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, startDate: "2026-12-13", endDate: "2026-12-14" }), /^Error: PERIOD_START_TOO_FAR$/);
  await assert.rejects(() => period.previewParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-11-15" }), /^Error: PERIOD_END_BEFORE_START$/);
  // 끝일 미정
  const open = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: null });
  assert.equal(open.count, 4);
  assert.deepEqual([db.periods[0].openEnded, db.periods[0].returnDate], [true, "2026-12-13"], "오늘 +27일(12/12)까지 쉬고 다음 날이 복귀일");
  assert.deepEqual(db.absences.map((a) => a.date), [MON, NEXT_MON, LAST_MON, "2026-12-07"]);
});

test("여러 날 결석(질병·부상): 사유 글 필수 · 날짜마다 «이월 검토 중»(보강권 없음) · 사진은 기간의 첫 결석에 한 묶음 · 알림에 사유 글 없음", async () => {
  const db = makeDb({ periodReady: true, illnessReady: true });
  freeze(SUN, "10:00");
  await assert.rejects(() => period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "ILLNESS_INJURY" }), /^Error: ILLNESS_REASON_TEXT_REQUIRED$/);
  assert.equal(db.periods.length, 0);
  const result = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "ILLNESS_INJURY", reasonText: "발목 골절" });
  assert.deepEqual([result.count, result.makeupCredits, result.carryPending], [3, 0, true]);
  assert.equal(result.evidenceAbsenceId, db.absences[0].id, "화면이 사진을 올릴 결석 = 기간의 첫 결석");
  assert.equal(db.credits.length, 0);
  assert.deepEqual(db.reviews.map((r) => [r.status, r.source, r.reasonText]), Array(3).fill(["PENDING", "PARENT", "발목 골절"]));
  assert.equal(db.notices.length, 1);
  assert.equal(db.notices[0].linkUrl, "/admin/inbox?kind=ILLNESS_CARRY");
  assert.doesNotMatch(JSON.stringify(db.notices[0]), /발목|골절/);
});

test("여러 날 결석 권한·중복: 내 아이만, 이미 알린 기간과 겹치면 거절, 준비 전(칸 없음)이면 기능 자체를 닫는다", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  await assert.rejects(() => period.createParentAbsencePeriod("p9", PERIOD_IN), /^Error: NOT_OWNER$/, "남의 아이");
  await assert.rejects(() => period.previewParentAbsencePeriod("p9", PERIOD_IN), /^Error: NOT_OWNER$/);
  await assert.rejects(() => period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "놀러감" }), /^Error: INVALID_REASON$/);
  assert.equal(db.periods.length + db.absences.length, 0);
  await period.createParentAbsencePeriod("p1", PERIOD_IN);
  await assert.rejects(() => period.createParentAbsencePeriod("p1", { ...PERIOD_IN, startDate: "2026-12-01", endDate: "2026-12-10" }), /^Error: PERIOD_OVERLAP$/);
  assert.deepEqual([db.periods.length, db.absences.length, db.notices.length], [1, 3, 1], "거절된 요청은 아무것도 남기지 않는다");
  // 겹치지 않으면 된다(복귀일 12/7 부터)
  assert.equal((await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, startDate: "2026-12-07", endDate: "2026-12-12" })).count, 1);

  const notReady = makeDb();
  await assert.rejects(() => period.createParentAbsencePeriod("p1", PERIOD_IN), /^Error: PERIOD_NOT_READY$/);
  await assert.rejects(() => period.previewParentAbsencePeriod("p1", PERIOD_IN), /^Error: PERIOD_NOT_READY$/);
  assert.equal(notReady.periods.length, 0);
});

test("복귀했어요: 복귀일부터의 결석만 취소(보강권 회수·검토 닫기) — 지난 날·마감 지난 오늘 수업은 그대로, 알림 1회", async () => {
  const db = makeDb({ periodReady: true, illnessReady: true });
  freeze(SUN, "10:00");
  await period.createParentAbsencePeriod("p1", PERIOD_IN);
  const periodId = db.periods[0].id;
  db.notices.length = 0;
  // 11/23(월) 17:30 — 오늘 수업은 마감 지남. 오늘 복귀한다고 알린다
  freeze(NEXT_MON, "17:30");
  const result = await period.closeParentAbsencePeriod("p1", { periodId, returnDate: NEXT_MON });
  assert.deepEqual([result.outcome, result.canceledCount, result.closedByDeadline, result.makeupKept], ["ENDED", 1, 1, 0]);
  assert.deepEqual(db.absences.map((a) => [a.date, a.status]), [[MON, "REPORTED"], [NEXT_MON, "REPORTED"], [LAST_MON, "CANCELLED"]]);
  assert.deepEqual(db.credits.map((c) => c.status), ["AVAILABLE", "AVAILABLE", "REVOKED"], "취소된 날의 보강권만 회수");
  assert.deepEqual([db.periods[0].status, db.periods[0].returnDate], ["ENDED", NEXT_MON]);
  assert.equal(db.notices.length, 1);
  assert.equal(db.notices[0].eventType, "REGULAR_ABSENCE_CANCELED");
  assert.match(db.notices[0].message, /11\/30\(월\) 1회 결석 신고가 취소되었습니다/);
  // 이미 끝난 기간은 다시 못 닫는다 / 남의 아이 기간은 «없음»
  await assert.rejects(() => period.closeParentAbsencePeriod("p1", { periodId, returnDate: NEXT_MON }), /^Error: PERIOD_ALREADY_CLOSED$/);
  await assert.rejects(() => period.closeParentAbsencePeriod("p9", { periodId, returnDate: NEXT_MON }), /^Error: PERIOD_NOT_FOUND$/);
});

test("알림 취소·복귀일 범위: 시작 전에 접으면 기간째 취소, 보강이 예약된 날은 그대로 두고 개수로 알린다", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  await period.createParentAbsencePeriod("p1", PERIOD_IN);
  const periodId = db.periods[0].id;
  await assert.rejects(() => period.closeParentAbsencePeriod("p1", { periodId, returnDate: "2026-11-14" }), /^Error: PERIOD_RETURN_PAST$/);
  await assert.rejects(() => period.closeParentAbsencePeriod("p1", { periodId, returnDate: "2026-12-08" }), /^Error: PERIOD_RETURN_AFTER_END$/);
  await assert.rejects(() => period.closeParentAbsencePeriod("p1", { periodId, returnDate: "" }), /^Error: PERIOD_INVALID_DATE$/);
  // 11/23 결석의 보강권으로 보강을 예약해 둔 상태
  Object.assign(db.credits[1], { status: "RESERVED", makeupSessionId: "ms-1" });
  const result = await period.closeParentAbsencePeriod("p1", { periodId, returnDate: SUN }); // 알림 취소 = 오늘부터
  assert.deepEqual([result.outcome, result.canceledCount, result.makeupKept], ["CANCELLED", 2, 1]);
  assert.deepEqual(db.absences.map((a) => a.status), ["CANCELLED", "REPORTED", "CANCELLED"], "보강이 예약된 날은 하루 취소 화면에서 확인하고 취소한다");
  assert.deepEqual(db.credits.map((c) => c.status), ["REVOKED", "RESERVED", "REVOKED"]);
  assert.equal(db.periods[0].status, "CANCELLED");
  // 실패하면 통째로 되돌아간다
  const broken = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  await period.createParentAbsencePeriod("p1", PERIOD_IN);
  // 두 번째 날을 취소하는 순간 DB 오류 — 첫 날의 취소·보강권 회수까지 되돌아가야 한다
  broken.failOn = { n: 0, test(sql) { return /UPDATE "RegularAbsence" SET status = 'CANCELLED', "updatedAt" = NOW\(\) WHERE id = \$1/.test(sql) && ++this.n === 2; } };
  await assert.rejects(() => period.closeParentAbsencePeriod("p1", { periodId: broken.periods[0].id, returnDate: SUN }));
  assert.deepEqual(broken.absences.map((a) => a.status), ["REPORTED", "REPORTED", "REPORTED"]);
  assert.deepEqual(broken.credits.map((c) => c.status), ["AVAILABLE", "AVAILABLE", "AVAILABLE"]);
});

test("기간을 전부 취소하면 진단서 사진도 빠지고, 같은 날짜를 다시 알려도 옛 사진이 붙지 않는다", async () => {
  const db = makeDb({ periodReady: true, illnessReady: true });
  freeze(SUN, "10:00");
  const first = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "ILLNESS_INJURY", reasonText: "독감" });
  // 사진은 기간의 첫 결석에 붙는다
  db.evidence.push({ id: "e1", absenceId: first.evidenceAbsenceId, removed: false });
  // 뒤 두 날만 취소(복귀) — 첫 날이 아직 검토 중이라 사진은 남는다
  await period.closeParentAbsencePeriod("p1", { periodId: first.periodId, returnDate: NEXT_MON });
  assert.equal(db.evidence[0].removed, false);
  assert.deepEqual(db.reviews.map((r) => r.status), ["PENDING", "CLOSED", "CLOSED"]);

  // 통째로 취소한 경우: 사진이 붙은 날이 먼저 닫히고 나머지가 뒤에 닫혀도 마지막에 전부 빠진다
  const all = makeDb({ periodReady: true, illnessReady: true });
  freeze(SUN, "10:00");
  const created = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "ILLNESS_INJURY", reasonText: "독감" });
  all.evidence.push({ id: "e1", absenceId: created.evidenceAbsenceId, removed: false }, { id: "e2", absenceId: all.absences[2].id, removed: false });
  const closed = await period.closeParentAbsencePeriod("p1", { periodId: created.periodId, returnDate: SUN });
  assert.deepEqual([closed.outcome, closed.canceledCount], ["CANCELLED", 3]);
  assert.deepEqual(all.evidence.map((e) => e.removed), [true, true], "전부 취소 뒤 살아 있는 사진 0장");

  // 같은 날짜를 다시 알린다 — 결석 행은 되살아나지만(같은 id) 옛 사진은 빠진 상태 그대로
  const again = await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, reason: "ILLNESS_INJURY", reasonText: "독감" });
  assert.notEqual(again.periodId, created.periodId);
  const members = all.absences.filter((a) => a.periodId === again.periodId).map((a) => a.id);
  assert.equal(members.length, 3);
  assert.equal(all.evidence.filter((e) => members.includes(e.absenceId) && !e.removed).length, 0, "새 기간에 살아 있는 사진 0장");
  assert.deepEqual(all.reviews.map((r) => r.status), ["PENDING", "PENDING", "PENDING"]);
});

test("만들기·취소 반복 제한: 아이당 하루(KST) 5번까지 — 취소한 것도 세고, 날이 바뀌면 다시 된다", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  for (let i = 0; i < 5; i += 1) {
    const made = await period.createParentAbsencePeriod("p1", PERIOD_IN);
    await period.closeParentAbsencePeriod("p1", { periodId: made.periodId, returnDate: SUN }); // 바로 취소
  }
  await assert.rejects(() => period.createParentAbsencePeriod("p1", PERIOD_IN), /^Error: PERIOD_DAILY_LIMIT$/);
  assert.equal(db.periods.length, 5, "여섯 번째는 기간도 결석도 만들지 않는다");
  assert.ok(db.absences.every((a) => a.status === "CANCELLED"));
  // KST 자정이 지나면 다시 알릴 수 있다(11/15 23:59 → 11/16 00:00)
  freeze(SUN, "23:59");
  await assert.rejects(() => period.createParentAbsencePeriod("p1", PERIOD_IN), /^Error: PERIOD_DAILY_LIMIT$/);
  freeze(MON, "00:00");
  assert.equal((await period.createParentAbsencePeriod("p1", PERIOD_IN)).ok, true);
});

test("여러 날 결석의 한 날을 날짜 바꾸기 하면 옮긴 날도 같은 기간에 묶인다(사진 묶음·복귀했어요가 그대로 닿게)", async () => {
  const db = makeDb({ periodReady: true });
  freeze(SUN, "10:00");
  await period.createParentAbsencePeriod("p1", { ...PERIOD_IN, endDate: "2026-11-29" }); // 11/16·11/23
  await absence.moveRegularAbsence("p1", { studentId: "s1", classId: "cO", date: NEXT_MON, toDate: LAST_MON });
  const moved = db.absences.find((a) => a.date === LAST_MON);
  assert.deepEqual([moved.status, moved.periodId, moved.note], ["REPORTED", db.periods[0].id, db.absences[0].note]);
});

// 질병·부상 이월 검토(2026-11-14) × 날짜 바꾸기 — 날짜를 바꿔도 «검토 대기» 규칙을 돌아갈 수 없다
test("결석 날짜 바꾸기(질병·부상 검토 중): 사진·사유 글이 새 날짜로 옮겨 가고 새 날짜도 «검토 중» — 보강권은 나가지 않는다", async () => {
  const db = makeDb({ illnessReady: true });
  const old = seedAbsence(db, { reason: "ILLNESS_INJURY", creditStatus: null });
  db.reviews.push({ absenceId: old.id, status: "PENDING", source: "PARENT", reasonText: "독감" });
  db.evidence.push({ id: "e1", absenceId: old.id, removed: false }, { id: "e-gone", absenceId: old.id, removed: true });
  freeze(SUN, "10:00");
  const result = await absence.moveRegularAbsence("p1", MOVE);
  assert.equal(result.ok, true);
  const moved = db.absences.find((a) => a.date === NEXT_MON);
  assert.deepEqual([moved.status, moved.reason], ["REPORTED", "ILLNESS_INJURY"]);
  assert.equal(db.credits.length, 0, "새 날짜에도 보강권이 바로 나가지 않는다");
  assert.deepEqual(db.reviews.map((r) => [r.absenceId, r.status, r.source, r.reasonText]),
    [[old.id, "CLOSED", "PARENT", "독감"], [moved.id, "PENDING", "PARENT", "독감"]]);
  assert.deepEqual(db.evidence.map((e) => [e.id, e.absenceId, e.removed]), [["e1", moved.id, false], ["e-gone", old.id, true]], "살아 있는 사진만 새 결석으로 옮긴다");
});

test("결석 날짜 바꾸기(원장이 이미 [보강권으로] 정한 결석): 결정을 새 날짜로 가져간다 — 옛 보강권 회수·새 보강권 1장", async () => {
  const db = makeDb({ illnessReady: true });
  const old = seedAbsence(db, { reason: "ILLNESS_INJURY" });
  db.reviews.push({ absenceId: old.id, status: "MAKEUP", source: "PARENT", reasonText: "독감" });
  freeze(SUN, "10:00");
  await absence.moveRegularAbsence("p1", MOVE);
  const moved = db.absences.find((a) => a.date === NEXT_MON);
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [[`REGULAR:cO:${MON}`, "REVOKED"], [`REGULAR:cO:${NEXT_MON}`, "AVAILABLE"]]);
  assert.deepEqual(db.reviews.map((r) => [r.absenceId, r.status]), [[old.id, "CLOSED"], [moved.id, "MAKEUP"]]);
});

test("결석 날짜 바꾸기(다른 사유): 표가 있어도 예전 그대로 — 옛 보강권 회수·새 보강권 발급", async () => {
  const db = makeDb({ illnessReady: true });
  seedAbsence(db, { reason: "FAMILY_TRIP" });
  freeze(SUN, "10:00");
  await absence.moveRegularAbsence("p1", MOVE);
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [[`REGULAR:cO:${MON}`, "REVOKED"], [`REGULAR:cO:${NEXT_MON}`, "AVAILABLE"]]);
  assert.equal(db.reviews.length, 0);
});

test("결석 날짜 바꾸기(검토 줄 없는 옛 질병·부상 결석): 새 날짜에서 «검토 중»으로 통일 — 옛 보강권 회수, 새 보강권은 나가지 않는다", async () => {
  const db = makeDb({ illnessReady: true });
  seedAbsence(db, { reason: "ILLNESS_INJURY" }); // 이 기능 이전 신고: 보강권 있음·검토 줄 없음
  freeze(SUN, "10:00");
  await absence.moveRegularAbsence("p1", MOVE);
  const moved = db.absences.find((a) => a.date === NEXT_MON);
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [[`REGULAR:cO:${MON}`, "REVOKED"]], "하루 신고와 같은 결과 — 보강권 대신 검토 대기");
  assert.deepEqual(db.reviews.map((r) => [r.absenceId, r.status, r.source, r.reasonText]), [[moved.id, "PENDING", "PARENT", null]]);
});

test("결석 날짜 바꾸기 알림: 기존 알림 두 통(취소 + 새 신고), 다시 눌러도 더 가지 않는다", async () => {
  const db = makeDb();
  seedAbsence(db);
  freeze(SUN, "10:00");
  await absence.moveRegularAbsence("p1", MOVE);
  assert.deepEqual(db.notices.map((n) => n.eventType), ["REGULAR_ABSENCE_CANCELED", "REGULAR_ABSENCE_REPORTED"]);
  assert.deepEqual(db.notices.map((n) => n.title), ["결석 신고 취소", "결석 사전 신고"], "기존 문구 그대로");
  assert.match(db.notices[0].message, new RegExp(`${MON} 월요반 결석 신고가 취소되었습니다`));
  assert.match(db.notices[1].message, new RegExp(`${NEXT_MON} 월요반 수업에 결석 예정입니다\\. \\(가족 여행\\)`));
  // 대상(원장·코치·기사)도 기존과 같다 — 날짜마다 기사님이 달라 날짜를 각각 싣는다
  for (const n of db.notices) { assert.equal(n.includeCoach, true); assert.equal(n.includeDriver, true); }
  assert.deepEqual(db.notices.map((n) => n.driverContext.serviceDate), [MON, NEXT_MON]);
  // 안정 키: 결석 행 id + 그 행의 변경 시각
  assert.match(db.notices[0].stableEventKey, new RegExp(`^regular-absence:ra-${MON}:CANCELED:\\d+$`));
  assert.match(db.notices[1].stableEventKey, /^regular-absence:ra\d+:REPORTED:\d+-[0-9a-f]{64}$/);
  // 같은 옮기기를 다시 누르면 거절되고(옛 신고가 이미 취소됨) 알림은 늘지 않는다
  const before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: ABSENCE_NOT_CANCELABLE$/);
  assert.equal(db.notices.length, 2);
  assert.equal(picture(db), before);
});

test("결석 날짜 바꾸기: 마감은 옛 날짜·새 날짜 양쪽 — 한쪽이라도 지났으면 거절하고 옛 신고가 그대로 남는다", async () => {
  // 옛 날짜 마감(월요일 수업 59분 전)
  let db = makeDb();
  seedAbsence(db);
  freeze(MON, "17:01");
  let before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: ABSENCE_CHANGE_CLOSED$/);
  assert.equal(picture(db), before);
  // 정확히 60분 전에는 옮겨진다
  freeze(MON, "17:00");
  assert.equal((await absence.moveRegularAbsence("p1", MOVE)).ok, true);
  // 새 날짜 마감: 다음 주 신고를 «오늘(마감 지남)»로 옮기려 한다
  db = makeDb();
  seedAbsence(db, { date: NEXT_MON });
  freeze(MON, "17:01");
  before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, date: NEXT_MON, toDate: MON }), /^Error: ABSENCE_CHANGE_CLOSED$/);
  assert.equal(picture(db), before);
  assert.equal(db.notices.length, 0);
  // 지난 날짜로는 옮길 수 없다
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, date: NEXT_MON, toDate: "2026-11-09" }), /^Error: NOT_REPORTABLE_DATE$/);
});

test("결석 날짜 바꾸기: 같은 반의 수업일(4주 범위)로만 — 다른 요일·먼 날짜·같은 날짜는 거절", async () => {
  const db = makeDb();
  seedAbsence(db);
  freeze(SUN, "10:00");
  const before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, toDate: TUE }), /^Error: NOT_REPORTABLE_DATE$/, "월요반인데 화요일");
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, toDate: "2026-12-14" }), /^Error: ABSENCE_TOO_FAR$/, "목록(4주) 밖");
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, toDate: MON }), /^Error: ABSENCE_MOVE_SAME_DATE$/);
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, toDate: "2026-11-31" }), /^Error: (INVALID_DATE|NOT_REPORTABLE_DATE)$/);
  assert.equal(picture(db), before);
  assert.equal((await absence.moveRegularAbsence("p1", { ...MOVE, toDate: "2026-12-07" })).ok, true, "4주째 수업일까지는 된다");
});

test("결석 날짜 바꾸기: 남의 자녀·확정된 신고·새 날짜에 이미 신고가 있는 경우는 거절", async () => {
  // 남의 자녀
  let db = makeDb();
  seedAbsence(db, { studentId: "s9" });
  freeze(SUN, "10:00");
  let before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", { ...MOVE, studentId: "s9" }), /^Error: NOT_OWNER$/);
  assert.equal(picture(db), before);
  // 확정(CONFIRMED)
  db = makeDb();
  seedAbsence(db, { status: "CONFIRMED" });
  before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: ABSENCE_NOT_CANCELABLE$/);
  assert.equal(picture(db), before);
  // 새 날짜에 이미 신고(또는 확정)가 있다 — 옛 신고의 취소까지 되돌아간다
  for (const status of ["REPORTED", "CONFIRMED"]) {
    db = makeDb();
    seedAbsence(db);
    seedAbsence(db, { date: NEXT_MON, status, reason: "ETC" });
    before = picture(db);
    await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: ABSENCE_MOVE_TARGET_TAKEN$/, status);
    assert.equal(picture(db), before);
  }
  // 취소됐던 줄이 있는 날짜로는 옮겨진다(그 줄을 되살린다 — 학생·반·날짜당 한 줄)
  db = makeDb();
  seedAbsence(db);
  seedAbsence(db, { date: NEXT_MON, status: "CANCELLED", reason: "ETC", creditStatus: "REVOKED" });
  assert.equal((await absence.moveRegularAbsence("p1", MOVE)).ok, true);
  assert.deepEqual(db.absences.map((a) => [a.date, a.status, a.reason]), [[MON, "CANCELLED", "FAMILY_TRIP"], [NEXT_MON, "REPORTED", "FAMILY_TRIP"]]);
  assert.deepEqual(db.credits.map((c) => c.status), ["REVOKED", "AVAILABLE"], "회수됐던 새 날짜 보강권은 되살아난다(한 결석 한 장)");
});

test("결석 날짜 바꾸기: 그 결석의 보강권으로 보강이 예약돼 있으면 막는다 — «보강 예약을 먼저» 안내, 예약·보강권은 그대로", async () => {
  const db = makeDb();
  seedAbsence(db, { creditStatus: null });
  const { credit } = seedBooking(db, { stored: at(NEXT_TUE) });
  credit.sourceKey = `REGULAR:cO:${MON}`;
  freeze(SUN, "10:00");
  const before = picture(db);
  await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: ABSENCE_MOVE_MAKEUP_BOOKED$/);
  assert.equal(picture(db), before, "결석·보강권·보강 예약 모두 그대로");
  assert.equal(db.notices.length, 0);
  assert.match(read("src/app/api/mypage/regular-absence/route.ts"), /ABSENCE_MOVE_MAKEUP_BOOKED: "[^"]*보강 예약을 먼저 취소하거나 바꿔 주세요\."/);
  // 보강을 이미 들은 결석도 옮길 수 없다(신고 취소와 같은 규칙) — 되돌린 뒤의 표에서 다시 집는다
  db.credits[0].status = "USED";
  await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /^Error: MAKEUP_ALREADY_USED$/);
  assert.equal(db.absences[0].status, "REPORTED");
});

test("결석 날짜 바꾸기: 중간에 실패하면 전부 되돌아간다 — 옛 신고와 보강권이 그대로 남고 알림도 없다", async () => {
  for (const failOn of [/INSERT INTO "RegularAbsence"/, /INSERT INTO "MakeupCredit"/]) {
    const db = makeDb();
    seedAbsence(db);
    freeze(SUN, "10:00");
    const before = picture(db);
    db.failOn = failOn;
    await assert.rejects(() => absence.moveRegularAbsence("p1", MOVE), /synthetic DB failure/);
    db.failOn = null;
    assert.equal(picture(db), before, String(failOn));
    assert.deepEqual(db.absences.map((a) => a.status), ["REPORTED"]);
    assert.deepEqual(db.credits.map((c) => c.status), ["AVAILABLE"]);
    assert.equal(db.notices.length, 0);
  }
});

// ═════════════════════════════════════════════════════════════════════════
// ④-2 셔틀 변경 날짜 바꾸기
// ═════════════════════════════════════════════════════════════════════════
const shuttleRow = (extra = {}) => ({ id: "x1", studentId: "s1", serviceDate: MON, direction: "PICKUP", kind: "LOCATION", location: "다산초 정문 앞", note: "5분 일찍", canceled: false, ...extra });
const live = (db) => db.exceptions.filter((x) => !x.canceled).map((x) => [x.serviceDate, x.direction, x.kind, x.location, x.note]);

test("셔틀 날짜 바꾸기: 한 트랜잭션에서 옛 신청 취소 + 새 날짜 신청 — 방향·종류·장소·한마디는 그대로", async () => {
  const db = makeDb({ exceptions: [shuttleRow()] });
  freeze(SUN, "10:00");
  const result = await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON });
  assert.equal(result.ok, true);
  assert.equal(result.movedFrom, MON);
  assert.equal(result.movedTo, NEXT_MON);
  assert.equal(db.transactions, 1, "한 트랜잭션");
  assert.equal(db.exceptions[0].canceled, true);
  assert.deepEqual(live(db), [[NEXT_MON, "PICKUP", "LOCATION", "다산초 정문 앞", "5분 일찍"]]);
  // 알림: 기존 두 통(취소 + 새 신청) — 날짜마다 기사님이 달라 각각 그 날짜를 싣는다
  assert.deepEqual(db.notices.map((n) => n.eventType), ["SHUTTLE_DAY_EXCEPTION_CANCELED", "SHUTTLE_DAY_EXCEPTION_SUBMITTED"]);
  assert.deepEqual(db.notices.map((n) => n.title), ["셔틀 당일 변경 취소", "셔틀 당일 변경"], "기존 문구 그대로");
  assert.deepEqual(db.notices.map((n) => n.driverContext.serviceDate), [MON, NEXT_MON]);
  assert.equal(db.notices[0].stableEventKey, "shuttle-day-exception:x1:CANCELED:canceled");
  assert.match(db.notices[1].stableEventKey, new RegExp(`^shuttle-day-exception:${result.id}:SUBMITTED:[0-9a-f]{64}$`));
  // 같은 옮기기를 다시 누르면 «찾을 수 없음»으로 끝나고 알림은 늘지 않는다
  const before = picture(db);
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON }), { ok: false, message: "바꿀 신청을 찾을 수 없습니다." });
  assert.equal(db.notices.length, 2);
  assert.equal(picture(db), before);
});

test("셔틀 날짜 바꾸기: 마감은 옛 날짜·새 날짜 양쪽 — 지났으면 거절하고 옛 신청이 그대로 남는다", async () => {
  // 옛 날짜 마감(수업 59분 전) — 2026-11-15 마감 1시간 전 통일(예전: 등원 119분 전)
  let db = makeDb({ exceptions: [shuttleRow()] });
  freeze(MON, "17:01");
  let before = picture(db);
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON }), { ok: false, message: CLOSED });
  assert.equal(picture(db), before);
  // 새 날짜 마감: 다음 주 신청을 오늘(마감 지남)로
  db = makeDb({ exceptions: [shuttleRow({ serviceDate: NEXT_MON })] });
  before = picture(db);
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: MON }), { ok: false, message: CLOSED });
  assert.equal(picture(db), before);
  // 새 날짜가 수업 없는 날(화요일)이면 전날까지 — 월요일 밤에는 되고 화요일 0시에는 안 된다
  freeze(TUE, "00:00");
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: TUE }), { ok: false, message: CLOSED });
  freeze(MON, "23:59");
  assert.equal((await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: TUE })).ok, true);
  assert.equal(db.notices.length, 2);
  // 지난 날짜·너무 먼 날짜·같은 날짜는 기존 날짜 검사가 그대로 막는다
  db = makeDb({ exceptions: [shuttleRow()] });
  freeze(SUN, "10:00");
  before = picture(db);
  assert.equal((await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: "2026-11-13" })).message, "지난 날짜는 바꿀 수 없습니다.");
  assert.equal((await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: "2026-12-07" })).message, "14일 이내로 선택해 주세요.");
  assert.match((await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: MON })).message, /지금 신청한 날짜와 같습니다/);
  assert.equal(picture(db), before);
});

test("셔틀 날짜 바꾸기: 남의 자녀 신청은 «찾을 수 없음» — 아무것도 바뀌지 않는다", async () => {
  const db = makeDb({ exceptions: [shuttleRow({ studentId: "s9" })] });
  freeze(SUN, "10:00");
  const before = picture(db);
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON }), { ok: false, message: "바꿀 신청을 찾을 수 없습니다." });
  assert.deepEqual(await shuttle.moveShuttleException("p1", { id: "", serviceDate: NEXT_MON }), { ok: false, message: "바꿀 신청을 찾을 수 없습니다." });
  assert.equal(picture(db), before);
  assert.equal(db.notices.length, 0);
});

test("셔틀 날짜 바꾸기: 새 날짜 저장이 실패하면 옛 신청의 취소도 되돌아간다", async () => {
  const db = makeDb({ exceptions: [shuttleRow()] });
  freeze(SUN, "10:00");
  const before = picture(db);
  db.failOn = /WITH guard AS MATERIALIZED/;
  await assert.rejects(() => shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON }), /synthetic DB failure/);
  db.failOn = null;
  assert.equal(picture(db), before);
  assert.equal(db.exceptions[0].canceled, false, "옛 신청이 살아 있다");
  assert.equal(db.notices.length, 0);
});

test("셔틀 날짜 바꾸기: 새 날짜에 기존 덮어쓰기 규칙 그대로 — 같은 내용이면 손대지 않고(취소 알림만), 다른 내용이면 덮는다", async () => {
  // 같은 내용이 이미 있다 → 새로 만들지 않는다
  let db = makeDb({ exceptions: [shuttleRow(), shuttleRow({ id: "x2", serviceDate: NEXT_MON })] });
  freeze(SUN, "10:00");
  let result = await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON });
  assert.equal(result.ok, true);
  assert.equal(result.id, "x2");
  assert.equal(db.exceptions.length, 2);
  assert.deepEqual(live(db), [[NEXT_MON, "PICKUP", "LOCATION", "다산초 정문 앞", "5분 일찍"]]);
  assert.deepEqual(db.notices.map((n) => n.eventType), ["SHUTTLE_DAY_EXCEPTION_CANCELED"], "새로 알릴 신청이 없다");
  // 같은 날·같은 방향에 다른 내용이 있다 → 그것을 취소하고 옮긴 내용이 남는다(살아 있는 것은 한 건)
  db = makeDb({ exceptions: [shuttleRow(), shuttleRow({ id: "x2", serviceDate: NEXT_MON, kind: "SKIP", location: null, note: null })] });
  result = await shuttle.moveShuttleException("p1", { id: "x1", serviceDate: NEXT_MON });
  assert.equal(result.ok, true);
  assert.deepEqual(live(db), [[NEXT_MON, "PICKUP", "LOCATION", "다산초 정문 앞", "5분 일찍"]]);
});

// ═════════════════════════════════════════════════════════════════════════
// ④-3 보강 예약 날짜 바꾸기
// ═════════════════════════════════════════════════════════════════════════
const RESCHEDULE = { creditId: "mcB", classId: "cA", dateYmd: NEXT_TUE };

test("보강 날짜 바꾸기 후보: 예약 중인 보강권에도 후보를 주고, 지금 예약한 반·날짜는 뺀다", async () => {
  const db = makeDb();
  seedBooking(db, { stored: at(TUE) });
  freeze(SUN, "10:00");
  // 예전 그대로: 인자 없이 부르면 예약 중인 보강권은 후보를 주지 않는다(새 예약용)
  assert.deepEqual(await makeup.getMakeupOptionsForCredit("p1", "mcB"), { ok: false, message: "이미 예약했거나 사용할 수 없는 보강권입니다." });
  const result = await makeup.getMakeupOptionsForCredit("p1", "mcB", { forReschedule: true });
  assert.equal(result.ok, true);
  const byClass = Object.fromEntries(result.options.map((o) => [o.classId, o.dates.map((d) => d.ymd)]));
  assert.ok(!byClass.cA.includes(TUE), "지금 예약한 화요반 11-17 은 빠진다");
  assert.deepEqual(byClass.cA.slice(0, 2), [NEXT_TUE, "2026-12-01"]);
  assert.equal(byClass.cW[0], "2026-11-18", "다른 반은 그대로");
  assert.equal(byClass.cO, undefined, "원래 반(다니는 반)은 후보가 아니다");
  assert.equal(JSON.stringify(result.options).includes('"remaining"'), false, "학생 수 숫자는 싣지 않는다");
  // 사용 가능한 보강권에는 날짜 바꾸기 후보를 주지 않는다 · 남의 보강권은 찾을 수 없다
  db.credits[0].status = "AVAILABLE";
  assert.equal((await makeup.getMakeupOptionsForCredit("p1", "mcB", { forReschedule: true })).ok, false);
  assert.equal((await makeup.getMakeupOptionsForCredit("p9", "mcB", { forReschedule: true })).ok, false);
  assert.ok(db.sessions.length === 1);
});

test("보강 날짜 바꾸기: 한 트랜잭션에서 옛 예약 취소 + 새 예약 — 보강권은 RESERVED 그대로(사용 가능으로 돌아가는 순간이 없다)", async () => {
  const db = makeDb();
  seedBooking(db, { stored: STORED["관리자 예약(UTC 자정 = KST 09:00)"] });
  freeze(SUN, "10:00");
  const result = await makeup.rescheduleMakeup("p1", RESCHEDULE);
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /화요반 11\/24\(화\)/);
  assert.equal(db.transactions, 1, "한 트랜잭션");
  assert.deepEqual(db.sessions.map((row) => [row.makeupClassId, kst.toKstYmd(row.makeupDate), row.status]), [["cA", TUE, "CANCELLED"], ["cA", NEXT_TUE, "BOOKED"]]);
  assert.equal(db.sessions[1].makeupDate.getTime(), at(NEXT_TUE), "새 예약은 그 날 KST 자정으로 저장");
  // 보강권 상태 불변: RESERVED 그대로, 연결만 새 예약으로
  assert.equal(db.credits[0].status, "RESERVED");
  assert.equal(db.credits[0].makeupSessionId, db.sessions[1].id);
  assert.deepEqual(db.creditStatusLog, [], "보강권 상태를 바꾸는 쓰기가 한 번도 없었다");
  assert.equal(db.credits.length, 1, "보강권이 새로 생기지 않는다");
  assert.equal(db.seatRechecks, 1, "잠금 뒤 새 날짜 정원을 다시 센다");
  // 다른 반으로도 옮길 수 있다
  assert.equal((await makeup.rescheduleMakeup("p1", { creditId: "mcB", classId: "cW", dateYmd: "2026-11-25" })).ok, true);
  assert.deepEqual(db.sessions.filter((row) => row.status === "BOOKED").map((row) => [row.makeupClassId, kst.toKstYmd(row.makeupDate)]), [["cW", "2026-11-25"]]);
  assert.deepEqual(db.creditStatusLog, []);
  // 웹 보강 예약·취소와 마찬가지로 원장·코치 알림은 없다(기존 그대로 — 이번에 바꾸지 않았다)
  assert.equal(db.notices.length, 0);
});

// 2026-11-15 마감 1시간 전 통일: 예전 «당일이면 거절» → 옛 보강·새 보강 모두 «수업 시작 1시간 전»까지
test("보강 날짜 바꾸기: 마감(수업 시작 1시간 전)은 옛 날짜·새 날짜 양쪽 — 지났으면 거절, 예약은 그대로", async () => {
  for (const stored of Object.values(STORED)) {
    // 옛 보강(화 17:00)의 59분 전 — 거절
    let db = makeDb();
    seedBooking(db, { stored });
    freeze(TUE, "16:01");
    const before = picture(db);
    assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: CLOSED });
    assert.equal(picture(db), before);
    assert.equal(db.transactions ?? 0, 0, "트랜잭션을 열기 전에 거절한다");
    // 옛 날짜가 지났다
    freeze("2026-11-18", "00:00");
    assert.match((await makeup.rescheduleMakeup("p1", RESCHEDULE)).message, /이미 지난 보강/);
    assert.equal(picture(db), before);
    // 옛 보강 당일이라도 정확히 60분 전에는 옮겨진다
    db = makeDb();
    seedBooking(db, { stored });
    freeze(TUE, "16:00");
    assert.equal((await makeup.rescheduleMakeup("p1", RESCHEDULE)).ok, true);
    assert.deepEqual(db.sessions.map((row) => [kst.toKstYmd(row.makeupDate), row.status]), [[TUE, "CANCELLED"], [NEXT_TUE, "BOOKED"]]);
  }
  // 새 날짜: 오늘(화 17:00) 수업으로 — 59분 전·지난 날은 거절, 60분 전은 된다
  let db = makeDb();
  seedBooking(db, { stored: at("2026-12-01") });
  freeze(NEXT_TUE, "16:01");
  const before = picture(db);
  for (const dateYmd of [NEXT_TUE, TUE]) {
    const result = await makeup.rescheduleMakeup("p1", { ...RESCHEDULE, dateYmd });
    assert.equal(result.ok, false);
    assert.match(result.message, BOOK_CLOSED);
  }
  assert.equal(picture(db), before);
  assert.equal(db.transactions ?? 0, 0);
  db = makeDb();
  seedBooking(db, { stored: at("2026-12-01") });
  freeze(NEXT_TUE, "16:00");
  assert.equal((await makeup.rescheduleMakeup("p1", RESCHEDULE)).ok, true, "오늘 수업으로도 1시간 전까지는 옮겨진다");
  assert.deepEqual(db.creditStatusLog, []);
});

test("보강 날짜 바꾸기: 남의 자녀·같은 자리·만료 뒤 날짜·갈 수 없는 반·수업 없는 날은 거절", async () => {
  // 남의 자녀
  let db = makeDb();
  seedBooking(db, { stored: at(TUE), studentId: "s9" });
  freeze(SUN, "10:00");
  let before = picture(db);
  assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: "날짜를 바꿀 수 있는 예약이 없습니다." });
  assert.equal(picture(db), before);
  // 같은 반·같은 날짜
  db = makeDb();
  seedBooking(db, { stored: at(TUE) });
  before = picture(db);
  assert.match((await makeup.rescheduleMakeup("p1", { ...RESCHEDULE, dateYmd: TUE })).message, /지금 예약한 수업·날짜와 같습니다/);
  // 그 반 요일이 아닌 날 · 다니는 반(원래 반) · 없는 날짜
  assert.match((await makeup.rescheduleMakeup("p1", { ...RESCHEDULE, dateYmd: "2026-11-26" })).message, /열리지 않거나 이미 마감된 날짜/);
  assert.match((await makeup.rescheduleMakeup("p1", { ...RESCHEDULE, classId: "cO", dateYmd: NEXT_MON })).message, /갈 수 있는 수업이 아닙니다/);
  assert.match((await makeup.rescheduleMakeup("p1", { ...RESCHEDULE, dateYmd: "2026-02-30" })).message, /날짜가 올바르지 않습니다/);
  assert.equal(picture(db), before);
  // 사용 기한(11-20)을 넘는 날짜
  db = makeDb();
  seedBooking(db, { stored: at(TUE), expiresYmd: "2026-11-20" });
  before = picture(db);
  assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: "보강권 사용 기간이 지난 날짜입니다." });
  assert.equal(picture(db), before);
  // 사용 가능(예약 없음) 보강권은 «바꿀 예약이 없다»
  db.credits[0].status = "AVAILABLE"; db.credits[0].makeupSessionId = null;
  assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: "날짜를 바꿀 수 있는 예약이 없습니다." });
});

test("보강 날짜 바꾸기: 정원이 꽉 찬 날은 거절 — 후보 단계에서도, 잠금 뒤 재확인에서도(동시 예약). 옛 예약은 그대로", async () => {
  // 화요반: 정원 10 + 2 − 수강 5 = 보강 7자리
  const fill = (db, n) => { for (let i = 0; i < n; i++) db.sessions.push({ id: `other${i}`, studentId: `o${i}`, makeupClassId: "cA", makeupDate: new Date(at(NEXT_TUE)), status: "BOOKED" }); };
  // ① 이미 꽉 찼다 — 후보에 없다
  let db = makeDb();
  seedBooking(db, { stored: at(TUE) });
  fill(db, 7);
  freeze(SUN, "10:00");
  let before = picture(db);
  assert.match((await makeup.rescheduleMakeup("p1", RESCHEDULE)).message, /열리지 않거나 이미 마감된 날짜/);
  assert.equal(picture(db), before);
  // 한 자리 남았으면 된다
  db = makeDb();
  seedBooking(db, { stored: at(TUE) });
  fill(db, 6);
  assert.equal((await makeup.rescheduleMakeup("p1", RESCHEDULE)).ok, true);
  // ② 후보를 본 뒤 다른 학부모가 마지막 자리를 채웠다 — 잠금 뒤 재확인에서 걸리고 전부 되돌아간다
  db = makeDb();
  seedBooking(db, { stored: at(TUE) });
  db.raceBooked[`cA|${NEXT_TUE}`] = 7;
  before = picture(db);
  assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: "방금 그 날짜가 마감됐습니다. 다른 날짜나 수업을 골라 주세요." });
  assert.equal(db.seatRechecks, 1);
  assert.equal(picture(db), before, "옛 예약·보강권 그대로");
  assert.deepEqual(db.creditStatusLog, []);
});

test("보강 날짜 바꾸기: 중간에 실패하면 전부 되돌아간다 — 옛 예약이 살아 있고 보강권 연결도 그대로", async () => {
  for (const failOn of [/INSERT INTO "MakeupSession"/, /UPDATE "MakeupCredit" SET "makeupSessionId"=\$2/]) {
    const db = makeDb();
    seedBooking(db, { stored: at(TUE) });
    freeze(SUN, "10:00");
    const before = picture(db);
    db.failOn = failOn;
    const result = await makeup.rescheduleMakeup("p1", RESCHEDULE);
    db.failOn = null;
    assert.deepEqual(result, { ok: false, message: "날짜를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요." }, String(failOn));
    assert.equal(picture(db), before);
    assert.deepEqual(db.sessions.map((row) => row.status), ["BOOKED"]);
    assert.equal(db.credits[0].makeupSessionId, "ms-mcB");
  }
  // 그 사이 예약이 이미 출석 처리됐다(BOOKED 가 아님) → 옮기지 않는다
  const db = makeDb();
  const { session } = seedBooking(db, { stored: at(TUE) });
  session.status = "ATTENDED";
  freeze(SUN, "10:00");
  assert.deepEqual(await makeup.rescheduleMakeup("p1", RESCHEDULE), { ok: false, message: "예약 상태가 변경됐습니다. 다시 확인해 주세요." });
  assert.equal(db.sessions.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════
// ⑤ 화면·경로 — 세 화면에 «날짜 바꾸기», 마감 뒤에는 같은 글
// ═════════════════════════════════════════════════════════════════════════
test("화면 세 곳: «날짜 바꾸기» 글자 버튼 + 그 자리에서 고르고 «바꾸기», 마감 글은 공용 상수", () => {
  const absenceUi = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  const shuttleUi = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  const makeupUi = read("src/app/mypage/makeup/MakeupClient.tsx");
  for (const [name, ui] of [["결석", absenceUi], ["셔틀", shuttleUi], ["보강", makeupUi]]) {
    // 결석 화면만 예외(2026-11-14 원장 지시 «학원에 문의 글 대신 그 자리에서 해결»): 마감 줄 = «마감» 한 단어 + 전화·문의 버튼.
    // 서버가 돌려주는 마감 오류 문구는 세 화면 모두 공용 상수 그대로다.
    if (name === "결석") assert.match(ui, /<ContactActions label="마감" contact=\{contact\} \/>/, "결석: 마감 줄은 «마감» + 전화·문의 버튼");
    else assert.match(ui, /import \{ CHANGE_CLOSED_MESSAGE[^}]*\} from "@\/lib\/parent\/changeDeadline";/, `${name}: 마감 글은 공용 상수`);
    assert.doesNotMatch(ui, /"마감 시간이 지나/, `${name}: 마감 글을 화면에 따로 적지 않는다`);
    assert.match(ui, /날짜 바꾸기/, `${name}: 날짜 바꾸기`);
    assert.match(ui, /className="academy-button-text shrink-0"\s*>\s*(\{[^}]*"날짜 바꾸기"\}|날짜 바꾸기)/, `${name}: 글자 버튼`);
    // 아이콘·이모지·굵은 글씨·색 코드 없음
    assert.doesNotMatch(ui, /font-(extrabold|black)|material-symbols|lucide|#[0-9a-fA-F]{6}\b/, name);
  }
  // 결석: 같은 반의 다른 수업일을 고른다 · 옛 안내 삭제 · 보강이 예약된 결석은 안내만
  assert.match(absenceUi, /body: JSON\.stringify\(\{ action: "move", studentId: d\.studentId, classId: d\.classId, date: d\.date, toDate \}\)/);
  assert.match(absenceUi, /\.filter\(\(x\) => x\.date !== d\.date && !x\.reported && changeOpen\(x\)\)/);
  assert.doesNotMatch(absenceUi, /취소한 뒤 다시 신고해 주세요/);
  assert.match(absenceUi, /보강 예약을 먼저 취소하거나 바꿔 주세요/);
  // 셔틀: 날짜만 다시 고른다(행 탭으로 번지지 않게)
  assert.match(shuttleUi, /action: "move",\s*id: item\.id,\s*serviceDate: moveDate,/);
  assert.match(shuttleUi, /event\.stopPropagation\(\);\s*setMoveDate\(""\);\s*setMoveId\(item\.id\);/);
  // 보강: 반·날짜 후보를 다시 불러 고른다
  // (main 병합: 불러오기는 «다시 확인»과 함께 쓰는 load(creditId, mode) 한 곳)
  assert.match(makeupUi, /fetchMakeupOptions\(creditId, mode === "move"\)/);
  assert.match(makeupUi, /await load\(credit\.id, mode\);/);
  assert.match(makeupUi, /rescheduleMakeupAction\(\{ creditId, classId: pick\.classId, dateYmd: pick\.ymd \}\)/);
  assert.match(makeupUi, /c\.booking\.changeOpen === false \? \(/);
  assert.match(makeupUi, /onClick=\{\(\) => reschedule\(c\.id\)\}[\s\S]{0,160}className="academy-button-primary w-full"[\s\S]{0,60}이 날짜로 바꾸기/);
});

test("경로: 결석·셔틀 API 에 move 분기, 보강은 서버 액션 — 모두 로그인한 보호자 id 를 서버에서 다시 얻는다", () => {
  const absenceRoute = read("src/app/api/mypage/regular-absence/route.ts");
  assert.match(absenceRoute, /body\?\.action === "move"[\s\S]{0,200}moveRegularAbsence\(parent\.appUserId, \{/);
  const shuttleRoute = read("src/app/api/mypage/shuttle-exception/route.ts");
  assert.match(shuttleRoute, /body\?\.action === "move"[\s\S]{0,200}moveShuttleException\(parent\.appUserId, \{ id: body\?\.id, serviceDate: body\?\.serviceDate \}\)/);
  const action = read("src/app/actions/parent-makeup.ts");
  assert.match(action, /export async function rescheduleMakeupAction[\s\S]{0,300}requireVerifiedParent\(\)[\s\S]{0,200}rescheduleMakeup\(parent\.appUserId, input\)/);
  assert.match(action, /getMakeupOptionsForCredit\(parent\.appUserId, creditId, \{ forReschedule: forReschedule === true \}\)/);
  // 카카오 대화에는 날짜 바꾸기 명령을 넣지 않았다(범위 밖)
  for (const file of ["src/lib/kakao-absence-flow.ts", "src/lib/kakao-shuttle-flow.ts", "src/lib/kakao-makeup-flow.ts"]) {
    assert.doesNotMatch(read(file), /moveRegularAbsence|moveShuttleException|rescheduleMakeup/, file);
  }
});
