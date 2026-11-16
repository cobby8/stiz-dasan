import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 수업 미처리 장치 1단계(2026-11-17) — 사실 조회·화면 조립·휴강 저장을 가짜 DB 로 «실제로 실행»한다.
// 실제 DB·실제 시계는 쓰지 않는다. «지금»·«오늘»은 전부 여기서 넣는다.

const query = await loadTsModule("src/lib/class-nudge/boardQuery.ts");
const board = await loadTsModule("src/lib/class-nudge/board.ts");
const store = await loadTsModule("src/lib/class-nudge/cancelStore.ts");
const rules = await loadTsModule("src/lib/class-nudge/rules.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const feedRules = await loadTsModule("src/lib/feed/rules.ts");
const makeup = await loadTsModule("src/lib/makeup/makeup-attendance.ts");
const visibility = await loadTsModule("src/lib/studentVisibility.ts");
const substitute = await loadTsModule("src/lib/staff/classSubstitute.ts");

const DAY = "2026-11-17"; // 화요일
const at = (hm) => kst.kstAt(DAY, hm);
const squash = (sql) => String(sql).replace(/\s+/g, " ").trim();

/** 조회 4종을 SQL 글자의 표식으로 가려 준비된 행을 돌려주는 가짜 db. 받은 SQL·값은 calls 에 남긴다. */
function readDb({ regular = [], seasonal = [], cancels = [], assignees = [], cancelError = null } = {}) {
  const calls = [];
  return {
    calls,
    async $executeRawUnsafe() { throw new Error("조회 함수가 쓰기를 보냈다"); },
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes(`"hasSeasonalToday"`)) { calls.push({ kind: "regular", sql, values }); return regular; }
      if (sql.includes("WITH occ AS")) { calls.push({ kind: "seasonal", sql, values }); return seasonal; }
      if (sql.includes(`FROM "ClassDayCancel"`)) {
        calls.push({ kind: "cancels", sql, values });
        if (cancelError) throw cancelError;
        return cancels;
      }
      if (sql.includes(`"ClassSubstitute" cs`)) { calls.push({ kind: "assignees", sql, values }); return assignees; }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
  };
}

const regularRow = (over = {}) => ({
  classId: "c1", name: "화4 초등 저학년", startTime: "16:00", endTime: "17:00", capacity: 12,
  sessionId: null, sessionStatus: null,
  enrolledCount: 8, enrolledUnmarked: 8, makeupCount: 0, makeupUnmarked: 0, hasSeasonalToday: false,
  ...over,
});

const seasonalRow = (over = {}) => ({
  classId: "sc1", name: "겨울특강 A", sessionDateId: "sd1",
  seatCount: 6, seatUnmarked: 6, seatUnrecorded: 6,
  startMs: BigInt(at("10:00")), endMs: BigInt(at("11:30")), startTime: "10:00", endTime: "11:30",
  sessionId: null, sessionStatus: null, coachName: "박코치", coachUserId: "u-park",
  ...over,
});

// ── 정규 조회 ────────────────────────────────────────────────────────────────

test("정규: 인원 = 수강생 + 보강 온 아이, 미확인도 둘을 더한다", async () => {
  const db = readDb({ regular: [regularRow({ enrolledCount: 8, enrolledUnmarked: 3, makeupCount: 2, makeupUnmarked: 1, sessionId: "s1", sessionStatus: "IN_PROGRESS" })] });
  const [fact] = await query.loadRegularClassDayFacts(db, DAY);
  assert.equal(fact.kind, "REGULAR");
  assert.equal(fact.rosterCount, 10);
  assert.equal(fact.unmarkedCount, 4);
  assert.equal(fact.sessionStatus, "IN_PROGRESS");
  assert.equal(fact.capacity, 12);
});

test("정규: 날짜와 요일 글자를 자리표시자로 넘긴다(요일은 달력 숫자로 — 2026-11-17 은 Tue)", async () => {
  const db = readDb({ regular: [] });
  await query.loadRegularClassDayFacts(db, DAY);
  assert.deepEqual(db.calls[0].values, [DAY, "Tue"]);
  // 자정 직후·월말·연말·윤년도 달력 요일 그대로
  for (const [ymd, key] of [["2026-11-30", "Mon"], ["2026-12-31", "Thu"], ["2027-01-01", "Fri"], ["2028-02-29", "Tue"]]) {
    const d = readDb();
    await query.loadRegularClassDayFacts(d, ymd);
    assert.deepEqual(d.calls[0].values, [ymd, key]);
  }
});

test("정규: 그날 특강 회차가 연결된 반은 버린다(그날은 특강 회차가 출석부를 대신한다)", async () => {
  const db = readDb({ regular: [regularRow(), regularRow({ classId: "c2", name: "특강 연결 반", hasSeasonalToday: true })] });
  const facts = await query.loadRegularClassDayFacts(db, DAY);
  assert.deepEqual(facts.map((f) => f.classId), ["c1"]);
});

test("정규: COUNT 가 bigint·글자로 와도 number 로 바뀐다(캐시가 JSON 으로 못 바꾸는 값 금지)", async () => {
  const db = readDb({ regular: [regularRow({ enrolledCount: 8n, enrolledUnmarked: "2", makeupCount: null, makeupUnmarked: undefined, capacity: 12n })] });
  const [fact] = await query.loadRegularClassDayFacts(db, DAY);
  assert.equal(fact.rosterCount, 8);
  assert.equal(fact.unmarkedCount, 2);
  assert.equal(fact.capacity, 12);
  assert.doesNotThrow(() => JSON.stringify(fact));
});

test("틀린 날짜는 DB 에 묻지 않고 빈 목록", async () => {
  const db = readDb({ regular: [regularRow()] });
  for (const bad of ["", "2026-02-30", "2026-11-17T00:00:00Z", "오늘"]) {
    assert.deepEqual(await query.loadRegularClassDayFacts(db, bad), []);
    assert.deepEqual(await query.loadSeasonalClassDayFacts(db, bad), []);
    assert.deepEqual(await query.loadClassDayCancels(db, bad), []);
    assert.deepEqual(await query.loadClassDayAssignees(db, bad, ["c1"]), []);
  }
  assert.equal(db.calls.length, 0);
});

// ── SQL 조각 고정 ─────────────────────────────────────────────────────────────

test("정규 SQL: 수업일 비교는 «두 번» 변환 조각, 보강·병합 제외는 기존 함수 그대로", async () => {
  const db = readDb();
  await query.loadRegularClassDayFacts(db, DAY);
  const sql = squash(db.calls[0].sql);
  assert.ok(sql.includes(squash(`${feedRules.sessionKstDateSql("se")} = $1::date`)), "sessionKstDateSql 조각이 없다");
  // 옛 기록 모양에서 하루 밀리는 비교 금지
  assert.doesNotMatch(sql, /se\.date::date|se\.date\s*=\s*\$1/);
  assert.ok(sql.includes(squash(makeup.makeupOnClassDateSql("ms", "c.id", "$1"))), "makeupOnClassDateSql 조각이 없다");
  assert.ok(sql.includes(visibility.notMergedStudent("st")), "병합 학생 제외가 없다");
  assert.ok(sql.includes(`se."specialProgramSessionDateId" IS NULL`), "특강 기록을 정규 기록으로 읽는다");
  // 같은 반·같은 날 기록이 둘이면 키 있는 것 → 먼저 만든 것 하나만
  assert.ok(sql.includes(`ORDER BY (se."sessionKey" IS NULL), se."createdAt", se.id LIMIT 1`));
  // 체험 아이는 종료 조건에 없어 세지 않는다
  assert.doesNotMatch(sql, /TrialLead/);
  // 휴강 표는 여기에 묶지 않는다(표가 없을 때 현황 전체가 죽지 않게)
  assert.doesNotMatch(sql, /ClassDayCancel/);
  // 사용자 입력을 SQL 에 이어 붙이지 않는다
  assert.ok(!sql.includes(DAY));
});

test("미확인 셈의 수강 조건 = 선생님 «수업 종료» 조건과 같은 글자(한쪽만 바뀌면 깨진다)", () => {
  const source = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
  const from = source.indexOf("export async function completeClassSession");
  assert.ok(from > 0, "completeClassSession 을 찾지 못했다");
  const body = squash(source.slice(from, from + 6000));
  // 정규 수강생: 활성 + 개시일이 수업일 이전
  assert.ok(body.includes(squash(query.activeEnrollmentOnDateSql("e", "$3"))), "수강 조건이 종료 쪽과 다르다");
  // 보강 온 아이: 같은 함수·병합 제외
  assert.ok(body.includes('${makeupOnClassDateSql("ms", "$1", "$3")}'), "종료 쪽이 makeupOnClassDateSql 을 쓰지 않는다");
  assert.ok(body.includes('${notMergedStudent("st")}'), "종료 쪽이 병합 제외를 쓰지 않는다");
  // 특강: 좌석 SCHEDULED 중 출결 칸이 빈 것
  assert.ok(body.includes(`e.status = 'SCHEDULED'`) && body.includes(`e."attendanceStatus" IS NULL`));
});

test("특강 SQL: timestamptz 는 한 번만 변환, 취소 상품·보관 시즌 제외, 좌석 조건은 종료 쪽과 같다", async () => {
  const db = readDb();
  await query.loadSeasonalClassDayFacts(db, DAY);
  const sql = squash(db.calls[0].sql);
  assert.deepEqual(db.calls[0].values, [DAY]);
  assert.ok(sql.includes(`(sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date`));
  assert.doesNotMatch(sql, /"startsAt" AT TIME ZONE 'UTC'/);
  assert.ok(sql.includes(`o.status <> 'CANCELLED'`));
  assert.ok(sql.includes(`season.status <> 'ARCHIVED'`));
  assert.ok(sql.includes(`i.status = 'APPROVED'`));
  assert.ok(sql.includes(`ed.status = 'SCHEDULED'`));
  assert.ok(sql.includes(`ed."attendanceStatus" IS NULL`));
  // 담당 = 기록의 코치 → 없으면 상품 담당 강사
  assert.ok(sql.includes(`COALESCE(s."coachId", occ."instructorId")`));
});

// ── 특강 조회 ────────────────────────────────────────────────────────────────

test("특강: 시각은 bigint → number, 인원은 좌석 수", async () => {
  const db = readDb({ seasonal: [seasonalRow()] });
  const [fact] = await query.loadSeasonalClassDayFacts(db, DAY);
  assert.equal(fact.kind, "SEASONAL");
  assert.equal(fact.startMs, at("10:00"));
  assert.equal(fact.endMs, at("11:30"));
  assert.equal(typeof fact.startMs, "number");
  assert.equal(fact.rosterCount, 6);
  assert.equal(fact.sessionDateId, "sd1");
  assert.doesNotThrow(() => JSON.stringify(fact));
});

test("특강: 끝이 시작보다 이르면 끝만 보류", async () => {
  const db = readDb({ seasonal: [seasonalRow({ endMs: BigInt(at("09:00")) })] });
  const [fact] = await query.loadSeasonalClassDayFacts(db, DAY);
  assert.equal(fact.startMs, at("10:00"));
  assert.equal(fact.endMs, null);
});

test("특강 미확인: 진행 중이면 종료 조건과 같은 좌석 셈, 그 밖은 «좌석도 출결 기록도 없음»", async () => {
  // 관리자 출결 화면은 특강 저장 때 출결 기록만 쓰고 좌석 칸은 비워 둔다 → 좌석 칸만 보면 전원 미확인으로 뜬다
  const adminSaved = { seatCount: 6, seatUnmarked: 6, seatUnrecorded: 0 };
  const planned = await query.loadSeasonalClassDayFacts(readDb({ seasonal: [seasonalRow({ ...adminSaved, sessionId: "s1", sessionStatus: "PLANNED" })] }), DAY);
  assert.equal(planned[0].unmarkedCount, 0);
  const running = await query.loadSeasonalClassDayFacts(readDb({ seasonal: [seasonalRow({ ...adminSaved, sessionId: "s1", sessionStatus: "IN_PROGRESS" })] }), DAY);
  assert.equal(running[0].unmarkedCount, 6);
  const none = await query.loadSeasonalClassDayFacts(readDb({ seasonal: [seasonalRow()] }), DAY);
  assert.equal(none[0].unmarkedCount, 6);
});

// ── 휴강 목록·표 없음 방어 ────────────────────────────────────────────────────

test("휴강 목록: 날짜 하나로 읽고 모양을 다듬는다", async () => {
  const db = readDb({ cancels: [
    { id: "x1", date: DAY, classId: "c1", kind: "REGULAR", startTime: "", reason: null },
    { id: "x2", date: DAY, classId: "sc1", kind: "SEASONAL", startTime: "10:00", reason: "강사 사정" },
  ] });
  const rows = await query.loadClassDayCancels(db, DAY);
  assert.deepEqual(db.calls[0].values, [DAY]);
  assert.deepEqual(rows.map((r) => [r.classId, r.kind, r.startTime, r.reason]), [["c1", "REGULAR", "", null], ["sc1", "SEASONAL", "10:00", "강사 사정"]]);
});

test("표가 아직 없으면(42P01) «휴강 없음» — 세 가지 오류 모양 모두", async () => {
  const shapes = [
    { code: "42P01" },
    { meta: { code: "42P01" } },
    new Error('relation "ClassDayCancel" does not exist'),
    new Error('relation "public.ClassDayCancel" does not exist'),
  ];
  for (const cancelError of shapes) {
    assert.equal(query.isMissingCancelTable(cancelError), true);
    assert.deepEqual(await query.loadClassDayCancels(readDb({ cancelError }), DAY), []);
  }
});

test("그 밖의 오류는 삼키지 않고 던진다", async () => {
  for (const cancelError of [{ code: "42703" }, { meta: { code: "08006" } }, new Error("connection refused"), new Error('relation "Other" does not exist')]) {
    assert.equal(query.isMissingCancelTable(cancelError), false);
    await assert.rejects(() => query.loadClassDayCancels(readDb({ cancelError }), DAY));
  }
  assert.equal(query.isMissingCancelTable(null), false);
});

// ── 담당 ─────────────────────────────────────────────────────────────────────

test("담당 SQL: 권한 판정(getAccessibleClassIds)과 같은 갈래 + 그날 대타", async () => {
  const db = readDb();
  await query.loadClassDayAssignees(db, DAY, ["c1", "c2", "c1", ""]);
  const call = db.calls[0];
  assert.deepEqual(call.values, [["c1", "c2"], DAY]); // 중복·빈 값 제거, 배열 한 번
  const sql = squash(call.sql);
  const access = squash(readFileSync("src/lib/staff-class-access.ts", "utf8"));
  // 시간표 칸 3곳(권한 판정이 보는 표와 같은 표·같은 연결 칼럼)
  for (const [table, alias, on] of [
    ["ScheduleSlot", "ss", `ss."slotKey" = c."slotKey"`],
    ["ClassSlotOverride", "cso", `cso."slotKey" = c."slotKey"`],
    ["CustomClassSlot", "ccs", `ccs.id = c."slotKey"`],
  ]) {
    assert.ok(sql.includes(`"${table}" ${alias} WHERE ${on}`), `담당 조회에 ${table} 갈래가 없다`);
    assert.ok(access.includes(`"${table}" ${alias} ON ${on}`), `권한 판정의 ${table} 갈래가 바뀌었다`);
  }
  // 시간표 칸이 없는 옛 반만 담당 강사(User)로
  assert.ok(sql.includes(`c."slotKey" IS NOT NULL`) && sql.includes(`c."slotKey" IS NULL`));
  assert.ok(sql.includes(`u.id = c."instructorId"`));
  assert.ok(access.includes(`c."slotKey" IS NULL AND c."instructorId" = $2`));
  // 대타는 그 날짜만, 선생님 역할을 판정 시점에 다시 본다
  assert.ok(sql.includes(squash(substitute.SUBSTITUTE_TEACHER_SQL)));
  assert.ok(sql.includes(`cs.date = $2`));
});

test("담당: 반이 없으면 묻지 않는다, 이름·역할을 다듬는다", async () => {
  const empty = readDb();
  assert.deepEqual(await query.loadClassDayAssignees(empty, DAY, []), []);
  assert.equal(empty.calls.length, 0);
  const db = readDb({ assignees: [
    { classId: "c1", userId: "u1", name: "김코치", role: "COACH" },
    { classId: "c1", userId: null, name: "  ", role: "COACH" },
    { classId: "c1", userId: "u2", name: "박코치", role: "SUBSTITUTE" },
  ] });
  const rows = await query.loadClassDayAssignees(db, DAY, ["c1"]);
  assert.deepEqual(rows.map((r) => [r.userId, r.name, r.role]), [["u1", "김코치", "COACH"], [null, "이름 없음", "COACH"], ["u2", "박코치", "SUBSTITUTE"]]);
});

// ── 조회 묶음: 쿼리 수·순서 ───────────────────────────────────────────────────

test("조회는 반 수와 무관하게 4번, 한꺼번에 쏘지 않고 차례로", async () => {
  for (const count of [1, 30]) {
    const regular = Array.from({ length: count }, (_, i) => regularRow({ classId: `c${i}`, name: `반${i}` }));
    let running = 0;
    let maxRunning = 0;
    const inner = readDb({ regular, seasonal: [seasonalRow()] });
    const db = {
      calls: inner.calls,
      $executeRawUnsafe: inner.$executeRawUnsafe,
      async $queryRawUnsafe(sql, ...values) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setImmediate(resolve));
        try { return await inner.$queryRawUnsafe(sql, ...values); } finally { running -= 1; }
      },
    };
    const facts = await query.loadClassDayDbFacts(db, DAY);
    assert.deepEqual(db.calls.map((c) => c.kind), ["regular", "seasonal", "cancels", "assignees"]);
    assert.equal(maxRunning, 1, "조회가 동시에 나갔다");
    assert.equal(facts.regular.length, count);
  }
});

test("휴강 표가 없어도 정규·특강·담당 조회는 그대로 돈다", async () => {
  const db = readDb({ regular: [regularRow()], seasonal: [seasonalRow()], cancelError: { code: "42P01" }, assignees: [{ classId: "c1", userId: "u1", name: "김코치", role: "COACH" }] });
  const facts = await query.loadClassDayDbFacts(db, DAY);
  assert.equal(facts.regular.length, 1);
  assert.equal(facts.seasonal.length, 1);
  assert.deepEqual(facts.cancels, []);
  assert.equal(facts.assignees.length, 1);
});

// ── 화면 조립(사실 + 지금 시각) ───────────────────────────────────────────────

function factsOf(over = {}) {
  return {
    dateYmd: DAY, holiday: null, holidayKnown: true,
    regular: [], seasonal: [], cancels: [], assignees: [],
    ...over,
  };
}
const regularFact = (over = {}) => ({
  kind: "REGULAR", classId: "c1", name: "화4 초등 저학년", startTime: "16:00", endTime: "17:00", capacity: 12,
  sessionId: null, sessionStatus: null, rosterCount: 8, unmarkedCount: 8, ...over,
});
const seasonalFact = (over = {}) => ({
  kind: "SEASONAL", classId: "sc1", name: "겨울특강 A", sessionDateId: "sd1",
  startMs: at("10:00"), endMs: at("11:30"), startTime: "10:00", endTime: "11:30",
  sessionId: null, sessionStatus: null, rosterCount: 6, unmarkedCount: 6, coachName: "박코치", coachUserId: "u-park", ...over,
});

test("같은 사실이라도 «지금»에 따라 판정이 달라진다(사실은 캐시, 판정은 매번 새 시각)", () => {
  const facts = factsOf({ regular: [regularFact()] });
  assert.equal(board.buildClassDayBoard(facts, at("15:00")).rows[0].status.state, "UPCOMING");
  assert.equal(board.buildClassDayBoard(facts, at("16:05")).rows[0].status.nudge, "NONE");
  assert.equal(board.buildClassDayBoard(facts, at("16:10")).rows[0].status.nudge, "DUE");
  assert.equal(board.buildClassDayBoard(facts, at("16:30")).rows[0].status.nudge, "ESCALATE");
  // 임계값을 넘기면 그 값으로
  assert.equal(board.buildClassDayBoard(facts, at("16:05"), { startGraceMin: 5, endGraceMin: 5, escalateMin: 15 }).rows[0].status.nudge, "DUE");
});

test("줄의 열쇠·주소는 출결 화면 형식(date + lesson)", () => {
  const built = board.buildClassDayBoard(factsOf({ regular: [regularFact()], seasonal: [seasonalFact()] }), at("09:00"));
  const byKey = Object.fromEntries(built.rows.map((r) => [r.key, r]));
  assert.equal(byKey["regular:c1"].href, `/admin/attendance?date=${DAY}&lesson=regular:c1`);
  assert.equal(byKey["seasonal:sd1"].href, `/admin/attendance?date=${DAY}&lesson=seasonal:sd1`);
  assert.equal(built.todayLabel, "11/17(화)");
  assert.equal(built.dateYmd, DAY);
});

test("휴무: 정규 줄은 목록에서 빠지고, 특강 줄과 이미 시작한 정규 수업은 남는다", () => {
  const facts = factsOf({
    holiday: { title: "학원 휴무" },
    regular: [regularFact(), regularFact({ classId: "c2", name: "수업 중인 반", sessionId: "s2", sessionStatus: "IN_PROGRESS", unmarkedCount: 3 })],
    seasonal: [seasonalFact()],
  });
  const built = board.buildClassDayBoard(facts, at("16:30"));
  assert.deepEqual(built.rows.map((r) => r.key).sort(), ["regular:c2", "seasonal:sd1"]);
  assert.deepEqual(built.holiday, { title: "학원 휴무" });
  assert.equal(built.summary.off, 1);
  // 특강 회차는 연간일정 휴무를 걸지 않는다(시작 시각이 지났으면 그대로 미처리)
  assert.equal(built.rows.find((r) => r.key === "seasonal:sd1").status.state, "NOT_STARTED");
});

test("수강생 0명 반은 목록에서 숨는다", () => {
  const built = board.buildClassDayBoard(factsOf({ regular: [regularFact({ rosterCount: 0, unmarkedCount: 0 }), regularFact({ classId: "c2", name: "있는 반" })] }), at("16:30"));
  assert.deepEqual(built.rows.map((r) => r.key), ["regular:c2"]);
});

test("휴강 매칭: 정규는 시작 시각 칸이 빈 행, 특강은 (반, 시작 시각)", () => {
  const facts = factsOf({
    regular: [regularFact(), regularFact({ classId: "c2", name: "다른 반" })],
    seasonal: [seasonalFact(), seasonalFact({ sessionDateId: "sd2", startMs: at("13:00"), endMs: at("14:30"), startTime: "13:00", endTime: "14:30" })],
    cancels: [
      { id: "x1", date: DAY, classId: "c1", kind: "REGULAR", startTime: "", reason: "체육관 공사" },
      { id: "x2", date: DAY, classId: "sc1", kind: "SEASONAL", startTime: "13:00", reason: null },
      // 종류가 다른 행은 서로 걸리지 않는다
      { id: "x3", date: DAY, classId: "c2", kind: "SEASONAL", startTime: "16:00", reason: null },
    ],
  });
  const built = board.buildClassDayBoard(facts, at("18:00"));
  const state = Object.fromEntries(built.rows.map((r) => [r.key, r.status.state]));
  assert.equal(state["regular:c1"], "CANCELLED");
  assert.equal(state["regular:c2"], "NOT_STARTED");
  assert.equal(state["seasonal:sd1"], "NOT_STARTED");
  assert.equal(state["seasonal:sd2"], "CANCELLED");
  // 휴강 줄은 «휴강 취소» 버튼이 있어야 해서 목록에 남고 사유도 싣는다
  assert.deepEqual(built.rows.find((r) => r.key === "regular:c1").cancel, { reason: "체육관 공사" });
  assert.equal(built.rows.find((r) => r.key === "regular:c2").cancel, null);
});

test("휴강 표시가 있어도 실제로 시작한 수업은 진행 중으로 보인다", () => {
  const facts = factsOf({
    regular: [regularFact({ sessionId: "s1", sessionStatus: "IN_PROGRESS", unmarkedCount: 2 })],
    cancels: [{ id: "x1", date: DAY, classId: "c1", kind: "REGULAR", startTime: "", reason: null }],
  });
  assert.equal(board.buildClassDayBoard(facts, at("16:30")).rows[0].status.state, "IN_PROGRESS");
});

test("정렬: 미처리가 맨 위, 나머지는 시각순", () => {
  const facts = factsOf({
    regular: [
      regularFact({ classId: "done", name: "끝난 반", startTime: "14:00", endTime: "15:00", sessionId: "s1", sessionStatus: "COMPLETED", unmarkedCount: 0 }),
      regularFact({ classId: "late", name: "밀린 반", startTime: "17:00", endTime: "18:00" }),
      regularFact({ classId: "next", name: "다음 반", startTime: "19:00", endTime: "20:00" }),
    ],
  });
  const built = board.buildClassDayBoard(facts, at("17:40"));
  assert.deepEqual(built.rows.map((r) => r.classId), ["late", "done", "next"]);
  assert.deepEqual(built.summary, { open: 1, inProgress: 0, done: 1, upcoming: 1, off: 0 });
});

test("담당 묶기: 원래 담당 먼저·대타 뒤, 계정 없는 코치는 linked=false, 같은 사람은 한 번", () => {
  const facts = factsOf({
    regular: [regularFact(), regularFact({ classId: "c2", name: "담당 없는 반" })],
    seasonal: [seasonalFact(), seasonalFact({ sessionDateId: "sd2", startTime: "13:00", startMs: at("13:00"), endMs: at("14:00"), coachName: "외부 강사", coachUserId: null }), seasonalFact({ sessionDateId: "sd3", startTime: "15:00", startMs: at("15:00"), endMs: at("16:00"), coachName: null })],
    assignees: [
      { classId: "c1", userId: "u2", name: "박코치", role: "SUBSTITUTE" },
      { classId: "c1", userId: "u1", name: "김코치", role: "COACH" },
      { classId: "c1", userId: "u1", name: "김코치", role: "INSTRUCTOR" },
      { classId: "c1", userId: null, name: "최코치", role: "COACH" },
      { classId: "other", userId: "u9", name: "다른 반 코치", role: "COACH" },
    ],
  });
  const built = board.buildClassDayBoard(facts, at("09:00"));
  const row = (key) => built.rows.find((r) => r.key === key);
  assert.deepEqual(row("regular:c1").assignees, [
    { name: "김코치", substitute: false, linked: true },
    { name: "최코치", substitute: false, linked: false },
    { name: "박코치", substitute: true, linked: true },
  ]);
  assert.deepEqual(row("regular:c2").assignees, []);
  assert.deepEqual(row("seasonal:sd1").assignees, [{ name: "박코치", substitute: false, linked: true }]);
  assert.deepEqual(row("seasonal:sd2").assignees, [{ name: "외부 강사", substitute: false, linked: false }]);
  assert.deepEqual(row("seasonal:sd3").assignees, []);
  // 화면 자료에는 계정 id 를 싣지 않는다
  assert.doesNotMatch(JSON.stringify(built), /"userId"|u-park|"u1"/);
});

test("연간일정을 못 읽었으면 휴무 판정 없이 보이고 표식을 싣는다", () => {
  const built = board.buildClassDayBoard(factsOf({ holidayKnown: false, regular: [regularFact()] }), at("16:30"));
  assert.equal(built.holidayKnown, false);
  assert.equal(built.rows[0].status.state, "NOT_STARTED");
});

// ── 휴강 저장(가짜 DB) ────────────────────────────────────────────────────────

/** 휴강 표·감사 기록·수업 기록을 흉내 내는 가짜 db. cancelStore 가 보내는 SQL 만 이해한다. */
function writeDb({ classes = { c1: { name: "화4 초등 저학년", dayOfWeek: "Tue" }, sc1: { name: "겨울특강 A", dayOfWeek: "Seasonal" } }, occurrences = ["sc1|10:00"], busyRegular = [], busySeasonal = [], missingTable = false } = {}) {
  const cancels = [];
  const audits = [];
  const sqls = [];
  let seq = 0;
  const missing = () => Object.assign(new Error('relation "ClassDayCancel" does not exist'), { code: "P2010", meta: { code: "42P01" } });
  return {
    cancels, audits, sqls,
    async $executeRawUnsafe(sql, ...values) {
      sqls.push(sql);
      if (sql.includes(`INSERT INTO "OperationsAuditLog"`)) {
        const [action, actorUserId, details] = values;
        audits.push({ action, actorUserId, actorType: /'ADMIN'/.test(sql) ? "ADMIN" : "?", details: JSON.parse(details) });
        return 1;
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
    async $queryRawUnsafe(sql, ...values) {
      sqls.push(sql);
      if (sql.includes(`FROM "Class" WHERE id = $1`)) return classes[values[0]] ? [classes[values[0]]] : [];
      if (sql.includes(`INSERT INTO "ClassDayCancel"`)) {
        if (missingTable) throw missing();
        const [date, classId, kind, startTime, reason, createdBy] = values;
        if (cancels.some((c) => c.date === date && c.classId === classId && c.kind === kind && c.startTime === startTime)) return [];
        const row = { id: `k${++seq}`, date, classId, kind, startTime, reason, createdBy };
        cancels.push(row);
        return [{ id: row.id }];
      }
      if (sql.includes(`DELETE FROM "ClassDayCancel"`)) {
        if (missingTable) throw missing();
        const [date, classId, kind, startTime] = values;
        const index = cancels.findIndex((c) => c.date === date && c.classId === classId && c.kind === kind && c.startTime === startTime);
        if (index < 0) return [];
        const [gone] = cancels.splice(index, 1);
        return [{ id: gone.id, reason: gone.reason }];
      }
      if (sql.includes(`FROM "SpecialProgramSessionDate" sd`)) {
        const hit = `${values[0]}|${values[2]}`;
        // 이미 시작·출결 확인 쿼리는 상태 목록을 담고 있다
        if (sql.includes("'IN_PROGRESS'")) return busySeasonal.includes(hit) ? [{ id: "sd" }] : [];
        return occurrences.includes(hit) ? [{ id: "sd" }] : [];
      }
      if (sql.includes(`FROM "Session" se`)) return busyRegular.includes(values[0]) ? [{ id: "s" }] : [];
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
  };
}

const setInput = (over = {}) => ({ date: DAY, today: DAY, classId: "c1", kind: "REGULAR", actorUserId: "admin-1", ...over });

test("휴강 넣기: 새로 넣으면 표시 1줄 + 감사 기록 1줄(ADMIN, 개인정보 없음)", async () => {
  const db = writeDb();
  const result = await store.setClassDayCancelInDb(db, setInput({ reason: " 체육관 공사 " }));
  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(db.cancels.map((c) => [c.date, c.classId, c.kind, c.startTime, c.reason, c.createdBy]), [[DAY, "c1", "REGULAR", "", "체육관 공사", "admin-1"]]);
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "CLASS_DAY_CANCEL_SET");
  assert.equal(db.audits[0].actorType, "ADMIN");
  assert.equal(db.audits[0].actorUserId, "admin-1");
  assert.deepEqual(db.audits[0].details, { date: DAY, classId: "c1", kind: "REGULAR", startTime: "", className: "화4 초등 저학년", reason: "체육관 공사" });
});

test("휴강 넣기: 같은 것을 또 넣어도 표시·감사 기록이 늘지 않는다", async () => {
  const db = writeDb();
  await store.setClassDayCancelInDb(db, setInput());
  const again = await store.setClassDayCancelInDb(db, setInput());
  assert.deepEqual(again, { ok: true, changed: false });
  assert.equal(db.cancels.length, 1);
  assert.equal(db.audits.length, 1);
});

test("휴강 지우기: 지우면 감사 기록 1줄, 없는 것을 지우면 아무 일도 없다", async () => {
  const db = writeDb();
  await store.setClassDayCancelInDb(db, setInput({ reason: "사유" }));
  const cleared = await store.clearClassDayCancelInDb(db, setInput());
  assert.deepEqual(cleared, { ok: true, changed: true });
  assert.equal(db.cancels.length, 0);
  assert.deepEqual(db.audits.map((a) => a.action), ["CLASS_DAY_CANCEL_SET", "CLASS_DAY_CANCEL_CLEARED"]);
  assert.equal(db.audits[1].details.reason, "사유");
  const none = await store.clearClassDayCancelInDb(db, setInput());
  assert.deepEqual(none, { ok: true, changed: false });
  assert.equal(db.audits.length, 2);
});

test("휴강 넣기: 이미 시작했거나 출결이 있는 수업은 거부(정규·특강)", async () => {
  const regular = writeDb({ busyRegular: ["c1"] });
  assert.deepEqual(await store.setClassDayCancelInDb(regular, setInput()), { ok: false, message: rules.CANCEL_BUSY_MESSAGE });
  const seasonal = writeDb({ busySeasonal: ["sc1|10:00"] });
  assert.deepEqual(await store.setClassDayCancelInDb(seasonal, setInput({ classId: "sc1", kind: "SEASONAL", startTime: "10:00" })), { ok: false, message: rules.CANCEL_BUSY_MESSAGE });
  assert.equal(regular.cancels.length + seasonal.cancels.length, 0);
  assert.equal(regular.audits.length + seasonal.audits.length, 0);
});

test("휴강 넣기(특강): 그 시각의 회차가 실제로 있어야 하고 열쇠는 시작 시각", async () => {
  const db = writeDb();
  const missing = await store.setClassDayCancelInDb(db, setInput({ classId: "sc1", kind: "SEASONAL", startTime: "13:00" }));
  assert.equal(missing.ok, false);
  const ok = await store.setClassDayCancelInDb(db, setInput({ classId: "sc1", kind: "SEASONAL", startTime: "10:00" }));
  assert.deepEqual(ok, { ok: true, changed: true });
  assert.deepEqual(db.cancels.map((c) => [c.kind, c.startTime]), [["SEASONAL", "10:00"]]);
});

test("휴강 넣기: 오늘이 아님·요일 불일치·없는 반·빈 반 id 는 DB 를 바꾸지 않고 거부", async () => {
  const cases = [
    setInput({ today: "2026-11-18" }),            // «오늘»이 다르다
    setInput({ date: "2026-11-18", today: "2026-11-18" }), // 수요일인데 화요일 반
    setInput({ classId: "없는반" }),
    setInput({ classId: "  " }),
    setInput({ kind: "OTHER" }),
    setInput({ reason: "가".repeat(201) }),
  ];
  for (const input of cases) {
    const db = writeDb();
    const result = await store.setClassDayCancelInDb(db, input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(db.cancels.length, 0);
    assert.equal(db.audits.length, 0);
    assert.ok(!db.sqls.some((sql) => /INSERT INTO|DELETE FROM/.test(sql)), "거부했는데 쓰기를 보냈다");
  }
});

test("표가 아직 없으면(42P01) 쓰기는 «준비 중» 결과 — 오류로 죽지 않는다", async () => {
  const db = writeDb({ missingTable: true });
  assert.deepEqual(await store.setClassDayCancelInDb(db, setInput()), { ok: false, message: rules.CANCEL_NOT_READY_MESSAGE });
  assert.deepEqual(await store.clearClassDayCancelInDb(db, setInput()), { ok: false, message: rules.CANCEL_NOT_READY_MESSAGE });
  assert.equal(db.audits.length, 0);
  assert.match(rules.CANCEL_NOT_READY_MESSAGE, /준비 중/);
});

test("쓰기 두 문장(표시 + 감사 기록)은 넘겨받은 트랜잭션 실행기 안에서 나간다", async () => {
  const db = writeDb();
  const inside = [];
  let depth = 0;
  const tx = {
    $queryRawUnsafe: async (sql, ...v) => { inside.push([depth, sql]); return db.$queryRawUnsafe(sql, ...v); },
    $executeRawUnsafe: async (sql, ...v) => { inside.push([depth, sql]); return db.$executeRawUnsafe(sql, ...v); },
  };
  const transact = async (run) => { depth += 1; try { return await run(tx); } finally { depth -= 1; } };
  await store.setClassDayCancelInDb(db, setInput(), transact);
  assert.equal(inside.length, 2);
  assert.ok(inside.every(([d]) => d === 1));
  assert.match(inside[0][1], /INSERT INTO "ClassDayCancel"/);
  assert.match(inside[1][1], /INSERT INTO "OperationsAuditLog"/);
});

test("휴강 저장 SQL: 값은 전부 자리표시자, 다른 표(학부모·청구·보강·셔틀·출결)에 쓰지 않는다", async () => {
  const db = writeDb();
  await store.setClassDayCancelInDb(db, setInput({ reason: "'; DROP TABLE \"Class\"; --" }));
  await store.setClassDayCancelInDb(db, setInput({ classId: "sc1", kind: "SEASONAL", startTime: "10:00" }));
  await store.clearClassDayCancelInDb(db, setInput());
  for (const sql of db.sqls) {
    assert.ok(!sql.includes(DAY) && !sql.includes("DROP TABLE") && !sql.includes("admin-1"), "값이 SQL 글자에 들어갔다");
    const written = [...sql.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+"(\w+)"/g)].map((m) => m[1]);
    for (const table of written) assert.ok(["ClassDayCancel", "OperationsAuditLog"].includes(table), `${table} 에 쓴다`);
  }
  // 겹침 판정 칼럼 = 마이그레이션의 유일 인덱스 칼럼
  const migration = readFileSync("prisma/migrations/20261117120000_add_class_day_cancel/migration.sql", "utf8");
  assert.ok(squash(migration).includes(`ON public."ClassDayCancel" (date, "classId", kind, "startTime")`));
  assert.ok(db.sqls.some((sql) => squash(sql).includes(`ON CONFLICT (date, "classId", kind, "startTime") DO NOTHING`)));
});
