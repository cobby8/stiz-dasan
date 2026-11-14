// 2026-11-14 원장 지시 — 「선생님 화면에서 완료한 수업도 들어가면 내용을 볼 수 있고 수정할 수 있게」.
// ① 수정 기간 규칙(수업일 포함 7일·원장·부원장 무제한)을 실제로 돌린다 — 자정·월말·연말 경계.
// ② 서버 기능을 가짜 DB 로 «실제로 돌려» 확인한다: 완료한 수업의 출결 정정이 기존 규칙 함수를 타는지,
//    보강·체험은 거부하는지, 기간이 지나면 서버가 막는지, 알림이 다시 나가지 않는지, 수정 기록이 남는지.
// ③ 화면·조회는 소스로 못박는다: 완료한 수업 본문에 타이머·종료 버튼이 없고, 지난 수업 목록이 «열 수 있는 수업»만 고른다.
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
const videoRules = load("src/lib/sessionVideo/rules.ts", { "@/lib/datetime/kst": kst });
const rules = load("src/lib/staff/sessionEditWindow.ts", { "@/lib/datetime/kst": kst, "@/lib/sessionVideo/rules": videoRules });
const feedRules = load("src/lib/feed/rules.ts", { "@/lib/datetime/kst": kst, "@/lib/sessionVideo/rules": videoRules });
const creditRules = load("src/lib/makeup/credit-rules.ts", { "@/lib/datetime/kst": kst });
const sessionRules = load("src/lib/staff-session-rules.ts", { "@/lib/datetime/kst": kst, "@/lib/auth/moneyAccess": load("src/lib/auth/moneyAccess.ts") });
const kstMs = (iso) => new Date(`${iso}+09:00`).getTime();

// ── ① 수정 기간 규칙 ──────────────────────────────────────────────────

test("수정 기간 = 수업일 포함 7일(KST) — 자정·월말·연말·윤년 경계", () => {
  const can = (sessionYmd, todayYmd, extra = {}) => rules.staffSessionEditWindow({ status: "COMPLETED", sessionYmd, todayYmd, ...extra });
  assert.equal(rules.STAFF_SESSION_EDIT_DAYS, 7);
  // 수업일(0일째)~6일 뒤까지 가능, 7일 뒤부터 EXPIRED
  assert.deepEqual(can("2026-11-14", "2026-11-14"), { ok: true });
  assert.deepEqual(can("2026-11-14", "2026-11-20"), { ok: true });
  assert.deepEqual(can("2026-11-14", "2026-11-21"), { ok: false, reason: "EXPIRED" });
  // 월말을 넘는다(10/28 → 11/3 까지)
  assert.deepEqual(can("2026-10-28", "2026-11-03"), { ok: true });
  assert.deepEqual(can("2026-10-28", "2026-11-04"), { ok: false, reason: "EXPIRED" });
  // 연말을 넘는다(12/28 → 1/3 까지)
  assert.deepEqual(can("2026-12-28", "2027-01-03"), { ok: true });
  assert.deepEqual(can("2026-12-28", "2027-01-04"), { ok: false, reason: "EXPIRED" });
  // 윤년 2월(2028-02-25 → 3/2 까지, 2/29 를 지난다)
  assert.deepEqual(can("2028-02-25", "2028-03-02"), { ok: true });
  assert.deepEqual(can("2028-02-25", "2028-03-03"), { ok: false, reason: "EXPIRED" });
  // 자정 경계 — «오늘»은 서버(UTC) 날짜가 아니라 한국 날짜. 7일째 밤 23:59:59 까지 열리고 8일째 0시에 닫힌다
  const at = (iso) => can("2026-11-14", kst.todayKst(kstMs(iso))).ok;
  assert.equal(at("2026-11-20T23:59:59"), true);
  assert.equal(at("2026-11-21T00:00:00"), false);
  // 잘못된 날짜·오지 않은 날짜
  assert.deepEqual(can("2026-02-30", "2026-03-01"), { ok: false, reason: "INVALID" });
  assert.deepEqual(can("2026-11-14", "2026-11-13"), { ok: false, reason: "NOT_TODAY" });
});

test("원장·부원장은 기간 제한 없음, 시작 전 수업은 대상이 아니다, 진행 중 수업도 같은 함수", () => {
  const input = { sessionYmd: "2026-01-05", todayYmd: "2026-11-14" };
  assert.deepEqual(rules.staffSessionEditWindow({ status: "COMPLETED", ...input }), { ok: false, reason: "EXPIRED" });
  assert.deepEqual(rules.staffSessionEditWindow({ status: "COMPLETED", ...input, unlimited: true }), { ok: true });
  assert.deepEqual(rules.staffSessionEditWindow({ status: "PLANNED", sessionYmd: "2026-11-14", todayYmd: "2026-11-14", unlimited: true }), { ok: false, reason: "NOT_STARTED" });
  assert.deepEqual(rules.staffSessionEditWindow({ status: "IN_PROGRESS", sessionYmd: "2026-11-14", todayYmd: "2026-11-14" }), { ok: true });
  // 사진·영상·한 줄이 같은 함수를 쓴다(판정이 갈라지지 않는다)
  for (const today of ["2026-11-14", "2026-11-20", "2026-11-21"]) {
    const base = { status: "COMPLETED", sessionYmd: "2026-11-14", todayYmd: today };
    const expected = rules.staffSessionEditWindow(base).ok;
    assert.equal(videoRules.canManageSessionVideo(base).ok, expected, today);
    assert.equal(feedRules.canManageSessionMedia(base).ok, expected, today);
    assert.equal(feedRules.canEditFeedLine(base).ok, expected, today);
  }
  // 한 곳의 함수다 — 다시 내보낸 것이 같은 함수
  assert.equal(rules.staffSessionEditWindow, videoRules.staffSessionEditWindow);
  assert.match(rules.STAFF_EDIT_EXPIRED_MESSAGE, /^수정 기간\(7일\)이 지났어요/);
});

test("학부모 «볼 수 있는가» 판정은 그대로다 — 끝났고 발행된 수업만", () => {
  assert.equal(feedRules.isParentVisibleSession({ status: "COMPLETED", published: true }), true);
  assert.equal(feedRules.isParentVisibleSession({ status: "COMPLETED", published: false }), false);
  assert.equal(feedRules.isParentVisibleSession({ status: "IN_PROGRESS", published: true }), false);
  assert.equal(feedRules.feedVisibleSessionSql("se"), "se.status = 'COMPLETED' AND se.published = true");
  // 참여 판정 SQL 도 건드리지 않았다(출결 기록 또는 ACTIVE 수강)
  assert.match(feedRules.feedParticipantSql("st", "se"), /FROM "Attendance" fa WHERE fa\."sessionId" = se\.id AND fa\."studentId" = st\.id/);
});

test("정정 대상·보강권 영향·확인 문구(순수 규칙)", () => {
  // 정규 수강생·특강 좌석만 정정, 보강 온 아이·체험 아이는 원장
  assert.equal(rules.canCorrectAfterCompletion("REGULAR"), true);
  assert.equal(rules.canCorrectAfterCompletion("SEASONAL"), true);
  assert.equal(rules.canCorrectAfterCompletion("MAKEUP"), false);
  assert.equal(rules.canCorrectAfterCompletion("TRIAL"), false);
  const effect = (previousStatus, nextStatus, creditStatuses) => rules.correctionCreditEffect({ previousStatus, nextStatus, creditStatuses });
  // 결석 → 출석·지각: 안 쓴 권만 회수, 예약·사용된 권은 그대로
  assert.equal(effect("ABSENT", "PRESENT", ["AVAILABLE"]), "REVOKE");
  assert.equal(effect("ABSENT", "LATE", ["USED"]), "KEEP_USED");
  assert.equal(effect("ABSENT", "PRESENT", ["RESERVED"]), "KEEP_USED");
  assert.equal(effect("ABSENT", "PRESENT", ["NO_SHOW"]), "KEEP_USED");
  assert.equal(effect("ABSENT", "PRESENT", []), "NONE");
  assert.equal(effect("ABSENT", "PRESENT", ["REVOKED", "EXPIRED"]), "NONE");
  // 출석·지각·미확인 → 결석: 살아 있는 권이 없으면 나간다
  assert.equal(effect("PRESENT", "ABSENT", []), "ISSUE");
  assert.equal(effect(null, "ABSENT", ["REVOKED"]), "ISSUE");
  assert.equal(effect("LATE", "ABSENT", ["AVAILABLE"]), "NONE");
  // 출석 ↔ 지각은 보강권과 무관
  assert.equal(effect("PRESENT", "LATE", ["AVAILABLE"]), "NONE");
  const message = (effectKind) => rules.correctionConfirmMessage({ name: "김하늘", previousStatus: "ABSENT", nextStatus: "PRESENT", effect: effectKind });
  assert.equal(message("REVOKE"), "김하늘 결석 → 출석으로 고칠까요?\n안 쓴 보강권은 회수돼요.");
  assert.equal(message("KEEP_USED"), "김하늘 결석 → 출석으로 고칠까요?\n이미 쓴 보강권은 그대로 남아요.");
  assert.equal(message("NONE"), "김하늘 결석 → 출석으로 고칠까요?");
  assert.equal(rules.correctionConfirmMessage({ name: "김하늘", previousStatus: "PRESENT", nextStatus: "ABSENT", effect: "ISSUE" }), "김하늘 출석 → 결석으로 고칠까요?\n결석 보강권이 나갈 수 있어요.");
});

test("지난 수업 목록: 오늘 포함 14일, 최근 날짜 먼저·같은 날은 시작 시간 순으로 묶는다", () => {
  assert.equal(rules.STAFF_PAST_SESSION_LIST_DAYS, 14);
  assert.equal(rules.inPastSessionListRange("2026-11-14", "2026-11-14"), true);
  assert.equal(rules.inPastSessionListRange("2026-11-01", "2026-11-14"), true);
  assert.equal(rules.inPastSessionListRange("2026-10-31", "2026-11-14"), false, "15일째는 빠진다");
  assert.equal(rules.inPastSessionListRange("2026-11-15", "2026-11-14"), false, "내일 수업은 지난 수업이 아니다");
  const row = (sessionId, ymd, startTime) => ({ sessionId, ymd, startTime, endTime: "", className: sessionId, seasonal: false, presentCount: 0, absentCount: 0, hasFeed: true, published: true });
  const groups = rules.groupPastSessions([row("a", "2026-11-12", "17:00"), row("b", "2026-11-14", "18:00"), row("c", "2026-11-14", "16:00"), row("d", "bad", "10:00")]);
  assert.deepEqual(groups.map((group) => [group.ymd, group.rows.map((item) => item.sessionId)]), [["2026-11-14", ["c", "b"]], ["2026-11-12", ["a"]]]);
});

// ── ② 서버 기능(가짜 DB) ───────────────────────────────────────────────

const SHEET_NOTE = "출석부에서 질병·부상 결석으로 표시";

/** 수업·출결·보강권을 메모리에 두고, 액션이 보낸 SQL 을 글자로 알아보는 가짜 환경. calls 에 «무엇이 불렸는지»를 남긴다. */
function makeWorld(options = {}) {
  const world = {
    today: options.today ?? "2026-11-16",
    session: { id: "se1", classId: "c1", status: "COMPLETED", className: "초등 A반", sessionDateId: null, date: "2026-11-14", ...options.session },
    access: { staff: { appUserId: "u-teacher", appUserRole: "INSTRUCTOR" }, coachId: "k1", canAccessAllClasses: false, ...options.access },
    accessError: options.accessError ?? null,
    enrolled: options.enrolled ?? true,
    makeupBookings: options.makeupBookings ?? [],
    attendance: options.attendance ?? "ABSENT",
    credits: options.credits ?? [],
    // 살아 있는 질병·부상 결석(출석부 표시·학부모 신고)이 있는가
    illness: options.illness ?? false,
    seat: options.seat ?? null,
    notes: options.notes ?? null,
    content: options.content ?? null,
    published: options.published ?? false,
    previousPublishedAt: options.previousPublishedAt ?? null,
    calls: [],
    audits: [],
    afterJobs: [],
    updates: [],
  };
  const query = async (sql, ...args) => {
    if (/^SELECT \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date::text AS "todayYmd"$/.test(sql)) return [{ todayYmd: world.today }];
    if (/FROM "Enrollment" e WHERE e\."classId" = \$1 AND e\."studentId" = \$2/.test(sql)) return world.enrolled ? [{ id: "e1" }] : [];
    if (/^SELECT status FROM "Attendance"/.test(sql)) return world.attendance ? [{ status: world.attendance }] : [];
    if (/^SELECT status FROM "MakeupCredit"/.test(sql)) { world.calls.push(["creditLookup", args[1]]); return world.credits; }
    if (/^INSERT INTO "Attendance"/.test(sql)) { world.calls.push(["saveAttendance", args[2]]); world.attendance = args[2]; world.attendanceInsert = { sql, args }; return [{ id: "a1" }]; }
    if (/FROM "RegularAbsence" ra\s+WHERE ra\."studentId" = \$1 AND ra\."classId" = \$2 AND ra\.date = \$3::date\s+AND ra\.status <> 'CANCELLED' AND ra\.reason = 'ILLNESS_INJURY'/.test(sql)) {
      world.calls.push(["illnessLookup"]);
      return world.illness ? [{ id: "ra1" }] : [];
    }
    if (/^SELECT "attendanceStatus" FROM "SpecialProgramEnrollmentDate"/.test(sql)) return world.seat ? [{ attendanceStatus: world.seat.attendanceStatus }] : [];
    if (/^UPDATE "SpecialProgramEnrollmentDate" e\s+SET "attendanceStatus" = \$3/.test(sql)) {
      if (!world.seat) return [];
      world.calls.push(["saveSeat", args[2]]);
      world.seatUpdate = { sql, args };
      world.seat = { ...world.seat, attendanceStatus: args[2] };
      return [{ id: world.seat.id, studentId: world.seat.studentId }];
    }
    if (/FROM "SpecialProgramEnrollmentDate" e\s+JOIN "Session" s ON s\.id = \$1/.test(sql)) return world.seat ? [world.seat] : [];
    if (/^SELECT notes FROM "Session"/.test(sql)) return [{ notes: world.notes }];
    if (/^SELECT status, .* AS "sessionYmd", .* AS "todayYmd", content\s+FROM "Session"/s.test(sql)) {
      return [{ status: world.session.status, sessionYmd: world.session.date, todayYmd: world.today, content: world.content }];
    }
    if (/^UPDATE "Session" SET content = \$2/.test(sql)) { world.updates.push({ sql, args }); world.content = args[1]; return [{ id: "se1" }]; }
    if (/^UPDATE "Session" s\s+SET published = true, "publishedAt" = NOW\(\)/.test(sql)) {
      world.updates.push({ sql, args });
      if (world.published || world.session.status !== "COMPLETED") return [];
      world.published = true;
      return [{ id: "se1", previousPublishedAt: world.previousPublishedAt }];
    }
    if (/^SELECT DISTINCT "studentId" FROM "Attendance" WHERE "sessionId" = \$1$/.test(sql)) return [{ studentId: "st1" }];
    throw new Error(`가짜 DB 가 모르는 SQL: ${sql.slice(0, 110)}`);
  };
  const prisma = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: async (sql, ...args) => {
      if (/^INSERT INTO "OperationsAuditLog" \(id, action, "actorType", "actorUserId", "detailsJson"\)/.test(sql)) {
        world.audits.push({ action: args[0], actorUserId: args[1], details: JSON.parse(args[2]) });
        return 1;
      }
      if (/^UPDATE "Session" SET notes = \$2, "updatedAt" = NOW\(\) WHERE id = \$1$/.test(sql)) { world.calls.push(["saveMemo"]); world.notes = args[1]; return 1; }
      throw new Error(`가짜 DB 가 모르는 실행문: ${sql.slice(0, 110)}`);
    },
    $transaction: async (fn) => fn(prisma),
  };
  const recipient = { studentId: "st1", studentName: "김하늘", userId: "p1" };
  const actions = load("src/app/actions/staff-sessions.ts", {
    "next/cache": { revalidatePath() {} },
    // 응답 뒤에 도는 일(학부모 알림)을 모아 두고, 테스트가 직접 돌린다
    "next/server": { after: (job) => { world.afterJobs.push(job); } },
    "@/lib/prisma": { prisma },
    "@/lib/makeup/credit-service": {
      syncCreditForRegularSession: async (input) => { world.calls.push(["syncRegularCredit", input.status, input.studentId]); return { action: "revoked" }; },
      revokeMakeupCreditInTx: async () => ({ revoked: 1 }),
      syncCreditForSeasonalSeat: async (input) => { world.calls.push(["syncSeatCredit", input.status, input.enrollmentDateId]); return { action: "revoked" }; },
    },
    "@/lib/makeup/credit-rules": creditRules,
    "@/lib/makeup/makeup-attendance": {
      applyMakeupAttendanceInTx: async (_db, input) => { world.calls.push(["makeupAttendance", input.status]); return []; },
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
    "@/lib/feed/rules": feedRules,
    "@/lib/staff/sessionEditWindow": rules,
    "@/lib/staff-session-rules": sessionRules,
    "@/lib/staff-session-queries": { trialOnClassDateSql: () => "true" },
    "@/lib/staff-notifications": {
      deliverParentNotification: async (input) => { world.calls.push(["notify", input.eventType, input.dedupeKey]); return {}; },
      getClassParentRecipients: async () => [recipient],
      getStudentParentRecipients: async () => [recipient],
    },
    "@/lib/studentVisibility": { notMergedStudent: () => "true" },
    "@/lib/profilePhoto/rules": { profilePhotoVersion: () => null },
    "@/lib/regular/regularSession": { adoptRegularSessionKey: async () => {}, regularSessionKey: () => "key" },
    "@/lib/regular/attendance-absence-reason": {
      SHEET_ABSENCE_NOTE: SHEET_NOTE,
      absencePlanMessage: () => null,
      applyAttendanceAbsenceReasonInTx: async (_tx, input) => { world.calls.push(["absenceReason", input.attendanceStatus, input.intent]); return { plan: "NONE", report: null }; },
    },
  });
  const runAfter = async () => { for (const job of world.afterJobs.splice(0)) await job(); };
  return { world, actions, runAfter };
}
const names = (world) => world.calls.map((call) => call[0]);
const KEY = { sessionId: "se1", attendanceKey: "st1" };

test("완료한 수업의 출결 정정(7일 안) — 기존 규칙 함수(결석 사유·보강권)를 타고, 학부모 알림은 나가지 않고, 기록이 남는다", async () => {
  const { world, actions, runAfter } = makeWorld({ attendance: "ABSENT" });
  const result = await actions.saveStaffAttendance({ ...KEY, status: "PRESENT" });
  assert.equal(result.ok, true);
  assert.equal(world.attendance, "PRESENT");
  // 질병·부상 결석이 아닌지 먼저 보고, 진행 중 수업과 같은 순서: 출결 저장 → 결석 사유 정리 → 보강권 맞춤
  assert.deepEqual(names(world), ["illnessLookup", "creditLookup", "saveAttendance", "absenceReason", "syncRegularCredit"]);
  assert.deepEqual(world.calls[4], ["syncRegularCredit", "PRESENT", "st1"]);
  // 수업 중 적어 둔 출결 노트는 지킨다 — 노트 없이 온 정정은 덮어쓰지 않는다($7 = true)
  assert.match(world.attendanceInsert.sql, /note = COALESCE\(EXCLUDED\.note, "Attendance"\.note\),/);
  assert.equal(world.attendanceInsert.args[3], null);
  // 알림: 응답 뒤에 돌 일이 하나도 없다
  await runAfter();
  assert.ok(!names(world).includes("notify"), "완료 뒤 정정은 출석 알림을 보내지 않는다");
  // 수정 기록 — 누가·어느 수업·누구를·전/후 상태. 사유 글은 없다
  assert.deepEqual(world.audits, [{
    action: "STAFF_SESSION_REVIEW_EDIT", actorUserId: "u-teacher",
    details: { sessionId: "se1", item: "ATTENDANCE", kind: "REGULAR", studentId: "st1", attendanceId: "a1", before: "ABSENT", after: "PRESENT" },
  }]);
});

test("진행 중 수업의 출결은 예전 그대로 — 출석 알림이 나가고 수정 기록은 남기지 않는다(회귀)", async () => {
  const { world, actions, runAfter } = makeWorld({ session: { status: "IN_PROGRESS", date: "2026-11-16" }, attendance: null });
  const result = await actions.saveStaffAttendance({ ...KEY, status: "PRESENT" });
  assert.equal(result.ok, true);
  await runAfter();
  assert.deepEqual(world.calls.find((call) => call[0] === "notify"), ["notify", "ATTENDANCE_PRESENT", "attendance:a1:status:PRESENT:user:p1"]);
  assert.equal(world.audits.length, 0);
  // 진행 중 수업은 노트를 예전처럼 보낸 값 그대로 쓴다, 질병·부상 검사도 타지 않는다
  assert.match(world.attendanceInsert.sql, /note = EXCLUDED\.note,/);
  assert.ok(!names(world).includes("illnessLookup"));
  // 진행 중 수업은 «오늘»을 DB 에 묻지 않는다(기간 판정을 타지 않는다) — 전체 출석·질병 표시도 그대로 받는다
  const bulk = makeWorld({ session: { status: "IN_PROGRESS", date: "2026-11-16" }, attendance: null });
  assert.equal((await bulk.actions.saveStaffAttendance({ ...KEY, status: "PRESENT", bulk: true })).ok, true);
  const illness = makeWorld({ session: { status: "IN_PROGRESS", date: "2026-11-16" }, attendance: "ABSENT" });
  assert.equal((await illness.actions.saveStaffAttendance({ ...KEY, status: "ABSENT", absenceReason: "ILLNESS_INJURY" })).ok, true);
  assert.deepEqual(illness.world.calls.find((call) => call[0] === "absenceReason"), ["absenceReason", "ABSENT", "ILLNESS_INJURY"]);
});

test("기간이 지난 수업은 서버가 막는다(선생님) — 원장·부원장은 기간 제한 없이 고친다", async () => {
  // 수업일 11/14 → 11/21 은 8일째
  const expired = makeWorld({ today: "2026-11-21" });
  const denied = await expired.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /^수정 기간\(7일\)이 지났어요/);
  assert.equal(expired.world.attendance, "ABSENT", "아무것도 바꾸지 않는다");
  assert.deepEqual(names(expired.world), []);
  assert.equal(expired.world.audits.length, 0);
  // 메모·미리 보기·보내기도 같은 문에서 막힌다
  assert.match((await expired.actions.saveSessionMemo({ sessionId: "se1", notes: "x" })).message, /수정 기간/);
  assert.match((await expired.actions.previewStaffAttendanceCorrection({ ...KEY, status: "PRESENT" })).message, /수정 기간/);
  assert.match((await expired.actions.publishStaffSessionReport({ sessionId: "se1" })).message, /수정 기간/);
  assert.match((await expired.actions.saveSessionFeedLine({ sessionId: "se1", content: "x" })).message, /수정 기간/);
  assert.equal(expired.world.updates.length, 0);
  // 7일째(11/20)는 아직 된다
  const lastDay = makeWorld({ today: "2026-11-20" });
  assert.equal((await lastDay.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" })).ok, true);
  // 원장·부원장
  const owner = makeWorld({ today: "2027-03-01", access: { staff: { appUserId: "u-owner", appUserRole: "ADMIN" }, coachId: null, canAccessAllClasses: true } });
  assert.equal((await owner.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" })).ok, true);
  assert.equal(owner.world.audits[0].actorUserId, "u-owner");
});

test("권한: 남의 수업·로그인 풀림은 완료한 수업에서도 거부(던지지 않고 결과로)", async () => {
  const other = makeWorld({ accessError: "담당 수업에만 접근할 수 있습니다." });
  for (const call of [
    () => other.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" }),
    () => other.actions.previewStaffAttendanceCorrection({ ...KEY, status: "PRESENT" }),
    () => other.actions.saveSessionMemo({ sessionId: "se1", notes: "x" }),
    () => other.actions.publishStaffSessionReport({ sessionId: "se1" }),
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.match(result.message, /담당 수업/);
  }
  assert.deepEqual(names(other.world), []);
  assert.equal(other.world.updates.length + other.world.audits.length, 0);
  const loggedOut = makeWorld({ accessError: "UNAUTHORIZED" });
  assert.equal((await loggedOut.actions.publishStaffSessionReport({ sessionId: "se1" })).needsLogin, true);
});

test("완료한 수업: 보강 온 아이·체험 아이·전체 출석·질병 표시·미확인 되돌리기는 받지 않는다", async () => {
  // 보강 온 아이(정규 명단에 없고 보강 예약이 있다)
  const makeup = makeWorld({ enrolled: false, makeupBookings: [{ id: "m1" }] });
  const makeupResult = await makeup.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" });
  assert.deepEqual(makeupResult, { ok: false, message: rules.STAFF_REVIEW_ASK_OWNER_MESSAGE });
  assert.deepEqual(names(makeup.world), [], "출결·보강 예약·보강권을 건드리지 않는다");
  assert.equal((await makeup.actions.previewStaffAttendanceCorrection({ ...KEY, status: "PRESENT" })).message, rules.STAFF_REVIEW_ASK_OWNER_MESSAGE);
  // 체험 아이
  const trial = makeWorld();
  assert.deepEqual(await trial.actions.saveStaffAttendance({ sessionId: "se1", attendanceKey: "trial:lead1", status: "PRESENT" }), { ok: false, message: rules.STAFF_REVIEW_ASK_OWNER_MESSAGE });
  assert.equal((await trial.actions.previewStaffAttendanceCorrection({ sessionId: "se1", attendanceKey: "trial:lead1", status: "PRESENT" })).ok, false);
  assert.deepEqual(names(trial.world), []);
  // 전체 출석·질병·부상 표시 변경
  const bulk = makeWorld();
  assert.equal((await bulk.actions.saveStaffAttendance({ ...KEY, status: "PRESENT", bulk: true })).ok, false);
  assert.equal((await bulk.actions.saveStaffAttendance({ ...KEY, status: "ABSENT", absenceReason: "ILLNESS_INJURY" })).ok, false);
  assert.deepEqual(names(bulk.world), []);
  // 미확인으로 되돌리기(출결 취소)는 진행 중 수업 전용 그대로
  const cleared = await bulk.actions.clearStaffAttendance(KEY);
  assert.equal(cleared.ok, false);
  assert.match(cleared.message, /진행 중인 수업에서만/);
  assert.equal(bulk.world.attendance, "ABSENT");
});

test("보안 검수 MEDIUM: 살아 있는 질병·부상 결석은 완료한 수업에서 출석·지각으로 정정할 수 없다(결석→출석→결석 우회 차단)", async () => {
  // 출석부 표시든 학부모 신고든 reason=ILLNESS_INJURY·취소 안 됨 → 출석·지각 정정 거부
  for (const status of ["PRESENT", "LATE"]) {
    const { world, actions } = makeWorld({ attendance: "ABSENT", illness: true, credits: [] });
    assert.deepEqual(await actions.saveStaffAttendance({ ...KEY, status }), { ok: false, message: rules.STAFF_REVIEW_ASK_OWNER_MESSAGE }, status);
    assert.equal(world.attendance, "ABSENT", "출결을 바꾸지 않는다");
    assert.deepEqual(names(world), ["illnessLookup"], "결석 사유·보강권 규칙을 타지 않는다(표시가 취소되지 않는다)");
    assert.equal(world.audits.length, 0);
    // 미리 보기도 같은 검사 — 화면은 그 줄에 «원장님께 요청»
    assert.deepEqual(await actions.previewStaffAttendanceCorrection({ ...KEY, status }), { ok: false, message: rules.STAFF_REVIEW_ASK_OWNER_MESSAGE });
  }
  assert.match(rules.STAFF_REVIEW_ASK_OWNER_MESSAGE, /질병·부상 결석/);
  // 결석으로의 정정은 질병·부상 표시를 건드리지 않으므로 받는다(검사도 하지 않는다)
  const toAbsent = makeWorld({ attendance: "PRESENT", illness: true });
  assert.equal((await toAbsent.actions.saveStaffAttendance({ ...KEY, status: "ABSENT" })).ok, true);
  assert.ok(!names(toAbsent.world).includes("illnessLookup"));
  // 화면: 질병·부상 결석이 걸린 줄은 출결 버튼을 그리지 않는다
  const roster = read("src/components/staff/CompletedAttendanceRoster.tsx");
  assert.match(roster, /const illnessAbsence = student\.absenceReport\?\.reason === "ILLNESS_INJURY";\s*const correctable = editable && !illnessAbsence && canCorrectAfterCompletion\(/);
});

test("보안 검수 LOW 2: 메모·출결 노트는 2000자까지, 새 기능의 id 는 모양·길이를 먼저 본다", async () => {
  const long = "가".repeat(2001);
  const { world, actions } = makeWorld({ attendance: "ABSENT" });
  assert.match((await actions.saveSessionMemo({ sessionId: "se1", notes: long })).message, /2000자/);
  assert.match((await actions.saveStaffAttendance({ ...KEY, status: "PRESENT", note: long })).message, /2000자/);
  assert.equal((await actions.saveSessionMemo({ sessionId: "se1", notes: 123 })).ok, false);
  assert.equal(world.notes, null);
  assert.equal(world.attendance, "ABSENT");
  // 2000자는 된다
  assert.equal((await actions.saveSessionMemo({ sessionId: "se1", notes: "가".repeat(2000) })).ok, true);
  // id 모양 — 권한 조회 전에 거른다
  const denied = makeWorld({ accessError: "담당 수업에만 접근할 수 있습니다." });
  for (const sessionId of ["", "x".repeat(101), "se1; DROP", "../se1", null, undefined, 7]) {
    assert.equal((await denied.actions.publishStaffSessionReport({ sessionId })).message, "수업 정보를 다시 확인해 주세요.", String(sessionId));
    assert.equal((await denied.actions.previewStaffAttendanceCorrection({ sessionId, attendanceKey: "st1", status: "PRESENT" })).message, "수업 정보를 다시 확인해 주세요.");
  }
  assert.equal((await denied.actions.previewStaffAttendanceCorrection({ sessionId: "se1", attendanceKey: "st 1'", status: "PRESENT" })).message, "수업 정보를 다시 확인해 주세요.");
  // 체험 줄 키(trial:<id>)·uuid 는 통과해 다음 검사로 간다
  assert.match((await denied.actions.previewStaffAttendanceCorrection({ sessionId: "0b1c2d3e-aaaa-4bbb-8ccc-1234567890ab", attendanceKey: "trial:lead1", status: "PRESENT" })).message, /담당 수업/);
});

test("정정 미리 보기 — 아무것도 바꾸지 않고 실제 보강권 결과를 알려 준다", async () => {
  const revoke = makeWorld({ attendance: "ABSENT", credits: [{ status: "AVAILABLE" }] });
  assert.deepEqual(await revoke.actions.previewStaffAttendanceCorrection({ ...KEY, status: "PRESENT" }), { ok: true, previousStatus: "ABSENT", effect: "REVOKE" });
  assert.deepEqual(names(revoke.world), ["illnessLookup", "creditLookup"]);
  assert.equal(revoke.world.calls[1][1], "REGULAR:c1:2026-11-14", "보강권 키는 발급과 같은 키(반·결석일)");
  assert.equal(revoke.world.attendance, "ABSENT");
  assert.equal(revoke.world.audits.length, 0);
  // 코드 리뷰 권장 2: 이미 예약·사용·불참 처리된 보강권이 걸린 결석은 출석·지각으로 고치지 못한다(미리 보기·저장 같은 판정)
  for (const status of ["RESERVED", "USED", "NO_SHOW"]) {
    const locked = makeWorld({ attendance: "ABSENT", credits: [{ status }] });
    assert.deepEqual(await locked.actions.previewStaffAttendanceCorrection({ ...KEY, status: "LATE" }), { ok: false, message: rules.STAFF_REVIEW_CREDIT_LOCKED_MESSAGE }, status);
    assert.deepEqual(await locked.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" }), { ok: false, message: rules.STAFF_REVIEW_CREDIT_LOCKED_MESSAGE }, status);
    assert.equal(locked.world.attendance, "ABSENT");
    assert.ok(!names(locked.world).includes("saveAttendance") && !names(locked.world).includes("syncRegularCredit"));
    assert.equal(locked.world.audits.length, 0);
  }
  assert.match(rules.STAFF_REVIEW_CREDIT_LOCKED_MESSAGE, /원장님께 요청/);
  // 특강 좌석도 같다
  const lockedSeat = makeWorld({ session: { sessionDateId: "sd1" }, seat: { id: "seat1", studentId: "st1", attendanceStatus: "ABSENT" }, credits: [{ status: "USED" }] });
  assert.equal((await lockedSeat.actions.saveStaffAttendance({ sessionId: "se1", attendanceKey: "seat1", status: "PRESENT" })).message, rules.STAFF_REVIEW_CREDIT_LOCKED_MESSAGE);
  assert.equal((await lockedSeat.actions.previewStaffAttendanceCorrection({ sessionId: "se1", attendanceKey: "seat1", status: "PRESENT" })).message, rules.STAFF_REVIEW_CREDIT_LOCKED_MESSAGE);
  assert.ok(!names(lockedSeat.world).includes("saveSeat"));
  // 진행 중 수업의 정정은 예전 그대로(이 검사를 타지 않는다)
  const liveLocked = makeWorld({ session: { status: "IN_PROGRESS", date: "2026-11-16" }, attendance: "ABSENT", credits: [{ status: "USED" }] });
  assert.equal((await liveLocked.actions.saveStaffAttendance({ ...KEY, status: "PRESENT" })).ok, true);
  const issue = makeWorld({ attendance: "PRESENT", credits: [] });
  assert.equal((await issue.actions.previewStaffAttendanceCorrection({ ...KEY, status: "ABSENT" })).effect, "ISSUE");
  // 진행 중 수업에는 쓰지 않는다
  const live = makeWorld({ session: { status: "IN_PROGRESS" } });
  assert.equal((await live.actions.previewStaffAttendanceCorrection({ ...KEY, status: "PRESENT" })).ok, false);
});

test("특강 좌석도 정정할 수 있다 — 좌석 저장 경로를 타고 알림 없이 기록을 남긴다", async () => {
  const seat = { id: "seat1", studentId: "st1", attendanceStatus: "ABSENT" };
  const { world, actions, runAfter } = makeWorld({ session: { sessionDateId: "sd1" }, seat });
  assert.deepEqual(await actions.previewStaffAttendanceCorrection({ sessionId: "se1", attendanceKey: "seat1", status: "PRESENT" }), { ok: true, previousStatus: "ABSENT", effect: "NONE" });
  const result = await actions.saveStaffAttendance({ sessionId: "se1", attendanceKey: "seat1", status: "PRESENT" });
  assert.equal(result.ok, true);
  assert.deepEqual(names(world).filter((name) => name !== "creditLookup"), ["saveSeat", "syncSeatCredit", "saveAttendance"]);
  // 좌석 노트·정규 출석 노트도 지킨다
  assert.match(world.seatUpdate.sql, /"attendanceNote" = CASE WHEN \$7::boolean THEN COALESCE\(\$4, e\."attendanceNote"\) ELSE \$4 END/);
  assert.equal(world.seatUpdate.args[6], true);
  assert.equal(world.attendanceInsert.args[5], true);
  await runAfter();
  assert.ok(!names(world).includes("notify"));
  assert.deepEqual(world.audits[0].details, { sessionId: "se1", item: "ATTENDANCE", kind: "SEASONAL", seatId: "seat1", before: "ABSENT", after: "PRESENT" });
});

test("메모: 완료한 수업도 7일 안이면 저장하고 기록을 남긴다(본문은 싣지 않는다) — 진행 중은 기록 없이 그대로", async () => {
  const { world, actions } = makeWorld({ notes: null });
  assert.deepEqual(await actions.saveSessionMemo({ sessionId: "se1", notes: "  발목을 조금 삐었어요  " }), { ok: true });
  assert.equal(world.notes, "발목을 조금 삐었어요");
  assert.deepEqual(world.audits[0].details, { sessionId: "se1", item: "MEMO", before: "없음", after: "있음" });
  assert.doesNotMatch(JSON.stringify(world.audits), /발목/, "메모 본문은 기록에 싣지 않는다");
  // 같은 글을 다시 저장하면 기록을 늘리지 않는다
  await actions.saveSessionMemo({ sessionId: "se1", notes: "발목을 조금 삐었어요" });
  assert.equal(world.audits.length, 1);
  const live = makeWorld({ session: { status: "IN_PROGRESS" } });
  assert.deepEqual(await live.actions.saveSessionMemo({ sessionId: "se1", notes: "메모" }), { ok: true });
  assert.equal(live.world.audits.length, 0);
  const planned = makeWorld({ session: { status: "PLANNED" } });
  assert.equal((await planned.actions.saveSessionMemo({ sessionId: "se1", notes: "메모" })).ok, false);
});

test("수업 한 줄: 완료한 수업을 고치면 알림 없이 내용만 바뀌고 기록이 남는다, UPDATE 에도 원장·부원장 여부를 넘긴다", async () => {
  const { world, actions, runAfter } = makeWorld({ content: "드리블", published: true });
  const result = await actions.saveSessionFeedLine({ sessionId: "se1", content: " 패스 연습 " });
  assert.deepEqual(result, { ok: true, content: "패스 연습" });
  assert.equal(world.updates[0].args[2], false, "선생님 = 기간 제한 적용");
  assert.match(world.updates[0].sql, /\(status = 'PLANNED' AND .* = \(NOW\(\) AT TIME ZONE 'Asia\/Seoul'\)::date\)\s+OR \(status IN \('IN_PROGRESS', 'COMPLETED'\) AND \(.*\$3::boolean OR .* - 7\)\)\)/s);
  await runAfter();
  assert.ok(!names(world).includes("notify"), "이미 보낸 수업을 고쳐도 다시 알리지 않는다");
  assert.deepEqual(world.audits[0].details, { sessionId: "se1", item: "FEED_LINE", before: "있음", after: "있음" });
  assert.doesNotMatch(JSON.stringify(world.audits), /패스|드리블/);
  const owner = makeWorld({ today: "2027-01-01", access: { staff: { appUserId: "u-owner", appUserRole: "ADMIN" }, coachId: null, canAccessAllClasses: true } });
  assert.equal((await owner.actions.saveSessionFeedLine({ sessionId: "se1", content: "x" })).ok, true);
  assert.equal(owner.world.updates[0].args[2], true);
});

test("학부모에게 보내기: 처음 발행만 앱 알림(중복 방지 키), 이미 보낸 수업·다시 발행은 알림 없음", async () => {
  // 처음 발행
  const first = makeWorld({ published: false, previousPublishedAt: null });
  assert.deepEqual(await first.actions.publishStaffSessionReport({ sessionId: "se1" }), { ok: true, published: true, alreadyPublished: false, notified: true });
  await first.runAfter();
  assert.deepEqual(first.world.calls.filter((call) => call[0] === "notify"), [["notify", "REPORT", "session:se1:report-published:student:st1:user:p1"]]);
  assert.deepEqual(first.world.audits[0].details, { sessionId: "se1", item: "PUBLISH", before: "안 보냄", after: "보냄", firstPublish: true });
  // 안 보낸 수업만 바꾸는 한 문장(두 기기가 동시에 눌러도 한 번)
  assert.match(first.world.updates[0].sql, /FROM "Session" prev\s+WHERE prev\.id = s\.id AND s\.id = \$1 AND s\.status = 'COMPLETED' AND s\.published = false\s+RETURNING s\.id, prev\."publishedAt" AS "previousPublishedAt"/);
  // 한 번 더 누르면 아무 일도 없다
  assert.deepEqual(await first.actions.publishStaffSessionReport({ sessionId: "se1" }), { ok: true, published: true, alreadyPublished: true, notified: false });
  await first.runAfter();
  assert.equal(first.world.calls.filter((call) => call[0] === "notify").length, 1);
  assert.equal(first.world.audits.length, 1);
  // 예전에 발행됐다가 내려진 수업을 다시 보내면 알림은 없다(처음이 아니다)
  const again = makeWorld({ published: false, previousPublishedAt: "2026-11-14T10:00:00Z" });
  assert.equal((await again.actions.publishStaffSessionReport({ sessionId: "se1" })).notified, false);
  await again.runAfter();
  assert.ok(!names(again.world).includes("notify"));
  // 진행 중 수업은 보낼 수 없다
  const live = makeWorld({ session: { status: "IN_PROGRESS" } });
  assert.equal((await live.actions.publishStaffSessionReport({ sessionId: "se1" })).ok, false);
});

// ── ③ 화면·조회(소스) ─────────────────────────────────────────────────

test("수업 주소: 완료한 수업도 연다 — 시작 전 수업만 홈으로 보내고, 원장·부원장 여부는 서버가 정한다", () => {
  const page = read("src/app/staff/sessions/[sessionId]/page.tsx");
  assert.match(page, /if \(session\.status !== "IN_PROGRESS" && session\.status !== "COMPLETED"\) redirect\("\/staff"\);/);
  assert.match(page, /editUnlimited=\{access\.canAccessAllClasses\}/);
  const workspace = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  assert.match(workspace, /if \(props\.session\.status === "COMPLETED"\) \{[\s\S]{0,200}return <CompletedSessionPanel [^>]*embedded=\{props\.embedded === true\} editUnlimited=\{props\.editUnlimited === true\} \/>;/);
});

test("완료한 수업 본문(다시 보기): 타이머·수업 종료·시작 취소·전체 출석이 없고, 기간 판정은 서버와 같은 함수", () => {
  const panels = read("src/components/staff/LessonWorkspacePanels.tsx");
  const done = panels.slice(panels.indexOf("export function CompletedSessionPanel"));
  const roster = read("src/components/staff/CompletedAttendanceRoster.tsx");
  for (const source of [done, roster]) {
    assert.doesNotMatch(source, /formatElapsed|수업 경과|completeClassSession|cancelClassSession|수업 종료 확인|markAllPresent|clearStaffAttendance|SessionMediaBar|popstate/);
  }
  assert.match(done, /const editable = staffSessionEditWindow\(\{ status: session\.status, sessionYmd: session\.sessionYmd, todayYmd: session\.todayYmd, unlimited: editUnlimited \}\)\.ok;/);
  // 머리: 수업 주소에서만 «완료한 수업 · 날짜 시간», 발행 상태는 양쪽 모두
  assert.match(done, /\{!embedded && \(\s*<section aria-label="완료한 수업"/);
  assert.match(done, /완료한 수업 · \{kstLabel\(session\.sessionYmd\)\} \{session\.startTime\}~\{session\.endTime\}/);
  assert.match(done, /\{published \? "학부모에게 보냄" : "아직 안 보냄"\}/);
  // 수업 주소에서는 지난 수업 목록으로 돌아가는 링크
  assert.match(done, /\{!embedded && \(\s*<Link href="\/staff\/sessions" className="inline-flex min-h-11[^"]*">← 지난 수업<\/Link>/);
  // 기간이 지나면 읽기 전용 + 한 줄, 안 보낸 수업만 «학부모에게 보내기»
  assert.match(done, /\{!editable && <p role="status"[^>]*>\{STAFF_EDIT_EXPIRED_MESSAGE\}<\/p>\}/);
  assert.match(done, /\{editable && !published && \(\s*<button[^>]*onClick=\{\(\) => void publishToParents\(\)\}[^>]*>/);
  assert.match(done, /<LessonTextEditor [^>]*disabled=\{!editable\} \/>/);
  assert.match(done, /<textarea value=\{memo\} disabled=\{!editable\}/);
  // 메모는 자동 저장하지 않는다(버튼으로만)
  assert.doesNotMatch(done, /setTimeout|onBlur/);
  // 출결: 고칠 수 있는 줄만 버튼, 같은 버튼을 다시 눌러도 미확인으로 되돌리지 않는다, 미리 보기 뒤 한 번 확인하고 저장
  assert.match(roster, /const correctable = editable && !illnessAbsence && canCorrectAfterCompletion\(rosterKindOf\(student, Boolean\(session\.sessionDateId\)\)\);/);
  assert.match(roster, /if \(!editable \|\| savingRows\[rowId\] \|\| target\.status === status\) return;/);
  const fn = roster.slice(roster.indexOf("async function correctAttendance"), roster.indexOf("return (\n    <ul"));
  assert.ok(fn.indexOf("previewStaffAttendanceCorrection(") < fn.indexOf("window.confirm(question)"));
  assert.ok(fn.indexOf("window.confirm(question)") < fn.indexOf("saveStaffAttendance("));
  assert.equal((fn.match(/window\.confirm\(/g) ?? []).length, 1);
  assert.match(roster, /\{editable && <span[^>]*>원장님께 요청<\/span>\}/);
  // 화면 규칙: 이모지 없음, 굵기는 400~700 만
  for (const source of [done, roster, read("src/app/staff/sessions/page.tsx")]) {
    assert.doesNotMatch(source, /font-extrabold|font-black|[\u{1F300}-\u{1FAFF}]/u);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, "색은 토큰만");
  }
});

test("진행 중 수업 화면은 그대로다(회귀) — 타이머·수업 종료·시작 취소·전체 출석·취소 토글", () => {
  const workspace = read("src/app/staff/sessions/[sessionId]/SessionInProgressClient.tsx");
  const live = workspace.slice(workspace.indexOf("function LiveSessionWorkspace"));
  assert.match(live, /<button id="session-end" type="button" disabled=\{endLocked\} onClick=\{openEndConfirm\}/);
  assert.match(live, /aria-label=\{`수업 경과 \$\{formatElapsed\(elapsed\)\}`\}/);
  assert.match(live, /\{\(bulkSplit\.targets\.length > 0 \|\| bulkBusy\) && \(/);
  assert.match(live, /if \(target\.status === status && absenceReason === undefined && !retryAfterError\) return clearAttendance\(target\);/);
  assert.match(live, /수업 시작 취소 \(시작 전으로 되돌리기\)/);
  assert.match(live, /const timer = window\.setTimeout\(\(\) => void persistMemo\(memo\), 900\);/, "진행 중 메모 자동 저장은 그대로");
  // 진행 중 화면에는 다시 보기 전용 기능이 섞이지 않는다
  assert.doesNotMatch(live, /previewStaffAttendanceCorrection|publishStaffSessionReport/);
});

test("지난 수업 목록: 완료한 수업·최근 14일·«열 수 있는 수업»만, 값은 바인딩으로", () => {
  const query = read("src/lib/staff-past-sessions.ts");
  assert.match(query, /WHERE s\.status = 'COMPLETED'\s+--[^\n]*\n\s+AND s\.date >= NOW\(\) - interval '\$\{STAFF_PAST_SESSION_LIST_DAYS \+ 2\} days'\s+AND \$\{pastSessionListRangeSql\("s"\)\}/);
  // 날짜 범위 SQL = 순수 규칙과 같은 상수(오늘 포함 14일). 수업일은 무tz 칼럼 «두 번» 변환, 오늘은 DB 시계
  assert.match(query, /return `\(\$\{day\} <= \$\{TODAY_KST_SQL\} AND \$\{day\} > \$\{TODAY_KST_SQL\} - \$\{STAFF_PAST_SESSION_LIST_DAYS\}\)`;/);
  assert.match(query, /const day = sessionKstDateSql\("s"\);/);
  // 범위: 원장·부원장 전체 / 내 담당 반 / 오늘 대타 반의 오늘 수업 / 특강은 기록의 코치가 나
  assert.match(query, /\$1::boolean = true\s+OR \(s\."specialProgramSessionDateId" IS NULL AND s\."classId" = ANY\(\$2::text\[\]\)\)\s+OR \(s\."specialProgramSessionDateId" IS NULL AND s\."classId" = ANY\(\$3::text\[\]\) AND \$\{day\} = \$\{TODAY_KST_SQL\}\)\s+OR \(s\."specialProgramSessionDateId" IS NOT NULL AND \$4::text IS NOT NULL AND s\."coachId" = \$4::text\)/);
  assert.match(query, /access\.canAccessAllClasses,\s+classIds,\s+substituteIds,\s+access\.coachId,/);
  assert.match(query, /getAccessibleClassIds\(access\), getSubstituteClassIds\(access, todayKst\(\)\)/);
  assert.doesNotMatch(query, /\$\{access|\$\{classIds|findMany|\.toISOString\(\)\.slice/);
  // 화면: 날짜 묶음 한 줄 행, 줄이 그 수업으로 가는 링크, 학생 수는 선생님 화면 안에서만
  const page = read("src/app/staff/sessions/page.tsx");
  assert.match(page, /const groups = groupPastSessions\(await getStaffPastSessions\(\)\);/);
  assert.match(page, /href=\{`\/staff\/sessions\/\$\{row\.sessionId\}`\}/);
  assert.match(page, /\{!row\.hasFeed && <span[^>]*>피드 없음<\/span>\}/);
  assert.match(page, /className="flex min-h-14 items-center/);
  assert.match(page, /if \(!staff\.roles\.teacher\) redirect\(DRIVER_ENTRY_PATH\);/);
  // 홈에 입구
  assert.match(read("src/app/staff/StaffHomeClient.tsx"), /<Link href="\/staff\/sessions"[^>]*>\s*<span>지난 수업<\/span>/);
  // 아래 탭은 목록에서는 보이고(수업 주소에서만 숨는다)
  assert.match(read("src/app/staff/StaffBottomNav.tsx"), /pathname\.startsWith\("\/staff\/sessions\/"\)/);
});

test("결석 알림 스윕은 완료 뒤 정정한 출결을 건너뛴다 — 정정 기록의 이름이 저장 쪽과 같다", () => {
  const sweep = read("src/lib/regular/absence-parent-notice-sweep.ts");
  // 보안 검수 LOW 1: 건너뛰는 것은 그 출결의 «마지막» 정정 기록이 «결석이 아니던 것 → 결석»일 때만(수업 중 원래 결석이던 알림은 막지 않는다)
  assert.match(sweep, /AND NOT EXISTS \(SELECT 1 FROM "OperationsAuditLog" al\s+WHERE al\.action = \$5 AND al\."detailsJson"->>'attendanceId' = a\.id\s+AND al\."detailsJson"->>'after' = 'ABSENT'\s+AND al\."detailsJson"->>'before' <> 'ABSENT'[\s\S]{0,260}AND al\."createdAt" >= \(a\."updatedAt" AT TIME ZONE 'UTC'\)\s+AND NOT EXISTS \(SELECT 1 FROM "OperationsAuditLog" later\s+WHERE later\.action = \$5 AND later\."detailsJson"->>'attendanceId' = a\.id\s+AND later\."createdAt" > al\."createdAt"\)\)/);
  assert.match(sweep, /today, ABSENCE_NOTICE_DELAY_MINUTES, ABSENCE_NOTICE_EVENT, limit, STAFF_SESSION_REVIEW_AUDIT_ACTION,/);
  assert.equal(rules.STAFF_SESSION_REVIEW_AUDIT_ACTION, "STAFF_SESSION_REVIEW_EDIT");
  // 수정 기록 저장은 본문 없이 항목·전/후 상태만 받는 한 곳
  const actions = read("src/app/actions/staff-sessions.ts");
  assert.match(actions, /async function recordReviewEdit\(actorUserId: string, details: Record<string, string \| boolean \| null>\)/);
  assert.match(actions, /VALUES \(gen_random_uuid\(\)::text, \$1, 'STAFF', \$2, \$3::jsonb\)/);
});
