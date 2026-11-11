import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

// 2026-11-09 원장 점검: «접수 후 복귀 신청도 떠야 해. 휴원 신청 취소도 필요하고».
// 학부모 복귀(RESUME) 신청 서버 경로를 가짜 DB 로 실제 실행해 본다 — 소유권(IDOR)·휴원 중 여부·중복·날짜 경계.

const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : nodeRequire(name);
  module._compile(compiled, absolute);
  return module.exports;
};
const rules = load("src/lib/enrollment/changeRequestRules.ts");
const changeStatus = load("src/lib/enrollment/parentChangeStatus.ts");
const kst = load("src/lib/datetime/kst.ts");

/**
 * 가짜 DB. 수강 행은 { id, parentId, status } 로 두고, 소유권 SQL 의 조건을 흉내 내어 걸러 준다.
 * (SQL 에 소유권·상태 조건이 실제로 들어 있는지도 함께 검사한다)
 */
function harness({ today = "2026-11-09", enrollments = [{ id: "enr-paused", parentId: "parent-a", status: "PAUSED" }], pendingFor = [] } = {}) {
  const writes = [];
  const queries = [];
  const notices = [];
  const prisma = {
    async $queryRawUnsafe(sql, ...values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT e.id, e."classId"')) {
        // 소유권 + 상태 조건이 SQL 에 있어야 한다(클라이언트 값을 믿지 않는다)
        assert.match(sql, /e\.id = \$1/);
        assert.match(sql, /OWNER\(s,\$2\)/);
        const wanted = /e\.status = 'PAUSED'/.test(sql) ? "PAUSED" : /e\.status = 'ACTIVE'/.test(sql) ? "ACTIVE" : null;
        assert.ok(wanted, "상태 조건이 있어야 한다");
        const row = enrollments.find((e) => e.id === values[0] && e.parentId === values[1] && e.status === wanted);
        return row ? [{ id: row.id, classId: "class-a", studentId: "student-a", studentName: "합성 학생", className: "합성 반" }] : [];
      }
      if (sql.includes('SELECT 1 FROM "EnrollmentChangeRequest"')) {
        assert.match(sql, /status = 'PENDING'/);
        return pendingFor.includes(values[0]) ? [{ "?column?": 1 }] : [];
      }
      return [];
    },
    async $executeRawUnsafe(sql, ...values) {
      assert.match(sql, /INSERT INTO "EnrollmentChangeRequest"/);
      writes.push({ sql, values });
      return 1;
    },
  };
  const api = load("src/lib/enrollment/parent-change-request.ts", {
    // 소유권 식은 표식으로 바꿔 «어느 자리표시자에 부모 id 를 묶는지» 확인한다
    "@/lib/account/child-access": { childAccessSql: async (alias, param) => `OWNER(${alias},${param})` },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: () => "TRUE" },
    "@/lib/datetime/kst": { ...kst, todayKst: () => today },
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
    "@/lib/operational-staff-notification": { notifyOperationalStaff: async (input) => { notices.push(input); } },
  });
  return { api, writes, queries, notices };
}

test("휴원 중인 본인 자녀 반의 복귀 신청은 RESUME·복귀일로 저장되고 원장에게 같은 경로로 알린다", async () => {
  const h = harness();
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: "2026-11-20", reason: " 다리 다 나았어요 " });
  assert.equal(result.ok, true);
  assert.equal(typeof result.id, "string");
  assert.equal(result.kind, "RESUME");
  assert.equal(h.writes.length, 1);
  const v = h.writes[0].values;
  // ("studentId","enrollmentId","fromClassId","toClassId","kind","effectiveFrom","resumeOn","reason","waitlisted","requestedByUserId",id)
  assert.deepEqual(v.slice(0, 10), ["student-a", "enr-paused", "class-a", null, "RESUME", "2026-11-20", null, "다리 다 나았어요", false, "parent-a"]);
  assert.equal(v[10], result.id, "화면이 바로 취소할 수 있게 저장한 id 를 그대로 돌려준다");
  // 원장 알림 = 휴원 신청과 같은 경로(notifyOperationalStaff · 수강 변경 신청 화면 링크)
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].type, "ENROLLMENT_CHANGE");
  assert.equal(h.notices[0].linkUrl, "/admin/inbox?tab=CHANGE&sub=ENROLLMENT");
  assert.match(h.notices[0].message, /합성 학생 학생 복귀 신청 \(합성 반, 2026-11-20부터\)/);
});

test("IDOR: 남의 자녀 수강 id 로는 복귀 신청이 저장되지 않는다", async () => {
  const h = harness({ enrollments: [{ id: "enr-other", parentId: "parent-b", status: "PAUSED" }] });
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-other", kind: "RESUME", effectiveFrom: "2026-11-20" });
  assert.equal(result.ok, false);
  assert.match(result.message, /본인 자녀/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.notices.length, 0);
  // 부모 id 는 클라이언트 값이 아니라 로그인한 부모(첫 인자)를 $2 로 묶는다
  assert.deepEqual(h.queries[0].values, ["enr-other", "parent-a"]);
});

test("다니는 중(ACTIVE)인 반에는 복귀 신청을 받지 않는다 — 휴원 중(PAUSED)만", async () => {
  const h = harness({ enrollments: [{ id: "enr-active", parentId: "parent-a", status: "ACTIVE" }] });
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-active", kind: "RESUME", effectiveFrom: "2026-11-20" });
  assert.equal(result.ok, false);
  assert.equal(h.writes.length, 0);
});

test("반대로 휴원 중인 반에는 반 변경·휴원·퇴원 신청을 받지 않는다(기존 ACTIVE 가드 유지)", async () => {
  for (const kind of ["PAUSE", "WITHDRAW"]) {
    const h = harness();
    const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind });
    assert.equal(result.ok, false, kind);
    assert.equal(h.writes.length, 0, kind);
  }
});

test("이미 검토 중인 신청이 있으면 복귀 신청을 막는다(중복 차단)", async () => {
  const h = harness({ pendingFor: ["enr-paused"] });
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: "2026-11-20" });
  assert.equal(result.ok, false);
  assert.match(result.message, /이미 검토 중/);
  assert.equal(h.writes.length, 0);
});

test("복귀일 경계: 오늘은 되고 어제는 안 되며, 3개월 뒤까지만(연말·월말 포함)", async () => {
  const cases = [
    // [오늘, 복귀일, 통과?]
    ["2026-11-09", "2026-11-09", true],
    ["2026-11-09", "2026-11-08", false],
    ["2026-11-09", "2027-02-09", true],
    ["2026-11-09", "2027-02-10", false],
    ["2026-12-31", "2026-12-31", true],
    ["2026-12-31", "2027-01-01", true],
    ["2026-12-31", "2027-03-31", true],
    ["2026-12-31", "2027-04-01", false],
    ["2026-11-30", "2027-02-28", true], // 11/30 + 3개월 = 2/28 로 접힌다
    ["2026-11-30", "2027-03-01", false],
  ];
  for (const [today, day, ok] of cases) {
    const h = harness({ today });
    const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: day });
    assert.equal(result.ok, ok, `${today} 기준 ${day}`);
    assert.equal(h.writes.length, ok ? 1 : 0, `${today} 기준 ${day}`);
  }
});

test("복귀일이 없거나 달력에 없는 날이면 거절한다", async () => {
  for (const day of [undefined, "", "  ", "2026-02-30", "2026-11-9", {}, 20261120]) {
    const h = harness();
    const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: day });
    assert.equal(result.ok, false, String(day));
    assert.equal(h.writes.length, 0, String(day));
  }
});

test("KST 자정 경계: UTC 로는 아직 11/09 인 KST 11/10 00:30 에는 11/09 복귀를 «지난날»로 막는다", async () => {
  // 서버(UTC)는 2026-11-09 15:30 — 한국은 이미 11/10. «오늘»은 공용 모듈(todayKst)로만 구한다.
  const kstToday = kst.todayKst(Date.parse("2026-11-09T15:30:00Z"));
  assert.equal(kstToday, "2026-11-10");
  const h = harness({ today: kstToday });
  const past = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: "2026-11-09" });
  assert.equal(past.ok, false);
  assert.match(past.message, /오늘 이후/);
  const okToday = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: "2026-11-10" });
  assert.equal(okToday.ok, true);
});

test("복귀 신청에 희망 반이 붙어 오면 조용히 무시하지 않고 거절한다", async () => {
  const h = harness();
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-paused", kind: "RESUME", effectiveFrom: "2026-11-20", toClassId: "class-b" });
  assert.equal(result.ok, false);
  assert.equal(h.writes.length, 0);
});

test("기존 휴원 신청도 저장한 id 를 돌려준다(접수 직후 바로 «휴원 신청 취소»)", async () => {
  const h = harness({ enrollments: [{ id: "enr-active", parentId: "parent-a", status: "ACTIVE" }] });
  const result = await h.api.submitEnrollmentChangeRequest("parent-a", { enrollmentId: "enr-active", kind: "PAUSE" });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "PAUSE");
  assert.equal(result.effectiveFrom, "2026-12-01");
  assert.equal(h.writes[0].values[10], result.id);
  // 기존 자리(종류=5번째, 적용일=6번째)는 그대로
  assert.equal(h.writes[0].values[4], "PAUSE");
  assert.equal(h.writes[0].values[5], "2026-12-01");
});

test("학부모 화면 조회는 휴원 중 반과 «승인됐지만 시작 전» 신청을 함께 읽는다", async () => {
  const seen = [];
  const prisma = {
    async $queryRawUnsafe(sql) {
      seen.push(sql);
      if (sql.includes('SELECT s.id AS "studentId"')) {
        return [{ studentId: "s", studentName: "합성", enrollmentId: "e", currentClassId: "c", currentClassName: "반", currentProgramName: "p",
          enrollmentStatus: "PAUSED", scheduledKind: "RESUME", scheduledEffectiveFrom: "2026-11-20", scheduledResumeOn: null, pendingId: null }];
      }
      return [];
    },
  };
  const api = load("src/lib/enrollment/parent-change-request.ts", {
    "@/lib/account/child-access": { childAccessSql: async () => "TRUE" },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: () => "TRUE" },
    "@/lib/datetime/kst": { ...kst, todayKst: () => "2026-11-09" },
    "@/lib/enrollment/changeRequestRules": rules,
    "@/lib/enrollment/parentChangeStatus": changeStatus,
  });
  const data = await api.getEnrollmentChangeOptions("parent-a");
  assert.match(seen[0], /e\.status IN \('ACTIVE','PAUSED'\)/);
  assert.match(seen[0], /x\.status = 'APPROVED' AND x\."appliedAt" IS NULL/);
  // 적용일이 지난 승인 건(사람 확인 보류)은 화면을 막지 않게 «시작 전»만
  assert.match(seen[0], /x\."effectiveFrom" > \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date/);
  assert.equal(data.children[0].enrollmentStatus, "PAUSED");
  assert.deepEqual(data.children[0].scheduled, { kind: "RESUME", effectiveFrom: "2026-11-20", resumeOn: null });
  assert.equal(data.minResumeFrom, "2026-11-09");
  assert.equal(data.maxResumeFrom, "2027-02-09");
  assert.equal(data.minEffectiveFrom, "2026-11-10");
});
