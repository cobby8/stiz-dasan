import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import ts from "typescript";

// 2026-11-14 복귀 예정 (원장 지적)
//   「복귀신청하고 승인되면 복귀신청 날짜가 되기 전에도 승인이 됐으니 결석신고도 할 수 있고 정상이 되어야 하는데,
//     복귀 날짜까지 휴원으로 잡혀 있어서 아무것도 할 수가 없다.」
//
// 결정(안 A): 수강 상태(PAUSED)·출석부·청구·정원은 그대로 두고, «학부모가 쓸 수 있는 수강인가» 판정만 한 곳
//   (src/lib/enrollment/resumeWindow.ts)에 더한다. 복귀 예정 반은 «복귀일 이후 날짜»만 쓸 수 있다.
//
// 이 파일이 못박는 것
//   ① 순수 규칙 usableOn·earliestUsableFrom (전날·당일·다음 날·복귀일 없음·ACTIVE·WITHDRAWN·반 2개)
//   ② SQL 조각 모양(별칭 검증·APPROVED·appliedAt IS NULL·enrollmentId 키)
//   ③ 결석 신고 목록·신고·취소 — 가짜 DB 로 «실제 실행»(복귀일 전 거절·이후 허용·대기/미신청은 그대로 막힘)
//   ④ 셔틀 «오늘만» 변경 — 가짜 DB 로 실제 실행 + 웹·카카오 두 경로가 같은 규칙을 쓰는지
//   ⑤ 수업 카드(다음 수업·버튼)·셔틀 «휴원» 판정
// prisma·알림만 가짜다. 규칙·SQL 문구는 진짜 파일을 그대로 올려 쓴다.

const read = (file) => readFileSync(file, "utf8");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = (file) => ts.transpileModule(read(file), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const OVERRIDES = {
  "@/lib/prisma": toDataUrl(`export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__resumeDb[key] });`),
  "@/lib/operational-staff-notification": toDataUrl(`export async function notifyOperationalStaff(input) { globalThis.__resumeDb.notices.push(input); return { ok: true }; }`),
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

const rw = await import(load("src/lib/enrollment/resumeWindow.ts"));
const absence = await import(load("src/lib/regular/parent-regular-absence.ts"));
const shuttle = await import(load("src/lib/shuttle/parent-shuttle-exception.ts"));
const cards = await import(load("src/lib/parent/classCards.ts"));
const shuttleRules = await import(load("src/lib/shuttle/childShuttleRules.ts"));

const USABLE_SQL = rw.parentUsableEnrollmentSql("e");
const RESUME_FROM_SQL = rw.resumeFromSql("e");

const at = (ymd, hm = "00:00") => new Date(`${ymd}T${hm}:00+09:00`).getTime();
function freeze(ymd, hm = "10:00") {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: at(ymd, hm) });
}
test.afterEach(() => mock.timers.reset());

// ═════════════════════════════════════════════════════════════════════════
// ① 순수 규칙
// ═════════════════════════════════════════════════════════════════════════
test("usableOn — 복귀일 전날은 불가, 당일·다음 날은 가능", () => {
  assert.equal(rw.usableOn("PAUSED", "2026-11-16", "2026-11-15"), false, "전날");
  assert.equal(rw.usableOn("PAUSED", "2026-11-16", "2026-11-16"), true, "당일");
  assert.equal(rw.usableOn("PAUSED", "2026-11-16", "2026-11-17"), true, "다음 날");
  assert.equal(rw.usableOn("PAUSED", "2026-12-01", "2026-11-30"), false, "월말 경계");
  assert.equal(rw.usableOn("PAUSED", "2027-01-01", "2026-12-31"), false, "연말 경계");
  assert.equal(rw.usableOn("PAUSED", "2027-01-01", "2027-01-01"), true);
});

test("usableOn — 복귀일이 없는 휴원·퇴원·모르는 상태는 막히고, 다니는 반은 항상 된다", () => {
  assert.equal(rw.usableOn("PAUSED", null, "2026-11-16"), false, "복귀 승인 없음");
  assert.equal(rw.usableOn("PAUSED", undefined, "2026-11-16"), false);
  assert.equal(rw.usableOn("PAUSED", "", "2026-11-16"), false);
  assert.equal(rw.usableOn("PAUSED", "11/16", "2026-11-16"), false, "형식이 아닌 복귀일은 추측하지 않는다");
  assert.equal(rw.usableOn("ACTIVE", null, "2026-11-01"), true);
  assert.equal(rw.usableOn("ACTIVE", "2026-12-01", "2026-11-01"), true, "다니는 반은 복귀일 값이 있어도 제한 없음");
  assert.equal(rw.usableOn("WITHDRAWN", "2026-11-16", "2026-11-20"), false, "퇴원");
  assert.equal(rw.usableOn(null, "2026-11-16", "2026-11-20"), false);
});

test("earliestUsableFrom — 반 2개의 복귀일이 다르면 이른 날, 다니는 반이 있으면 제한 없음", () => {
  assert.equal(rw.earliestUsableFrom([{ status: "PAUSED", resumeFrom: "2026-11-18" }, { status: "PAUSED", resumeFrom: "2026-11-16" }]), "2026-11-16");
  assert.equal(rw.earliestUsableFrom([{ status: "ACTIVE", resumeFrom: null }, { status: "PAUSED", resumeFrom: "2026-11-18" }]), null);
  assert.equal(rw.earliestUsableFrom([]), null);
  // 반마다 따로 본다: 11-16 복귀 반은 11-17 에 되고, 11-18 복귀 반은 11-17 에 아직 안 된다
  assert.equal(rw.usableOn("PAUSED", "2026-11-16", "2026-11-17"), true);
  assert.equal(rw.usableOn("PAUSED", "2026-11-18", "2026-11-17"), false);
});

test("안내 문구·오류 — 복귀일(M/D)을 넣는다", () => {
  assert.equal(rw.resumeNotice("2026-11-16"), "복귀일(11/16) 이후 수업부터 신청할 수 있어요");
  assert.equal(rw.resumeNotice("2026-11-16", "신고"), "복귀일(11/16) 이후 수업부터 알릴 수 있어요");
  assert.equal(rw.resumeNotice(null), "복귀일 이후 수업부터 신청할 수 있어요");
  const error = new rw.BeforeResumeError("2026-12-01");
  assert.equal(error.message, "BEFORE_RESUME_DATE");
  assert.equal(rw.resumeFromOfError(error), "2026-12-01");
  assert.equal(rw.resumeFromOfError(new Error("NOT_OWNER")), null);
});

// ═════════════════════════════════════════════════════════════════════════
// ② SQL 조각 모양
// ═════════════════════════════════════════════════════════════════════════
test("SQL 조각 — 승인·미반영 복귀 신청만, 수강 id 로 잇는다", () => {
  assert.equal(
    USABLE_SQL,
    `(e.status = 'ACTIVE' OR (e.status = 'PAUSED' AND EXISTS (SELECT 1 FROM "EnrollmentChangeRequest" rw WHERE rw."enrollmentId" = e.id AND rw.kind = 'RESUME' AND rw.status = 'APPROVED' AND rw."appliedAt" IS NULL AND rw."effectiveFrom" >= (NOW() AT TIME ZONE 'Asia/Seoul')::date AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" oc WHERE oc."idempotencyKey" = 'enrollment-change:' || rw.id))))`,
  );
  assert.equal(
    RESUME_FROM_SQL,
    `(SELECT to_char(MIN(rw."effectiveFrom"), 'YYYY-MM-DD') FROM "EnrollmentChangeRequest" rw WHERE e.status = 'PAUSED' AND rw."enrollmentId" = e.id AND rw.kind = 'RESUME' AND rw.status = 'APPROVED' AND rw."appliedAt" IS NULL AND rw."effectiveFrom" >= (NOW() AT TIME ZONE 'Asia/Seoul')::date AND NOT EXISTS (SELECT 1 FROM "OperationsCommand" oc WHERE oc."idempotencyKey" = 'enrollment-change:' || rw.id))`,
  );
  // 대기(PENDING)·이미 반영(APPLIED)은 조건에 없다
  for (const sql of [USABLE_SQL, RESUME_FROM_SQL]) {
    assert.doesNotMatch(sql, /PENDING|APPLIED'/);
    // effectiveFrom 은 date 열 — 열에는 시간대 변환을 걸지 않는다(«오늘»만 DB 에서 KST 로 만든다)
    assert.doesNotMatch(sql, /"effectiveFrom"\)?\s+AT TIME ZONE/);
    assert.equal((sql.match(/AT TIME ZONE/g) ?? []).length, 1);
  }
  // 크론이 «이미 처리(적용·보류)한 신청»을 건너뛰는 조건과 글자까지 같은 키(별칭만 다르다: c→oc, r→rw)
  const cron = read("src/lib/enrollment/admin-change-request.ts");
  assert.ok(cron.includes(`WHERE c."idempotencyKey" = 'enrollment-change:' || r.id)`), "크론 대상 조회의 키 모양");
  assert.ok(cron.includes("const key = `enrollment-change:${row.id}`;"), "보류 원장을 만드는 키");
  assert.ok(USABLE_SQL.includes(`WHERE oc."idempotencyKey" = 'enrollment-change:' || rw.id)`));
  assert.match(rw.parentUsableEnrollmentSql("enr"), /^\(enr\.status = 'ACTIVE' OR \(enr\.status = 'PAUSED'/);
  assert.match(rw.resumeFromSql("enr"), /rw\."enrollmentId" = enr\.id/);
});

test("SQL 조각 — 별칭은 글자·숫자·밑줄만 받는다", () => {
  for (const bad of ["e; DROP TABLE x", "e.status", "", "1e", "e\"", "e e", "e)"]) {
    assert.throws(() => rw.parentUsableEnrollmentSql(bad), /잘못된 SQL 별칭/, bad);
    assert.throws(() => rw.resumeFromSql(bad), /잘못된 SQL 별칭/, bad);
  }
});

test("복귀 신청은 enrollmentId 로 수강을 가리킨다(신청 생성·적용 크론과 같은 키)", () => {
  const submit = read("src/lib/enrollment/parent-change-request.ts");
  assert.match(submit, /owned\[0\]\.studentId, enrollmentId, owned\[0\]\.classId, null, RESUME_KIND, effectiveFrom/);
  assert.match(read("src/lib/enrollment/admin-change-request.ts"), /WHERE e\.id = \$1 FOR UPDATE OF e`, row\.enrollmentId\)/);
  // 이 파일은 다른 모듈을 끌어오지 않는다(테스트·화면이 그대로 쓴다)
  assert.doesNotMatch(read("src/lib/enrollment/resumeWindow.ts"), /^import /m);
});

// ═════════════════════════════════════════════════════════════════════════
// 가짜 DB — 수강·복귀 신청 표를 들고, 공용 조각의 뜻을 그대로 흉내 낸다
// ═════════════════════════════════════════════════════════════════════════
const TODAY = "2026-11-14"; // 토요일
function makeDb(overrides = {}) {
  const db = {
    students: [
      { id: "s1", name: "복귀예정", parentId: "p1" }, // 반 2개, 복귀일 11-16(월반)·11-25(수반)
      { id: "s2", name: "복귀대기", parentId: "p1" }, // 복귀 신청이 아직 대기
      { id: "s3", name: "휴원중", parentId: "p1" },   // 복귀 신청 없음
      { id: "s4", name: "재원", parentId: "p1" },     // 다니는 중
      { id: "s5", name: "섞임", parentId: "p1" },     // 다니는 반 + 복귀 예정 반
      { id: "s9", name: "남의아이", parentId: "p9" },
    ],
    classes: [
      { id: "cMon", name: "월요반", dayOfWeek: "Mon", startTime: "18:00" },
      { id: "cWed", name: "수요반", dayOfWeek: "Wed", startTime: "18:00" },
      { id: "cFri", name: "금요반", dayOfWeek: "Fri", startTime: "18:00" },
    ],
    enrollments: [
      { id: "e1", studentId: "s1", classId: "cMon", status: "PAUSED" },
      { id: "e2", studentId: "s1", classId: "cWed", status: "PAUSED" },
      { id: "e3", studentId: "s2", classId: "cMon", status: "PAUSED" },
      { id: "e4", studentId: "s3", classId: "cMon", status: "PAUSED" },
      { id: "e5", studentId: "s4", classId: "cMon", status: "ACTIVE" },
      { id: "e6", studentId: "s5", classId: "cFri", status: "ACTIVE" },
      { id: "e7", studentId: "s5", classId: "cWed", status: "PAUSED" },
      { id: "e8", studentId: "s9", classId: "cMon", status: "PAUSED" },
    ],
    requests: [
      { enrollmentId: "e1", kind: "RESUME", status: "APPROVED", appliedAt: null, effectiveFrom: "2026-11-16" },
      { enrollmentId: "e2", kind: "RESUME", status: "APPROVED", appliedAt: null, effectiveFrom: "2026-11-25" },
      { enrollmentId: "e3", kind: "RESUME", status: "PENDING", appliedAt: null, effectiveFrom: "2026-11-16" },
      // 옛 휴원 신청(반영 끝) — 복귀 예정일이 적혀 있어도 «승인된 복귀»가 아니다
      { enrollmentId: "e4", kind: "PAUSE", status: "APPLIED", appliedAt: "x", effectiveFrom: "2026-10-01" },
      { enrollmentId: "e7", kind: "RESUME", status: "APPROVED", appliedAt: null, effectiveFrom: "2026-11-25" },
      { enrollmentId: "e8", kind: "RESUME", status: "APPROVED", appliedAt: null, effectiveFrom: "2026-11-16" },
    ],
    // 크론이 적용일에 만든 운영 원장(보류 포함) — idempotencyKey = enrollment-change:<신청 id>
    commands: [],
    absences: [],
    credits: [],
    exceptions: [],
    notices: [],
    seq: 0,
    ...overrides,
  };
  const student = (id) => db.students.find((row) => row.id === id);
  const cls = (id) => db.classes.find((row) => row.id === id);
  const owns = (studentId, parentId) => student(studentId)?.parentId === parentId;
  // 공용 조각의 뜻: 승인(APPROVED)·미반영(appliedAt NULL) 복귀(RESUME) 신청
  // + 복귀일이 오늘(KST) 이후 + 크론이 아직 처리(적용·보류)하지 않음. 신청 id 는 "rq-<수강 id>"
  const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const approved = (e) => db.requests.filter((r) => r.enrollmentId === e.id && r.kind === "RESUME" && r.status === "APPROVED" && r.appliedAt == null
    && r.effectiveFrom >= todayKst()
    && !db.commands.some((c) => c.idempotencyKey === `enrollment-change:${r.id ?? `rq-${r.enrollmentId}`}`));
  const usable = (e) => e.status === "ACTIVE" || (e.status === "PAUSED" && approved(e).length > 0);
  const resumeFrom = (e) => (e.status === "PAUSED" ? approved(e).map((r) => r.effectiveFrom).sort()[0] ?? null : null);
  const needsFragments = (sql) => {
    assert.ok(sql.includes(USABLE_SQL), "수강 조건은 공용 조각");
    assert.ok(sql.includes(`${RESUME_FROM_SQL} AS "resumeFrom"`), "복귀일도 공용 조각으로 읽는다");
    assert.doesNotMatch(sql, /e\.status = 'ACTIVE'\s*(\n|$)/, "맨 ACTIVE 조건을 따로 쓰지 않는다");
  };

  async function $queryRawUnsafe(sql, ...args) {
    // ── 결석: 소유·수강 확인 ──
    if (/FROM "Enrollment" e\s+JOIN "Student" s ON s\.id = e\."studentId"\s+JOIN "Class" c ON c\.id = e\."classId"/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건은 그대로");
      needsFragments(sql);
      const e = owns(args[1], args[0]) ? db.enrollments.find((row) => row.studentId === args[1] && row.classId === args[2] && usable(row)) : null;
      if (!e) return [];
      const c = cls(e.classId);
      return [{ dayOfWeek: c.dayOfWeek, startTime: c.startTime, studentName: student(e.studentId).name, className: c.name, enrollmentStatus: e.status, resumeFrom: resumeFrom(e) }];
    }
    // ── 결석: 다가오는 수업일 목록 ──
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && sql.includes('c."dayOfWeek" AS "dayOfWeek"')) {
      needsFragments(sql);
      return db.enrollments.filter((e) => usable(e) && owns(e.studentId, args[0])).map((e) => {
        const c = cls(e.classId);
        return { studentId: e.studentId, studentName: student(e.studentId).name, classId: c.id, className: c.name, dayOfWeek: c.dayOfWeek, startTime: c.startTime, enrollmentStatus: e.status, resumeFrom: resumeFrom(e) };
      });
    }
    if (/FROM "RegularAbsence" ra\s+JOIN "Student" s ON s\.id = ra\."studentId"/.test(sql) && /^SELECT/.test(sql.trim())) {
      return db.absences.filter((a) => owns(a.studentId, args[0]) && a.status !== "CANCELLED").map((a) => ({ ...a }));
    }
    if (/FROM "MakeupCredit" mc/.test(sql)) return [];
    if (/INSERT INTO "RegularAbsence"/.test(sql)) {
      const [studentId, classId, date, reason] = args;
      const row = { id: `ra${++db.seq}`, studentId, classId, date, reason, status: "REPORTED" };
      db.absences.push(row);
      return [{ id: row.id, eventVersion: String(db.seq) }];
    }
    // ── 결석: 취소(UPDATE … RETURNING) — 복귀일을 같은 조각으로 돌려받는다 ──
    if (/UPDATE "RegularAbsence" ra\s+SET status = 'CANCELLED'/.test(sql)) {
      assert.ok(sql.includes(`(SELECT ${RESUME_FROM_SQL} FROM "Enrollment" e`), "취소도 그 반의 복귀일을 읽는다");
      assert.match(sql, /e\."studentId" = ra\."studentId" AND e\."classId" = ra\."classId"/);
      const byId = /ra\.id = \$2/.test(sql);
      const row = db.absences.find((a) => a.status === "REPORTED" && owns(a.studentId, args[0])
        && (byId ? a.id === args[1] : a.studentId === args[1] && a.classId === args[2] && a.date === args[3]));
      if (!row) return [];
      row.status = "CANCELLED";
      const c = cls(row.classId);
      const e = db.enrollments.find((x) => x.studentId === row.studentId && x.classId === row.classId);
      return [{ id: row.id, studentName: student(row.studentId).name, className: c.name, classId: c.id, studentId: row.studentId, date: row.date, startTime: c.startTime, eventVersion: String(++db.seq), resumeFrom: e ? resumeFrom(e) : null }];
    }
    if (/to_regclass/.test(sql)) return [{ found: null, ready: false }];
    // 보강권 — 신고 즉시 한 장(일반 반과 같은 길). 여기서는 장수만 센다
    if (/INSERT INTO "MakeupCredit"/.test(sql)) { db.credits.push({ id: `mc${++db.seq}`, studentId: args[0], sourceKey: args[1] }); return [{ id: `mc${db.seq}` }]; }
    if (/FROM "Attendance" a/.test(sql)) return [];
    // ── 셔틀: 자녀 목록 / 소유 검증(같은 JOIN, 소유 검증은 s.id = $1) ──
    if (/FROM "Student" s\s+JOIN "Enrollment" e ON e\."studentId" = s\.id AND /.test(sql) && /e\.status AS status/.test(sql)) {
      needsFragments(sql);
      const single = /WHERE s\.id = \$1/.test(sql);
      const parentId = single ? args[1] : args[0];
      return db.enrollments
        .filter((e) => usable(e) && owns(e.studentId, parentId) && (!single || e.studentId === args[0]))
        .map((e) => ({ id: e.studentId, name: student(e.studentId).name, studentId: e.studentId, studentName: student(e.studentId).name, status: e.status, resumeFrom: resumeFrom(e) }));
    }
    // ── 셔틀: 마감 기준 시각(2026-11-15 마감 통일·날짜 바꾸기) — 쓸 수 있는 수강 반의 요일·시작 시각 ──
    if (/FROM "Enrollment" e\s+JOIN "Class" c ON c\.id = e\."classId"\s+WHERE e\."studentId" = ANY\(\$1::text\[\]\)/.test(sql)) {
      needsFragments(sql);
      return db.enrollments.filter((e) => usable(e) && args[0].includes(e.studentId)).map((e) => {
        const c = cls(e.classId);
        return { studentId: e.studentId, dayOfWeek: c.dayOfWeek, startTime: c.startTime, status: e.status, resumeFrom: resumeFrom(e) };
      });
    }
    if (/FROM "ShuttleDayException" x\s+JOIN "Student" s/.test(sql)) return [];
    if (/INSERT INTO "ShuttleDayException"/.test(sql)) {
      const row = { id: `x${++db.seq}`, studentId: args[0], serviceDate: args[1], direction: args[2], kind: args[3] };
      db.exceptions.push(row);
      return [{ id: row.id, changed: true }];
    }
    if (/FROM "NotificationDelivery" d/.test(sql)) return [];
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  async function $executeRawUnsafe(sql) {
    if (/pg_advisory_xact_lock/.test(sql)) return 1;
    throw new Error(`예상하지 않은 실행: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  /** 트랜잭션: 안에서 오류가 나면 결석 표를 되돌린다(ROLLBACK 흉내) */
  async function $transaction(fn) {
    const snapshot = structuredClone(db.absences);
    try { return await fn({ $queryRawUnsafe, $executeRawUnsafe }); } catch (error) { db.absences = snapshot; throw error; }
  }
  Object.assign(db, { $queryRawUnsafe, $executeRawUnsafe, $transaction });
  globalThis.__resumeDb = db;
  return db;
}

// ═════════════════════════════════════════════════════════════════════════
// ③ 결석 신고
// ═════════════════════════════════════════════════════════════════════════
test("결석 수업일 목록 — 복귀 예정 반은 복귀일 이후 날짜만, 대기·미신청 휴원은 없다", async () => {
  makeDb();
  freeze(TODAY);
  const list = await absence.getUpcomingRegularClassDates("p1");
  assert.deepEqual(list.map((c) => c.studentId).sort(), ["s1", "s4", "s5"], "복귀 대기(s2)·휴원 중(s3)·남의 아이(s9)는 없다");
  const s1 = list.find((c) => c.studentId === "s1");
  const mon = s1.classes.find((c) => c.classId === "cMon");
  const wed = s1.classes.find((c) => c.classId === "cWed");
  assert.equal(mon.resumeFrom, "2026-11-16");
  assert.deepEqual(mon.dates.map((d) => d.date), ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"], "복귀일 당일 수업부터");
  assert.equal(wed.resumeFrom, "2026-11-25");
  assert.deepEqual(wed.dates.map((d) => d.date), ["2026-11-25", "2026-12-02", "2026-12-09"], "11-18 수업은 아직 휴원이라 빠진다");
  assert.ok(mon.dates.every((d) => d.changeOpen === true), "마감 규칙은 그대로 계산된다");
  // 다니는 반은 예전과 같다
  const s4 = list.find((c) => c.studentId === "s4").classes[0];
  assert.equal(s4.resumeFrom, null);
  assert.equal(s4.dates[0].date, "2026-11-16");
  // 다니는 반 + 복귀 예정 반: 반마다 따로
  const s5 = list.find((c) => c.studentId === "s5");
  assert.equal(s5.classes.find((c) => c.classId === "cFri").dates[0].date, "2026-11-20");
  assert.equal(s5.classes.find((c) => c.classId === "cWed").dates[0].date, "2026-11-25");
});

test("결석 신고 — 복귀일 전 날짜는 거절(복귀일을 실어), 복귀일 당일·이후는 받는다", async () => {
  const db = makeDb();
  freeze(TODAY);
  await assert.rejects(
    absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cWed", date: "2026-11-18", reason: "PERSONAL" }),
    (error) => error.message === "BEFORE_RESUME_DATE" && rw.resumeFromOfError(error) === "2026-11-25",
  );
  assert.equal(db.absences.length, 0, "거절된 신고는 저장되지 않는다");
  const onDay = await absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", date: "2026-11-16", reason: "PERSONAL" });
  assert.equal(onDay.ok, true);
  const after = await absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cWed", date: "2026-12-02", reason: "FAMILY_TRIP" });
  assert.equal(after.ok, true);
  assert.deepEqual(db.absences.map((a) => [a.classId, a.date, a.status]), [["cMon", "2026-11-16", "REPORTED"], ["cWed", "2026-12-02", "REPORTED"]]);
  assert.equal(db.notices.length, 2, "원장·코치·기사 알림은 일반 반과 같게 나간다");
  assert.deepEqual(db.credits.map((x) => x.sourceKey), ["REGULAR:cMon:2026-11-16", "REGULAR:cWed:2026-12-02"], "보강권도 일반 반과 같게 한 장씩");
});

test("결석 신고 — 복귀 신청이 대기·없음이면 여전히 막힌다(남의 아이도)", async () => {
  const db = makeDb();
  freeze(TODAY);
  const body = { classId: "cMon", date: "2026-11-16", reason: "PERSONAL" };
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, studentId: "s2" }), /^Error: NOT_OWNER$/, "대기(PENDING)");
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, studentId: "s3" }), /^Error: NOT_OWNER$/, "복귀 신청 없음");
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, studentId: "s9" }), /^Error: NOT_OWNER$/, "남의 아이는 복귀가 승인돼 있어도 못 건드린다");
  assert.equal(db.absences.length, 0);
  // 승인이 거절·취소·이미 반영으로 바뀌면 다시 막힌다
  for (const status of ["REJECTED", "CANCELED", "APPLIED"]) {
    makeDb({ requests: [{ enrollmentId: "e1", kind: "RESUME", status, appliedAt: status === "APPLIED" ? "x" : null, effectiveFrom: "2026-11-16" }] });
    await assert.rejects(absence.reportRegularAbsence("p1", { ...body, studentId: "s1" }), /^Error: NOT_OWNER$/, status);
  }
});

test("보류된 복귀 신청은 «쓸 수 있음»이 아니다 — 크론이 원장을 만든 신청은 다시 휴원해도 열리지 않는다", async () => {
  // 승인(11-16 복귀) → 원장이 직접 ACTIVE → 11-16 크론이 «이미 복귀 상태»로 보류(원장 생성) → 다시 휴원. 신청 행은 APPROVED·appliedAt NULL 그대로다.
  const held = { commands: [{ idempotencyKey: "enrollment-change:rq-e1" }, { idempotencyKey: "enrollment-change:rq-e2" }] };
  const db = makeDb(held);
  freeze(TODAY);
  const list = await absence.getUpcomingRegularClassDates("p1");
  assert.equal(list.some((c) => c.studentId === "s1"), false, "결석 목록에 없다");
  await assert.rejects(absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", date: "2026-11-16", reason: "PERSONAL" }), /^Error: NOT_OWNER$/);
  const options = await shuttle.getShuttleExceptionOptions("p1");
  assert.equal(options.children.some((c) => c.studentId === "s1"), false, "셔틀 자녀 목록에도 없다");
  assert.deepEqual(
    await shuttle.submitShuttleException("p1", { studentId: "s1", serviceDate: "2026-11-17", direction: "PICKUP", kind: "SKIP" }),
    { ok: false, message: "본인 자녀만 신청할 수 있습니다." },
  );
  assert.equal(db.absences.length + db.credits.length + db.exceptions.length, 0, "결석·보강권·셔틀 변경이 하나도 생기지 않는다");
  // 다른 신청의 원장은 상관없다(키가 신청 id 까지 같아야 한다)
  makeDb({ commands: [{ idempotencyKey: "enrollment-change:rq-e3" }, { idempotencyKey: "enrollment-change:rq-e" }] });
  assert.equal((await absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", date: "2026-11-16", reason: "PERSONAL" })).ok, true);
});

test("복귀일이 지난 신청은 «예정»이 아니다 — 당일은 크론 전에도 되고, 다음 날부터는 막힌다", async () => {
  const body = { studentId: "s1", classId: "cMon", reason: "PERSONAL" };
  makeDb();
  freeze("2026-11-16", "00:10"); // 복귀일 당일 새벽(UTC 로는 아직 11-15) — 크론이 돌기 전
  assert.equal((await absence.reportRegularAbsence("p1", { ...body, date: "2026-11-16" })).ok, true, "복귀일 당일은 허용");
  makeDb();
  freeze("2026-11-17", "00:10"); // 하루 지났는데 아직 PAUSED·미반영(크론 실패 등)
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, date: "2026-11-23" }), /^Error: NOT_OWNER$/, "지난 복귀일은 열지 않는다");
  const list = await absence.getUpcomingRegularClassDates("p1");
  const s1 = list.find((c) => c.studentId === "s1");
  assert.deepEqual(s1.classes.map((c) => c.classId), ["cWed"], "11-25 복귀 반은 그대로 열려 있다");
});

test("결석 신고 — 목록 범위(4주) 밖 날짜는 거절, 경계일은 허용(다니는 반도 같은 규칙)", async () => {
  assert.equal(absence.ABSENCE_REPORT_WEEKS, 4);
  const db = makeDb();
  freeze(TODAY); // 토요일. 월요반 목록 = 11-16 · 11-23 · 11-30 · 12-07
  const body = { studentId: "s4", classId: "cMon", reason: "PERSONAL" };
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, date: "2026-12-14" }), /^Error: ABSENCE_TOO_FAR$/, "5주째");
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, date: "2027-03-01" }), /^Error: ABSENCE_TOO_FAR$/, "몇 달 뒤");
  await assert.rejects(absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", reason: "PERSONAL", date: "2026-12-14" }), /^Error: ABSENCE_TOO_FAR$/, "복귀 예정 반도");
  assert.equal(db.absences.length + db.credits.length, 0);
  assert.equal((await absence.reportRegularAbsence("p1", { ...body, date: "2026-12-07" })).ok, true, "4주째(경계)");
  // 오늘이 수업일이면 오늘 + 4주치 = 목록과 같은 5개
  makeDb();
  freeze("2026-11-16", "09:00");
  assert.equal((await absence.reportRegularAbsence("p1", { ...body, date: "2026-12-14" })).ok, true, "목록 마지막 날");
  await assert.rejects(absence.reportRegularAbsence("p1", { ...body, date: "2026-12-21" }), /^Error: ABSENCE_TOO_FAR$/);
  // 문구
  assert.match(read("src/app/api/mypage/regular-absence/route.ts"), /ABSENCE_TOO_FAR: `앞으로 \$\{ABSENCE_REPORT_WEEKS\}주 안의 수업만 알릴 수 있습니다\.`/);
  const kakao = read("src/lib/kakao-absence-flow.ts");
  assert.match(kakao, /if \(code === "ABSENCE_TOO_FAR"\)/);
  assert.match(kakao, /export const ABSENCE_WEEKS = 4;/, "카카오 결석 후보도 같은 4주 — 상한 때문에 깨지지 않는다");
});

test("결석 신고 — 마감·요일 규칙은 복귀 예정 반에도 그대로다", async () => {
  makeDb();
  freeze("2026-11-16", "17:30"); // 월요반 18:00 시작 30분 전
  await assert.rejects(
    absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", date: "2026-11-16", reason: "PERSONAL" }),
    /^Error: ABSENCE_CHANGE_CLOSED$/,
  );
  await assert.rejects(
    absence.reportRegularAbsence("p1", { studentId: "s1", classId: "cMon", date: "2026-11-24", reason: "PERSONAL" }),
    /^Error: NOT_REPORTABLE_DATE$/, "화요일은 월요반 수업일이 아니다",
  );
});

test("결석 취소 — 복귀일 전 날짜의 신고는 못 건드리고(되돌림), 이후 신고는 취소된다", async () => {
  const db = makeDb({ absences: [
    { id: "old", studentId: "s1", classId: "cWed", date: "2026-11-18", reason: "PERSONAL", status: "REPORTED" },
    { id: "new", studentId: "s1", classId: "cWed", date: "2026-11-25", reason: "PERSONAL", status: "REPORTED" },
    { id: "act", studentId: "s4", classId: "cMon", date: "2026-11-16", reason: "PERSONAL", status: "REPORTED" },
  ] });
  freeze(TODAY);
  await assert.rejects(
    absence.cancelRegularAbsence("p1", { id: "old" }),
    (error) => error.message === "BEFORE_RESUME_DATE" && rw.resumeFromOfError(error) === "2026-11-25",
  );
  assert.equal(db.absences.find((a) => a.id === "old").status, "REPORTED", "거절되면 취소도 되돌려진다");
  assert.equal((await absence.cancelRegularAbsence("p1", { studentId: "s1", classId: "cWed", date: "2026-11-25" })).ok, true);
  assert.equal(db.absences.find((a) => a.id === "new").status, "CANCELLED");
  // 다니는 반은 예전과 같다
  assert.equal((await absence.cancelRegularAbsence("p1", { id: "act" })).ok, true);
});

test("결석 — 화면·카카오 오류 문구와 안내 한 줄", () => {
  const route = read("src/app/api/mypage/regular-absence/route.ts");
  assert.match(route, /if \(code === BEFORE_RESUME_CODE\) \{\s*return NextResponse\.json\(\{ error: `\$\{resumeNotice\(resumeFromOfError\(error\), "신고"\)\}\.`, code \}, \{ status: 409 \}\);/);
  const kakao = read("src/lib/kakao-absence-flow.ts");
  assert.match(kakao, /if \(code === BEFORE_RESUME_CODE\) return `\$\{resumeNotice\(resumeFromOfError\(error\), "신고"\)\}\.`;/);
  // 카카오 결석(대화·접수 자동 처리)은 웹과 같은 함수를 쓴다 — 따로 수강 조건을 두지 않는다
  assert.match(kakao, /getUpcomingRegularClassDates\(input\.parentUserId, ABSENCE_WEEKS\)/);
  assert.match(kakao, /await reportRegularAbsence\(state\.parentUserId,/);
  assert.match(read("src/lib/kakao-parent-intake-routing.ts"), /await reportRegularAbsence\(intake\.parentUserId,/);
  assert.doesNotMatch(kakao, /e\.status\s*=\s*'ACTIVE'/);
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /resumeNotice\(cl\.resumeFrom, "신고"\)/);
  assert.match(client, /resumeNotes\.length > 0 &&/);
});

// ═════════════════════════════════════════════════════════════════════════
// ④ 셔틀 «오늘만» 변경
// ═════════════════════════════════════════════════════════════════════════
test("셔틀 자녀 목록 — 복귀 예정 자녀는 복귀일과 함께, 대기·미신청 휴원은 없다", async () => {
  makeDb();
  freeze(TODAY);
  const options = await shuttle.getShuttleExceptionOptions("p1");
  assert.equal(options.today, TODAY);
  assert.deepEqual(
    options.children.map((c) => [c.studentId, c.usableFrom]).sort(),
    [["s1", "2026-11-16"], ["s4", null], ["s5", null]],
    "s1 = 두 반 중 이른 복귀일 · s5 = 다니는 반이 있어 제한 없음",
  );
});

test("셔틀 변경 — 복귀일 전 날짜는 서버가 거절, 복귀일부터 저장된다", async () => {
  const db = makeDb();
  freeze(TODAY);
  const body = { direction: "PICKUP", kind: "SKIP" };
  const before = await shuttle.submitShuttleException("p1", { ...body, studentId: "s1", serviceDate: "2026-11-15" });
  assert.deepEqual(before, { ok: false, message: "복귀일(11/16) 이후 수업부터 신청할 수 있어요." });
  assert.equal(db.exceptions.length, 0);
  assert.equal((await shuttle.submitShuttleException("p1", { ...body, studentId: "s1", serviceDate: "2026-11-16" })).ok, true, "복귀일 당일");
  assert.equal((await shuttle.submitShuttleException("p1", { ...body, studentId: "s1", serviceDate: "2026-11-17" })).ok, true, "다음 날");
  // 2026-11-15 마감 통일·날짜 바꾸기: 예전에는 «다니는 반이 있는 학생은 오늘도 된다»였다(시각·요일 검사 없음).
  // 이제 그 날짜에 수업이 없는 학생은 전날까지만 받는다 — 오늘(토)은 s5(금·수반)·s4(월반) 모두 수업이 없어 마감이다.
  const CLOSED = { ok: false, message: "마감 시간이 지나 여기서 바꿀 수 없습니다. 학원으로 연락해 주세요." };
  assert.deepEqual(await shuttle.submitShuttleException("p1", { ...body, studentId: "s5", serviceDate: TODAY }), CLOSED);
  assert.deepEqual(await shuttle.submitShuttleException("p1", { ...body, studentId: "s4", serviceDate: TODAY }), CLOSED);
  assert.equal(db.exceptions.length, 2, "마감된 신청은 저장되지 않는다");
  // 복귀일 제한이 없는(다니는) 학생은 다가오는 수업일에 그대로 신청된다 — 복귀일 검사에 걸리지 않는다
  assert.equal((await shuttle.submitShuttleException("p1", { ...body, studentId: "s5", serviceDate: "2026-11-20" })).ok, true, "금요반 수업일");
  assert.equal((await shuttle.submitShuttleException("p1", { ...body, studentId: "s4", serviceDate: "2026-11-16" })).ok, true, "월요반 수업일");
  assert.equal(db.exceptions.length, 4);
  // 대기·미신청 휴원·남의 아이는 그대로 막힌다
  for (const studentId of ["s2", "s3", "s9"]) {
    assert.deepEqual(
      await shuttle.submitShuttleException("p1", { ...body, studentId, serviceDate: "2026-11-20" }),
      { ok: false, message: "본인 자녀만 신청할 수 있습니다." }, studentId,
    );
  }
  assert.equal(db.exceptions.length, 4);
});

test("셔틀 — 웹·카카오 두 경로가 같은 규칙을 쓴다", () => {
  const web = read("src/lib/shuttle/parent-shuttle-exception.ts");
  const kakao = read("src/lib/kakao-shuttle-flow.ts");
  // 수강 조건: 두 파일 모두 공용 조각, 맨 ACTIVE 조건 없음
  // 2026-11-15 마감 통일·날짜 바꾸기: 마감 기준 시각을 읽는 조회(loadClassTimes)가 같은 공용 조각을 한 번 더 쓴다 → 2곳에서 3곳
  assert.equal((web.match(/\$\{parentUsableEnrollmentSql\("e"\)\}/g) ?? []).length, 3, "자녀 목록 + 소유 검증 + 마감 기준 반 시각");
  assert.match(kakao, /WHERE e\."studentId"=\$2 AND \$\{parentUsableEnrollmentSql\("e"\)\}`/, "카카오 정규 셔틀의 «다니는 요일»");
  for (const src of [web, kakao]) {
    assert.match(src, /from "@\/lib\/enrollment\/resumeWindow"/);
    assert.doesNotMatch(src, /e\.status\s*=\s*'ACTIVE'/);
  }
  // 카카오 당일 변경 확정은 웹과 같은 저장 함수 — 복귀일 검사를 따로 만들지 않는다
  assert.match(kakao, /const result = await submitShuttleException\(state\.parentUserId, \{/);
  assert.match(read("src/lib/kakao-parent-intake-routing.ts"), /await submitShuttleException\(intake\.parentUserId,/);
  // 화면: 복귀일을 날짜 칸의 가장 이른 날로 + 안내 한 줄
  const client = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(client, /min=\{minDate\}/);
  assert.match(client, /resumeNotice\(usableFrom\)/);
});

// ═════════════════════════════════════════════════════════════════════════
// ⑤ 수업 카드·셔틀 «휴원» 판정
// ═════════════════════════════════════════════════════════════════════════
test("수업 카드 — 복귀 예정 반의 «다음 수업»은 복귀일 이후 첫 수업", () => {
  const dates = ["2026-11-16", "2026-11-23", "2026-11-30"];
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: true }), null, "복귀 승인 없는 휴원은 그대로 없음");
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: true, resumeFrom: null }), null);
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: true, resumeFrom: "2026-11-16" }), "2026-11-16", "복귀일 당일 수업");
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: true, resumeFrom: "2026-11-17" }), "2026-11-23", "복귀일 전 수업은 건너뛴다");
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: true, resumeFrom: "2026-12-05" }), null);
  assert.equal(cards.nextClassDate({ dates, today: TODAY, paused: false, resumeFrom: "2026-11-30" }), "2026-11-16", "다니는 반은 복귀일을 보지 않는다");
});

test("수업 카드 — 복귀 예정 반 버튼은 결석·보강·셔틀, 칩은 «복귀 예정 · M/D부터»", () => {
  const resuming = cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: true, resumeFrom: "2026-11-16" });
  assert.deepEqual(resuming.map((a) => [a.key, a.label]), [["absence", "결석"], ["makeup", "보강"], ["shuttle", "셔틀"]]);
  assert.equal(resuming[0].href, "/mypage/regular-absence?studentId=s1&enrollmentId=e1");
  // 복귀 승인 없는 휴원 반은 그대로 [복귀 신청] 하나
  assert.deepEqual(cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: true }).map((a) => a.key), ["resume"]);
  assert.deepEqual(cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: true, resumeFrom: null }).map((a) => a.key), ["resume"]);
  assert.deepEqual(cards.classCardActions({ studentId: "s1", enrollmentId: "e1", paused: false }).map((a) => a.key), ["absence", "makeup", "shuttle", "change"]);
  assert.deepEqual(
    cards.classStatusChip({ enrollmentStatus: "PAUSED", scheduled: { kind: "RESUME", effectiveFrom: "2026-11-16", resumeOn: null }, pending: null, pausedResumeOn: null, today: TODAY }),
    { text: "복귀 예정 · 11/16부터", tone: "info" },
  );
  const overview = read("src/lib/parent/classes-overview.ts");
  assert.match(overview, /\$\{resumeFromSql\("e"\)\} AS "resumeFrom"/);
  assert.match(overview, /nextClassDate\(\{ dates, today, paused, stopFrom, resumeFrom \}\)/);
  assert.match(overview, /classCardActions\(\{ studentId: row\.studentId, enrollmentId: row\.enrollmentId, paused, resumeFrom \}\)/);
  assert.match(read("src/app/mypage/classes/ClassesClient.tsx"), /card\.paused && !card\.resumeFrom/);
});

test("셔틀 «휴원» 판정 — 승인된 복귀일부터 정상 운행", () => {
  const cls = (extra) => ({ classId: "MON", className: "월 6시", dayOfWeek: "Mon", startTime: "18:00", status: "PAUSED", startsOn: null, scheduled: null, pausedResumeOn: null, ...extra });
  const st = shuttleRules.enrollmentStateOn;
  assert.equal(st(cls({ resumeFrom: "2026-11-16" }), "2026-11-15"), "PAUSED", "복귀일 전날");
  assert.equal(st(cls({ resumeFrom: "2026-11-16" }), "2026-11-16"), "ACTIVE", "복귀일 당일");
  assert.equal(st(cls({ resumeFrom: "2026-11-16" }), "2026-11-23"), "ACTIVE");
  // 휴원 신청에 적어 둔 옛 복귀 예정일보다 «승인된 복귀일»이 먼저다
  assert.equal(st(cls({ resumeFrom: "2026-11-16", pausedResumeOn: "2026-12-01" }), "2026-11-16"), "ACTIVE");
  assert.equal(st(cls({ resumeFrom: "2026-11-23", pausedResumeOn: "2026-11-16" }), "2026-11-16"), "PAUSED");
  // 승인된 복귀가 없으면 예전 판정 그대로
  assert.equal(st(cls({}), "2026-11-16"), "PAUSED");
  assert.equal(st(cls({ pausedResumeOn: "2026-11-16" }), "2026-11-16"), "ACTIVE");
  assert.match(read("src/lib/parent/childClassesQuery.ts"), /\$\{resumeFromSql\("e"\)\} AS "resumeFrom"/);
});

// ═════════════════════════════════════════════════════════════════════════
// ⑥ 학부모 홈·달력 — 복귀 예정 반의 복귀일 이후 일정 (2026-11-14 원장 승인)
//    getMyPageData 의 enrollments(수강 중 = ACTIVE 만) 뜻은 그대로, 별도 칸 resumingEnrollments 를 홈·달력만 읽는다.
// ═════════════════════════════════════════════════════════════════════════
const schedule = await import(load("src/lib/mypage/parentSchedule.ts"));
const summary = await import(load("src/lib/mypage/summary.ts"));

/** 연간일정 대신: 그 달의 그 요일 날짜 전부(휴무 없음) */
function weekdayDates(ym, dayOfWeek) {
  const target = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayOfWeek);
  const [y, m] = ym.split("-").map(Number);
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1) break;
    if (date.getUTCDay() === target) out.push(`${ym}-${String(d).padStart(2, "0")}`);
  }
  return out;
}
const calendarDates = (month, enrollments, resuming) =>
  rw.withResumingForSchedule(enrollments, resuming)
    .flatMap((e) => schedule.classDatesForCalendarMonth(month, e.dayOfWeek, e.startsOn, weekdayDates))
    .sort();

test("달력 — 복귀 예정 반은 복귀일 전날까지 없고 당일부터 수업일이다", () => {
  const mon = { id: "e1", dayOfWeek: "Mon", startsOn: "2026-03-02" };
  // 복귀일 11-16(월) — 11-02·11-09 는 없고 11-16 부터
  assert.deepEqual(calendarDates("2026-11", [], [{ ...mon, resumeFrom: "2026-11-16" }]), ["2026-11-16", "2026-11-23", "2026-11-30"]);
  // 복귀일이 수업 요일 다음 날(11-17 화)이면 11-16 수업은 아직 휴원
  assert.deepEqual(calendarDates("2026-11", [], [{ ...mon, resumeFrom: "2026-11-17" }]), ["2026-11-23", "2026-11-30"]);
  // 복귀일 전 달은 비어 있고, 다음 달은 전부
  assert.deepEqual(calendarDates("2026-10", [], [{ ...mon, resumeFrom: "2026-11-16" }]), []);
  assert.equal(calendarDates("2026-12", [], [{ ...mon, resumeFrom: "2026-11-16" }]).length, 4);
  // 개시일이 복귀일보다 늦으면 개시일이 기준(둘 중 늦은 날)
  assert.deepEqual(calendarDates("2026-11", [], [{ ...mon, startsOn: "2026-11-23", resumeFrom: "2026-11-16" }]), ["2026-11-23", "2026-11-30"]);
});

test("달력 — 반 2개의 복귀일이 다르면 반마다 따로, 수강 중인 반은 그대로", () => {
  const resuming = [
    { id: "e1", dayOfWeek: "Mon", startsOn: null, resumeFrom: "2026-11-16" },
    { id: "e2", dayOfWeek: "Wed", startsOn: null, resumeFrom: "2026-11-18" },
  ];
  assert.deepEqual(calendarDates("2026-11", [], resuming), ["2026-11-16", "2026-11-18", "2026-11-23", "2026-11-25", "2026-11-30"]);
  const active = [{ id: "e9", dayOfWeek: "Fri", startsOn: null }];
  const withActive = calendarDates("2026-11", active, resuming);
  assert.ok(withActive.includes("2026-11-06") && withActive.includes("2026-11-13"), "다니는 반(금)은 달 처음부터");
  assert.equal(withActive.includes("2026-11-09"), false, "복귀 예정 반(월)의 복귀일 전 수업은 없다");
  // 복귀 예정 반이 없으면 예전과 같은 목록 — 형식이 틀린 복귀일은 버린다
  assert.deepEqual(rw.withResumingForSchedule(active, []), active);
  assert.deepEqual(rw.withResumingForSchedule(active, undefined), active);
  assert.deepEqual(rw.withResumingForSchedule(active, [{ id: "x", dayOfWeek: "Mon", resumeFrom: "" }, { id: "y", dayOfWeek: "Mon", resumeFrom: "11/16" }]), active);
  assert.deepEqual(rw.withResumingForSchedule(null, [{ id: "x", dayOfWeek: "Mon", startsOn: null, resumeFrom: "2026-11-16" }]), [{ id: "x", dayOfWeek: "Mon", startsOn: "2026-11-16", resumeFrom: "2026-11-16" }]);
});

test("홈 «다음 수업» — 전부 복귀 예정인 아이도 복귀일 이후 첫 수업이 잡힌다", () => {
  const sat = { dayIndex: 6, minutes: 10 * 60 }; // 2026-11-14(토) 10:00
  const cls = { className: "월요반", dayOfWeek: "Mon", startTime: "18:00", endTime: "19:30" };
  assert.equal(summary.computeNextClass([], sat, TODAY), null, "예전: 수강 중인 반이 없으면 다음 수업 없음");
  const next = summary.computeNextClass(rw.withResumingForSchedule([], [{ ...cls, startsOn: null, resumeFrom: "2026-11-16" }]), sat, TODAY);
  assert.equal(next.serviceDate, "2026-11-16");
  assert.equal(next.className, "월요반");
  // 복귀일이 한 주 뒤면 그 주차로 밀린다(복귀일 전 월요일은 건너뛴다)
  assert.equal(summary.computeNextClass(rw.withResumingForSchedule([], [{ ...cls, startsOn: null, resumeFrom: "2026-11-17" }]), sat, TODAY).serviceDate, "2026-11-23");
  // 다니는 반이 더 가까우면 그 반이 다음 수업
  const active = [{ className: "일요반", dayOfWeek: "Sun", startTime: "10:00", endTime: "11:00" }];
  assert.equal(summary.computeNextClass(rw.withResumingForSchedule(active, [{ ...cls, startsOn: null, resumeFrom: "2026-11-16" }]), sat, TODAY).className, "일요반");
});

// getMyPageData 를 «실제 실행» — queries.ts 는 딸린 모듈이 많아, 이 함수가 쓰는 것만 진짜(resumeWindow·commencement·kst)로 넣고 나머지는 빈 대역을 준다.
async function runMyPageData(db) {
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const cjs = (file, requireFn) => {
    const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    new Function("require", "module", "exports", code)(requireFn, module, module.exports);
    return module.exports;
  };
  // 아무 이름이나 받아 주는 대역: 함수를 넘기면 그 함수를 그대로 돌려준다(cache·unstable_cache), SQL 에 끼우면 TRUE
  const blank = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => "TRUE" : key === "then" ? undefined : blank),
    apply: (_t, _this, args) => (typeof args[0] === "function" ? args[0] : blank),
  });
  const real = {
    "@/lib/datetime/kst": cjs("src/lib/datetime/kst.ts", nodeRequire),
    "@/lib/enrollment/resumeWindow": cjs("src/lib/enrollment/resumeWindow.ts", nodeRequire),
    "@/lib/enrollment/parentChangeStatus": cjs("src/lib/enrollment/parentChangeStatus.ts", nodeRequire),
    "@/lib/prisma": { prisma: db },
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
    "@/lib/payments/payerAccess": { payerAccessSql: async () => "TRUE" },
    "@/lib/payment-ledger": { ensurePaymentInfrastructure: async () => {} },
    "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL`, notMergedStudentOptional: () => "TRUE" },
  };
  real["@/lib/enrollment/commencement"] = cjs("src/lib/enrollment/commencement.ts", (name) => real[name] ?? blank);
  const queries = cjs("src/lib/queries.ts", (name) => real[name] ?? blank);
  return queries.getMyPageData("p1");
}

test("getMyPageData — 복귀 예정 반은 별도 칸으로 오고, enrollments 에는 PAUSED 가 섞이지 않는다", async () => {
  const base = makeDb();
  freeze(TODAY);
  const seen = [];
  const cls = (id) => base.classes.find((c) => c.id === id);
  const db = {
    async $queryRawUnsafe(sql, ...args) {
      if (/FROM "User" WHERE id = \$1/.test(sql)) return [{ id: "p1", name: "보호자", email: null, phone: null }];
      if (/FROM "Student" s/.test(sql) && /"canPay"/.test(sql)) {
        assert.match(sql, /s\."parentId" = \$1 AND s\."mergedIntoStudentId" IS NULL/, "자녀 목록의 소유·병합 조건은 그대로");
        return base.students.filter((s) => s.parentId === args[0]).map((s) => ({ id: s.id, name: s.name, canPay: true }));
      }
      if (/FROM "Enrollment" e/.test(sql)) {
        seen.push(sql);
        const row = (e) => ({ id: e.id, classId: e.classId, status: e.status, startsOn: null, class_name: cls(e.classId).name, dayOfWeek: cls(e.classId).dayOfWeek, startTime: "18:00", endTime: "19:30", program_name: null });
        // 수강 중: 맨 ACTIVE 조건 그대로
        if (/WHERE e\."studentId" = \$1 AND e\.status = 'ACTIVE'$/.test(sql.trim())) {
          return base.enrollments.filter((e) => e.studentId === args[0] && e.status === "ACTIVE").map(row);
        }
        // 복귀 예정: PAUSED + 공용 조각(가짜 DB 는 그 뜻 — 승인·미반영·미처리·오늘 이후 — 을 그대로 흉내 낸다)
        assert.ok(sql.includes(`WHERE e."studentId" = $1 AND e.status = 'PAUSED' AND ${USABLE_SQL}`), "복귀 예정 조회 = PAUSED + 공용 조각");
        assert.ok(sql.includes(`${RESUME_FROM_SQL} AS "resumeFrom"`));
        const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        return base.enrollments.filter((e) => e.studentId === args[0] && e.status === "PAUSED").flatMap((e) => {
          const from = base.requests.filter((r) => r.enrollmentId === e.id && r.kind === "RESUME" && r.status === "APPROVED" && r.appliedAt == null
            && r.effectiveFrom >= today && !base.commands.some((c) => c.idempotencyKey === `enrollment-change:rq-${e.id}`)).map((r) => r.effectiveFrom).sort()[0];
          return from ? [{ ...row(e), resumeFrom: from }] : [];
        });
      }
      if (/FROM "Attendance" a/.test(sql) || /FROM "Payment" p/.test(sql)) return [];
      throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
    },
  };
  const data = await runMyPageData(db);
  assert.ok(data, "getMyPageData 가 null 이 아니다(안에서 오류가 나면 null 이 된다)");
  const child = (id) => data.children.find((c) => c.id === id);
  // 전부 복귀 예정(s1): 수강 중 목록은 비고, 별도 칸에 반 2개가 복귀일과 함께
  assert.deepEqual(child("s1").enrollments, []);
  assert.deepEqual(child("s1").resumingEnrollments.map((e) => [e.classId, e.className, e.dayOfWeek, e.resumeFrom, e.resumeFromLabel]).sort(), [["cMon", "월요반", "Mon", "2026-11-16", "11/16"], ["cWed", "수요반", "Wed", "2026-11-25", "11/25"]]);
  // 일정 계산용 목록: 복귀 예정 반이 «개시일 자리에 복귀일»로 들어 있다 → 달력이 복귀일 당일부터 그린다
  assert.deepEqual(child("s1").scheduleEnrollments.map((e) => [e.dayOfWeek, e.startsOn]).sort(), [["Mon", "2026-11-16"], ["Wed", "2026-11-25"]]);
  assert.deepEqual(
    child("s1").scheduleEnrollments.flatMap((e) => schedule.classDatesForCalendarMonth("2026-11", e.dayOfWeek, e.startsOn, weekdayDates)).sort(),
    ["2026-11-16", "2026-11-23", "2026-11-25", "2026-11-30"], "11-02·11-09(월)·11-18(수)은 복귀일 전이라 없다",
  );
  assert.deepEqual(child("s4").scheduleEnrollments.map((e) => [e.dayOfWeek, e.startsOn]), [["Mon", null]], "다니는 반은 그대로");
  assert.deepEqual(child("s5").scheduleEnrollments.map((e) => [e.dayOfWeek, e.startsOn]), [["Fri", null], ["Wed", "2026-11-25"]]);
  assert.deepEqual(child("s2").scheduleEnrollments, []);
  // 홈 «다음 수업»: 전부 복귀 예정인 s1 도 복귀일 수업이 잡힌다(토요일 10시 기준)
  assert.equal(summary.computeNextClass(child("s1").scheduleEnrollments, { dayIndex: 6, minutes: 600 }, TODAY).serviceDate, "2026-11-16");
  // 복귀 대기(s2)·복귀 신청 없음(s3): 어느 칸에도 없다
  for (const id of ["s2", "s3"]) { assert.deepEqual(child(id).enrollments, []); assert.deepEqual(child(id).resumingEnrollments, []); }
  // 다니는 아이(s4)·섞인 아이(s5): enrollments 는 ACTIVE 만
  assert.deepEqual(child("s4").enrollments.map((e) => [e.classId, e.status]), [["cMon", "ACTIVE"]]);
  assert.deepEqual(child("s4").resumingEnrollments, []);
  assert.deepEqual(child("s5").enrollments.map((e) => [e.classId, e.status]), [["cFri", "ACTIVE"]]);
  assert.deepEqual(child("s5").resumingEnrollments.map((e) => e.classId), ["cWed"]);
  for (const c of data.children) assert.ok(c.enrollments.every((e) => e.status === "ACTIVE"), "enrollments 에 PAUSED 가 섞이지 않는다");
  assert.equal(seen.filter((sql) => /e\.status = 'ACTIVE'$/.test(sql.trim())).length, data.children.length, "수강 중 조회는 자녀마다 예전 조건 그대로");

  // 보류된(크론이 원장을 만든) 신청은 홈·달력에도 안 보인다
  base.commands.push({ idempotencyKey: "enrollment-change:rq-e1" });
  const held = await runMyPageData(db);
  const s1 = held.children.find((c) => c.id === "s1");
  assert.deepEqual(s1.resumingEnrollments.map((e) => e.classId), ["cWed"]);
  // 달력까지 이어서: s1 의 11월 = 수요반 11-25 하나뿐(월요반은 보류, 수요반은 복귀일 전 제외)
  assert.deepEqual(calendarDates("2026-11", s1.enrollments, s1.resumingEnrollments), ["2026-11-25"]);
  assert.deepEqual(s1.scheduleEnrollments.map((e) => [e.dayOfWeek, e.startsOn]), [["Wed", "2026-11-25"]]);
});

test("홈·달력 화면 — 별도 칸만 읽고, 전부 복귀 예정인 아이를 «수강 중인 반이 없습니다»로 보이지 않는다", () => {
  const queries = read("src/lib/queries.ts");
  // 수강 중 조회는 글자 그대로 남아 있다(다른 사용처가 이 뜻에 기댄다)
  assert.match(queries, /WHERE e\."studentId" = \$1 AND e\.status = 'ACTIVE'`/);
  assert.match(queries, /WHERE e\."studentId" = \$1 AND e\.status = 'PAUSED' AND \$\{parentUsableEnrollmentSql\("e"\)\}`/);
  // 일정 계산용 목록은 서버 한 곳(getMyPageData)에서 공용 도우미로 만든다 — 화면은 받아서 쓰기만 한다
  assert.match(queries, /scheduleEnrollments: withResumingForSchedule\(/);
  assert.match(read("src/lib/mypage/parentMonthViews.ts"), /const scheduled = child\.scheduleEnrollments \?\? child\.enrollments \?\? \[\];/);
  // 2026-11-14 검수: «연간일정 확정 후 보여요» 안내는 수강 중인 반이 있을 때만(복귀 예정만 있으면 틀린 안내)
  assert.match(read("src/lib/mypage/parentMonthViews.ts"), /hasEnrollments: \(child\.enrollments \?\? \[\]\)\.length > 0/);
  assert.match(read("src/app/mypage/history/page.tsx"), /\(selected\?\.scheduleEnrollments \?\? selected\?\.enrollments \?\? \[\]\)\.flatMap/);
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /computeNextClass\(child\.scheduleEnrollments \?\? child\.enrollments, kstNow, todayStr\)/);
  assert.match(home, /복귀 예정인 반 \$\{resumingEnrollments\.length\}개/);
  assert.match(home, /const currentEnrollments = child\.enrollments;/, "«수강 중인 반 N개»는 여전히 ACTIVE 만 센다");
  const hub = read("src/app/mypage/history/ScheduleHub.tsx");
  assert.match(hub, /hasEnrollments=\{enrollments\.length > 0\}/);
  assert.match(hub, /복귀 예정 · \{e\.resumeFromLabel\}부터/);
  // 결제·수강 변경 쪽은 새 칸을 읽지 않는다
  for (const file of ["src/lib/enrollment/parent-change-request.ts", "src/lib/payments/parent-payment-request.ts"]) {
    assert.doesNotMatch(read(file), /resumingEnrollments/, file);
  }
});
