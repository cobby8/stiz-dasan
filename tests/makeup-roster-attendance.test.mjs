import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 보강 온 아이를 코치 출석부에서 처리 — 2026-11-08 원장 승인.
// 출석·지각 → 보강 예약 «참석» → 보강권 «사용» / 결석 → 보강권 안 씀(참석이었으면 되돌림) / 두 번 차감 금지.

const mod = await loadTsModule("src/lib/makeup/makeup-attendance.ts");

/**
 * MakeupSession + 연결된 보강권을 흉내 내는 가짜 db.
 * 보강권 전이는 credit-service.ts 의 syncCreditForMakeupSession 과 같은 표로 따라 바꾼다
 * (ATTENDED→USED, BOOKED→RESERVED) — 코치 출결 저장이 트랜잭션 뒤에 그 함수를 부르는 것을 흉내.
 */
function fakeDb(bookings, { carry = [] } = {}) {
  const rows = bookings.map((b, i) => ({ studentId: "s1", classId: "c9", ymd: "2026-11-08", createdAt: i, ...b }));
  const credits = new Map(rows.map((r) => [r.id, r.status === "ATTENDED" ? "USED" : "RESERVED"]));
  const calls = [];
  const db = {
    rows, credits, calls,
    async $executeRawUnsafe(sql, ...values) {
      if (sql.includes("pg_advisory_xact_lock")) { calls.push("lock"); return 0; }
      if (sql.includes(`UPDATE "MakeupSession" SET status`)) {
        const [id, to, from] = values;
        const row = rows.find((r) => r.id === id && r.status === from);
        if (!row) return 0;
        row.status = to;
        calls.push(`update:${id}:${from}->${to}`);
        return 1;
      }
      // 보강권 전이 — syncCreditForMakeupSession 과 같은 UPDATE(회수된 권은 그대로)를 같은 db(트랜잭션)로 받는다.
      if (sql.includes(`UPDATE "MakeupCredit" SET status=$2`)) {
        assert.match(sql, /status <> 'REVOKED'/);
        const [id, next] = values;
        if (!credits.has(id) || credits.get(id) === "REVOKED") return 0;
        credits.set(id, next);
        calls.push(`credit:${id}->${next}`);
        return 1;
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
    async $queryRawUnsafe(sql, ...values) {
      if (sql.includes("to_regclass")) return [{ found: carry.length ? "BillingAbsenceResolution" : null }];
      if (sql.includes(`"BillingAbsenceResolution" r`)) return carry.includes(values[0]) ? [{ id: "a1" }] : [];
      if (sql.includes(`FROM "MakeupSession" ms`)) {
        assert.match(sql, /FOR UPDATE/, "출결 반영은 예약 행을 잠그고 읽는다");
        const [studentId, classId, ymd] = values;
        return rows
          .filter((r) => r.studentId === studentId && r.classId === classId && r.ymd === ymd && ["BOOKED", "ATTENDED"].includes(r.status))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map(({ id, status }) => ({ id, status }));
      }
      throw new Error(`예상 밖 SQL: ${sql}`);
    },
  };
  return db;
}

/** 코치 출결 저장 한 번 = 한 트랜잭션 안에서 예약 전이 + 보강권 전이(호출부가 따로 맞추지 않는다). */
async function coachMarks(db, status, who = { studentId: "s1", classId: "c9", dateYmd: "2026-11-08" }) {
  return mod.applyMakeupAttendanceInTx(db, { ...who, status });
}
const usedCount = (db) => [...db.credits.values()].filter((s) => s === "USED").length;

test("출석 → 예약 참석·보강권 사용, 같은 출석을 또 눌러도 두 번 차감하지 않는다", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  assert.equal((await coachMarks(db, "PRESENT")).length, 1);
  assert.equal(db.rows[0].status, "ATTENDED");
  assert.equal(usedCount(db), 1);
  assert.deepEqual(await coachMarks(db, "PRESENT"), [], "두 번째 출석은 아무것도 바꾸지 않는다");
  assert.deepEqual(await coachMarks(db, "LATE"), [], "출석→지각 정정도 추가 차감 없음");
  assert.equal(usedCount(db), 1);
});

test("지각도 보강을 다녀온 것으로 본다", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  await coachMarks(db, "LATE");
  assert.equal(db.credits.get("m1"), "USED");
});

test("결석이면 보강권을 쓰지 않는다(예약은 그대로)", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  assert.deepEqual(await coachMarks(db, "ABSENT"), []);
  assert.equal(db.rows[0].status, "BOOKED");
  assert.equal(db.credits.get("m1"), "RESERVED");
});

test("출석 → 결석으로 바꾸면 보강권 사용을 되돌리고, 다시 출석하면 한 장만 쓴다", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  await coachMarks(db, "PRESENT");
  const back = await coachMarks(db, "ABSENT");
  assert.deepEqual(back, [{ id: "m1", from: "ATTENDED", to: "BOOKED" }]);
  assert.equal(db.credits.get("m1"), "RESERVED");
  await coachMarks(db, "PRESENT");
  assert.equal(usedCount(db), 1);
});

test("같은 날 같은 반에 예약이 둘이어도 출석 한 번에 먼저 만든 한 건만 쓴다", async () => {
  const db = fakeDb([{ id: "m-late", status: "BOOKED", createdAt: 5 }, { id: "m-first", status: "BOOKED", createdAt: 1 }]);
  await coachMarks(db, "PRESENT");
  await coachMarks(db, "PRESENT");
  assert.equal(db.credits.get("m-first"), "USED");
  assert.equal(db.credits.get("m-late"), "RESERVED");
  assert.equal(usedCount(db), 1);
});

test("다른 반·다른 날·다른 학생 예약과 취소·무단불참 예약은 건드리지 않는다", async () => {
  const db = fakeDb([
    { id: "other-class", status: "BOOKED", classId: "c1" },
    { id: "other-day", status: "BOOKED", ymd: "2026-11-09" },
    { id: "other-kid", status: "BOOKED", studentId: "s2" },
    { id: "cancelled", status: "CANCELLED" },
    { id: "noshow", status: "NO_SHOW" },
  ]);
  assert.deepEqual(await coachMarks(db, "PRESENT"), []);
  assert.deepEqual(db.rows.map((r) => r.status), ["BOOKED", "BOOKED", "BOOKED", "CANCELLED", "NO_SHOW"]);
});

test("이월로 정산된 결석의 보강이면 참석 처리를 막는다(관리자 경로와 같은 검사)", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }], { carry: ["m1"] });
  await assert.rejects(() => coachMarks(db, "PRESENT"), (e) => e.name === "CompensationConflict");
  assert.equal(db.rows[0].status, "BOOKED");
});

test("보강·이월 정산과 같은 잠금을 먼저 잡는다", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  await coachMarks(db, "PRESENT");
  assert.equal(db.calls[0], "lock");
});

test("순수 판정 표", () => {
  const p = mod.planMakeupAttendance;
  assert.deepEqual(p([], "PRESENT"), []);
  assert.deepEqual(p([{ id: "a", status: "BOOKED" }], "PRESENT"), [{ id: "a", from: "BOOKED", to: "ATTENDED" }]);
  assert.deepEqual(p([{ id: "a", status: "ATTENDED" }, { id: "b", status: "BOOKED" }], "PRESENT"), []);
  assert.deepEqual(p([{ id: "a", status: "ATTENDED" }], "ABSENT"), [{ id: "a", from: "ATTENDED", to: "BOOKED" }]);
  assert.deepEqual(p([{ id: "a", status: "BOOKED" }], "UNKNOWN"), []);
});

test("보강 날짜는 timestamptz 에 시간대를 «한 번»만 걸어 KST 달력 날짜로 비교한다", () => {
  const sql = mod.makeupOnClassDateSql("ms", "$2", "$3");
  assert.match(sql, /\(ms\."makeupDate" AT TIME ZONE 'Asia\/Seoul'\)::date = \$3::date/);
  assert.equal(sql.match(/AT TIME ZONE/g).length, 1);
  assert.match(sql, /ms\.status IN \('BOOKED','ATTENDED'\)/);
});

// ── 연결부: 명단 조회·출결 저장이 같은 조건을 쓰고, 보강 아이는 «결석 → 새 보강권 발급»을 타지 않는다 ──
const staff = readFileSync("src/app/actions/staff-sessions.ts", "utf8");
const queries = readFileSync("src/lib/staff-session-queries.ts", "utf8");

test("코치 출석부 명단은 makeupOnClassDateSql 로 보강 아이를 붙이고 «보강» 표시를 단다", () => {
  assert.match(queries, /FROM "MakeupSession" ms[\s\S]*makeupOnClassDateSql\("ms", "\$2", "\$3"\)/);
  assert.match(queries, /makeup: true,/);
});

test("코치 출결 저장: 보강 아이는 보강 예약 전이 + 기존 보강권 전이 함수를 쓰고, 정규 보강권 발급을 타지 않는다", () => {
  const start = staff.indexOf("export async function saveStaffAttendance(");
  const b = staff.slice(start, staff.indexOf("\nexport ", start + 1));
  assert.match(b, /findMakeupBookings\(prisma,/);
  // 주석은 빼고 실제 코드만 본다(주석에 함수 이름이 설명으로 적혀 있다).
  const makeupBranch = b.slice(b.indexOf("if (isMakeup) {"), b.indexOf("// 결석 사유(질병·부상)", b.indexOf("if (isMakeup) {")))
    .split(/\r?\n/).filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.match(makeupBranch, /applyMakeupAttendanceInTx\(tx,/);
  // 보강권 전이는 applyMakeupAttendanceInTx 안 같은 트랜잭션에서 한다 — 트랜잭션 뒤 따로 부르지 않는다.
  assert.doesNotMatch(makeupBranch, /syncCreditForMakeupSession/);
  assert.doesNotMatch(makeupBranch, /syncCreditForRegularSession/);
  // 2026-11-14: 정규 보강권 맞춤은 보강 아이가 아닐 때만, 결석 사유(질병·부상 표시)를 저장한 «뒤»에 부른다
  const reasonAt = b.indexOf("applyAttendanceAbsenceReasonInTx(tx,");
  const syncAt = b.indexOf("await syncCreditForRegularSession(");
  assert.ok(reasonAt > 0 && syncAt > reasonAt, "사유 저장 → 보강권 맞춤 순서");
  assert.match(b.slice(syncAt - 700, syncAt), /if \(!isMakeup\) \{/);
});

// ── 검수 권장 반영(2026-11-08) ──
test("보강권 상태는 예약 전이와 같은 트랜잭션(db)에서 바뀐다 — 관리자 경로와 같은 표", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  await mod.applyMakeupAttendanceInTx(db, { studentId: "s1", classId: "c9", dateYmd: "2026-11-08", status: "PRESENT" });
  assert.deepEqual(db.calls.filter((c) => c !== "lock"), ["update:m1:BOOKED->ATTENDED", "credit:m1->USED"]);
  assert.deepEqual(mod.MAKEUP_CREDIT_STATUS_FOR, { ATTENDED: "USED", BOOKED: "RESERVED" });
  // credit-service.ts 의 syncCreditForMakeupSession 과 같은 전이표·같은 UPDATE 문
  const credit = readFileSync("src/lib/makeup/credit-service.ts", "utf8");
  assert.match(credit, /input\.status === "ATTENDED" \? "USED"/);
  assert.match(credit, /input\.status === "BOOKED" \? "RESERVED"/);
  const src = readFileSync("src/lib/makeup/makeup-attendance.ts", "utf8");
  assert.match(src, /UPDATE "MakeupCredit" SET status=\$2, "updatedAt"=now\(\) WHERE "makeupSessionId" = \$1 AND status <> 'REVOKED'/);
});

test("회수(REVOKED)된 보강권은 코치 출석으로 되살리지 않는다", async () => {
  const db = fakeDb([{ id: "m1", status: "BOOKED" }]);
  db.credits.set("m1", "REVOKED");
  await coachMarks(db, "PRESENT");
  assert.equal(db.rows[0].status, "ATTENDED");
  assert.equal(db.credits.get("m1"), "REVOKED");
});

test("이월로 정산된 결석의 보강이면 «예약됨» 되돌림도 막는다", async () => {
  const db = fakeDb([{ id: "m1", status: "ATTENDED" }], { carry: ["m1"] });
  await assert.rejects(() => coachMarks(db, "ABSENT"), (e) => e.name === "CompensationConflict");
  assert.equal(db.rows[0].status, "ATTENDED");
  assert.equal(db.credits.get("m1"), "USED");
});

test("코치 수강료 확인은 보강 온 아이를 빼고 읽는다(다른 반 청구 자료가 내려가지 않게)", () => {
  const fees = readFileSync("src/lib/staff-monthly-fees.ts", "utf8");
  const start = fees.indexOf("async function readContext(");
  assert.notEqual(start, -1, "readContext 함수가 없습니다");
  const b = fees.slice(start, fees.indexOf("\nexport ", start + 1));
  // 체험 아이(f1)도 함께 뺀다(2026-11-13) — 보강 제외는 그대로 남아 있어야 한다.
  assert.match(b, /const students = roster\.filter\(s => !s\.makeup && !s\.trial\);/);
  // 결제 조회 대상 학생 목록은 걸러진 students 에서 만든다
  assert.match(b, /const studentIds = students\.filter/);
});
