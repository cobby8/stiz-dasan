import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-09 원장 승인 4건 — 출석부 «질병·부상» 결석 표시 · 보강 아이 종료 필수 · 보강 아이 출석 알림 · 전체 출석·수정.

const mod = await loadTsModule("src/lib/regular/attendance-absence-reason.ts");
const NOTE = mod.SHEET_ABSENCE_NOTE;

/** RegularAbsence 한 테이블 + 정산(BillingAbsenceResolution) 여부를 흉내 내는 가짜 db. */
function fakeDb(initial = [], { resolved = [] } = {}) {
  const rows = initial.map((r, i) => ({ id: `a${i + 1}`, note: null, reportedByUserId: null, resolvedByUserId: null, ...r }));
  const calls = [];
  const match = (r, [studentId, classId, ymd]) => r.studentId === studentId && r.classId === classId && r.date === ymd;
  return {
    rows, calls,
    async $executeRawUnsafe(sql, ...v) {
      if (sql.includes("pg_advisory_xact_lock")) { calls.push("lock"); return 0; }
      if (sql.includes(`SET reason = $2, status = $3`)) {
        const row = rows.find((r) => r.id === v[0] && r.status === "CANCELLED");
        if (!row) return 0;
        Object.assign(row, { reason: v[1], status: v[2], note: v[3], reportedByUserId: null, resolvedByUserId: v[4] });
        calls.push(`reactivate:${row.id}`);
        return 1;
      }
      if (sql.includes(`SET status = 'CANCELLED'`)) {
        // UPDATE 에도 «출석부가 만든 행만» 조건이 걸려 있어야 학부모 행을 실수로 지우지 않는다.
        assert.match(sql, /note = \$3 AND "reportedByUserId" IS NULL/);
        const row = rows.find((r) => r.id === v[0] && r.status !== "CANCELLED" && r.note === v[2] && !r.reportedByUserId);
        if (!row) return 0;
        row.status = "CANCELLED";
        calls.push(`cancel:${row.id}`);
        return 1;
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
    async $queryRawUnsafe(sql, ...v) {
      if (sql.includes("to_regclass")) return [{ found: "BillingAbsenceResolution" }];
      if (sql.includes(`INSERT INTO "RegularAbsence"`)) {
        const [studentId, classId, date, reason, status, note, resolvedBy] = v;
        if (rows.some((r) => match(r, [studentId, classId, date]))) return []; // ON CONFLICT DO NOTHING
        const row = { id: `a${rows.length + 1}`, studentId, classId, date, reason, status, note, reportedByUserId: null, resolvedByUserId: resolvedBy };
        rows.push(row);
        calls.push(`insert:${status}`);
        return [{ id: row.id }];
      }
      if (sql.includes(`FROM "RegularAbsence" ra`)) {
        if (sql.includes("FOR UPDATE")) calls.push("read-locked");
        return rows.filter((r) => match(r, v)).map((r) => ({ ...r, resolved: resolved.includes(r.id) }));
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
  };
}
const KEY = { studentId: "s1", classId: "c1", dateYmd: "2026-11-09" };
const ROW = { studentId: "s1", classId: "c1", date: "2026-11-09" };
const apply = (db, attendanceStatus, intent, extra = {}) => mod.applyAttendanceAbsenceReasonInTx(db, { ...KEY, attendanceStatus, intent, ...extra });

test("코치가 결석+질병·부상 → 이월 후보(RegularAbsence reason=ILLNESS_INJURY)를 «신고됨»으로 만든다", async () => {
  const db = fakeDb();
  const r = await apply(db, "ABSENT", "ILLNESS_INJURY");
  assert.equal(r.plan, "INSERT");
  assert.deepEqual(r.report, { reason: "ILLNESS_INJURY", status: "REPORTED", source: "SHEET" });
  assert.equal(db.rows[0].reason, "ILLNESS_INJURY", "청구 작업대가 읽는 값과 같다");
  assert.equal(db.rows[0].note, NOTE);
  assert.ok(db.calls.indexOf("lock") < db.calls.indexOf("insert:REPORTED"), "정산과 같은 잠금을 먼저 잡는다");
});

test("관리자가 찍으면 바로 «확정»(작업대에서 증빙 확인만 남음)", async () => {
  const db = fakeDb();
  const r = await apply(db, "ABSENT", "ILLNESS_INJURY", { confirmedByUserId: "admin1" });
  assert.equal(r.report.status, "CONFIRMED");
  assert.equal(db.rows[0].resolvedByUserId, "admin1");
});

test("결석 → 출석으로 바꾸면 출석부 사유가 지워진다(취소)", async () => {
  const db = fakeDb();
  await apply(db, "ABSENT", "ILLNESS_INJURY");
  const r = await apply(db, "PRESENT", undefined);
  assert.equal(r.plan, "CANCEL");
  assert.equal(r.report, null);
  assert.equal(db.rows[0].status, "CANCELLED");
  // 다시 결석+질병·부상 → 취소된 행을 되살린다(학생·반·날짜당 1건 제약)
  const again = await apply(db, "ABSENT", "ILLNESS_INJURY");
  assert.equal(again.plan, "REACTIVATE");
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "REPORTED");
});

test("지각으로 바꿔도, 표시만 꺼도(null) 지워진다", async () => {
  const db = fakeDb();
  await apply(db, "ABSENT", "ILLNESS_INJURY");
  assert.equal((await apply(db, "LATE", undefined)).plan, "CANCEL");
  const db2 = fakeDb();
  await apply(db2, "ABSENT", "ILLNESS_INJURY");
  assert.equal((await apply(db2, "ABSENT", null)).plan, "CANCEL");
});

test("결석 버튼만 다시 누르면(사유 요청 없음) 아무것도 안 바꾸고 잠금도 안 잡는다", async () => {
  const db = fakeDb();
  await apply(db, "ABSENT", "ILLNESS_INJURY");
  db.calls.length = 0;
  const r = await apply(db, "ABSENT", undefined);
  assert.equal(r.plan, "NONE");
  assert.deepEqual(r.report, { reason: "ILLNESS_INJURY", status: "REPORTED", source: "SHEET" });
  assert.deepEqual(db.calls, [], "전체 출석처럼 할 일이 없는 저장은 전역 잠금을 잡지 않는다");
});

test("출석만 찍는 평범한 저장(행 없음)은 잠금 없이 끝난다", async () => {
  const db = fakeDb();
  assert.equal((await apply(db, "PRESENT", undefined)).plan, "NONE");
  assert.deepEqual(db.calls, []);
});

test("학부모가 직접 신고한 행은 출석부가 고치거나 지우지 않는다", async () => {
  const db = fakeDb([{ ...ROW, reason: "PERSONAL", status: "REPORTED", reportedByUserId: "parent1" }]);
  const r = await apply(db, "ABSENT", "ILLNESS_INJURY");
  assert.equal(r.plan, "BLOCKED_PARENT");
  assert.equal(db.rows[0].reason, "PERSONAL");
  assert.ok(mod.absencePlanMessage(r.plan));
  // 아이가 와서 출석 → 학부모 신고는 그대로(기존 동작)
  assert.equal((await apply(db, "PRESENT", undefined)).plan, "NONE");
  assert.equal(db.rows[0].status, "REPORTED");
  // 학부모가 이미 질병·부상으로 신고했으면 그대로 두면 된다
  const db2 = fakeDb([{ ...ROW, reason: "ILLNESS_INJURY", status: "CONFIRMED", reportedByUserId: "parent1" }]);
  const r2 = await apply(db2, "ABSENT", "ILLNESS_INJURY");
  assert.equal(r2.plan, "NONE");
  assert.equal(r2.report.source, "PARENT");
  assert.equal((await apply(db2, "ABSENT", null)).plan, "NONE", "표시 끄기로도 학부모 신고는 안 지운다");
});

test("학부모가 출석부 행 위에 다시 신고하면(reportedByUserId 채워짐) 학부모 행으로 넘어가 출석부가 못 지운다", async () => {
  const db = fakeDb([{ ...ROW, reason: "ILLNESS_INJURY", status: "REPORTED", note: NOTE, reportedByUserId: "parent1" }]);
  assert.equal((await apply(db, "PRESENT", undefined)).plan, "NONE");
  assert.equal(db.rows[0].status, "REPORTED");
});

test("이미 청구에서 이월·보강으로 정산된 결석은 사유를 지우지 않는다", async () => {
  const db = fakeDb([{ ...ROW, reason: "ILLNESS_INJURY", status: "CONFIRMED", note: NOTE }], { resolved: ["a1"] });
  const r = await apply(db, "PRESENT", undefined);
  assert.equal(r.plan, "BLOCKED_RESOLVED");
  assert.equal(db.rows[0].status, "CONFIRMED");
  assert.ok(mod.absencePlanMessage(r.plan));
});

test("학부모가 취소했던 날 아이가 아파서 빠지면 그 행을 출석부 행으로 되살린다", async () => {
  const db = fakeDb([{ ...ROW, reason: "PERSONAL", status: "CANCELLED", reportedByUserId: "parent1" }]);
  const r = await apply(db, "ABSENT", "ILLNESS_INJURY");
  assert.equal(r.plan, "REACTIVATE");
  assert.equal(db.rows[0].reason, "ILLNESS_INJURY");
  assert.equal(db.rows[0].reportedByUserId, null);
});

test("날짜 형식이 틀리면 거부(시간대 계산 없이 YYYY-MM-DD 만)", async () => {
  await assert.rejects(() => mod.applyAttendanceAbsenceReasonInTx(fakeDb(), { ...KEY, dateYmd: "2026-11-9", attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY" }));
});

test("청구 작업대는 같은 테이블·같은 사유 값을 읽는다(저장 위치가 어긋나면 이월 후보에 안 잡힌다)", () => {
  const svc = readFileSync("src/lib/billing/workbench-service.ts", "utf8");
  assert.match(svc, /FROM "RegularAbsence" a JOIN "Student" s/);
  const absence = readFileSync("src/lib/billing/workbench-absence.ts", "utf8");
  assert.match(absence, new RegExp(`absence\\.reason !== "${mod.SHEET_ABSENCE_REASON}"`));
});

// ── 연결부(코치·관리자 저장, 종료, 알림) ──
const staff = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
const admin = readFileSync("src/app/actions/admin.ts", "utf8");
const client = readFileSync("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx", "utf8");

test("코치·관리자 출결 저장이 같은 결석 사유 함수를 쓴다(코치=신고, 관리자=확정)", () => {
  assert.match(staff, /applyAttendanceAbsenceReasonInTx\(tx, \{[\s\S]*?confirmedByUserId: null/);
  assert.match(admin, /applyAttendanceAbsenceReasonInTx\(tx, \{[\s\S]*?confirmedByUserId: admin\.appUserId/);
  // 보강 온 아이의 결석은 자기 반 결석이 아니라 이월 후보를 만들지 않는다.
  assert.match(staff, /if \(!isMakeup\) \{\s*try \{\s*const applied = await prisma\.\$transaction\(\(tx\) => applyAttendanceAbsenceReasonInTx/);
});

test("수업 종료: 출결을 안 찍은 보강 아이가 있으면 종료를 막는다(명단과 같은 makeupOnClassDateSql)", () => {
  const end = staff.slice(staff.indexOf("export async function completeClassSession"));
  assert.match(end, /FROM "MakeupSession" ms[\s\S]*?makeupOnClassDateSql\("ms", "\$1", "\$3"\)[\s\S]*?NOT EXISTS \(SELECT 1 FROM "Attendance" a WHERE a\."sessionId" = \$2 AND a\."studentId" = ms\."studentId"\)/);
  assert.match(end, /Number\(missing\[0\]\?\.count \?\? 0\) \+ Number\(missingMakeup\[0\]\?\.count \?\? 0\) > 0/);
  // 종료 UPDATE 보다 검사가 먼저
  assert.ok(end.indexOf("missingMakeup") < end.search(/SET status = 'COMPLETED'/));
});

test("수업 종료 안내: 출석·지각한 보강 아이 학부모에게도 같은 경로·같은 중복 방지 키로 보낸다(결석 보강 아이 제외)", () => {
  const helper = staff.slice(staff.indexOf("async function getMakeupCompletedParentRecipients"), staff.indexOf("export async function completeClassSession"));
  assert.match(helper, /if \(session\.sessionDateId\) return \[\];/, "특강 회차는 보강 대상 아님");
  assert.match(helper, /makeupOnClassDateSql\("ms", "\$1", "\$3"\)/, "명단과 같은 보강 예약 조건(예약됨·참석)");
  assert.match(helper, /a\."sessionId" = \$2 AND a\."studentId" = ms\."studentId" AND a\.status IN \('PRESENT','LATE'\)/, "출석·지각만");
  assert.match(helper, /notMergedStudent\("st"\)/);
  assert.match(helper, /return getStudentParentRecipients\(/, "학부모는 학생으로 바로 찾는다");
  const end = staff.slice(staff.indexOf("export async function completeClassSession"));
  assert.match(end, /getMakeupCompletedParentRecipients\(session, input\.sessionId\)/);
  // 정규·보강 모두 같은 deliverParentNotification 호출 하나·같은 키 규칙
  assert.match(end, /const recipients = \[\.\.\.regularRecipients, \.\.\.makeupRecipients\.filter/);
  assert.match(end, /eventType: "CLASS_COMPLETED",\s*dedupeKey: `session:\$\{input\.sessionId\}:completed:student:\$\{recipient\.studentId\}:user:\$\{recipient\.userId\}`/);
});

test("보강 아이 출석·지각 알림은 반 수강 조회가 아니라 그 학생 학부모로 직접 보낸다", () => {
  assert.match(staff, /isMakeup\s*\? await getStudentParentRecipients\(\[studentId\]\)\s*: await getSessionParentRecipients\(session, \[studentId\]\)/);
  const notif = readFileSync("src/lib/staff-notifications.ts", "utf8");
  const fn = notif.slice(notif.indexOf("export async function getStudentParentRecipients"));
  assert.match(fn, /s\.id = ANY\(\$1::text\[\]\)/);
  assert.match(fn, /mergedIntoStudentId|notMergedStudent/);
  assert.doesNotMatch(fn.slice(0, fn.indexOf("}\n")), /Enrollment/, "보강 아이는 이 반 수강생이 아니므로 수강 조건을 걸지 않는다");
});

test("전체 출석은 미확인이면 보강 아이도 포함하고, 수업 중 출결은 다시 눌러 고칠 수 있다", () => {
  assert.match(client, /const unchecked = students\.filter\(\(student\) => !student\.status\)/, "보강 여부로 거르지 않는다");
  // 출결 버튼은 이미 찍힌 상태여도 막지 않는다(pending 중에만 잠금)
  assert.match(client, /active=\{student\.status === status\} disabled=\{pending\} onClick=\{\(\) => updateAttendance\(student\.id, status\)\}/);
  // 질병·부상 버튼: 결석일 때만·정규만·44px
  assert.match(client, /student\.status === "ABSENT" && !student\.makeup && !session\.sessionDateId/);
  assert.match(client, /aria-pressed=\{illness\}[\s\S]*?min-h-11/);
});

test("원장 결석 신고 알림 복구 크론은 출석부가 만든 행을 학부모 신고로 보내지 않는다", () => {
  const rec = readFileSync("src/lib/operational-notification-reconciliation.ts", "utf8");
  assert.match(rec, /NOT \(ra\.note IS NOT DISTINCT FROM \$2 AND ra\."reportedByUserId" IS NULL\)/);
  assert.match(rec, /safeLimit, SHEET_ABSENCE_NOTE/);
});
