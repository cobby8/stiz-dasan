// 2026-11-14 원장 지시 — 「출결 화면에서 출석이나 결석, 지각 체크 후 버튼 다시 누르면 취소가 되도록」.
// 선택된 버튼을 다시 누르면 «미확인»(= 출결 기록 없음)으로 되돌린다.
// 서버 기능(clearStaffAttendance)을 가짜 DB 로 «실제로 돌려» 따라오는 일을 확인한다:
//   결석 취소 → 안 쓴 보강권 회수 규칙 호출 / 예약·사용된 보강권이면 거부 / 학부모 신고는 그대로 / 권한.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

// 순수 규칙은 진짜를 쓴다
const kst = load("src/lib/datetime/kst.ts");
const creditRules = load("src/lib/makeup/credit-rules.ts", { "@/lib/datetime/kst": kst });
const sessionRules = load("src/lib/staff-session-rules.ts", { "@/lib/datetime/kst": kst, "@/lib/auth/moneyAccess": load("src/lib/auth/moneyAccess.ts") });

const SHEET_NOTE = "출석부에서 질병·부상 결석으로 표시";

/**
 * 가짜 환경 하나 — 수업·명단·출결·보강권·결석 신고를 메모리에 두고, 액션이 보낸 SQL 을 글자로 알아본다.
 * calls 에 «무엇이 불렸는지»를 남긴다.
 */
function makeWorld(options = {}) {
  const world = {
    session: { id: "se1", classId: "c1", status: "IN_PROGRESS", className: "초등 A반", sessionDateId: null, date: "2026-11-14", ...options.session },
    access: { staff: { appUserId: "u-teacher", appUserRole: "INSTRUCTOR" }, coachId: "k1", canAccessAllClasses: false },
    accessError: options.accessError ?? null,
    enrolled: options.enrolled ?? true,
    makeupBookings: options.makeupBookings ?? [],
    attendance: options.attendance ?? null,          // 정규 출결 상태
    credits: options.credits ?? [],                  // [{ status }]
    standingReport: options.standingReport ?? false, // 학부모 신고·기간 결석
    reasonPlan: options.reasonPlan ?? "NONE",
    makeupRevertError: options.makeupRevertError ?? null, // 보강 예약 되돌림이 규칙에 막힐 때
    seat: options.seat ?? null,                      // 특강 좌석 { id, studentId, attendanceStatus }
    trial: options.trial ?? null,                    // 체험 { status, staffAttendanceStatus }
    calls: [],
  };
  const query = async (sql, ...args) => {
    if (/FROM "Enrollment" e WHERE e\."classId" = \$1 AND e\."studentId" = \$2/.test(sql)) return world.enrolled ? [{ id: "e1" }] : [];
    if (/^SELECT status FROM "Attendance"/.test(sql)) return world.attendance ? [{ status: world.attendance }] : [];
    if (/^SELECT status FROM "MakeupCredit"/.test(sql)) { world.calls.push(["creditLookup", args[1]]); return world.credits; }
    if (/FROM "RegularAbsence" ra/.test(sql)) { assert.equal(args[3], SHEET_NOTE); return world.standingReport ? [{ id: "ra1" }] : []; }
    if (/^DELETE FROM "Attendance" WHERE "sessionId" = \$1 AND "studentId" = \$2 AND status = \$3 RETURNING id/.test(sql)) {
      if (world.attendance !== args[2]) return [];
      world.calls.push(["deleteAttendance", args[1], args[2]]);
      world.attendance = null;
      return [{ id: "a1" }];
    }
    if (/FROM "SpecialProgramEnrollmentDate" e\s+JOIN "Session" s ON s\.id = \$1/.test(sql)) return world.seat ? [world.seat] : [];
    if (/^UPDATE "SpecialProgramEnrollmentDate"\s+SET "attendanceStatus" = NULL/.test(sql)) {
      if (!world.seat || world.seat.attendanceStatus !== args[1]) return [];
      world.calls.push(["clearSeat", args[0]]);
      world.seat = { ...world.seat, attendanceStatus: null };
      return [{ id: args[0] }];
    }
    if (/FROM "TrialLead" tl/.test(sql)) return world.trial ? [world.trial] : [];
    if (/^UPDATE "TrialLead"\s+SET "staffAttendanceStatus" = NULL/.test(sql)) {
      world.calls.push(["clearTrial", args[0], args[2]]);
      world.trial = { status: args[2], staffAttendanceStatus: null };
      return [{ id: args[0] }];
    }
    throw new Error(`가짜 DB 가 모르는 SQL: ${sql.slice(0, 90)}`);
  };
  const prisma = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql, ...args) => {
      if (/^DELETE FROM "Attendance" WHERE "sessionId" = \$1 AND "studentId" = \$2$/.test(sql)) { world.calls.push(["deleteSeatAttendance", args[1]]); return 1; }
      throw new Error(`가짜 DB 가 모르는 실행문: ${sql.slice(0, 90)}`);
    },
    $transaction: async (fn) => {
      // 되돌림 흉내 — 안에서 던지면 출결·기록을 원래대로. 트랜잭션 안의 db 는 바깥 prisma 와 «다른 객체»로 넘겨 구분한다.
      const snapshot = { attendance: world.attendance, calls: world.calls.length };
      const tx = { $queryRawUnsafe: query, $executeRawUnsafe: prisma.$executeRawUnsafe };
      world.txClient = tx;
      world.transactions += 1;
      try { return await fn(tx); } catch (error) { world.attendance = snapshot.attendance; world.calls.length = snapshot.calls; throw error; }
    },
  };
  world.transactions = 0;
  const actions = load("src/app/actions/staff-sessions.ts", {
    "next/cache": { revalidatePath() {} },
    "next/server": { after() {} },
    "@/lib/prisma": { prisma },
    "@/lib/makeup/credit-service": {
      syncCreditForRegularSession: async (input) => { world.calls.push(["syncRegularCredit", input.status, input.studentId]); return { action: "revoked" }; },
      // 트랜잭션판 회수 — 넘겨받은 db 가 트랜잭션 안의 것인지도 본다
      revokeMakeupCreditInTx: async (db, input) => { world.calls.push(["revokeCredit", input.sourceKey, input.studentId, db === world.txClient]); return { revoked: 1 }; },
      syncCreditForSeasonalSeat: async (input) => { world.calls.push(["syncSeatCredit", input.status, input.enrollmentDateId]); return { action: "revoked" }; },
    },
    "@/lib/makeup/credit-rules": creditRules,
    "@/lib/makeup/makeup-attendance": {
      applyMakeupAttendanceInTx: async (db, input) => {
        if (world.makeupRevertError) throw new Error(world.makeupRevertError);
        world.calls.push(["makeupAttendance", input.status, db === world.txClient]);
        return [];
      },
      findMakeupBookings: async () => world.makeupBookings,
      makeupOnClassDateSql: () => "true",
    },
    "@/lib/staff-class-access": {
      requireStaffSessionAccess: async () => {
        if (world.accessError) throw new Error(world.accessError);
        return { session: world.session, access: world.access };
      },
      requireStaffClassAccess: async () => world.access,
      requireStaffSeasonalSessionAccess: async () => ({ access: world.access, seasonal: {} }),
    },
    "@/lib/datetime/kst": kst,
    "@/lib/feed/rules": { canEditFeedLine: () => ({ ok: true }), feedLineWindowMessage: () => "", normalizeFeedLine: (v) => v, sessionKstDateSql: () => "date", TODAY_KST_SQL: "today" },
    "@/lib/staff-session-rules": sessionRules,
    "@/lib/staff-session-queries": { trialOnClassDateSql: () => "true" },
    "@/lib/staff-notifications": { deliverParentNotification: async () => { world.calls.push(["notify"]); return {}; }, getClassParentRecipients: async () => [], getStudentParentRecipients: async () => [] },
    "@/lib/studentVisibility": { notMergedStudent: () => "true" },
    "@/lib/regular/regularSession": { adoptRegularSessionKey: async () => {}, regularSessionKey: () => "key" },
    "@/lib/regular/attendance-absence-reason": {
      SHEET_ABSENCE_NOTE: SHEET_NOTE,
      absencePlanMessage: () => null,
      applyAttendanceAbsenceReasonInTx: async (_tx, input) => {
        world.calls.push(["absenceReason", input.attendanceStatus, input.intent]);
        return { plan: world.reasonPlan, report: world.standingReport ? { reason: "FAMILY", status: "REPORTED", source: "PARENT" } : null };
      },
    },
  });
  return { world, clear: (input) => actions.clearStaffAttendance({ sessionId: "se1", attendanceKey: "st1", ...input }) };
}
const names = (world) => world.calls.map((call) => call[0]);

// ── 정규 수강생 ───────────────────────────────────────────────

test("출석 → 미확인: 출결 기록을 지우고, 결석이 아니라 보강권 조회·확인 없이 끝난다", async () => {
  const { world, clear } = makeWorld({ attendance: "PRESENT" });
  const result = await clear({});
  assert.deepEqual({ ok: result.ok, cleared: result.cleared, previousStatus: result.previousStatus, creditRevoke: result.creditRevoke }, { ok: true, cleared: true, previousStatus: "PRESENT", creditRevoke: false });
  assert.equal(world.attendance, null);
  assert.ok(!names(world).includes("creditLookup"), "출석·지각 취소는 보강권을 미리 보지 않는다");
  assert.ok(names(world).includes("deleteAttendance"));
  assert.ok(!names(world).includes("notify"), "학부모 알림을 다시 보내지 않는다");
});

test("결석 → 미확인: 미리 보기는 아무것도 바꾸지 않고 «보강권 회수 여부»만 알려 준다", async () => {
  const withCredit = makeWorld({ attendance: "ABSENT", credits: [{ status: "AVAILABLE" }] });
  const preview = await withCredit.clear({ dryRun: true });
  assert.deepEqual({ ok: preview.ok, preview: preview.preview, creditRevoke: preview.creditRevoke }, { ok: true, preview: true, creditRevoke: true });
  assert.equal(withCredit.world.attendance, "ABSENT", "미리 보기는 출결을 건드리지 않는다");
  assert.deepEqual(names(withCredit.world), ["creditLookup"]);
  // 보강권 키는 발급과 같은 키(반·결석일)
  assert.equal(withCredit.world.calls[0][1], "REGULAR:c1:2026-11-14");

  const noCredit = makeWorld({ attendance: "ABSENT", credits: [] });
  assert.equal((await noCredit.clear({ dryRun: true })).creditRevoke, false);
  // 이미 회수·소멸된 권만 있으면 회수할 것이 없다
  const revoked = makeWorld({ attendance: "ABSENT", credits: [{ status: "REVOKED" }, { status: "EXPIRED" }] });
  assert.equal((await revoked.clear({ dryRun: true })).creditRevoke, false);
});

test("결석 → 미확인: 결석 사유 정리 → 출결 삭제 → 보강권 회수 규칙을 «결석 아님»으로 부른다", async () => {
  const { world, clear } = makeWorld({ attendance: "ABSENT", credits: [{ status: "AVAILABLE" }] });
  const result = await clear({});
  assert.equal(result.ok, true);
  assert.equal(result.creditRevoke, true);
  assert.equal(world.attendance, null);
  // 사유 정리 → 출결 삭제 → 보강권 회수가 «한 트랜잭션» 안에서 이 순서로
  assert.deepEqual(names(world), ["creditLookup", "absenceReason", "deleteAttendance", "revokeCredit"]);
  assert.equal(world.transactions, 1);
  // 규칙 함수에는 결석이 아닌 상태를 넘긴다 → 출석·지각으로 정정할 때와 같은 길(회수·표시 취소)
  const reason = world.calls.find((call) => call[0] === "absenceReason");
  assert.notEqual(reason[1], "ABSENT");
  assert.equal(reason[2], undefined, "사유 요청 없이 — 출석부가 만든 표시만 지워진다");
  const revoke = world.calls.find((call) => call[0] === "revokeCredit");
  assert.equal(revoke[1], "REGULAR:c1:2026-11-14", "발급과 같은 키의 보강권을 회수한다");
  assert.equal(revoke[2], "st1");
  assert.equal(revoke[3], true, "출결 삭제와 같은 트랜잭션의 db 로 회수한다");
  // 트랜잭션 밖의 따로 도는 맞춤 함수는 부르지 않는다(반쪽 상태 방지)
  assert.ok(!names(world).includes("syncRegularCredit"));
});

test("예약·사용된 보강권이 걸린 결석은 취소를 거부하고 이유를 돌려준다(출결 그대로)", async () => {
  for (const status of ["RESERVED", "USED", "NO_SHOW"]) {
    for (const dryRun of [true, false]) {
      const { world, clear } = makeWorld({ attendance: "ABSENT", credits: [{ status }] });
      const result = await clear({ dryRun });
      assert.equal(result.ok, false, `${status} dryRun=${dryRun}`);
      assert.match(result.message, /보강권이 이미 예약됐거나 사용돼 결석을 취소할 수 없습니다/);
      assert.equal(world.attendance, "ABSENT");
      assert.deepEqual(names(world), ["creditLookup"], "아무것도 바꾸지 않는다");
    }
  }
});

test("이미 이월·보강으로 정산된 결석은 취소를 막는다 — 출결 삭제도 되돌린다", async () => {
  const { world, clear } = makeWorld({ attendance: "ABSENT", reasonPlan: "BLOCKED_RESOLVED" });
  const result = await clear({});
  assert.equal(result.ok, false);
  assert.match(result.message, /정산된 결석이라 취소할 수 없습니다/);
  assert.equal(world.attendance, "ABSENT");
  assert.ok(!names(world).includes("deleteAttendance"));
  assert.ok(!names(world).includes("revokeCredit"));
});

test("학부모가 미리 알린 결석: 출결만 미확인으로 — 신고와 그 보강권은 건드리지 않는다", async () => {
  const { world, clear } = makeWorld({ attendance: "ABSENT", standingReport: true, credits: [{ status: "RESERVED" }] });
  const preview = await clear({ dryRun: true });
  assert.deepEqual({ ok: preview.ok, creditRevoke: preview.creditRevoke }, { ok: true, creditRevoke: false }, "예약된 보강권이 있어도 막지 않는다(보강권을 건드리지 않으므로)");
  const result = await clear({});
  assert.equal(result.ok, true);
  assert.equal(world.attendance, null);
  assert.ok(!names(world).includes("creditLookup"));
  assert.ok(!names(world).includes("revokeCredit") && !names(world).includes("syncRegularCredit"), "신고로 나간 보강권을 회수하지 않는다");
  // 화면이 «결석 신고» 표시를 그대로 두도록 신고 상태를 돌려준다
  assert.equal(result.absenceReport.source, "PARENT");
});

test("이미 미확인이면 아무 일도 하지 않고 성공", async () => {
  const { world, clear } = makeWorld({ attendance: null });
  const result = await clear({});
  assert.deepEqual({ ok: result.ok, cleared: result.cleared, previousStatus: result.previousStatus }, { ok: true, cleared: true, previousStatus: null });
  assert.deepEqual(names(world), []);
});

test("그사이 다른 기기가 출결을 바꿨으면 지우지 않는다", async () => {
  // 조회 때는 출석이었는데, 삭제 직전(사유 정리 단계 뒤)에 다른 기기가 지각으로 바꾼 상황
  const { world, clear } = makeWorld({ attendance: "PRESENT" });
  Object.defineProperty(world, "attendance", {
    configurable: true,
    get() { return world.calls.some((call) => call[0] === "absenceReason") ? "LATE" : "PRESENT"; },
    set() {},
  });
  const raced = await clear({});
  assert.equal(raced.ok, false);
  assert.match(raced.message, /그사이 출결이 바뀌었습니다/);
  assert.ok(!names(world).includes("deleteAttendance"));
  assert.ok(!names(world).includes("revokeCredit"), "출결을 못 지웠으면 보강권도 그대로");
});

// ── 보강 온 아이 · 체험 · 특강 좌석 ───────────────────────────

test("보강 온 아이: 참석 표시를 «예약됨»으로 되돌리는 기존 전이를 타고, 이 반 보강권 회수는 타지 않는다", async () => {
  const { world, clear } = makeWorld({ enrolled: false, makeupBookings: [{ id: "m1", status: "ATTENDED" }], attendance: "PRESENT" });
  const result = await clear({});
  assert.equal(result.ok, true);
  assert.deepEqual(names(world), ["deleteAttendance", "makeupAttendance"]);
  assert.equal(world.calls[1][1], "ABSENT", "결석으로 고칠 때와 같은 되돌림(참석 → 예약됨, 보강권 사용 → 예약 중)");
  assert.equal(world.calls[1][2], true, "출결 삭제와 같은 트랜잭션에서 되돌린다");
  assert.equal(world.transactions, 1);
});

test("보강 온 아이: 예약 되돌림이 규칙에 막히면 출결 삭제도 함께 되돌아간다", async () => {
  const { world, clear } = makeWorld({ enrolled: false, makeupBookings: [{ id: "m1", status: "ATTENDED" }], attendance: "PRESENT", makeupRevertError: "이월로 정산된 결석의 보강입니다." });
  const quiet = console.error;
  console.error = () => {};
  try {
    const result = await clear({});
    assert.equal(result.ok, false);
    assert.match(result.message, /보강 예약을 되돌리지 못해 출결을 취소하지 않았습니다/);
  } finally {
    console.error = quiet;
  }
  assert.equal(world.attendance, "PRESENT", "출결이 그대로 남는다");
  assert.deepEqual(names(world), []);
});

test("체험 아이: 체험 장부만 되돌린다(선생님이 올린 «체험 완료» → «일정 확정»)", async () => {
  const { world, clear } = makeWorld({ trial: { status: "ATTENDED", staffAttendanceStatus: "PRESENT" } });
  const result = await clear({ attendanceKey: "trial:t1" });
  assert.equal(result.ok, true);
  assert.deepEqual(world.calls, [["clearTrial", "t1", "SCHEDULED"]]);
  // 관리자가 직접 바꾼 단계는 건드리지 않는다
  const consult = makeWorld({ trial: { status: "CONSULTING", staffAttendanceStatus: "ABSENT" } });
  await consult.clear({ attendanceKey: "trial:t1" });
  assert.deepEqual(consult.world.calls, [["clearTrial", "t1", "CONSULTING"]]);
});

test("특강 좌석: 좌석 출결을 비우고 정규 출석 기록·보강권도 같은 규칙으로 맞춘다, 잠긴 보강권이면 거부", async () => {
  const seat = { id: "seat1", studentId: "st1", attendanceStatus: "ABSENT" };
  const { world, clear } = makeWorld({ session: { sessionDateId: "sd1" }, seat, credits: [{ status: "AVAILABLE" }] });
  const result = await clear({ attendanceKey: "seat1" });
  assert.equal(result.ok, true);
  assert.equal(result.creditRevoke, true);
  assert.deepEqual(names(world), ["creditLookup", "clearSeat", "deleteSeatAttendance", "syncSeatCredit"]);
  assert.equal(world.calls[0][1], "SEASONAL:seat1");
  assert.notEqual(world.calls[3][1], "ABSENT");

  const locked = makeWorld({ session: { sessionDateId: "sd1" }, seat, credits: [{ status: "USED" }] });
  const refused = await locked.clear({ attendanceKey: "seat1" });
  assert.equal(refused.ok, false);
  assert.deepEqual(names(locked.world), ["creditLookup"]);

  // 이 수업 범위 밖 좌석 id
  const outside = makeWorld({ session: { sessionDateId: "sd1" }, seat: null });
  assert.equal((await outside.clear({ attendanceKey: "other" })).ok, false);
});

test("특강 좌석: 이미 미확인이어도 남은 정규 출석 기록은 지운다(여러 번 눌러도 같은 결과), 미리 보기는 지우지 않는다", async () => {
  const blank = { id: "seat1", studentId: "st1", attendanceStatus: null };
  const again = makeWorld({ session: { sessionDateId: "sd1" }, seat: blank });
  const result = await again.clear({ attendanceKey: "seat1" });
  assert.deepEqual({ ok: result.ok, cleared: result.cleared, previousStatus: result.previousStatus }, { ok: true, cleared: true, previousStatus: null });
  assert.deepEqual(again.world.calls, [["deleteSeatAttendance", "st1"]]);
  const preview = makeWorld({ session: { sessionDateId: "sd1" }, seat: blank });
  await preview.clear({ attendanceKey: "seat1", dryRun: true });
  assert.deepEqual(preview.world.calls, []);
  // 미전환 신청자(학생 없음)는 지울 정규 기록이 없다
  const unconverted = makeWorld({ session: { sessionDateId: "sd1" }, seat: { ...blank, studentId: null } });
  await unconverted.clear({ attendanceKey: "seat1" });
  assert.deepEqual(unconverted.world.calls, []);
});

// ── 권한·상태 ─────────────────────────────────────────────────

test("권한: 남의 수업·로그인 풀림·명단 밖 학생·끝난 수업은 거부", async () => {
  const forbidden = makeWorld({ attendance: "PRESENT", accessError: "담당 수업만 접근할 수 있습니다." });
  const denied = await forbidden.clear({});
  assert.equal(denied.ok, false);
  assert.equal(forbidden.world.attendance, "PRESENT");
  assert.deepEqual(names(forbidden.world), []);

  const outsider = makeWorld({ attendance: "PRESENT", enrolled: false, makeupBookings: [] });
  const notOnRoster = await outsider.clear({});
  assert.equal(notOnRoster.ok, false);
  assert.match(notOnRoster.message, /확정 명단에 없는 학생/);

  for (const status of ["COMPLETED", "PLANNED"]) {
    const closed = makeWorld({ attendance: "PRESENT", session: { status } });
    const result = await closed.clear({});
    assert.equal(result.ok, false, status);
    assert.match(result.message, /진행 중인 수업에서만/);
    assert.equal(closed.world.attendance, "PRESENT");
  }
});

// ── 화면 계약 ─────────────────────────────────────────────────

const client = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
const action = read("src/app/actions/staff-sessions.ts");

test("화면: 선택된 버튼을 다시 누르면 취소, 다른 버튼은 기존대로 변경", () => {
  // 버튼은 그대로 updateAttendance 하나를 부른다 — 같은 상태를 다시 누른 경우만 취소로 갈린다
  assert.match(client, /active=\{student\.status === status\} disabled=\{bulkBusy \|\| Boolean\(savingRows\[student\.id\]\)\} onClick=\{\(\) => void updateAttendance\(student\.id, status\)\}/);
  assert.match(client, /if \(target\.status === status && absenceReason === undefined && !retryAfterError\) return clearAttendance\(target\);/);
  // 그 줄에 오류 안내(«다시 눌러 주세요»)가 떠 있으면 같은 버튼 재누름은 취소가 아니라 «다시 저장»
  assert.match(client, /const retryAfterError = rowNotices\[rowId\]\?\.tone === "error";/);
  const update = client.slice(client.indexOf("async function updateAttendance"), client.indexOf("// 전체 출석 —"));
  assert.ok(update.indexOf("retryAfterError") < update.indexOf("saveStaffAttendance({"), "판정이 저장보다 먼저");
  // 판정은 안내를 지우기(setRowNotice(rowId, \"\")) «전»에 읽는다 — 지운 뒤에 읽으면 늘 취소로 간다
  assert.ok(update.indexOf("retryAfterError") < update.indexOf('setRowNotice(rowId, "");'));
  // 참고 안내(notice — 결석 신고 등)는 재저장으로 돌리지 않는다
  assert.doesNotMatch(update, /tone === "notice"/);
  // «질병·부상» 칩은 사유를 보내므로 취소로 가지 않는다
  assert.match(client, /updateAttendance\(student\.id, "ABSENT", illness \? null : "ILLNESS_INJURY"\)/);
  const fn = client.slice(client.indexOf("async function clearAttendance"), client.indexOf("async function updateAttendance"));
  // 결석을 되돌릴 때만 한 번 묻고, 보강권이 실제로 있을 때만 회수 문장
  assert.match(fn, /if \(target\.status === "ABSENT"\) \{\s*const preview = await clearStaffAttendance\(\{ sessionId: session\.id, attendanceKey: target\.attendanceKey, dryRun: true \}\);/);
  assert.equal((fn.match(/window\.confirm\(/g) ?? []).length, 1);
  assert.match(fn, /preview\.creditRevoke\s*\? `\$\{target\.name\} 결석을 취소할까요\? 이 결석으로 나간 보강권이 회수됩니다\.`\s*: `\$\{target\.name\} 결석을 취소할까요\?`/);
  // 취소되면 그 줄만 미확인으로 — 현황 숫자(counts)는 students 에서 계산되므로 바로 따라온다
  assert.match(fn, /\{ \.\.\.student, status: null, arrivedAt: null, \.\.\.absenceReportPatch\(result\) \}/);
  assert.match(client, /UNCHECKED: students\.filter\(\(student\) => !student\.status\)\.length/);
  // 서버가 막으면 그 줄 아래에 이유를 보인다
  assert.match(fn, /if \(!result\.ok\) \{\s*setRowNotice\(rowId, result\.message\);/);
  // 다시 누르면 취소된다는 설명문은 넣지 않는다(동작으로)
  assert.doesNotMatch(client, /다시 누르면 취소|한 번 더 누르면/);
  // 선택 표시는 버튼 부품의 aria-pressed
  assert.match(read("src/components/staff/StatusChoiceButton.tsx"), /aria-pressed=\{active\}/);
});

test("서버: 미확인은 «기록 없음» — 종료 검사와 같은 뜻, 저장 액션의 상태 검사는 그대로", () => {
  // 종료는 출결 기록이 없는 학생이 있으면 막는다 → 취소한 학생이 있으면 그대로 막힌다
  assert.match(action, /NOT EXISTS \(SELECT 1 FROM "Attendance" a WHERE a\."sessionId" = \$2 AND a\."studentId" = e\."studentId"\)/);
  // 저장 액션은 여전히 세 상태만 받는다(UNCHECKED 를 출결 표에 쓰지 않는다)
  assert.match(action, /if \(!\["PRESENT", "LATE", "ABSENT"\]\.includes\(input\.status\)\) return \{ ok: false as const, message: "올바른 출결 상태가 아닙니다\." \};/);
  const fn = action.slice(action.indexOf("export async function clearStaffAttendance"), action.indexOf("async function getMakeupCompletedParentRecipients"));
  assert.match(fn, /const gate = await trySessionAccess\(input\.sessionId\);\s*if \(!gate\.ok\) return gate;/);
  assert.doesNotMatch(fn, /deliverParentNotification|runAfterResponse/, "취소는 알림을 보내지 않는다");
  assert.doesNotMatch(fn, /UPDATE "RegularAbsence"|DELETE FROM "RegularAbsence"/, "결석 신고는 규칙 함수만 건드린다");
  // 비운 좌석의 확인 시각은 NULL — 관리자 쪽(setSeasonalAttendance)과 같은 모양
  assert.match(fn, /SET "attendanceStatus" = NULL, "attendanceNote" = NULL, "arrivedAt" = NULL,\s*"attendanceCheckedAt" = NULL, "attendanceCheckedByUserId" = \$3/);
  assert.match(read("src/lib/seasonal/attendance.ts"), /"attendanceCheckedAt" = CASE WHEN \$2 IS NULL THEN NULL ELSE now\(\) END/);
  // 보강권 회수 SQL 은 한 곳(트랜잭션판)이고, 기존 함수는 그것을 그대로 부른다
  const service = read("src/lib/makeup/credit-service.ts");
  assert.match(service, /export async function revokeMakeupCredit\([\s\S]{0,160}return revokeMakeupCreditInTx\(prisma, input\);/);
  assert.equal(service.split(`SET "status" = 'REVOKED'`).length - 1, 1);
  assert.match(service, /WHERE "studentId" = \$1 AND "sourceKey" = \$2\s*AND "status" = 'AVAILABLE'/);
});
