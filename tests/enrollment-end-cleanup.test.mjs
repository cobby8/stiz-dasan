// 관리자 직접 수강 변경 뒤 정리(처리 중 신청 SUPERSEDED · 끝난 반 결석/보강권 · 미납 안내) — 2026-11-14 김루빈 사례 재발 방지
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const m = await loadTsModule("src/lib/enrollment/enrollment-end-cleanup.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const read = (p) => readFileSync(p, "utf8");

const req = (patch = {}) => ({
  id: "r1", kind: "RESUME", status: "APPROVED", toClassId: null, toClassName: null,
  effectiveFrom: "2026-11-16", resumeOn: null, invoiced: false, settled: false, linkedCommand: false, ...patch,
});

// ── A. 처리 중 신청 판정 ──
test("김루빈 사례: 승인된 복귀 신청 2건 + 관리자가 수강 중으로 바꿈 → 둘 다 바로 정리", () => {
  const plan = m.planOpenChangeRequests([req({ id: "a" }), req({ id: "b", effectiveFrom: "2026-11-18" })], { type: "STATUS", nextStatus: "ACTIVE" });
  assert.deepEqual(plan.supersede.map((r) => r.id), ["a", "b"]);
  assert.equal(plan.ask.length, 0);
  assert.equal(plan.block.length, 0);
});

test("판단이 어려운 건은 묻고(대기·반대 방향·복귀일 있는 휴원), 돈·반영이 걸린 건은 막는다", () => {
  const active = { type: "STATUS", nextStatus: "ACTIVE" };
  assert.equal(m.planOpenChangeRequests([req({ status: "PENDING" })], active).ask.length, 1, "대기 중 복귀 신청은 자동으로 닫지 않는다");
  assert.equal(m.planOpenChangeRequests([req({ kind: "PAUSE" })], active).ask.length, 1, "반대 방향");
  const paused = { type: "STATUS", nextStatus: "PAUSED" };
  assert.equal(m.planOpenChangeRequests([req({ kind: "PAUSE" })], paused).supersede.length, 1);
  assert.equal(m.planOpenChangeRequests([req({ kind: "PAUSE", resumeOn: "2026-12-01" })], paused).ask.length, 1, "예정된 복귀가 사라지므로 묻는다");
  const withdrawn = { type: "STATUS", nextStatus: "WITHDRAWN" };
  assert.equal(m.planOpenChangeRequests([req({ kind: "WITHDRAW" })], withdrawn).supersede.length, 1);
  assert.equal(m.planOpenChangeRequests([req({ kind: "CLASS_CHANGE", toClassId: "x" })], withdrawn).ask.length, 1);
  for (const flag of ["invoiced", "settled", "linkedCommand"]) {
    assert.equal(m.planOpenChangeRequests([req({ [flag]: true })], active).block.length, 1, `${flag} 는 막는다`);
  }
  // 이미 끝난 신청은 대상이 아니다
  assert.deepEqual(m.planOpenChangeRequests([req({ status: "SUPERSEDED" }), req({ status: "APPLIED" })], active), { supersede: [], ask: [], block: [] });
});

test("반 이동: 같은 반으로 가는 승인 반 변경만 바로 정리, 다른 반이면 묻는다", () => {
  const move = { type: "MOVE", toClassId: "sat7" };
  assert.equal(m.planOpenChangeRequests([req({ kind: "CLASS_CHANGE", toClassId: "sat7" })], move).supersede.length, 1);
  assert.equal(m.planOpenChangeRequests([req({ kind: "CLASS_CHANGE", toClassId: "sun1" })], move).ask.length, 1);
  assert.equal(m.planOpenChangeRequests([req({ kind: "RESUME" })], move).ask.length, 1);
  assert.equal(m.openRequestLabel(req({ kind: "CLASS_CHANGE", toClassName: "토7", status: "PENDING" })), "반·요일 변경(→ 토7) · 검토 중 · 2026-11-16부터");
  assert.equal(m.openRequestLabel(req()), "복귀 · 승인됨 · 2026-11-16부터");
  assert.match(m.supersedeNote({ type: "STATUS", nextStatus: "ACTIVE" }, "2026-11-14", false), /수강 중 전환, 2026-11-14/);
  assert.match(m.supersedeNote(move, "2026-11-14", true), /관리자 확인/);
});

// ── B. 끝난 반 결석·보강권 판정 ──
const ab = (patch = {}) => ({
  id: "ab1", date: "2026-11-18", status: "CONFIRMED", note: null, periodRow: false,
  billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false,
  creditId: "c1", creditStatus: "AVAILABLE", creditBooked: false, ...patch,
});

test("결석 판정: 효력일 당일부터 취소, 전날은 그대로(날짜 경계)", () => {
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2026-11-14" }), "2026-11-14"), "CANCEL", "효력일 당일 포함");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2026-11-13" }), "2026-11-14"), "SKIP", "효력일 전은 다니던 때");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2026-12-31" }), "2026-11-14"), "CANCEL");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2027-01-02" }), "2026-12-31"), "CANCEL", "연말 넘김");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ status: "CANCELLED" }), "2026-11-14"), "SKIP");
});

test("KST 자정 경계: UTC 11-13 15:30 = KST 11-14 00:30 → 오늘(기본 효력일)은 11-14 이고 11-14 결석이 정리된다", () => {
  const today = kst.todayKst(Date.UTC(2026, 10, 13, 15, 30));
  assert.equal(today, "2026-11-14");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2026-11-14" }), today), "CANCEL");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ date: "2026-11-13" }), today), "SKIP");
});

test("보호: 정산·이월 → 보강 예약/사용 → 출석 기록 순, 보강권은 쓰지 않은 것만 회수", () => {
  assert.equal(m.decideAbsenceOnClassEnd(ab({ billingResolved: true }), "2026-11-14"), "KEEP_BILLING");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ carryCredit: true, makeupBooked: true }), "2026-11-14"), "KEEP_BILLING");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ makeupBooked: true }), "2026-11-14"), "KEEP_MAKEUP");
  for (const s of ["RESERVED", "USED", "NO_SHOW"]) assert.equal(m.decideAbsenceOnClassEnd(ab({ creditStatus: s }), "2026-11-14"), "KEEP_MAKEUP");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ creditBooked: true }), "2026-11-14"), "KEEP_MAKEUP");
  assert.equal(m.decideAbsenceOnClassEnd(ab({ attendanceRecorded: true }), "2026-11-14"), "KEEP_ATTENDANCE");
  assert.equal(m.creditActionOnClassEnd({ creditStatus: "AVAILABLE", creditBooked: false }), "REVOKE");
  assert.equal(m.creditActionOnClassEnd({ creditStatus: "EXPIRED", creditBooked: false }), "NONE");
  assert.equal(m.creditActionOnClassEnd({ creditStatus: null, creditBooked: false }), "NONE");
  const plan = m.planClassEndAbsences([ab({ id: "a" }), ab({ id: "b", creditId: null }), ab({ id: "c", makeupBooked: true }), ab({ id: "d", date: "2026-11-01" })], "2026-11-14");
  assert.deepEqual(plan.cancel.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(plan.revokeCreditIds, ["c1"]);
  assert.deepEqual(plan.kept, { billing: 0, makeup: 1, attendance: 0 });
});

test("note: 기간 결석 행은 머리말을 지키고, 나머지는 «수강 종료로 정리» 머리말(알림 재조정 제외용)", () => {
  assert.equal(m.endedAbsenceNote({ note: "기간 결석 · 질병", periodRow: true }), "기간 결석 · 질병");
  assert.equal(m.endedAbsenceNote({ note: null, periodRow: false }), "수강 종료로 정리");
  assert.equal(m.endedAbsenceNote({ note: "가족 여행", periodRow: false }), "수강 종료로 정리 · 가족 여행");
});

// ── C. 미납 청구 ──
test("미납 청구: 효력일이 낀 달 이후만, 1일이 아니면 그달은 «일부 다님», 낸 청구는 제외", () => {
  const p = (patch) => ({ id: "p", status: "PENDING", amount: 160000, year: 2026, month: 12, dueYmd: null, description: null, ...patch });
  assert.deepEqual(m.isUnpaidAfterEnd(p({}), "2026-11-14"), { match: true, partial: false });
  assert.deepEqual(m.isUnpaidAfterEnd(p({ month: 11 }), "2026-11-14"), { match: true, partial: true });
  assert.deepEqual(m.isUnpaidAfterEnd(p({ month: 11 }), "2026-11-01"), { match: true, partial: false });
  assert.equal(m.isUnpaidAfterEnd(p({ month: 10 }), "2026-11-14").match, false);
  assert.equal(m.isUnpaidAfterEnd(p({ year: 2027, month: 1 }), "2026-12-31").match, true, "연말 넘김");
  assert.equal(m.isUnpaidAfterEnd(p({ status: "PAID" }), "2026-11-14").match, false);
  assert.equal(m.isUnpaidAfterEnd(p({ status: "OVERDUE" }), "2026-11-14").match, true);
  assert.equal(m.isUnpaidAfterEnd(p({ year: null, month: null, dueYmd: "2026-11-20" }), "2026-11-14").match, true);
  assert.equal(m.isUnpaidAfterEnd(p({ year: null, month: null, dueYmd: "2026-11-10" }), "2026-11-14").match, false);
  assert.equal(m.unpaidPaymentViews([p({})], "2026-11-14")[0].monthLabel, "2026년 12월");
});

test("결과 문구", () => {
  const s = { ...m.emptyCleanupSummary(), supersededRequests: 2, cancelledAbsences: 3, revokedCredits: 2, keptAbsences: { billing: 0, makeup: 1, attendance: 0 } };
  assert.equal(m.cleanupResultMessage(s), "처리 중 신청 2건 정리 · 결석 3건 취소 · 보강권 2장 회수 · 정리 못 한 결석 1건(보강 예약·사용 1) — 결석 관리에서 확인");
  assert.equal(m.cleanupResultMessage(m.emptyCleanupSummary()), "");
});

// ── 가짜 DB 로 트랜잭션 흐름 ──
function fakeDb(handlers) {
  const log = [];
  const run = (sql, values) => {
    log.push({ sql, values });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(values, sql);
    return [];
  };
  return {
    log,
    async $queryRawUnsafe(sql, ...values) { return run(sql, values); },
    async $executeRawUnsafe(sql, ...values) { const r = run(sql, values); return typeof r === "number" ? r : 0; },
  };
}

test("끝난 반 정리(가짜 DB): 묶인 결석·보강권은 그대로, 나머지만 취소·회수, 미납은 읽기만, 감사 기록", async () => {
  const absences = [
    { id: "a1", date: "2026-11-17", status: "CONFIRMED", note: null, periodRow: false, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false },
    { id: "a2", date: "2026-11-19", status: "REPORTED", note: "기간 결석 · 질병", periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false },
    { id: "a3", date: "2026-11-24", status: "CONFIRMED", note: null, periodRow: false, billingResolved: true, carryCredit: true, makeupBooked: false, attendanceRecorded: false },
    { id: "a4", date: "2026-11-26", status: "CONFIRMED", note: null, periodRow: false, billingResolved: false, carryCredit: false, makeupBooked: true, attendanceRecorded: false },
  ];
  const absenceUpdates = [];
  let creditUpdate = null;
  const db = fakeDb([
    [/to_regclass/, () => [{ found: "x" }]],
    [/pg_advisory_xact_lock/, () => 0],
    [/FROM "RegularAbsence" ra/, () => absences],
    [/FROM "MakeupCredit" WHERE/, () => [
      { id: "c1", sourceKey: "REGULAR:mon4:2026-11-17", status: "AVAILABLE", booked: false },
      { id: "c2", sourceKey: "REGULAR:mon4:2026-11-19", status: "USED", booked: true },
      { id: "c4", sourceKey: "REGULAR:mon4:2026-11-26", status: "RESERVED", booked: true },
    ]],
    [/UPDATE "RegularAbsence" SET status = 'CANCELLED'/, (v) => { absenceUpdates.push(v); return 1; }],
    [/UPDATE "RegularAbsenceCarryReview"/, () => 0],
    [/UPDATE "MakeupCredit" SET status = 'REVOKED'/, (v) => { creditUpdate = v; return v[0].length; }],
    [/FROM "Payment" p/, () => [
      { id: "pay12", status: "PENDING", amount: 160000, year: 2026, month: 12, dueYmd: "2026-12-05", description: "12월 수강료" },
      { id: "pay10", status: "PENDING", amount: 160000, year: 2026, month: 10, dueYmd: "2026-10-05", description: "10월 수강료" },
    ]],
  ]);
  const out = await m.cleanupEndedClassInTx(db, { studentId: "s1", classId: "mon4", className: "월4", fromYmd: "2026-11-14", actorUserId: "admin" });
  // a2 는 보강권이 USED 라 «보강 사용» 보호 → 결석도 그대로
  assert.deepEqual(absenceUpdates.map((v) => v[0]), ["a1"]);
  assert.equal(absenceUpdates[0][1], "수강 종료로 정리");
  assert.deepEqual(creditUpdate[0], ["c1"], "쓰지 않은 보강권만 회수");
  assert.equal(out.cancelledAbsences, 1);
  assert.equal(out.revokedCredits, 1);
  assert.deepEqual(out.keptAbsences, { billing: 1, makeup: 2, attendance: 0 });
  assert.deepEqual(out.unpaidPayments.map((p) => p.id), ["pay12"], "효력일 전 달 청구는 안내하지 않는다");
  assert.ok(!db.log.some((q) => /(UPDATE|DELETE).*"Payment"/s.test(q.sql)), "청구는 자동으로 바꾸거나 지우지 않는다");
  assert.ok(db.log.some((q) => /ENROLLMENT_END_CLEANUP/.test(q.sql)), "감사 기록");
  // 잠금 먼저, 결석 행은 FOR UPDATE
  assert.match(db.log[0].sql, /pg_advisory_xact_lock/);
  assert.ok(db.log.some((q) => /FROM "RegularAbsence" ra[\s\S]*FOR UPDATE OF ra/.test(q.sql)));
});

test("기간 결석 행만 취소되면 note 머리말을 그대로 둔다(가짜 DB)", async () => {
  const updates = [];
  const db = fakeDb([
    [/to_regclass/, () => [{ found: null }]],
    [/FROM "RegularAbsence" ra/, () => [{ id: "p1", date: "2026-11-20", status: "CONFIRMED", note: "기간 결석 · 질병", periodRow: true, billingResolved: false, carryCredit: false, makeupBooked: false, attendanceRecorded: false }]],
    [/UPDATE "RegularAbsence" SET status = 'CANCELLED'/, (v) => { updates.push(v); return 1; }],
  ]);
  const out = await m.cleanupEndedClassInTx(db, { studentId: "s1", classId: "wed4", className: "수4", fromYmd: "2026-11-14", actorUserId: "admin" });
  assert.equal(updates[0][1], "기간 결석 · 질병");
  assert.equal(out.cancelledAbsences, 1);
  assert.equal(out.unpaidPayments.length, 0);
});

test("신청 정리(가짜 DB): 열린 건만 조건부로 닫고, 실제로 닫힌 건만 감사 기록", async () => {
  const audits = [];
  const db = fakeDb([
    [/UPDATE "EnrollmentChangeRequest"/, () => [{ id: "a" }]], // b 는 그 사이 크론이 적용해 안 닫힘
    [/OperationsAuditLog/, (v) => { audits.push(JSON.parse(v[1])); return 1; }],
  ]);
  const n = await m.supersedeChangeRequests(db, [req({ id: "a" }), req({ id: "b" })], { enrollmentId: "e1", actorUserId: "admin", note: "정리", confirmed: false });
  assert.equal(n, 1);
  assert.deepEqual(audits.map((a) => a.changeRequestId), ["a"]);
  assert.equal(audits[0].to, "SUPERSEDED");
  const update = db.log.find((q) => /UPDATE "EnrollmentChangeRequest"/.test(q.sql)).sql;
  assert.match(update, /status IN \('PENDING','APPROVED'\) AND "appliedAt" IS NULL/);
  assert.match(update, /"decidedByUserId" = COALESCE\("decidedByUserId", \$2\)/, "승인자 기록은 지우지 않는다");
  assert.equal(await m.supersedeChangeRequests(db, [], { enrollmentId: "e1", actorUserId: "admin", note: "x", confirmed: false }), 0);
});

// ── 연결부 소스 확인 ──
test("서버 동작: 같은 트랜잭션·잠금 순서(전역 → 신청 → 수강)·수강 종료만 반 정리", () => {
  const admin = read("src/app/actions/admin.ts");
  const fn = admin.slice(admin.indexOf("export async function updateEnrollmentStatus"), admin.indexOf("export async function deleteEnrollment"));
  const lock = fn.indexOf("await lockCompensation(tx)");
  const reqs = fn.indexOf("readOpenChangeRequestsForUpdate(tx, enrollmentId)");
  const enr = fn.indexOf("FOR UPDATE OF e");
  const upd = fn.indexOf('UPDATE "Enrollment" SET status=$1');
  const sup = fn.indexOf("supersedeChangeRequests(tx");
  const clean = fn.indexOf("cleanupEndedClassInTx(tx");
  assert.ok(lock > 0 && lock < reqs && reqs < enr, "잠금 순서");
  assert.ok(upd < sup && sup < clean, "상태를 바꾼 뒤 같은 트랜잭션에서 정리");
  assert.match(fn, /if \(status === "WITHDRAWN"\) \{\s*const ended = await cleanupEndedClassInTx/);
  // 확인은 «보여 준 id 목록»과 대조 — 그 사이 바뀌었으면 쓰기 전에 다시 묻는다
  assert.match(fn, /closeOpenRequests\?: string\[\]/);
  assert.match(fn, /if \(!askConfirmed\(requestPlan\.ask, change\?\.closeOpenRequests\)\)/);
  assert.ok(fn.indexOf("askConfirmed(") < fn.indexOf('UPDATE "Enrollment" SET status=$1'), "대조는 어떤 쓰기보다 먼저");

  const move = read("src/app/actions/enrollment-admin-edit.ts");
  const mv = move.slice(move.indexOf("export async function moveEnrollmentToClass"), move.indexOf("export async function removeMistakenEnrollment"));
  assert.ok(mv.indexOf("lockCompensation(tx)") < mv.indexOf("readOpenChangeRequestsForUpdate") && mv.indexOf("readOpenChangeRequestsForUpdate") < mv.indexOf("FOR UPDATE OF e"));
  assert.ok(mv.indexOf("supersedeChangeRequests(tx") < mv.indexOf("readEnrollmentLinkCounts(tx"), "닫은 뒤 남은 신청을 다시 센다");
  assert.match(mv, /cleanupEndedClassInTx\(tx, \{\s*studentId: from\.studentId, classId: from\.classId/);
});

test("SUPERSEDED 는 다시 적용되지 않는다 — 적용일 크론·확정 동기화·학부모 중복 확인은 APPROVED/PENDING 만 본다", () => {
  const cron = read("src/lib/enrollment/admin-change-request.ts");
  const due = cron.slice(cron.indexOf("export async function applyDueEnrollmentChangesWithSummary"));
  assert.match(due, /WHERE status = 'APPROVED'\s*AND "appliedAt" IS NULL/);
  assert.match(read("src/lib/enrollment/finalize-change-sync.ts"), /r\.status='APPROVED' AND r\."appliedAt" IS NULL/);
  assert.match(read("src/lib/enrollment/resumeWindow.ts"), /rw\.status = 'APPROVED' AND rw\."appliedAt" IS NULL/);
  // 화면 이름표 — 없으면 신청함에 «상태 확인 필요»로 진행 중 칸에 남는다
  assert.match(read("src/lib/enrollment/changeRequestRules.ts"), /SUPERSEDED: "학원에서 처리함"/);
  assert.match(read("src/lib/requests/catalog.ts"), /SUPERSEDED: off\("학원에서 처리함"\)/);
  assert.match(read("src/lib/enrollment/parent-change-request.ts"), /'CANCELED','SUPERSEDED'\)/);
});

test("알림 재조정: «수강 종료로 정리» 머리말의 취소 결석은 결석 취소 알림을 보내지 않는다", () => {
  const src = read("src/lib/operational-notification-reconciliation.ts");
  // $4 는 학부모 «여러 날 결석» 머리말(2026-11-15 main), 이 조건은 $5
  assert.match(src, /AND NOT \(ra\.status = 'CANCELLED' AND COALESCE\(ra\.note,''\) LIKE \$5\)/);
  assert.match(src, /`\$\{PARENT_PERIOD_NOTE_PREFIX\} · %`, `\$\{ENROLLMENT_END_ABSENCE_NOTE_PREFIX\}%`,/, "자리표시자 순서와 값 순서가 맞다");
  assert.match(src, /`\$\{ENROLLMENT_END_ABSENCE_NOTE_PREFIX\}%`/);
  assert.equal(m.ENROLLMENT_END_ABSENCE_NOTE_PREFIX, "수강 종료로 정리");
  // 정리한 행의 note 는 반드시 그 머리말로 시작한다(LIKE '수강 종료로 정리%')
  assert.ok(m.endedAbsenceNote({ note: "x", periodRow: false }).startsWith(m.ENROLLMENT_END_ABSENCE_NOTE_PREFIX));
});

// ── 검수 권장 반영(2026-11-14) ──
test("확인 대조: 보여 준 신청 id 목록과 지금 닫을 대상이 정확히 같을 때만 진행", () => {
  const ask = [req({ id: "a" }), req({ id: "b" })];
  assert.equal(m.askConfirmed([], undefined), true, "물어볼 신청이 없으면 확인 불필요");
  assert.equal(m.askConfirmed(ask, undefined), false, "아직 안 물어봤다");
  assert.equal(m.askConfirmed(ask, []), false);
  assert.equal(m.askConfirmed(ask, ["b", "a"]), true, "순서는 상관없다");
  assert.equal(m.askConfirmed(ask, ["a"]), false, "그 사이 새 신청(b)이 들어왔다 → 다시 묻는다");
  assert.equal(m.askConfirmed([req({ id: "a" })], ["a", "b"]), false, "보여 준 신청 중 하나가 그 사이 처리됐다 → 다시 묻는다");
  assert.equal(m.askConfirmed(ask, ["a", "a"]), false, "중복 id 로 개수를 맞출 수 없다");
  assert.match(m.openRequestsMessage(2, true), /그 사이 처리 중인 수강 변경 신청이 바뀌었어요\(지금 2건\)/);
  assert.equal(m.openRequestsMessage(2, false), "이 수강에 처리 중인 수강 변경 신청이 2건 있어요.");
});

test("반 이동도 같은 대조를 쓰고, 화면 두 곳은 보여 준 신청 id 목록을 보낸다", () => {
  const move = read("src/app/actions/enrollment-admin-edit.ts");
  const mv = move.slice(move.indexOf("export async function moveEnrollmentToClass"), move.indexOf("export async function removeMistakenEnrollment"));
  assert.match(move, /closeOpenRequests\?: string\[\];/);
  assert.match(mv, /if \(!askConfirmed\(requestPlan\.ask, input\.closeOpenRequests\)\)/);
  assert.ok(mv.indexOf("askConfirmed(") < mv.indexOf("supersedeChangeRequests(tx"), "대조는 신청을 닫기 전에");
  const detail = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(detail, /runEnrollmentStatusChange\(statusOpenRequests\.requests\.map\(\(r\) => r\.id\)\)/);
  const modal = read("src/app/admin/students/[id]/EnrollmentMoveModal.tsx");
  assert.match(modal, /submit\(false, openRequests\.requests\.map\(\(r\) => r\.id\)\)/);
});

test("신청 정리 시 학부모 «취소 요청» 대기 건도 REJECTED + 안내 글로 끝낸다(가짜 DB)", async () => {
  let update = null;
  const db = fakeDb([
    [/information_schema\.columns/, () => [{ n: 2 }]],
    [/UPDATE "EnrollmentChangeRequest"/, (v, sql) => { update = { v, sql }; return [{ id: "a" }]; }],
    [/OperationsAuditLog/, () => 1],
  ]);
  await m.supersedeChangeRequests(db, [req({ id: "a" })], { enrollmentId: "e1", actorUserId: "admin", note: "정리", confirmed: false });
  assert.match(update.sql, /"cancelRequestStatus" = CASE WHEN "cancelRequestStatus" = 'PENDING' THEN 'REJECTED' ELSE "cancelRequestStatus" END/);
  assert.match(update.sql, /"cancelDecisionNote" = CASE WHEN "cancelRequestStatus" = 'PENDING' THEN \$4 ELSE "cancelDecisionNote" END/);
  assert.equal(update.v[3], "관리자 직접 변경으로 신청이 정리되었습니다");
  // DB CHECK 제약이 허용하는 값인지(마이그레이션과 대조)
  const mig = read("prisma/migrations/20261110130000_enrollment_change_cancel_request/migration.sql");
  assert.match(mig, /"cancelRequestStatus" IN \('PENDING', 'APPROVED', 'REJECTED'\)/);
  // 관리자 «처리할 취소 요청» 목록은 PENDING 만 본다 → 정리 뒤 빠진다
  assert.match(read("src/lib/enrollment/admin-change-request.ts"), /WHERE r\."cancelRequestStatus" = 'PENDING'/);
});

test("취소 요청 칸이 없는 DB(마이그레이션 전)에서는 그 칸을 건드리지 않는다(가짜 DB)", async () => {
  let update = null;
  const db = fakeDb([
    [/information_schema\.columns/, () => [{ n: 0 }]],
    [/UPDATE "EnrollmentChangeRequest"/, (v, sql) => { update = { v, sql }; return [{ id: "a" }]; }],
  ]);
  await m.supersedeChangeRequests(db, [req({ id: "a" })], { enrollmentId: "e1", actorUserId: "admin", note: "정리", confirmed: false });
  assert.doesNotMatch(update.sql, /cancelRequestStatus/);
  assert.equal(update.v.length, 3);
});
