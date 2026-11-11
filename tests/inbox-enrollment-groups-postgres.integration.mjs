import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import pg from "pg";
import * as catalog from "../src/lib/requests/catalog.ts";
import * as grouping from "../src/lib/requests/inbox-enrollment-change-group.ts";
import * as rules from "../src/lib/enrollment/changeRequestRules.ts";

// 반드시 직접 시작한 로컬 시험 DB 포트를 넘긴다. 환경 설정이나 운영 URL을 사용하지 않는다.
const port = Number(process.argv[2]);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "postgres" });
const sql = async (query, ...values) => (await client.query(query, values)).rows;
const load = (file, deps) => {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)((id) => {
    if (!(id in deps)) throw new Error(`Unexpected test dependency: ${id}`);
    return deps[id];
  }, exports);
  return exports;
};
const fakePrisma = {
  $queryRawUnsafe: sql,
  async $transaction(work) {
    await sql("SAVEPOINT app");
    try {
      const result = await work(this);
      await sql("RELEASE SAVEPOINT app");
      return result;
    } catch (error) {
      await sql("ROLLBACK TO SAVEPOINT app");
      await sql("RELEASE SAVEPOINT app");
      throw { code: "P2010", meta: { code: error.code } };
    }
  },
};
const notices = [];
const readModel = load("../src/lib/requests/admin-inbox.ts", {
  react: { cache: (fn) => fn },
  "@/lib/prisma": { prisma: {
    $queryRawUnsafe: (query, ...values) => fakePrisma.$transaction(() => sql(query, ...values)),
  } },
  "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
  "@/lib/datetime/kst": { isKstYmd: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") },
  "@/lib/enrollment/admin-enrollment-edit": { notClosedByDeletedEnrollmentSql: (alias) => `${alias}."holdReason" IS DISTINCT FROM 'deleted'` },
  "@/lib/enrollment/pause-settlement": { settlementTablesReady: async () => true },
  "@/lib/requests/inbox-enrollment-change-group": grouping,
  "@/lib/requests/catalog": catalog,
  "@/lib/requests/consult-inbox": { countConsultAction: async () => 0 },
});
const parentRequests = load("../src/lib/enrollment/parent-change-request.ts", {
  "@/lib/prisma": { prisma: fakePrisma },
  "@/lib/account/child-access": { childAccessSql: async (alias, bind) => `${alias}."parentId" = ${bind}` },
  "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
  "@/lib/datetime/kst": { todayKst: () => "2026-11-11", kstHm: () => "18:00" },
  "@/lib/enrollment/changeRequestRules": rules,
  "@/lib/enrollment/parentChangeStatus": {},
  "@/lib/operational-staff-notification": { notifyOperationalStaff: async (notice) => notices.push(notice) },
});
const read = (bucket, extra = {}) => readModel.getInboxRows({ bucket, kinds: ["ENROLLMENT_CHANGE"], ...extra });
const countRows = (withSettlement = true) => sql(readModel.buildInboxCountsSql(false, withSettlement).split("\nUNION ALL\n")[0]);
const legacyNote = "[nov-class-pause-20261029] 합성 기록";

await client.connect();
try {
  await sql("BEGIN");
  await sql(`CREATE TABLE "Student" (id text PRIMARY KEY, name text, "parentId" text, "mergedIntoStudentId" text);
    CREATE TABLE "Class" (id text PRIMARY KEY, name text, "dayOfWeek" text, "startTime" text);
    CREATE TABLE "Enrollment" (id text PRIMARY KEY, "studentId" text, "classId" text, status text);
    CREATE TABLE "OperationsCommand" (id text PRIMARY KEY, "idempotencyKey" text, "afterJson" jsonb,
      status text, "holdReason" text, "createdAt" timestamptz DEFAULT now());
    CREATE TABLE "OperationsSyncAttempt" ("commandId" text, target text, status text);
    CREATE TABLE "EnrollmentChangeSettlement" ("requestId" text, status text);
    CREATE TABLE "EnrollmentChangeRequest" (
      id text PRIMARY KEY DEFAULT gen_random_uuid()::text, "studentId" text, "enrollmentId" text,
      "fromClassId" text, "toClassId" text, kind text, "effectiveFrom" date, "resumeOn" date,
      reason text, status text DEFAULT 'PENDING', waitlisted boolean DEFAULT false,
      "requestedByUserId" text, "decidedByUserId" text, "decisionNote" text, "appliedAt" timestamptz,
      "cancelRequestStatus" text, "cancelRequestedAt" timestamptz, "cancelRequestReason" text,
      "createdAt" timestamptz DEFAULT now());
    CREATE UNIQUE INDEX test_pending_per_class ON "EnrollmentChangeRequest" ("enrollmentId") WHERE status = 'PENDING';
    INSERT INTO "Student" VALUES ('student-a','합성 학생','parent-a',NULL), ('student-b','합성 학생','parent-a',NULL),
      ('student-other','다른 집 학생','parent-other',NULL);
    INSERT INTO "Class" VALUES ('mon','월요일 5교시','Mon','17:00'), ('wed','수요일 5교시','Wed','17:00'),
      ('fri','금요일 5교시','Fri','17:00');
    INSERT INTO "Enrollment" VALUES ('old-mon','student-a','mon','PAUSED'),('old-wed','student-a','wed','PAUSED'),
      ('new-mon','student-a','mon','ACTIVE'),('new-wed','student-a','wed','ACTIVE'),
      ('new-fri','student-a','fri','ACTIVE'),('new-sibling','student-b','mon','ACTIVE'),
      ('new-other','student-other','wed','ACTIVE');
    INSERT INTO "OperationsCommand" (id, "idempotencyKey", status, "holdReason") VALUES
      ('o1','enrollment-change:legacy-a','HELD','보호자 확인 필요'),
      ('o2','enrollment-change:legacy-b','HELD','보호자 확인 필요'),
      ('o3','enrollment-change:sync-a','APPLIED',NULL);
    INSERT INTO "OperationsSyncAttempt" VALUES ('o3','RALLYZ','PENDING');
    INSERT INTO "EnrollmentChangeSettlement" VALUES ('settlement-a','OPEN');`);
  const fixtures = [
    ["legacy-a", "student-a", "old-mon", "mon", "같은 신청", legacyNote, "APPROVED"],
    ["legacy-b", "student-a", "old-wed", "wed", "같은 신청", legacyNote, "APPROVED"],
    ["independent-a", "student-a", "x1", "mon", "같은 신청", null, "APPROVED"],
    ["independent-b", "student-a", "x2", "wed", "같은 신청", null, "APPROVED"],
    ["other-reason", "student-a", "x3", "wed", "다른 신청", legacyNote, "APPROVED"],
    ["same-name-other-student", "student-b", "x4", "wed", "같은 신청", legacyNote, "APPROVED"],
    ["sync-a", "student-a", "x5", "mon", "처리됨", null, "APPLIED"],
    ["settlement-a", "student-a", "x6", "wed", "처리됨", null, "APPLIED"],
  ];
  for (const fixture of fixtures) {
    await sql(`INSERT INTO "EnrollmentChangeRequest"
      (id,"studentId","enrollmentId","fromClassId",reason,"decisionNote",status,kind,"effectiveFrom","requestedByUserId","decidedByUserId","createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PAUSE','2026-11-03','admin','admin','2026-10-29T08:00:00Z')`, ...fixture);
  }

  const readyInput = {
    kind: "PAUSE", enrollmentId: "new-mon", enrollmentIds: ["new-mon","new-wed"],
    effectiveFrom: "2026-11-12", resumeOn: "2026-11-19", reason: "합성 접수",
  };
  assert.equal((await parentRequests.submitEnrollmentChangeRequest("parent-a", readyInput)).ok, false);
  const migration = readFileSync(new URL("../prisma/migrations/20261111120000_enrollment_pause_submission_group/migration.sql", import.meta.url), "utf8");
  const legacy = (await read("ACTION")).rows.find((row) => row.id === "legacy-a");
  assert.equal(legacy.statusLabel, "반영 확인 필요");
  assert.deepEqual(legacy.members.map(({ id, enrollmentStatus, holdReason }) => ({ id, enrollmentStatus, holdReason }))
    .sort((a,b) => a.id.localeCompare(b.id)), [
    { id: "legacy-a", enrollmentStatus: "PAUSED", holdReason: "보호자 확인 필요" },
    { id: "legacy-b", enrollmentStatus: "PAUSED", holdReason: "보호자 확인 필요" },
  ]);
  assert.match(legacy.summary, /월요일 5교시/);
  assert.match(legacy.summary, /수요일 5교시/);
  assert.equal((await read("ONGOING")).rows.length, 4);
  assert.equal((await read("ACTION", { limitPerKind: 1 })).rows.length, 1);
  assert.equal((await read("ACTION", { from: "2026-10-30" })).rows.length, 0);
  assert.deepEqual(Object.fromEntries((await countRows()).map(({raw,n}) => [raw,n])), {
    APPLY_HELD: 1, APPROVED: 4, SYNC_CHECK: 1, SETTLEMENT_CHECK: 1,
  });
  assert.equal((await countRows(false)).some((row) => row.raw === "SETTLEMENT_CHECK"), false);
  assert.match(readModel.buildInboxCountsSql(true), /pauseGroupKey/);
  await sql(`ALTER TABLE "EnrollmentChangeRequest" DROP COLUMN "cancelRequestStatus", DROP COLUMN "cancelRequestedAt", DROP COLUMN "cancelRequestReason"`);
  assert.equal((await read("ACTION")).rows.find((row) => row.id === "legacy-a").members.length, 2);
  assert.equal((await sql(readModel.buildInboxCountsSql(true).split("\nUNION ALL\n")[0])).find((row) => row.raw === "APPLY_HELD").n, 1);
  await sql(`ALTER TABLE "EnrollmentChangeRequest" ADD COLUMN "cancelRequestStatus" text, ADD COLUMN "cancelRequestedAt" timestamptz, ADD COLUMN "cancelRequestReason" text`);
  await sql(migration);
  await sql(migration);
  await sql(`INSERT INTO "EnrollmentChangeRequest"
    (id,"studentId","enrollmentId","fromClassId",reason,status,kind,"effectiveFrom","requestedByUserId","createdAt","submissionGroupId")
    VALUES
      ('explicit-a','student-a','explicit-enroll-a','mon','같은 사유','APPROVED','PAUSE','2026-12-01','parent-a','2026-11-11T09:00:00Z',gen_random_uuid()),
      ('explicit-b','student-a','explicit-enroll-b','wed','같은 사유','APPROVED','PAUSE','2026-12-01','parent-a','2026-11-11T09:00:00Z',gen_random_uuid())`);
  const explicitRows = (await read("ONGOING")).rows.filter((row) => row.id.startsWith("explicit-"));
  assert.deepEqual(explicitRows.map((row) => row.id), ["explicit-a", "explicit-b"]);
  assert.ok(explicitRows.every((row) => row.members.length === 1));
  assert.equal((await countRows()).find((row) => row.raw === "APPROVED").n, 6);

  for (const input of [
    { ...readyInput, effectiveFrom: "2026-11-11" },
    { ...readyInput, enrollmentIds: ["new-mon","new-sibling"] },
    { ...readyInput, enrollmentIds: ["new-mon","new-other"] },
    { ...readyInput, enrollmentIds: ["new-mon","new-mon"] },
  ]) assert.equal((await parentRequests.submitEnrollmentChangeRequest("parent-a", input)).ok, false);
  assert.equal(notices.length, 0);
  const submission = await parentRequests.submitEnrollmentChangeRequest("parent-a", readyInput);
  assert.equal(submission.ok, true);
  assert.ok(submission.submissionGroupId);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].classIds, ["mon", "wed"]);
  assert.equal(notices[0].linkUrl, "/admin/inbox?tab=CHANGE&sub=ENROLLMENT");
  assert.equal((await parentRequests.submitEnrollmentChangeRequest("parent-a", {
    ...readyInput, enrollmentIds: ["new-mon", "new-fri"],
  })).ok, false);
  const stored = await sql(`SELECT id, "enrollmentId", "createdAt" FROM "EnrollmentChangeRequest"
    WHERE "submissionGroupId" = $1::uuid ORDER BY "enrollmentId"`, submission.submissionGroupId);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].createdAt.getTime(), stored[1].createdAt.getTime());
  let open = (await read("ACTION")).rows.find((row) => row.members.some((m) => m.id === submission.id));
  assert.equal(open.members.length, 2);
  const groupId = open.id;
  await sql(`UPDATE "EnrollmentChangeRequest" SET status = 'APPLIED' WHERE id = $1`, groupId);
  open = (await read("ACTION")).rows.find((row) => row.id === groupId);
  assert.equal(open.id, groupId);
  assert.deepEqual(new Set(open.members.map((m) => m.rawStatus)), new Set(["PENDING","APPLIED"]));
  assert.equal((await countRows()).find((row) => row.raw === "PENDING").n, 1);
  console.log("PostgreSQL 16: 과거 묶음, 별개 신청, 보류·정산, 목록/개수, 이전 스키마, 여러 반 접수/혼합 상태 검증 통과");
} finally {
  await sql("ROLLBACK");
  await client.end();
}
