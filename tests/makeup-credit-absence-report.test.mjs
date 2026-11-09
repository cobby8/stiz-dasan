import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 결석 신고 즉시 보강권(2026-11-10 원장 결정 k4) — 실행 테스트.
//
// absence-report-credit.ts 는 prisma 를 import 하지 않고 호출부의 트랜잭션(tx)만 쓰므로 그대로 실행한다.
// 가짜 tx 는 «보강권 표»를 메모리에 들고, 들어온 SQL 의 충돌 처리 문구(DO NOTHING / DO UPDATE … REVOKED)를
// 그대로 해석한다. 그래서 출결 경로(credit-service.issueMakeupCredit)의 실제 SQL 도 같은 가짜 표에 넣어 볼 수 있다
// — «신고로 한 장, 나중에 출결이 결석으로 저장돼도 여전히 한 장»을 SQL 문구 수준에서 확인한다.

const credit = await loadTsModule("src/lib/makeup/absence-report-credit.ts");
const rules = await loadTsModule("src/lib/makeup/credit-rules.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const creditServiceSource = readFileSync("src/lib/makeup/credit-service.ts", "utf8");

/** 메모리 «MakeupCredit»·«MakeupSession»·출결 결석 표를 흉내 내는 가짜 트랜잭션 */
function fakeDb({ carry = false, absentAttendance = [], nowIso = "2026-11-10T03:00:00.000Z" } = {}) {
  const credits = []; // { id, studentId, sourceKey, status, absenceDate, expiresAt, originClassId, makeupSessionId, note }
  const sessions = []; // { id, makeupDate, status }
  const calls = [];
  let seq = 0;

  /** INSERT … ON CONFLICT 를 SQL 문구대로 처리 */
  function upsert(sql, row) {
    const existing = credits.find((c) => c.studentId === row.studentId && c.sourceKey === row.sourceKey);
    if (!existing) {
      const created = { id: `mc${++seq}`, makeupSessionId: null, ...row };
      credits.push(created);
      return [{ id: created.id }];
    }
    if (/DO NOTHING/.test(sql)) return [];
    // DO UPDATE … WHERE status='REVOKED' AND makeupSessionId IS NULL — 회수된 같은 결석만 되살린다
    assert.match(sql, /DO UPDATE[\s\S]*"MakeupCredit"\.status = 'REVOKED' AND "MakeupCredit"\."makeupSessionId" IS NULL/);
    if (existing.status === "REVOKED" && existing.makeupSessionId == null) {
      existing.status = "AVAILABLE";
      return [{ id: existing.id }];
    }
    return [];
  }

  const tx = {
    credits, sessions, calls,
    async $executeRawUnsafe(sql, ...v) {
      calls.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return 1;
      if (/UPDATE "MakeupSession" SET status = 'CANCELLED'/.test(sql)) {
        const s = sessions.find((x) => x.id === v[0] && x.status === "BOOKED");
        if (s) s.status = "CANCELLED";
        return s ? 1 : 0;
      }
      if (/UPDATE "MakeupCredit"/.test(sql)) {
        // 예약 취소 경로는 RESERVED 만, 회수 경로는 AVAILABLE 만 바꾼다(SQL 조건 그대로)
        const need = /WHERE id = \$1 AND status = 'RESERVED'/.test(sql) ? "RESERVED" : "AVAILABLE";
        const c = credits.find((x) => x.id === v[0] && x.status === need);
        if (!c) return 0;
        c.status = "REVOKED";
        c.note = v[1];
        if (/"makeupSessionId" = NULL/.test(sql)) c.makeupSessionId = null;
        return 1;
      }
      throw new Error(`예상하지 못한 SQL: ${sql}`);
    },
    async $queryRawUnsafe(sql, ...v) {
      calls.push(sql);
      if (/to_regclass/.test(sql)) return [{ found: "BillingAbsenceResolution" }];
      if (/"BillingAbsenceResolution"/.test(sql)) return carry ? [{ id: "absence-a" }] : [];
      if (/INSERT INTO "MakeupCredit"/.test(sql)) {
        // 신고 경로: ($1 학생, $2 키, $3 결석일, $4 만료, $5 반, $6 메모) / 출결 경로: ($1 학생, $2 종류, $3 키, $4, $5, $6 반, $7, $8 세션, $9 메모)
        const fromReport = /VALUES \(\$1,'REGULAR',\$2/.test(sql);
        const row = fromReport
          ? { studentId: v[0], sourceKey: v[1], absenceDate: v[2], expiresAt: v[3], originClassId: v[4], note: v[5], status: "AVAILABLE" }
          : { studentId: v[0], sourceKey: v[2], absenceDate: v[3], expiresAt: v[4], originClassId: v[5], note: v[8], status: "AVAILABLE" };
        return upsert(sql, row);
      }
      if (/FROM "MakeupCredit" mc/.test(sql) && /FOR UPDATE OF mc/.test(sql)) {
        const c = credits.find((x) => x.studentId === v[0] && x.sourceKey === v[1]);
        if (!c) return [];
        const s = c.makeupSessionId ? sessions.find((x) => x.id === c.makeupSessionId) : null;
        return [{ id: c.id, status: c.status, makeupSessionId: c.makeupSessionId, bookingPast: Boolean(s && s.makeupDate < nowIso) }];
      }
      if (/FROM "Attendance" a/.test(sql)) {
        // Session."date" 는 글자 그대로 비교(시간대 변환 없음)해야 한다
        assert.match(sql, /to_char\(se\."date", 'YYYY-MM-DD'\) = \$3/);
        assert.doesNotMatch(sql, /AT TIME ZONE/);
        return absentAttendance.includes(`${v[0]}|${v[1]}|${v[2]}`) ? [{ found: 1 }] : [];
      }
      throw new Error(`예상하지 못한 SQL: ${sql}`);
    },
  };
  return tx;
}

/** 출결 경로(credit-service.issueMakeupCredit)의 실제 INSERT SQL 을 꺼내, 같은 인자 순서로 가짜 표에 넣는다 */
function attendanceInsertSql() {
  const start = creditServiceSource.indexOf("export async function issueMakeupCredit(");
  const body = creditServiceSource.slice(start, creditServiceSource.indexOf("\nexport ", start + 1));
  const m = /`(INSERT INTO "MakeupCredit"[\s\S]*?RETURNING id)`/.exec(body);
  assert.ok(m, "issueMakeupCredit 의 INSERT SQL 을 찾지 못했습니다");
  return m[1];
}
async function issueFromAttendance(tx, { studentId, classId, absenceYmd, sessionId }) {
  // credit-service.syncCreditForRegularSession 과 같은 키 — Session 의 반·날짜에서 만든다(세션 id 는 키에 안 들어간다)
  const sourceKey = rules.makeSourceKey({ sourceType: "REGULAR", classId, absenceYmd });
  const absenceAt = new Date(`${absenceYmd}T00:00:00+09:00`); // credit-service ymdToUtc 와 같은 기준점
  return tx.$queryRawUnsafe(attendanceInsertSql(),
    studentId, "REGULAR", sourceKey, absenceAt.toISOString(), rules.calcExpiry(absenceAt).toISOString(),
    classId, null, sessionId, null);
}

const S = "student-1", C = "class-mon", D = "2026-11-16";

test("키 통일: 신고(학생·반·KST 날짜)와 출결(세션의 반·날짜)이 같은 sourceKey — 세션 id 는 키에 없다", () => {
  assert.equal(credit.regularAbsenceSourceKey(C, D), "REGULAR:class-mon:2026-11-16");
  assert.equal(credit.regularAbsenceSourceKey(C, D), rules.makeSourceKey({ sourceType: "REGULAR", classId: C, absenceYmd: D }));
});

test("신고 → 즉시 보강권 1장(사용 가능, 반·결석일 기준)", async () => {
  const db = fakeDb();
  const r = await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  assert.deepEqual(r, { issued: true });
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
  assert.equal(db.credits[0].sourceKey, "REGULAR:class-mon:2026-11-16");
  assert.equal(db.credits[0].originClassId, C);
  assert.match(db.calls[0], /pg_advisory_xact_lock/, "이월 정산과 같은 잠금을 먼저 잡는다");
});

test("같은 신고를 다시 보내도 1장(멱등)", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  const again = await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  assert.deepEqual(again, { issued: false, reason: "EXISTS" });
  assert.equal(db.credits.length, 1);
});

test("신고 후 그 수업 출결이 결석으로 저장(또는 랠리즈 동기화)돼도 여전히 1장", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  const rows = await issueFromAttendance(db, { studentId: S, classId: C, absenceYmd: D, sessionId: "session-9" });
  assert.deepEqual(rows, [], "출결 경로는 이미 있는 보강권을 새로 만들지 않는다");
  // 랠리즈 동기화가 같은 출결을 다시 돌려도
  await issueFromAttendance(db, { studentId: S, classId: C, absenceYmd: D, sessionId: "session-9" });
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("출결 결석이 먼저 저장된 뒤 학부모가 신고해도 1장", async () => {
  const db = fakeDb();
  await issueFromAttendance(db, { studentId: S, classId: C, absenceYmd: D, sessionId: "session-9" });
  const r = await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  assert.equal(r.issued, false);
  assert.equal(db.credits.length, 1);
});

test("신고 취소 → 미사용 보강권 회수", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  const r = await credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D });
  assert.equal(r.action, "REVOKE");
  assert.equal(db.credits[0].status, "REVOKED");
  assert.equal(db.credits.length, 1);
});

test("신고 → 취소(회수) → 다시 신고 = 같은 1장이 되살아난다", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  await credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D });
  const r = await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  assert.equal(r.issued, true);
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("신고 취소(회수) 후 그날 실제로 결석해 출결이 저장되면 보강권이 다시 생긴다(출결 경로도 되살림)", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  await credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D });
  const rows = await issueFromAttendance(db, { studentId: S, classId: C, absenceYmd: D, sessionId: "session-9" });
  assert.equal(rows.length, 1);
  assert.equal(db.credits.length, 1);
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("보강 예약에 쓰인 경우: 확인 없이 취소하면 막고(확인 요청), 확인하면 예약 취소 + 회수", async () => {
  const db = fakeDb();
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  db.sessions.push({ id: "ms1", makeupDate: "2026-11-14T07:00:00.000Z", status: "BOOKED" });
  Object.assign(db.credits[0], { status: "RESERVED", makeupSessionId: "ms1" });

  await assert.rejects(
    credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D }),
    /MAKEUP_BOOKING_CONFIRM_REQUIRED/,
  );
  assert.equal(db.credits[0].status, "RESERVED", "확인 전에는 아무것도 바꾸지 않는다");
  assert.equal(db.sessions[0].status, "BOOKED");

  const r = await credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D, confirmBookingCancel: true });
  assert.equal(r.action, "CANCEL_BOOKING_AND_REVOKE");
  assert.equal(db.sessions[0].status, "CANCELLED");
  assert.equal(db.credits[0].status, "REVOKED");
  assert.equal(db.credits[0].makeupSessionId, null);
});

test("예약한 보강 날짜가 이미 지났으면(출결 미처리) 확인해도 신고 취소를 막는다", async () => {
  const db = fakeDb({ nowIso: "2026-11-15T03:00:00.000Z" });
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  db.sessions.push({ id: "ms1", makeupDate: "2026-11-14T07:00:00.000Z", status: "BOOKED" });
  Object.assign(db.credits[0], { status: "RESERVED", makeupSessionId: "ms1" });
  await assert.rejects(
    credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D, confirmBookingCancel: true }),
    /MAKEUP_BOOKING_PAST/,
  );
  assert.equal(db.sessions[0].status, "BOOKED");
});

test("이미 보강을 들은(사용 완료·무단 불참) 경우 학부모 신고 취소를 막는다", async () => {
  for (const status of ["USED", "NO_SHOW"]) {
    const db = fakeDb();
    await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
    db.credits[0].status = status;
    await assert.rejects(
      credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D, confirmBookingCancel: true }),
      /MAKEUP_ALREADY_USED/,
      status,
    );
    assert.equal(db.credits[0].status, status);
  }
});

test("관리자 신고 취소 = 기존 회수 규칙과 같게(미사용만 회수, 예약·사용 완료는 그대로, 막지 않음)", async () => {
  const cases = [["AVAILABLE", "REVOKE", "REVOKED"], ["RESERVED", "NONE", "RESERVED"], ["USED", "NONE", "USED"], ["NO_SHOW", "NONE", "NO_SHOW"]];
  for (const [before, action, after] of cases) {
    const db = fakeDb();
    await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
    db.credits[0].status = before;
    const r = await credit.settleCreditOnAbsenceCancel(db, { actor: "ADMIN", studentId: S, classId: C, absenceYmd: D });
    assert.equal(r.action, action, before);
    assert.equal(db.credits[0].status, after, before);
  }
});

test("출결이 이미 결석으로 확정된 수업이면 신고를 취소해도 보강권은 그대로(실제 결석)", async () => {
  const db = fakeDb({ absentAttendance: [`${S}|${C}|${D}`] });
  await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  for (const actor of ["PARENT", "ADMIN"]) {
    const r = await credit.settleCreditOnAbsenceCancel(db, { actor, studentId: S, classId: C, absenceYmd: D });
    assert.equal(r.action, "NONE", actor);
  }
  assert.equal(db.credits[0].status, "AVAILABLE");
});

test("보강권이 없는 결석(발급 시작일 전 등)의 신고 취소는 아무것도 하지 않는다", async () => {
  const db = fakeDb();
  const r = await credit.settleCreditOnAbsenceCancel(db, { actor: "PARENT", studentId: S, classId: C, absenceYmd: D });
  assert.equal(r.action, "NONE");
});

test("이월(CARRY)로 정산된 결석이면 신고는 받되 보강권은 만들지 않는다", async () => {
  const db = fakeDb({ carry: true });
  const r = await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: D });
  assert.deepEqual(r, { issued: false, reason: "CARRY" });
  assert.equal(db.credits.length, 0);
});

test("판정표: 순수 함수", () => {
  const d = (o) => credit.decideCreditOnAbsenceCancel({ actor: "PARENT", creditStatus: "AVAILABLE", attendanceAbsent: false, bookingPast: false, confirmBookingCancel: false, ...o });
  assert.equal(d({}), "REVOKE");
  assert.equal(d({ creditStatus: null }), "NONE");
  assert.equal(d({ creditStatus: "EXPIRED" }), "NONE");
  assert.equal(d({ creditStatus: "REVOKED" }), "NONE");
  assert.equal(d({ creditStatus: "RESERVED" }), "NEED_BOOKING_CONFIRM");
  assert.equal(d({ creditStatus: "RESERVED", confirmBookingCancel: true }), "CANCEL_BOOKING_AND_REVOKE");
  assert.equal(d({ creditStatus: "RESERVED", confirmBookingCancel: true, bookingPast: true }), "BLOCK_PAST_BOOKING");
  assert.equal(d({ creditStatus: "USED" }), "BLOCK_USED");
  assert.equal(d({ creditStatus: "USED", attendanceAbsent: true }), "NONE", "실제 결석이면 사용한 보강도 정당");
  assert.equal(d({ actor: "ADMIN", creditStatus: "RESERVED" }), "NONE");
});

test("자정 경계(KST): 결석일은 그 날 KST 자정으로 저장되고 날짜가 하루 밀리지 않는다", async () => {
  // 서버(UTC) 기준으로는 전날 15:00 — 이 값을 KST 로 읽으면 다시 신고한 날짜여야 한다
  const cases = [["2026-11-16", "2026-11-15T15:00:00.000Z"], ["2027-01-01", "2026-12-31T15:00:00.000Z"], ["2028-03-01", "2028-02-29T15:00:00.000Z"]];
  for (const [ymd, iso] of cases) {
    const db = fakeDb();
    await credit.issueCreditForReportedAbsence(db, { studentId: S, classId: C, absenceYmd: ymd });
    assert.equal(db.credits[0].absenceDate, iso, ymd);
    assert.equal(kst.toKstYmd(db.credits[0].absenceDate), ymd, `${ymd} 가 하루 밀리면 안 된다`);
    // 출결 경로(credit-service ymdToUtc)와 같은 기준점 — 두 경로의 결석일·만료일이 같다
    assert.equal(db.credits[0].absenceDate, new Date(`${ymd}T00:00:00+09:00`).toISOString());
    assert.equal(db.credits[0].expiresAt, rules.calcExpiry(new Date(iso)).toISOString());
  }
  // 학부모 화면의 «오늘 이후 결석분» 경계 — KST 자정 직후(UTC 로는 전날 15:00대)에도 오늘이 KST 로 잡힌다
  const justAfterMidnight = Date.parse("2026-11-15T15:05:00.000Z"); // KST 11/16 00:05
  const today = kst.todayKst(justAfterMidnight);
  assert.equal(today, "2026-11-16");
  assert.equal(new Date(kst.kstAt(today)).toISOString(), "2026-11-15T15:00:00.000Z", "오늘 결석분의 absenceDate 와 정확히 같아 포함된다");
});

// ── 연결부 고정(소스) — 신고·취소가 같은 트랜잭션에서 보강권을 다루는지 ──

const parentAbsence = readFileSync("src/lib/regular/parent-regular-absence.ts", "utf8");
const adminAbsence = readFileSync("src/app/actions/regular-absence-admin.ts", "utf8");
const route = readFileSync("src/app/api/mypage/regular-absence/route.ts", "utf8");
const timeline = readFileSync("src/lib/requests/parent-timeline.ts", "utf8");

function fnBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, name);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("학부모 신고: 결석 저장과 보강권 발급이 한 트랜잭션, 발급 시작일 판정을 거친다", () => {
  const body = fnBody(parentAbsence, "reportRegularAbsence");
  assert.match(body, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*INSERT INTO "RegularAbsence"[\s\S]*isMakeupCreditIssuableYmd\(date\)[\s\S]*issueCreditForReportedAbsence\(tx,/);
  assert.match(body, /makeupCreditIssued/);
});

test("학부모 취소: 권한 조건 유지 + 같은 트랜잭션에서 보강권 되돌리기(PARENT)", () => {
  const body = fnBody(parentAbsence, "cancelRegularAbsence");
  assert.match(body, /const access = await childAccessSql\("s", "\$1"\);/);
  assert.equal((body.match(/AND \$\{access\}/g) || []).length, 2, "id·자연키 두 경로 모두 그 부모의 자녀만");
  assert.match(body, /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*ra\.status = 'REPORTED'[\s\S]*settleCreditOnAbsenceCancel\(tx, \{\s*actor: "PARENT"/);
  assert.match(body, /confirmBookingCancel: confirmMakeupCancel/);
});

test("관리자 취소: 같은 트랜잭션에서 ADMIN 규칙으로 되돌린다", () => {
  const body = fnBody(adminAbsence, "cancelRegularAbsenceByAdmin");
  assert.match(body, /prisma\.\$transaction\(async tx => \{[\s\S]*RETURNING "studentId", "classId", to_char\(date, 'YYYY-MM-DD'\)[\s\S]*settleCreditOnAbsenceCancel\(tx, \{\s*actor: "ADMIN"/);
});

test("학부모 API: 확인 플래그는 명시적 true 만, 막힘 코드를 한국어로", () => {
  assert.match(route, /confirmMakeupCancel: body\.confirmMakeupCancel === true/);
  for (const code of ["MAKEUP_BOOKING_CONFIRM_REQUIRED", "MAKEUP_ALREADY_USED", "MAKEUP_BOOKING_PAST"]) assert.match(route, new RegExp(`${code}: "`));
});

test("신청 내역: 결석의 보강권을 같은 키 형식으로 읽어 한 줄로 보인다", async () => {
  assert.match(timeline, /mc\."sourceKey" = 'REGULAR:' \|\| ra\."classId" \|\| ':' \|\| to_char\(ra\.date,'YYYY-MM-DD'\)/);
  const tl = await loadTsModule("src/lib/requests/parent-timeline-rules.ts");
  assert.equal(tl.absenceCreditLine("AVAILABLE"), "보강권 1장이 생겼어요");
  assert.equal(tl.absenceCreditLine(null), null);
  assert.equal(tl.canCancelNow({ kind: "REGULAR_ABSENCE", rawStatus: "REPORTED", absenceCredit: "AVAILABLE" }), true);
  assert.equal(tl.canCancelNow({ kind: "REGULAR_ABSENCE", rawStatus: "REPORTED", absenceCredit: "USED" }), false);
  assert.equal(tl.canCancelNow({ kind: "ENROLLMENT_CHANGE", rawStatus: "PENDING" }), true);
});
