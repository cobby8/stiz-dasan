import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 부상·질병 «기간 결석» 복귀 정산 1b 단계(2026-11-15 원장 승인) — 실행 테스트.
//
// 승인(금액 없음)·승인 취소·7일 자동 전환 제외·신청함 «기간 한 줄»을 «실제로 돌려» 본다.
// 가짜 DB 는 들어온 SQL 의 조건 문구를 읽어 그 조건이 있을 때만 걸러 준다 — 코드에서 조건이 빠지면 테스트가 깨진다.
// 모르는 조회는 오류로 던진다 — 승인이 청구 표(Payment·BillingWorkbenchDraft 등)를 읽으면 바로 드러난다.
// 승인된 기간의 결석을 하루씩 이월 승인하면 거절되는지는 tests/billing-workbench.test.mjs 에 있다(기존 CARRY 규칙의 가짜 DB 를 쓴다).

const rules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
const admin = await loadTsModule("src/lib/regular/illness-period-admin.ts");
const cron = await loadTsModule("src/lib/regular/illness-carry-cron.ts");
const service = await loadTsModule("src/lib/regular/absence-period-service.ts");
const read = (path) => readFileSync(path, "utf8");
const require = createRequire(import.meta.url);
const migration = read("prisma/migrations/20261116100000_absence_period_carry_state/migration.sql");

const KEY = (classId, ymd) => `REGULAR:${classId}:${ymd}`;
const ILLNESS = "ILLNESS_INJURY";

/** 기간·결석·검토·보강권·사진을 메모리에 들고 SQL 문구대로 답하는 가짜 DB */
function fakeDb(init = {}) {
  const state = {
    periodCarry: true,   // 기간 정산 칸(6개)이 있는가
    reviewReady: true,   // 검토·증빙 표가 있는가
    periods: [],         // { id, studentId, reason, status, carryState, startDate, returnDate, note, reportedByUserId, approvedBy }
    absences: [],        // { id, periodId, studentId, classId, date, reason, status }
    reviews: [],         // { absenceId, status, source, requestedTick, decidedByUserId }
    credits: [],         // { id, studentId, sourceKey, status, expired, makeupSessionId }
    bookings: [],        // 보강 예약 { studentId, classId, date, status }
    attendance: [],      // 출결 { studentId, classId, date, status }
    notifications: [],   // 앱 알림 { studentId, title, message, hoursAgo }
    evidence: [],        // { id, absenceId, removed }
    resolutions: [],     // 하루씩 실제로 이월 적립된 결석 id
    audit: [],
    tick: 100,           // now() 대신 쓰는 시계 — 다시 열린 검토의 «알린 시각»이 새로 찍혔는지 본다
    today: "2026-11-15",
    ...init,
  };
  const db = { state, calls: [] };
  const live = (periodId) => state.absences.filter((a) => a.periodId === periodId && a.status !== "CANCELLED" && a.reason === ILLNESS && a.date >= "2026-10-05");
  const reviewOf = (absenceId) => state.reviews.find((r) => r.absenceId === absenceId);
  const creditOf = (a) => state.credits.find((c) => c.studentId === a.studentId && c.sourceKey === KEY(a.classId, a.date));
  // 보강을 이미 예약·사용한 날인가(보강권 RESERVED/USED/NO_SHOW 또는 보강 예약 BOOKED/ATTENDED/NO_SHOW)
  const makeupInUse = (a) => ["RESERVED", "USED", "NO_SHOW"].includes(creditOf(a)?.status)
    || state.bookings.some((b) => b.studentId === a.studentId && b.classId === a.classId && b.date === a.date && ["BOOKED", "ATTENDED", "NO_SHOW"].includes(b.status));

  db.$queryRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    if (/information_schema\.columns/.test(sql)) {
      assert.match(sql, /table_name = 'RegularAbsencePeriod'/);
      return [{ n: /'carryState'/.test(sql) && state.periodCarry ? 6 : 0 }];
    }
    if (/to_regclass\(\$1\)/.test(sql)) return [{ found: "present" }];
    if (/to_regclass/.test(sql)) return [state.reviewReady ? { review: "present", evidence: "present" } : { review: null, evidence: null }];
    // 기간 한 줄(승인·취소는 FOR UPDATE, 상세는 잠금 없이)
    if (/FROM "RegularAbsencePeriod" p WHERE p\.id = \$1/.test(sql)) {
      return state.periods.filter((p) => p.id === v[0]).map((p) => ({
        id: p.id, studentId: p.studentId, reason: p.reason, status: p.status, carryState: p.carryState,
        startDate: p.startDate, returnDate: p.returnDate ?? null, note: p.note ?? null, parentReported: Boolean(p.reportedByUserId), approvedYmd: p.approvedYmd ?? null,
        carrySettlement: p.carrySettlement ?? null,
      }));
    }
    // 승인: 그 기간의 살아 있는 질병·부상 결석 중 아직 결정 전인 것
    if (/FROM "RegularAbsencePeriod" p\s+JOIN "RegularAbsence" ra ON \(ra\."periodId" = p\.id AND ra\.status <> 'CANCELLED' AND ra\.reason = 'ILLNESS_INJURY'/.test(sql) && /FOR UPDATE OF ra/.test(sql)) {
      assert.match(sql, /COALESCE\(r\.status, 'PENDING'\) = 'PENDING'/, "결정이 난 결석(하루씩 이월·보강권 전환·닫힘)은 건드리지 않는다");
      // 승인은 «보강을 이미 예약·사용한 날»을 뺀다 — 그 조건 문구가 있을 때만 거른다(보강권으로 전환은 그런 날도 함께 닫는다)
      const skipInUse = /AND NOT \(EXISTS \(SELECT 1 FROM "MakeupCredit" used_credit[\s\S]+used_credit\.status IN \('RESERVED', 'USED', 'NO_SHOW'\)\) OR EXISTS \(SELECT 1 FROM "MakeupSession" used_session[\s\S]+to_char\(used_session\."originalDate" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) = to_char\(ra\.date, 'YYYY-MM-DD'\)\s+AND used_session\.status IN \('BOOKED', 'ATTENDED', 'NO_SHOW'\)\)\)/.test(sql);
      return live(v[0]).filter((a) => (reviewOf(a.id)?.status ?? "PENDING") === "PENDING")
        .filter((a) => !skipInUse || !makeupInUse(a))
        .map((a) => ({ id: a.id, studentId: a.studentId, classId: a.classId, absenceYmd: a.date, noReview: !reviewOf(a.id) }));
    }
    // 승인: 거둘 미사용 보강권(id 를 남겨 승인 취소 때 돌려준다)
    if (/JOIN "MakeupCredit" mc ON mc\."studentId" = ra\."studentId"/.test(sql)) {
      assert.match(sql, /WHERE ra\.id = ANY\(\$1::text\[\]\) AND mc\.status = 'AVAILABLE'\s+FOR UPDATE OF mc/);
      return state.absences.filter((a) => v[0].includes(a.id)).map((a) => ({ a, c: creditOf(a) }))
        .filter(({ c }) => c?.status === "AVAILABLE").map(({ a, c }) => ({ id: c.id, absenceId: a.id }));
    }
    // 보강권으로 전환(기존 convertIllnessToMakeupInTx)이 읽는 것들
    if (/FROM "RegularAbsence" WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return state.absences.filter((a) => a.id === v[0]).map((a) => ({ studentId: a.studentId, classId: a.classId, absenceYmd: a.date, reason: a.reason, status: a.status }));
    }
    if (/SELECT status FROM "RegularAbsenceCarryReview" WHERE "absenceId" = \$1 FOR UPDATE/.test(sql)) {
      return state.reviews.filter((r) => r.absenceId === v[0]).map((r) => ({ status: r.status }));
    }
    if (/FROM "Attendance" a\s+JOIN "Session" se ON se\.id = a\."sessionId"/.test(sql)) {
      return state.attendance.filter((t) => t.studentId === v[0] && t.classId === v[1] && t.date === v[2] && ["PRESENT", "LATE"].includes(t.status)).map(() => ({ found: 1 }));
    }
    if (/INSERT INTO "MakeupCredit"/.test(sql)) {
      const found = state.credits.find((c) => c.studentId === v[0] && c.sourceKey === v[1]);
      if (!found) { const row = { id: `new-${state.credits.length + 1}`, studentId: v[0], sourceKey: v[1], status: "AVAILABLE", makeupSessionId: null }; state.credits.push(row); return [{ id: row.id }]; }
      if (found.status === "REVOKED" && found.makeupSessionId == null) { found.status = "AVAILABLE"; return [{ id: found.id }]; }
      return [];
    }
    // 승인 알림을 최근 24시간 안에 보냈는가
    if (/FROM "Notification" n\s+JOIN "Student" s ON s\."parentId" = n\."userId"/.test(sql)) {
      assert.match(sql, /n\.type = 'ABSENCE' AND n\.title = \$2 AND n\.message = \$3\s+AND n\."createdAt" > now\(\) - interval '24 hours'/);
      return state.notifications.filter((n) => n.studentId === v[0] && n.title === v[1] && n.message === v[2] && n.hoursAgo < 24).map(() => ({ found: 1 }));
    }
    // 상세: 그 기간의 살아 있는 결석 + 반 이름 + 검토
    if (/FROM "RegularAbsencePeriod" p\s+JOIN "RegularAbsence" ra ON \(ra\."periodId" = p\.id/.test(sql)) {
      return live(v[0]).map((a) => ({ id: a.id, className: a.className ?? a.classId, reviewStatus: reviewOf(a.id)?.status ?? null, reasonText: reviewOf(a.id)?.reasonText ?? null }));
    }
    if (/FROM "RegularAbsenceEvidence" e JOIN "RegularAbsence" ra ON ra\.id = e\."absenceId"\s+WHERE ra\."periodId" = \$1 AND e\."removedAt" IS NULL/.test(sql)) {
      return state.evidence.filter((e) => !e.removed && state.absences.find((a) => a.id === e.absenceId)?.periodId === v[0]).map((e) => ({ id: e.id }));
    }
    // cron: 7일 지난 검토 후보
    if (/FROM "RegularAbsenceCarryReview" r\s+JOIN "RegularAbsence" ra ON ra\.id = r\."absenceId"\s+WHERE r\.status = 'PENDING' AND r\.source IN \('PARENT', 'KAKAO'\)/.test(sql)) {
      const skipDecided = /AND NOT EXISTS \(SELECT 1 FROM "RegularAbsencePeriod" decided_period\s+WHERE decided_period\.id = ra\."periodId" AND decided_period\."carryState" <> 'NONE'\)/.test(sql);
      return state.reviews.filter((r) => r.status === "PENDING" && ["PARENT", "KAKAO"].includes(r.source))
        .filter((r) => {
          const period = state.periods.find((p) => p.id === state.absences.find((a) => a.id === r.absenceId)?.periodId);
          return !skipDecided || !period || period.carryState === "NONE";
        })
        .map((r) => ({ absenceId: r.absenceId, status: r.status, source: r.source, photoCount: 0, requestedYmd: r.requestedYmd ?? state.today, absenceYmd: state.absences.find((a) => a.id === r.absenceId).date, todayYmd: state.today }));
    }
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 200)}`);
  };

  db.$executeRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    if (/pg_advisory_xact_lock\(hashtext\('STIZ_BILLING_WORKBENCH'\)\)/.test(sql)) return 1;
    if (/UPDATE "RegularAbsencePeriod"\s+SET "carryState" = 'APPROVED'/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND "carryState" = 'NONE'/, "지금 NONE 일 때만 바꾼다(두 번 눌러도 한 번)");
      const period = state.periods.find((p) => p.id === v[0] && p.carryState === "NONE");
      if (!period) return 0;
      period.carryState = "APPROVED"; period.approvedBy = v[1]; period.approvedYmd = state.today;
      return 1;
    }
    if (/UPDATE "RegularAbsencePeriod"\s+SET "carryState" = 'NONE'/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND "carryState" = 'APPROVED'/, "금액을 정하기 전(APPROVED)에만 취소한다");
      assert.match(sql, /"carryApprovedAt" = NULL, "carryApprovedByUserId" = NULL/);
      const period = state.periods.find((p) => p.id === v[0] && p.carryState === "APPROVED");
      if (!period) return 0;
      assert.match(sql, /"carrySettlement" = NULL/, "승인 기록도 함께 비운다");
      period.carryState = "NONE"; period.approvedBy = null; period.approvedYmd = null; period.carrySettlement = null;
      return 1;
    }
    // 승인: 되돌릴 재료(거둔 보강권·새로 만든 검토 줄)를 기간 행에 남긴다
    if (/UPDATE "RegularAbsencePeriod" SET "carrySettlement" = \$2::jsonb WHERE id = \$1 AND "carryState" = 'APPROVED'/.test(sql)) {
      const period = state.periods.find((p) => p.id === v[0] && p.carryState === "APPROVED");
      if (!period) return 0;
      period.carrySettlement = JSON.parse(v[1]);
      return 1;
    }
    // 승인 취소: 거둔 보강권 돌려주기 — 조건 문구가 있을 때만 그 조건으로 거른다
    if (/UPDATE "MakeupCredit" mc\s+SET status = CASE WHEN mc\."expiresAt" < now\(\) THEN 'EXPIRED' ELSE 'AVAILABLE' END/.test(sql)) {
      assert.match(sql, /mc\.id = ANY\(\$1::text\[\]\) AND mc\."studentId" = \$2 AND mc\.status = 'REVOKED' AND mc\."makeupSessionId" IS NULL/);
      const liveOnly = /ra\."periodId" = \$3 AND ra\."studentId" = mc\."studentId" AND ra\.status <> 'CANCELLED'/.test(sql);
      const keepSettled = /NOT EXISTS \(SELECT 1 FROM "BillingAbsenceResolution" settled WHERE settled\."absenceId" = ra\.id\)/.test(sql);
      let n = 0;
      for (const credit of state.credits.filter((c) => v[0].includes(c.id) && c.studentId === v[1] && c.status === "REVOKED" && c.makeupSessionId == null)) {
        const absence = state.absences.find((a) => a.periodId === v[2] && a.studentId === credit.studentId && KEY(a.classId, a.date) === credit.sourceKey);
        if (!absence) continue;
        if (liveOnly && absence.status === "CANCELLED") continue;
        if (keepSettled && state.resolutions.includes(absence.id)) continue;
        credit.status = credit.expired ? "EXPIRED" : "AVAILABLE"; n += 1;
      }
      return n;
    }
    // 승인 취소: 승인 때 새로 만든 검토 줄 지우기
    if (/DELETE FROM "RegularAbsenceCarryReview" r\s+USING "RegularAbsence" ra/.test(sql)) {
      assert.match(sql, /ra\."periodId" = \$1 AND r\."absenceId" = ANY\(\$2::text\[\]\)\s+AND r\.status = 'APPROVED'/);
      const keepSettled = /NOT EXISTS \(SELECT 1 FROM "BillingAbsenceResolution" settled/.test(sql);
      const before = state.reviews.length;
      state.reviews = state.reviews.filter((r) => !(v[1].includes(r.absenceId) && r.status === "APPROVED"
        && state.absences.find((a) => a.id === r.absenceId)?.periodId === v[0] && !(keepSettled && state.resolutions.includes(r.absenceId))));
      return before - state.reviews.length;
    }
    // 승인 취소: 그 사이 취소된 결석의 승인 검토는 닫는다
    if (/UPDATE "RegularAbsenceCarryReview" r\s+SET status = 'CLOSED', "decidedAt" = now\(\), "updatedAt" = now\(\)\s+FROM "RegularAbsence" ra/.test(sql)) {
      assert.match(sql, /ra\."periodId" = \$1 AND ra\.status = 'CANCELLED'\s+AND r\.status = 'APPROVED'/);
      let n = 0;
      for (const a of state.absences.filter((x) => x.periodId === v[0] && x.status === "CANCELLED")) {
        const found = reviewOf(a.id);
        if (found?.status === "APPROVED" && !state.resolutions.includes(a.id)) { found.status = "CLOSED"; n += 1; }
      }
      return n;
    }
    // 기존 닫기(closeIllnessReviewInTx) — «검토 중»만 닫는다
    if (/UPDATE "RegularAbsenceCarryReview"\s+SET status = 'CLOSED'/.test(sql)) {
      const found = reviewOf(v[0]);
      if (!found || !v[1].includes(found.status)) return 0;
      found.status = "CLOSED";
      return 1;
    }
    if (/UPDATE "RegularAbsenceEvidence"/.test(sql)) return 0;
    // 미사용 보강권 거두기(기존 holdCreditForIllnessInTx)
    if (/UPDATE "MakeupCredit"\s+SET status = 'REVOKED'/.test(sql)) {
      assert.match(sql, /AND status = 'AVAILABLE'/, "예약·사용 중인 보강권은 건드리지 않는다");
      const hit = state.credits.filter((c) => c.studentId === v[0] && c.sourceKey === v[1] && c.status === "AVAILABLE");
      for (const credit of hit) credit.status = "REVOKED";
      return hit.length;
    }
    // 보강권으로 전환(기존 함수): 검토를 «보강권으로 전환»으로
    if (/INSERT INTO "RegularAbsenceCarryReview"[\s\S]+VALUES \(\$1, 'MAKEUP', 'STAFF'/.test(sql)) {
      const found = reviewOf(v[0]);
      if (!found) state.reviews.push({ absenceId: v[0], status: "MAKEUP", source: "STAFF", decidedByUserId: v[2], convertReason: v[3] });
      else if (["PENDING", "CLOSED"].includes(found.status)) { found.status = "MAKEUP"; found.decidedByUserId = v[2]; found.convertReason = v[3]; }
      return 1;
    }
    // 보강권으로 전환: 그날 출석한 날은 닫힌 검토 줄을 만든다(이미 줄이 있으면 그대로)
    if (/INSERT INTO "RegularAbsenceCarryReview"[\s\S]+VALUES \(\$1, 'CLOSED', 'STAFF'/.test(sql)) {
      assert.match(sql, /ON CONFLICT \("absenceId"\) DO NOTHING/);
      if (reviewOf(v[0])) return 0;
      state.reviews.push({ absenceId: v[0], status: "CLOSED", source: "STAFF", decidedByUserId: v[1] });
      return 1;
    }
    if (/INSERT INTO "RegularAbsenceCarryReview"/.test(sql)) {
      assert.match(sql, /unnest\(\$1::text\[\]\)/);
      assert.match(sql, /WHERE "RegularAbsenceCarryReview"\.status = 'PENDING'/, "이미 결정된 검토는 덮어쓰지 않는다");
      let n = 0;
      for (const id of v[0]) {
        const found = reviewOf(id);
        if (!found) { state.reviews.push({ absenceId: id, status: "APPROVED", source: "STAFF", decidedByUserId: v[1], requestedTick: 0 }); n += 1; }
        else if (found.status === "PENDING") { found.status = "APPROVED"; found.decidedByUserId = v[1]; n += 1; }
      }
      return n;
    }
    // 승인 취소: 기간 승인이 맞춰 둔 검토를 «검토 중»으로(알린 시각을 지금으로)
    if (/UPDATE "RegularAbsenceCarryReview" r\s+SET status = 'PENDING', "requestedAt" = now\(\)/.test(sql)) {
      assert.match(sql, /ra\."periodId" = \$1 AND ra\.status <> 'CANCELLED' AND ra\.reason = \$2\s+AND r\.status = 'APPROVED'/);
      const keepSettled = /NOT EXISTS \(SELECT 1 FROM "BillingAbsenceResolution" settled WHERE settled\."absenceId" = ra\.id\)/.test(sql);
      let n = 0;
      for (const a of state.absences.filter((x) => x.periodId === v[0] && x.status !== "CANCELLED" && x.reason === v[1])) {
        const found = reviewOf(a.id);
        if (!found || found.status !== "APPROVED") continue;
        if (keepSettled && state.resolutions.includes(a.id)) continue;
        found.status = "PENDING"; found.decidedByUserId = null; found.requestedTick = ++state.tick; n += 1;
      }
      return n;
    }
    if (/INSERT INTO "OperationsAuditLog"/.test(sql)) { state.audit.push({ action: v[0], actor: v[1], details: JSON.parse(v[2]) }); return 1; }
    throw new Error(`예상하지 않은 쓰기: ${sql.replace(/\s+/g, " ").slice(0, 200)}`);
  };

  // 트랜잭션 — 안에서 던지면 통째로 되돌린다
  db.$transaction = async (work, options) => {
    db.txOptions = options;
    const snapshot = structuredClone(state);
    try { return await work(db); } catch (error) { for (const key of Object.keys(snapshot)) state[key] = snapshot[key]; throw error; }
  };
  return db;
}

/** 윤수영 사례 모양 — 학원이 등록한 부상 기간(11/6부터 복귀 미정), 월·금반 16회(오늘 11/15 기준 지난 날 3 + 앞으로 13), 사진 2장 */
function sixteenDayPeriod(overrides = {}) {
  const dates = ["2026-11-06", "2026-11-09", "2026-11-13", "2026-11-16", "2026-11-20", "2026-11-23", "2026-11-27", "2026-11-30",
    "2026-12-04", "2026-12-07", "2026-12-11", "2026-12-14", "2026-12-18", "2026-12-21", "2026-12-25", "2026-12-28"];
  const absences = dates.map((date, index) => ({
    id: `a${index + 1}`, periodId: "p1", studentId: "s1", classId: index % 2 === 0 ? "fri" : "mon",
    className: index % 2 === 0 ? "금요반" : "월요반", date, reason: ILLNESS, status: "CONFIRMED",
  }));
  return fakeDb({
    periods: [{ id: "p1", studentId: "s1", reason: ILLNESS, status: "ACTIVE", carryState: "NONE", startDate: "2026-11-06", returnDate: null, note: "발목 골절", reportedByUserId: null }],
    absences,
    evidence: [{ id: "e1", absenceId: "a1" }, { id: "e2", absenceId: "a1" }],
    ...overrides,
  });
}

// ── 상수·마이그레이션 ─────────────────────────────────────────────────────

test("기간 정산 상태 상수 = 마이그레이션 CHECK 제약 집합, schema.prisma 에도 같은 칸", () => {
  const check = migration.match(/CHECK \("carryState" IN \(([^)]+)\)\)/);
  assert.ok(check, "CHECK 제약이 있다");
  const fromSql = check[1].split(",").map((value) => value.trim().replace(/'/g, ""));
  assert.deepEqual([...fromSql].sort(), [...rules.PERIOD_CARRY_STATES].sort());
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "carryState" TEXT NOT NULL DEFAULT 'NONE'/);
  // 멱등 + 부분 색인
  assert.equal((migration.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 6);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS "RegularAbsencePeriod_carryState_idx"\s+ON public\."RegularAbsencePeriod" \("studentId"\) WHERE "carryState" <> 'NONE'/);
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model RegularAbsencePeriod {"), schema.indexOf("// 질병·부상 결석 «이월 검토»(2026-11-14 원장 결정표 a1~a8) — 결석 1건당 1줄."));
  for (const column of ["carryState", "carryApprovedAt", "carryApprovedByUserId", "carrySettledAt", "carrySettledByUserId", "carrySettlement"]) {
    assert.match(model, new RegExp(`\\n  ${column}\\s`), column);
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`), column);
  }
  // 칸 확인 함수는 같은 6칸을 센다
  const serviceSource = read("src/lib/regular/absence-period-service.ts");
  const ready = serviceSource.slice(serviceSource.indexOf("export async function periodCarryColumnsReady"), serviceSource.indexOf("/** 학부모가 알린 기간인가"));
  for (const column of ["carryState", "carryApprovedAt", "carryApprovedByUserId", "carrySettledAt", "carrySettledByUserId", "carrySettlement"]) assert.match(ready, new RegExp(`'${column}'`), column);
  assert.match(ready, /=== 6/);
});

test("정산 시작일 상수는 보강권 발급 시작일(MAKEUP_CREDIT_ISSUE_FROM_YMD)과 같은 값", () => {
  const creditService = read("src/lib/makeup/credit-service.ts");
  const issueFrom = creditService.match(/export const MAKEUP_CREDIT_ISSUE_FROM_YMD = "(\d{4}-\d{2}-\d{2})";/)[1];
  assert.equal(rules.ILLNESS_PERIOD_FROM_YMD, issueFrom);
  assert.match(rules.illnessPeriodAbsenceSql("p", "ra"), new RegExp(`ra\\.date >= '${issueFrom}'::date`));
  // 규칙 파일에 날짜 글자를 한 번만 적는다(SQL 조각은 상수를 쓴다)
  assert.equal((read("src/lib/regular/illnessPeriodRules.ts").match(/2026-10-05/g) ?? []).length, 1);
});

test("칸 확인: 6칸이 모두 있을 때만 준비됨", async () => {
  assert.equal(await service.periodCarryColumnsReady(fakeDb()), true);
  assert.equal(await service.periodCarryColumnsReady(fakeDb({ periodCarry: false })), false);
  assert.equal(await service.periodCarryColumnsReady({ $queryRawUnsafe: async () => [{ n: 5 }] }), false, "일부만 있으면 준비 안 됨");
});

// ── 규칙(순수) ────────────────────────────────────────────────────────────

test("기간 글자·신청함 한 줄 — «11/6 ~ · 16회 · 사진 2장»", () => {
  assert.equal(rules.periodRangeText("2026-11-06", null), "11/6 ~");
  // 복귀일 = 다시 나오는 첫날 → 마지막으로 쉬는 날은 그 전날
  assert.equal(rules.periodRangeText("2026-11-06", "2026-11-28"), "11/6 ~ 11/27");
  // 달·해 경계(복귀일 12/1 → 11/30, 1/1 → 12/31)
  assert.equal(rules.periodRangeText("2026-11-06", "2026-12-01"), "11/6 ~ 11/30");
  assert.equal(rules.periodRangeText("2026-12-21", "2027-01-01"), "12/21 ~ 12/31");
  assert.equal(rules.periodRangeText("2026-11-06", "2026-11-07"), "11/6", "하루짜리");
  assert.equal(rules.periodRangeText("없는날짜", null), "");
  assert.equal(rules.periodInboxSummary({ startYmd: "2026-11-06", returnYmd: null, count: 16, photoCount: 2 }), "11/6 ~ · 16회 · 사진 2장");
  assert.equal(rules.periodInboxSummary({ startYmd: "2026-11-06", returnYmd: "2026-11-28", count: 6, photoCount: 0 }), "11/6 ~ 11/27 · 6회 · 사진 없음");
});

test("승인 가능 판정은 사유·기간 상태·정산 상태만 본다(날짜·청구 기록 없음)", () => {
  assert.equal(rules.periodApprovalBlocker({ reason: ILLNESS, periodStatus: "ACTIVE", carryState: "NONE" }), null);
  assert.equal(rules.periodApprovalBlocker({ reason: ILLNESS, periodStatus: "ENDED", carryState: "NONE" }), null, "복귀 처리된 기간도 승인할 수 있다");
  assert.match(rules.periodApprovalBlocker({ reason: "FAMILY_TRIP", periodStatus: "ACTIVE", carryState: "NONE" }), /질병·부상/);
  assert.match(rules.periodApprovalBlocker({ reason: ILLNESS, periodStatus: "ACTIVE", carryState: "APPROVED" }), /이미 승인/);
  assert.match(rules.periodApprovalBlocker({ reason: ILLNESS, periodStatus: "ACTIVE", carryState: "SETTLED" }), /정산이 끝난/);
  assert.match(rules.periodApprovalBlocker({ reason: ILLNESS, periodStatus: "CANCELLED", carryState: "NONE" }), /등록 취소/);
  assert.equal(rules.periodApprovalBlocker.length, 1);
});

// ── 승인 ──────────────────────────────────────────────────────────────────

test("승인: 미래 날짜·청구 기록 없음·청구 준비 저장 스위치 꺼짐에서도 된다 — 돈이 움직이지 않는다", async () => {
  const saved = process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED;
  delete process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED; // 스위치 꺼짐
  try {
    const db = sixteenDayPeriod();
    // 전부 앞으로 올 날짜로 — 하루짜리 승인이라면 «결석일이 지난 뒤에»로 거절된다
    db.state.absences.forEach((absence, index) => { absence.date = `2099-01-${String(index + 1).padStart(2, "0")}`; });
    db.state.credits.push({ id: "c1", studentId: "s1", sourceKey: KEY("fri", "2099-01-01"), status: "AVAILABLE" }, { id: "c2", studentId: "s1", sourceKey: KEY("mon", "2099-01-02"), status: "RESERVED" });
    const done = await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
    // 보강이 이미 예약된 날(a2)은 승인 대상에서 빠진다 — 검토 줄을 만들지 않는다
    assert.deepEqual(done, { periodId: "p1", studentId: "s1", startDate: "2026-11-06", returnDate: null, reviewed: 15, creditsHeld: 1 });
    assert.equal(db.state.periods[0].carryState, "APPROVED");
    assert.equal(db.state.periods[0].approvedBy, "admin-1");
    // 검토 15건이 «승인»으로 — 7일 자동 보강권 전환이 멈춘다
    assert.equal(db.state.reviews.length, 15);
    assert.ok(!db.state.reviews.some((review) => review.absenceId === "a2"));
    // 되돌릴 재료: 거둔 보강권 id 와 새로 만든 검토 줄의 결석 id 를 기간 행과 감사 기록에 남긴다
    const record = db.state.periods[0].carrySettlement.approval;
    assert.deepEqual(record.revokedCreditIds, ["c1"]);
    assert.equal(record.createdReviewAbsenceIds.length, 15);
    assert.ok(!record.createdReviewAbsenceIds.includes("a2"));
    assert.deepEqual(db.state.audit[0].details.revokedCreditIds, ["c1"]);
    assert.deepEqual(db.state.audit[0].details.createdReviewAbsenceIds, record.createdReviewAbsenceIds);
    assert.ok(db.state.reviews.every((review) => review.status === "APPROVED" && review.decidedByUserId === "admin-1"));
    // 미사용 보강권만 거둔다. 예약된 보강권은 그대로
    assert.deepEqual(db.state.credits.map((credit) => credit.status), ["REVOKED", "RESERVED"]);
    // 결석 행 상태는 바꾸지 않는다(학부모 «복귀했어요»가 REPORTED 만 취소한다)
    assert.ok(db.state.absences.every((absence) => absence.status === "CONFIRMED"));
    // 감사 기록 1건 — 사유 글은 싣지 않는다
    assert.equal(db.state.audit.length, 1);
    assert.equal(db.state.audit[0].action, "ILLNESS_PERIOD_APPROVED");
    assert.equal(db.state.audit[0].actor, "admin-1");
    assert.deepEqual(Object.keys(db.state.audit[0].details).sort(), ["createdReviewAbsenceIds", "creditsHeld", "periodId", "returnDate", "reviewed", "revokedCreditIds", "startDate", "studentId"]);
    // 청구 표는 읽지도 쓰지도 않는다(가짜 DB 가 모르는 조회를 오류로 던지므로 여기까지 왔으면 안 읽은 것) — 문구로도 한 번 더
    assert.ok(!db.calls.some((sql) => /"Payment"|"PaymentInvoice"|BillingWorkbench|BillingCarryCredit|MonthlyEnrollmentRegister/.test(sql)));
    assert.equal(db.txOptions.isolationLevel, "Serializable");
    // 잠금 순서: 작업대 전역 잠금이 맨 먼저
    assert.match(db.calls[0], /pg_advisory_xact_lock\(hashtext\('STIZ_BILLING_WORKBENCH'\)\)/);
  } finally {
    if (saved === undefined) delete process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED; else process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED = saved;
  }
  // 코드에도 날짜·스위치·청구 읽기가 없다
  const source = read("src/lib/regular/illness-period-admin.ts") + read("src/app/actions/illness-period-admin.ts");
  assert.doesNotMatch(source, /STIZ_BILLING_WORKBENCH_WRITES_ENABLED|writesEnabled|readWorkbench|resolveWorkbenchAbsence|todayKst|"Payment"|BillingCarryCredit/);
});

test("승인: 두 번 누르면 두 번째는 «이미 승인» — 검토·보강권·감사 기록이 한 번만 바뀐다", async () => {
  const db = sixteenDayPeriod();
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-2"), (error) => error instanceof rules.IllnessPeriodError && /이미 승인된 기간 결석/.test(error.message));
  assert.equal(db.state.periods[0].approvedBy, "admin-1");
  assert.equal(db.state.audit.length, 1);
  assert.equal(db.state.reviews.length, 16);
  // 화면이 낡아 상태 확인을 지나쳐도(동시에 누름) 조건부 UPDATE 가 0행이라 같은 문구로 끝난다
  const racing = sixteenDayPeriod();
  const originalQuery = racing.$queryRawUnsafe;
  racing.$queryRawUnsafe = async (sql, ...values) => {
    const rows = await originalQuery(sql, ...values);
    if (/FROM "RegularAbsencePeriod" p WHERE p\.id = \$1/.test(sql)) { racing.state.periods[0].carryState = "APPROVED"; return rows; } // 읽은 직후 다른 요청이 먼저 승인
    return rows;
  };
  await assert.rejects(() => admin.approveIllnessPeriod(racing, { periodId: "p1", evidenceConfirmed: true }, "admin-2"), /이미 승인된 기간 결석/);
  assert.equal(racing.state.audit.length, 0);
});

test("승인: 증빙 확인·권한·대상이 맞지 않으면 아무것도 바꾸지 않는다", async () => {
  const untouched = (db) => { assert.equal(db.state.periods[0].carryState, "NONE"); assert.equal(db.state.reviews.length, 0); assert.equal(db.state.audit.length, 0); };
  let db = sixteenDayPeriod();
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: false }, "admin-1"), /증빙을 확인했는지/); untouched(db);
  assert.equal(db.calls.length, 0, "DB 를 건드리기 전에 막는다");
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, ""), /관리자 확인/); untouched(db);
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "없는기간", evidenceConfirmed: true }, "admin-1"), /찾을 수 없습니다/); untouched(db);
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "", evidenceConfirmed: true }, "admin-1"), /찾을 수 없습니다/);
  db = sixteenDayPeriod(); db.state.periods[0].reason = "FAMILY_TRIP";
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1"), /질병·부상으로 등록한 기간/); untouched(db);
  db = sixteenDayPeriod(); db.state.periods[0].status = "CANCELLED";
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1"), /등록 취소된/); untouched(db);
  // 칸이 없는 DB — 승인 자체를 막는다(기존 화면은 그대로)
  db = sixteenDayPeriod({ periodCarry: false });
  await assert.rejects(() => admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1"), /저장 구조를 확인/); untouched(db);
});

test("승인: 이미 하루씩 결정된 결석(이월 승인·보강권 전환·닫힘)과 취소된 날·다른 사유는 그대로 둔다", async () => {
  const db = sixteenDayPeriod();
  db.state.reviews.push(
    { absenceId: "a1", status: "APPROVED", source: "STAFF", decidedByUserId: "earlier" }, // 하루씩 실제 이월 적립된 날
    { absenceId: "a2", status: "MAKEUP", source: "PARENT", decidedByUserId: null },
    { absenceId: "a3", status: "CLOSED", source: "PARENT", decidedByUserId: null },
    { absenceId: "a4", status: "PENDING", source: "PARENT", decidedByUserId: null },
  );
  db.state.absences[4].status = "CANCELLED";
  db.state.absences[5].reason = "PERSONAL";
  const done = await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  assert.equal(done.reviewed, 11, "16 − 결정 3 − 취소 1 − 다른 사유 1");
  const status = (id) => db.state.reviews.find((review) => review.absenceId === id)?.status ?? null;
  assert.deepEqual([status("a1"), status("a2"), status("a3"), status("a4"), status("a5"), status("a6")], ["APPROVED", "MAKEUP", "CLOSED", "APPROVED", null, null]);
  assert.equal(db.state.reviews.find((review) => review.absenceId === "a1").decidedByUserId, "earlier");
  // 학부모가 알린 검토는 «누가 알렸는지»(source)를 유지한다
  assert.equal(db.state.reviews.find((review) => review.absenceId === "a4").source, "PARENT");
});

// ── 7일 자동 전환 ─────────────────────────────────────────────────────────

test("승인 뒤 7일 자동 보강권 전환 대상에서 빠진다 — 승인 뒤에 새로 생긴 «검토 중» 결석도", async () => {
  const db = sixteenDayPeriod();
  // 학부모가 알린 기간(사진 없음, 알린 지 한 달) — 승인 전에는 16건 모두 자동 전환 후보다
  db.state.periods[0].reportedByUserId = "parent-1";
  for (const absence of db.state.absences) db.state.reviews.push({ absenceId: absence.id, status: "PENDING", source: "PARENT", requestedYmd: "2026-10-10" });
  // 견줄 것: 승인하지 않은 다른 기간의 검토 1건(오늘 알림 — 기한 전이라 전환은 안 되지만 후보로는 잡힌다)
  db.state.periods.push({ id: "p2", studentId: "s2", reason: ILLNESS, status: "ACTIVE", carryState: "NONE", startDate: "2026-11-10", returnDate: "2026-11-20", reportedByUserId: "parent-2" });
  db.state.absences.push({ id: "b1", periodId: "p2", studentId: "s2", classId: "mon", date: "2026-11-16", reason: ILLNESS, status: "REPORTED" });
  db.state.reviews.push({ absenceId: "b1", status: "PENDING", source: "PARENT", requestedYmd: "2026-11-15" });
  const issuable = () => true;

  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  let result = await cron.autoConvertOverdueIllnessReviews(db, issuable);
  assert.deepEqual(result, { checked: 1, converted: [], failed: 0 }, "승인된 기간의 16건은 후보에도 없다(다른 기간 1건만)");

  // 승인 뒤 학부모가 기간을 늘려 새 «검토 중» 결석이 생겼다(기한 지남·사진 없음) — 그래도 전환하지 않는다
  db.state.absences.push({ id: "a17", periodId: "p1", studentId: "s1", classId: "mon", date: "2026-10-12", reason: ILLNESS, status: "REPORTED" });
  db.state.reviews.push({ absenceId: "a17", status: "PENDING", source: "PARENT", requestedYmd: "2026-10-10" });
  result = await cron.autoConvertOverdueIllnessReviews(db, issuable);
  assert.deepEqual(result, { checked: 1, converted: [], failed: 0 });
  assert.equal(db.state.reviews.find((review) => review.absenceId === "a17").status, "PENDING");
  // 조건 문구가 실제로 실렸다
  const candidateSql = db.calls.filter((sql) => /WHERE r\.status = 'PENDING' AND r\.source IN \('PARENT', 'KAKAO'\)/.test(sql)).at(-1);
  assert.match(candidateSql, /AND NOT EXISTS \(SELECT 1 FROM "RegularAbsencePeriod" decided_period/);

  // 칸이 없는 DB 는 예전 그대로(조건 없이 읽는다 — 없는 칸을 읽어 죽지 않는다)
  const legacy = fakeDb({ periodCarry: false });
  await cron.autoConvertOverdueIllnessReviews(legacy, issuable);
  assert.ok(!legacy.calls.some((sql) => /carryState" <> 'NONE'/.test(sql)));
});

// ── 승인 취소 ─────────────────────────────────────────────────────────────

test("승인 취소: 기간은 NONE 으로, 검토는 «검토 중»으로 돌아오고 기한(알린 시각)이 새로 시작한다", async () => {
  const db = sixteenDayPeriod();
  db.state.periods[0].reportedByUserId = "parent-1";
  for (const absence of db.state.absences) db.state.reviews.push({ absenceId: absence.id, status: "PENDING", source: "PARENT", requestedYmd: "2026-10-10", requestedTick: 1 });
  // a1 은 승인 전에 하루씩 실제로 이월 적립된 날 — 승인 취소가 건드리면 안 된다
  db.state.reviews[0].status = "APPROVED"; db.state.resolutions.push("a1");
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  assert.equal(db.state.reviews.filter((review) => review.status === "APPROVED").length, 16);

  const done = await admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "admin-2");
  assert.deepEqual(done, { periodId: "p1", studentId: "s1", reopened: 15, creditsRestored: 0, reviewsRemoved: 0, closed: 0 });
  assert.equal(db.state.periods[0].carrySettlement, null);
  assert.equal(db.state.periods[0].carryState, "NONE");
  assert.equal(db.state.periods[0].approvedBy, null);
  const settled = db.state.reviews.find((review) => review.absenceId === "a1");
  assert.equal(settled.status, "APPROVED", "실제 이월 적립된 결석의 검토는 그대로");
  assert.equal(settled.requestedTick, 1);
  for (const review of db.state.reviews.filter((item) => item.absenceId !== "a1")) {
    assert.equal(review.status, "PENDING", review.absenceId);
    assert.ok(review.requestedTick > 100, "알린 시각이 지금으로 새로 찍힌다(7일 기한 새로 시작)");
    assert.equal(review.decidedByUserId, null);
    assert.equal(review.source, "PARENT");
  }
  assert.deepEqual(db.state.audit.map((entry) => entry.action), ["ILLNESS_PERIOD_APPROVED", "ILLNESS_PERIOD_APPROVAL_CANCELED"]);
  assert.equal(db.state.audit[1].actor, "admin-2");
  // 다시 승인할 수 있다 / 두 번 취소는 거절
  await assert.rejects(() => admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "admin-2"), /승인되지 않은 기간 결석/);
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  assert.equal(db.state.periods[0].carryState, "APPROVED");
});

test("승인 취소: 정산이 끝난 기간·없는 기간·권한 없음은 거절하고 아무것도 바꾸지 않는다", async () => {
  for (const carryState of ["SETTLED", "REFUND_REVIEW", "REFUND_DONE"]) {
    const db = sixteenDayPeriod(); db.state.periods[0].carryState = carryState;
    await assert.rejects(() => admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "admin-1"), /정산이 끝난 기간 결석은 승인 취소할 수 없습니다/);
    assert.equal(db.state.periods[0].carryState, carryState);
    assert.equal(db.state.audit.length, 0);
  }
  const db = sixteenDayPeriod();
  await assert.rejects(() => admin.cancelIllnessPeriodApproval(db, { periodId: "없는기간" }, "admin-1"), /찾을 수 없습니다/);
  await assert.rejects(() => admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, ""), /관리자 확인/);
});

test("승인 취소: 승인 때 거둔 보강권을 돌려주고(만료일 지난 것은 만료), 새로 만든 검토 줄은 지우고, 취소된 결석의 승인 검토는 닫는다", async () => {
  // 학원이 등록한 기간 — 검토 줄 없음. 미사용 보강권 3장(c1·c2·c3), 그중 c3 은 만료일이 지났다
  const db = sixteenDayPeriod();
  db.state.credits.push(
    { id: "c1", studentId: "s1", sourceKey: KEY("fri", "2026-11-06"), status: "AVAILABLE", makeupSessionId: null },
    { id: "c2", studentId: "s1", sourceKey: KEY("mon", "2026-11-09"), status: "AVAILABLE", makeupSessionId: null },
    { id: "c3", studentId: "s1", sourceKey: KEY("fri", "2026-11-13"), status: "AVAILABLE", makeupSessionId: null, expired: true },
    // 승인과 무관하게 예전에 회수된 보강권 — 승인 취소가 되살리면 안 된다
    { id: "old", studentId: "s1", sourceKey: KEY("mon", "2026-11-16"), status: "REVOKED", makeupSessionId: null },
  );
  // a5 는 학부모가 알려 검토 줄이 이미 있던 날(승인 취소 때 지우지 않고 «검토 중»으로 되돌린다)
  db.state.reviews.push({ absenceId: "a5", status: "PENDING", source: "PARENT", requestedTick: 1 });
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  assert.deepEqual(db.state.credits.map((credit) => credit.status), ["REVOKED", "REVOKED", "REVOKED", "REVOKED"]);
  assert.deepEqual(db.state.periods[0].carrySettlement.approval.revokedCreditIds, ["c1", "c2", "c3"]);
  assert.equal(db.state.periods[0].carrySettlement.approval.createdReviewAbsenceIds.length, 15);
  assert.equal((await admin.readIllnessPeriodDetail(db, "p1")).heldCreditCount, 3);

  // 승인 뒤 원장이 «복귀 처리»해 a16 이 취소됐다 / a2(c2 의 결석)도 취소됐다
  db.state.absences.find((absence) => absence.id === "a16").status = "CANCELLED";
  db.state.absences.find((absence) => absence.id === "a2").status = "CANCELLED";
  // a5 도 취소 — 원래 있던 검토 줄이라 지우지 않고 닫는다
  db.state.absences.find((absence) => absence.id === "a5").status = "CANCELLED";

  const done = await admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "admin-2");
  // 새로 만든 15줄은 지움 · 취소된 결석의 원래 있던 검토(a5)는 닫음 · 보강권은 살아 있는 결석 것만(c1·c3) 돌려줌
  assert.deepEqual(done, { periodId: "p1", studentId: "s1", reopened: 0, creditsRestored: 2, reviewsRemoved: 15, closed: 1 });
  assert.deepEqual(db.state.reviews.map((review) => [review.absenceId, review.status]), [["a5", "CLOSED"]]);
  const status = (id) => db.state.credits.find((credit) => credit.id === id).status;
  assert.equal(status("c1"), "AVAILABLE", "원래 상태로");
  assert.equal(status("c3"), "EXPIRED", "만료일이 지났으면 만료");
  assert.equal(status("c2"), "REVOKED", "그 사이 취소된 결석의 보강권은 돌려주지 않는다");
  assert.equal(status("old"), "REVOKED", "승인이 거둔 것이 아닌 보강권은 건드리지 않는다");
  assert.equal(db.state.periods[0].carrySettlement, null);
  assert.deepEqual(db.state.audit[1].details.revokedCreditIds, ["c1", "c2", "c3"]);
  assert.equal(db.state.audit[1].details.creditsRestored, 2);
  // 다시 승인 → 다시 취소해도 같은 결과(두 번 돌려주지 않는다)
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  assert.deepEqual(db.state.periods[0].carrySettlement.approval.revokedCreditIds, ["c1"], "만료된 c3 은 다시 거두지 않는다");
  const again = await admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "admin-2");
  assert.equal(again.creditsRestored, 1);
  assert.equal(status("c1"), "AVAILABLE");
});

test("승인 기록(carrySettlement.approval) 읽기 — 모양이 다르거나 없으면 아무것도 되돌리지 않는다", () => {
  const empty = { revokedCreditIds: [], createdReviewAbsenceIds: [] };
  assert.deepEqual(rules.parsePeriodApprovalRecord(null), empty);
  assert.deepEqual(rules.parsePeriodApprovalRecord("깨진 글자"), empty);
  assert.deepEqual(rules.parsePeriodApprovalRecord({ approval: { revokedCreditIds: "c1" } }), empty);
  assert.deepEqual(rules.parsePeriodApprovalRecord({ approval: { revokedCreditIds: ["c1", "c1", 3, "", null], createdReviewAbsenceIds: ["a1"] } }), { revokedCreditIds: ["c1"], createdReviewAbsenceIds: ["a1"] });
  // 글자로 내려와도(드라이버에 따라) 읽는다
  assert.deepEqual(rules.parsePeriodApprovalRecord(JSON.stringify({ approval: { revokedCreditIds: ["c9"] } })), { revokedCreditIds: ["c9"], createdReviewAbsenceIds: [] });
});

// ── 보강권으로 전환 ───────────────────────────────────────────────────────

test("보강권으로 전환: 결정 전인 날마다 보강권 1장(기존 [보강권으로]와 같은 함수) — 출석한 날은 닫고, 기간은 «날짜별로 처리함»이 된다", async () => {
  const db = sixteenDayPeriod();
  // a1: 거둬 둔 보강권이 있는 날(같은 한 장을 되살린다) · a2: 그날 출석으로 기록됨 · a3: 이미 하루씩 이월 승인됨 · a4: 보강을 이미 들음
  db.state.credits.push(
    { id: "c1", studentId: "s1", sourceKey: KEY("fri", "2026-11-06"), status: "REVOKED", makeupSessionId: null },
    { id: "c4", studentId: "s1", sourceKey: KEY("mon", "2026-11-16"), status: "USED", makeupSessionId: "ms1" },
  );
  db.state.attendance.push({ studentId: "s1", classId: "mon", date: "2026-11-09", status: "PRESENT" });
  db.state.reviews.push({ absenceId: "a3", status: "APPROVED", source: "STAFF" }, { absenceId: "a5", status: "PENDING", source: "PARENT" });
  db.state.resolutions.push("a3");
  const issuable = (ymd) => ymd >= "2026-10-05";

  const done = await admin.convertIllnessPeriodToMakeup(db, { periodId: "p1" }, "admin-1", issuable);
  // 대상 15일(이월 승인된 a3 제외) 중 출석한 a2 를 뺀 14일이 보강권으로 — 그중 보강을 이미 들은 a4 는 새 보강권 없음
  assert.deepEqual(done, { periodId: "p1", studentId: "s1", startDate: "2026-11-06", returnDate: null, converted: 14, creditsIssued: 13, attendedClosed: 1 });
  const review = (id) => db.state.reviews.find((item) => item.absenceId === id);
  assert.equal(review("a1").status, "MAKEUP");
  assert.equal(review("a1").convertReason, "REJECTED", "원장이 인정하지 않음");
  assert.equal(review("a2").status, "CLOSED", "그날 출석 — 보강권 없이 닫는다");
  assert.equal(review("a3").status, "APPROVED", "이미 이월 승인된 날은 그대로");
  assert.equal(review("a4").status, "MAKEUP");
  assert.equal(review("a5").status, "MAKEUP");
  assert.equal(db.state.credits.find((credit) => credit.id === "c1").status, "AVAILABLE", "거둬 둔 같은 한 장을 되살린다");
  assert.equal(db.state.credits.find((credit) => credit.id === "c4").status, "USED");
  assert.equal(db.state.credits.filter((credit) => credit.status === "AVAILABLE").length, 13);
  assert.ok(!db.state.credits.some((credit) => credit.sourceKey === KEY("mon", "2026-11-09")), "출석한 날은 보강권이 없다");
  // 결정 전인 날이 하나도 남지 않는다 → 신청함에서 «날짜별로 처리함»(완료)
  assert.equal((await admin.readIllnessPeriodDetail(db, "p1")).pendingCount, 0);
  assert.equal(db.state.periods[0].carryState, "NONE", "기간 상태는 그대로(인정하지 않았다)");
  assert.equal(db.state.audit.at(-1).action, "ILLNESS_PERIOD_TO_MAKEUP");
  assert.deepEqual(db.state.audit.at(-1).details, { periodId: "p1", studentId: "s1", converted: 14, creditsIssued: 13, attendedClosed: 1 });
  // 한 거래(Serializable) — 중간에 실패하면 전부 되돌아간다
  assert.equal(db.txOptions.isolationLevel, "Serializable");
  // 두 번 누르면 돌릴 것이 없다
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(db, { periodId: "p1" }, "admin-1", issuable), /보강권으로 돌릴 결석이 없습니다/);
  // 코드: 기존 함수를 그대로 부른다(규칙을 둘로 만들지 않는다)
  assert.match(read("src/lib/regular/illness-period-admin.ts"), /await convertIllnessToMakeupInTx\(tx, \{ absenceId: absence\.id, by: "ADMIN", actorUserId: actorId, issuable \}\)/);
});

test("보강권으로 전환: 승인된 기간·다른 사유·없는 기간·권한 없음은 거절하고, 도중에 실패하면 아무것도 남기지 않는다", async () => {
  const issuable = () => true;
  let db = sixteenDayPeriod(); db.state.periods[0].carryState = "APPROVED";
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(db, { periodId: "p1" }, "admin-1", issuable), /승인을 취소한 뒤 보강권으로/);
  db = sixteenDayPeriod(); db.state.periods[0].reason = "FAMILY_TRIP";
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(db, { periodId: "p1" }, "admin-1", issuable), /질병·부상으로 등록한 기간/);
  db = sixteenDayPeriod();
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(db, { periodId: "없는기간" }, "admin-1", issuable), /찾을 수 없습니다/);
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(db, { periodId: "p1" }, "", issuable), /관리자 확인/);
  assert.equal(db.state.reviews.length, 0);
  // 8번째 날에서 실패 → 앞의 7일도 되돌아간다
  let count = 0;
  const failing = sixteenDayPeriod();
  const execute = failing.$executeRawUnsafe;
  failing.$executeRawUnsafe = async (sql, ...values) => {
    if (/VALUES \(\$1, 'MAKEUP', 'STAFF'/.test(sql) && ++count === 8) throw new Error("연결 끊김");
    return execute(sql, ...values);
  };
  await assert.rejects(() => admin.convertIllnessPeriodToMakeup(failing, { periodId: "p1" }, "admin-1", issuable), /연결 끊김/);
  assert.equal(failing.state.reviews.length, 0);
  assert.equal(failing.state.credits.length, 0);
  assert.equal(failing.state.audit.length, 0);
});

test("승인 알림: 같은 학부모·같은 제목·같은 본문을 24시간 안에 보냈으면 다시 보내지 않는다", async () => {
  const db = fakeDb({ notifications: [
    { studentId: "s1", title: "부상 결석 인정", message: "11/6 ~ 결석을 부상 결석으로 인정했어요.", hoursAgo: 2 },
    { studentId: "s1", title: "부상 결석 인정", message: "10/1 ~ 결석을 부상 결석으로 인정했어요.", hoursAgo: 30 },
  ] });
  const sent = (message, studentId = "s1") => admin.parentNoticeSentRecently(db, { studentId, title: "부상 결석 인정", message });
  assert.equal(await sent("11/6 ~ 결석을 부상 결석으로 인정했어요."), true);
  assert.equal(await sent("10/1 ~ 결석을 부상 결석으로 인정했어요."), false, "24시간이 지났으면 다시 보낸다");
  assert.equal(await sent("11/20 ~ 결석을 부상 결석으로 인정했어요."), false, "다른 기간(본문이 다르다)");
  assert.equal(await sent("11/6 ~ 결석을 부상 결석으로 인정했어요.", "s2"), false, "다른 아이");
});

// ── 상세 ──────────────────────────────────────────────────────────────────

test("상세: 기간 한 묶음의 사진·반별 횟수·승인 가능 여부 — 금액은 없다", async () => {
  const db = sixteenDayPeriod();
  db.state.reviews.push({ absenceId: "a2", status: "PENDING", source: "PARENT", reasonText: "발목 골절(깁스 6주)" });
  let detail = await admin.readIllnessPeriodDetail(db, "p1");
  assert.equal(detail.carryState, "NONE");
  assert.equal(detail.blocker, null);
  assert.equal(detail.absenceCount, 16);
  assert.equal(detail.pendingCount, 16);
  assert.deepEqual(detail.photoIds, ["e1", "e2"]);
  assert.deepEqual(detail.classes, [{ className: "금요반", count: 8 }, { className: "월요반", count: 8 }]);
  assert.equal(detail.reasonText, "발목 골절(깁스 6주)");
  assert.equal(detail.parentReported, false);
  assert.ok(!Object.keys(detail).some((key) => /amount|tuition|carryTotal|won/i.test(key)), "이 단계 화면에는 금액이 없다");
  await admin.approveIllnessPeriod(db, { periodId: "p1", evidenceConfirmed: true }, "admin-1");
  detail = await admin.readIllnessPeriodDetail(db, "p1");
  assert.equal(detail.carryState, "APPROVED");
  assert.equal(detail.pendingCount, 0);
  assert.equal(detail.approvedYmd, "2026-11-15");
  assert.match(detail.blocker, /이미 승인/);
  // 없는 기간·다른 사유·칸 없는 DB 는 null(화면이 «찾을 수 없음»을 보인다)
  assert.equal(await admin.readIllnessPeriodDetail(db, "없는기간"), null);
  assert.equal(await admin.readIllnessPeriodDetail(sixteenDayPeriod({ periodCarry: false }), "p1"), null);
  const other = sixteenDayPeriod(); other.state.periods[0].reason = "FAMILY_TRIP";
  assert.equal(await admin.readIllnessPeriodDetail(other, "p1"), null);
  // 승인 시각(timestamptz)은 KST 로 한 번만 바꾼다
  assert.match(read("src/lib/regular/illness-period-admin.ts"), /to_char\(p\."carryApprovedAt" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "approvedYmd"/);
  assert.doesNotMatch(read("src/lib/regular/illness-period-admin.ts"), /AT TIME ZONE 'UTC'/);
});

// ── 신청함(목록·메뉴 숫자) — 실제 모듈을 가짜 prisma 로 돌린다 ──────────────────────

/** TS 모듈을 CommonJS 로 바꿔 가짜 의존성과 함께 실행한다(admin-inbox 는 prisma·react 를 부르므로 순수 로더로는 못 올린다) */
function compileModule(path, imports = {}) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Intl, Date, Number, Math, console, require: (name) => (name in imports ? imports[name] : require(name)) });
  return module.exports;
}

/** 신청함 모듈 + 그 모듈이 읽는 가짜 prisma. state.periodCarry / state.reviewReady 로 «칸·표 없는 DB»를 흉내 낸다 */
function loadInbox(state) {
  const kst = compileModule("src/lib/datetime/kst.ts");
  const catalog = compileModule("src/lib/requests/catalog.ts", { "../ui/statusTones.ts": compileModule("src/lib/ui/statusTones.ts") });
  const periodRules = compileModule("src/lib/regular/illnessPeriodRules.ts", { "@/lib/datetime/kst": kst });
  const sqls = [];
  const statusesIn = (sql) => (sql.match(/WHERE t\.raw = ANY\(ARRAY\[([^\]]*)\]/)?.[1] ?? "").split(",").map((value) => value.trim().replace(/'/g, "")).filter(Boolean);
  const liveIllness = (absence) => absence.status !== "CANCELLED" && absence.reason === ILLNESS && absence.date >= "2026-10-05";
  const reviewStatus = (absenceId) => state.reviews.find((review) => review.absenceId === absenceId)?.status ?? null;
  const prisma = {
    $queryRawUnsafe: async (sql) => {
      sqls.push(sql);
      // 칸이 없는 DB 에서 그 칸을 읽으면 실제 Postgres 는 오류를 낸다
      if (!state.periodCarry && /carryState/.test(sql)) throw new Error('column "carryState" does not exist');
      if (!state.reviewReady && /RegularAbsenceCarryReview/.test(sql)) throw new Error('relation "RegularAbsenceCarryReview" does not exist');
      // 메뉴 숫자(UNION ALL 한 번) — 없는 칸·표를 읽지 않는지만 위에서 보고 빈 결과
      if (/UNION ALL/.test(sql)) return [];
      const wanted = statusesIn(sql);
      // 표·칸이 없을 때 쓰는 빈 표
      if (/WHERE false\) x/.test(sql) || /WHERE false\s*\) t/.test(sql)) return [];
      if (/FROM "RegularAbsencePeriod" x/.test(sql)) {
        // 기간 한 줄 — 조건 문구가 있을 때만 그 조건으로 거른다
        assert.match(sql, /x\.reason = 'ILLNESS_INJURY' AND \(x\.status <> 'CANCELLED' OR x\."carryState" <> 'NONE'\)/);
        assert.match(sql, /pa\."periodId" = x\.id AND pa\.status <> 'CANCELLED' AND pa\.reason = 'ILLNESS_INJURY' AND pa\.date >= '2026-10-05'::date/);
        return state.periods
          .filter((period) => period.reason === ILLNESS && (period.status !== "CANCELLED" || period.carryState !== "NONE"))
          .map((period) => ({ period, days: state.absences.filter((absence) => absence.periodId === period.id && liveIllness(absence)) }))
          .filter(({ days }) => days.length > 0)
          .map(({ period, days }) => ({
            id: period.id,
            raw: period.carryState !== "NONE" ? period.carryState : days.some((day) => (reviewStatus(day.id) ?? "PENDING") === "PENDING") ? "PENDING" : "DAY_DONE",
            studentName: period.studentName, createdAt: "2026-11-06T01:00:00.000Z", targetDate: period.startDate,
            extra: { returnDate: period.returnDate ?? null, parentReported: Boolean(period.reportedByUserId), periodStatus: period.status, count: days.length,
              photoCount: state.evidence.filter((photo) => !photo.removed && state.absences.find((absence) => absence.id === photo.absenceId)?.periodId === period.id).length },
          }))
          .filter((row) => wanted.includes(row.raw));
      }
      if (/FROM "RegularAbsence" x/.test(sql) && /x\.reason = 'ILLNESS_INJURY'/.test(sql)) {
        // 하루짜리 목록 — «질병·부상 기간에 묶인 결석 제외» 문구가 있을 때만 뺀다
        const excludePeriod = /AND NOT EXISTS \(SELECT 1 FROM "RegularAbsencePeriod" illness_period\s+WHERE illness_period\.id = x\."periodId" AND \(illness_period\.reason = 'ILLNESS_INJURY' AND \(illness_period\.status <> 'CANCELLED' OR illness_period\."carryState" <> 'NONE'\)\)\)/.test(sql);
        return state.absences.filter(liveIllness)
          .filter((absence) => reviewStatus(absence.id) !== "CLOSED")
          .filter((absence) => {
            if (!excludePeriod) return true;
            const period = state.periods.find((item) => item.id === absence.periodId);
            return !(period && period.reason === ILLNESS && (period.status !== "CANCELLED" || period.carryState !== "NONE"));
          })
          .map((absence) => ({
            id: absence.id,
            raw: ["APPROVED", "MAKEUP"].includes(reviewStatus(absence.id)) ? reviewStatus(absence.id) : absence.date > state.today ? "WAITING" : "PENDING",
            studentName: absence.studentName ?? "원생", createdAt: "2026-11-06T01:00:00.000Z", targetDate: absence.date,
            extra: { className: absence.className, source: "STAFF", period: Boolean(absence.periodId), parentPeriod: false, photoCount: 0, creditStatus: null },
          }))
          .filter((row) => wanted.includes(row.raw));
      }
      if (/"TrialLead"/.test(sql)) return [{ trial: 0, enroll: 0 }];
      throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
    },
  };
  const inbox = compileModule("src/lib/requests/admin-inbox.ts", {
    react: { cache: (fn) => fn },
    "@/lib/auth/moneyAccess": { canSeeAllMoney: () => true },
    "@/lib/prisma": { prisma },
    "@/lib/studentVisibility": { notMergedStudent: (alias) => `${alias}."mergedIntoStudentId" IS NULL` },
    "@/lib/datetime/kst": kst,
    "@/lib/enrollment/admin-enrollment-edit": { notClosedByDeletedEnrollmentSql: () => "true" },
    "@/lib/operations-sync/rallyzRetirement": { externalSyncPendingSql: () => "false" },
    "@/lib/enrollment/pause-settlement": { settlementTablesReady: async () => false },
    "@/lib/requests/inbox-enrollment-change-group": { groupEnrollmentChangeInboxSql: (rows) => rows, PAUSE_GROUP_KEY_SQL: "NULL" },
    "@/lib/requests/catalog": catalog,
    "@/lib/requests/consult-inbox": { countConsultAction: async () => 0 },
    "@/lib/regular/illness-carry-tx": { illnessReviewReady: async () => state.reviewReady },
    "@/lib/regular/illnessCarryRules": compileModule("src/lib/regular/illnessCarryRules.ts", { "@/lib/datetime/kst": kst }),
    "@/lib/regular/absence-period-service": { periodCarryColumnsReady: async () => state.periodCarry },
    "@/lib/regular/illnessPeriodRules": periodRules,
    "@/lib/requests/inquiry-thread": { inquiryFollowUpFacts: async () => new Map() },
  });
  return { inbox, sqls };
}

/** 신청함 재료 — 윤수영 기간 16건 + 다른 아이의 하루짜리 질병 결석 1건 */
function inboxState(overrides = {}) {
  const base = sixteenDayPeriod().state;
  base.periods[0].studentName = "윤수영";
  base.absences.forEach((absence) => { absence.studentName = "윤수영"; });
  base.absences.push({ id: "single", periodId: null, studentId: "s2", studentName: "김하루", classId: "mon", className: "월요반", date: "2026-11-09", reason: ILLNESS, status: "REPORTED" });
  return { ...base, ...overrides };
}

const ILLNESS_KINDS = ["ILLNESS_CARRY", "ILLNESS_PERIOD"];
// 신청함 모듈은 별도 실행 공간(vm)에서 돌아 배열의 «틀»이 다르다 — 값만 견주려고 평범한 값으로 바꾼다
const plain = (value) => JSON.parse(JSON.stringify(value));

test("신청함: 기간 결석 16건이 «기간 한 줄»로 — 하루짜리 목록에는 하루짜리만 남는다", async () => {
  const state = inboxState();
  const { inbox } = loadInbox(state);
  const open = [
    ...(await inbox.getInboxRows({ bucket: "ACTION", kinds: ILLNESS_KINDS })).rows,
    ...(await inbox.getInboxRows({ bucket: "ONGOING", kinds: ILLNESS_KINDS })).rows,
  ];
  assert.equal(open.length, 2, "16줄이 아니라 기간 1줄 + 하루짜리 1줄");
  const period = open.find((row) => row.kind === "ILLNESS_PERIOD");
  assert.equal(period.id, "p1");
  assert.equal(period.studentName, "윤수영");
  assert.equal(period.title, "부상 결석");
  assert.equal(period.summary, "11/6 ~ · 16회 · 사진 2장");
  assert.equal(period.bucket, "ACTION");
  assert.equal(period.statusLabel, "승인 대기");
  assert.equal(period.detailHref, "/admin/inbox?kind=ILLNESS_PERIOD");
  assert.deepEqual(plain(period.facts), [["기간", "11/6 ~ 복귀 미정"], ["결석", "16회"], ["접수", "학원 등록(기간 결석)"], ["증빙", "사진 2장"]]);
  // 목록에는 사유 글·금액을 싣지 않는다
  assert.doesNotMatch(JSON.stringify(period), /발목|골절|원"/);
  const single = open.find((row) => row.kind === "ILLNESS_CARRY");
  assert.equal(single.id, "single");
  assert.equal(single.studentName, "김하루");

  // 승인하면 «인정 · 금액은 복귀 뒤»(진행 중)로 — 메뉴 «처리 필요» 숫자에서 빠진다
  state.periods[0].carryState = "APPROVED";
  for (const absence of state.absences.filter((item) => item.periodId === "p1")) state.reviews.push({ absenceId: absence.id, status: "APPROVED" });
  assert.equal((await inbox.getInboxRows({ bucket: "ACTION", kinds: ["ILLNESS_PERIOD"] })).rows.length, 0);
  const ongoing = (await inbox.getInboxRows({ bucket: "ONGOING", kinds: ["ILLNESS_PERIOD"] })).rows;
  assert.equal(ongoing.length, 1);
  assert.equal(ongoing[0].statusLabel, "인정 · 금액은 복귀 뒤");
  // 승인된 기간의 날짜들이 하루짜리 «완료(이월 승인)» 목록에 16줄로 다시 뜨지 않는다
  assert.equal((await inbox.getInboxRows({ bucket: "DONE", kinds: ["ILLNESS_CARRY"] })).rows.length, 0);
  assert.equal(inbox.summarizeCounts([{ kind: "ILLNESS_PERIOD", raw: "APPROVED", n: 1 }]).action, 0);
  assert.equal(inbox.summarizeCounts([{ kind: "ILLNESS_PERIOD", raw: "PENDING", n: 1 }]).byTab.CHANGE, 1);
});

test("신청함: 날짜를 전부 하루씩 처리한 기간은 «날짜별로 처리함»(완료), 살아 있는 결석이 없는 기간·다른 사유 기간은 올리지 않는다", async () => {
  const state = inboxState();
  for (const absence of state.absences.filter((item) => item.periodId === "p1")) state.reviews.push({ absenceId: absence.id, status: "MAKEUP" });
  // 여행 기간(다른 사유)의 질병 결석 하루 — 기간 줄이 아니라 하루짜리 목록에 남는다
  state.periods.push({ id: "trip", studentId: "s3", reason: "FAMILY_TRIP", status: "ACTIVE", carryState: "NONE", startDate: "2026-11-02", returnDate: "2026-11-12" });
  state.absences.push({ id: "trip-day", periodId: "trip", studentId: "s3", classId: "mon", date: "2026-11-09", reason: ILLNESS, status: "REPORTED" });
  // 전부 취소된 질병 기간
  state.periods.push({ id: "gone", studentId: "s4", reason: ILLNESS, status: "ACTIVE", carryState: "NONE", startDate: "2026-11-02", returnDate: null });
  state.absences.push({ id: "gone-day", periodId: "gone", studentId: "s4", classId: "mon", date: "2026-11-09", reason: ILLNESS, status: "CANCELLED" });
  const { inbox } = loadInbox(state);
  assert.equal((await inbox.getInboxRows({ bucket: "ACTION", kinds: ["ILLNESS_PERIOD"] })).rows.length, 0);
  const done = (await inbox.getInboxRows({ bucket: "DONE", kinds: ["ILLNESS_PERIOD"] })).rows;
  assert.deepEqual(plain(done.map((row) => [row.id, row.statusLabel])), [["p1", "날짜별로 처리함"]]);
  const singles = (await inbox.getInboxRows({ bucket: "ACTION", kinds: ["ILLNESS_CARRY"] })).rows.map((row) => row.id).sort();
  assert.deepEqual(plain(singles), ["single", "trip-day"]);
});

test("신청함: 승인한 뒤 등록 취소된 기간도 남는다 — «승인 취소»를 누를 곳이 있어야 한다", async () => {
  const state = inboxState();
  state.periods[0].carryState = "APPROVED"; state.periods[0].status = "CANCELLED";
  const { inbox } = loadInbox(state);
  const rows = (await inbox.getInboxRows({ bucket: "ONGOING", kinds: ["ILLNESS_PERIOD"] })).rows;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].facts.some(([label, value]) => label === "안내" && /등록 취소된 기간/.test(value)));
  // 승인 없이 등록 취소된 기간은 빠지고, 남은(보호된) 결석은 하루짜리 목록으로 돌아온다
  state.periods[0].carryState = "NONE";
  assert.equal((await inbox.getInboxRows({ bucket: "ACTION", kinds: ["ILLNESS_PERIOD"] })).rows.length, 0);
  assert.equal((await inbox.getInboxRows({ bucket: "ACTION", kinds: ["ILLNESS_CARRY"] })).rows.length, 4, "지난 날 3건 + 하루짜리 1건");
});

test("칸 없는 DB: 신청함·메뉴 숫자가 그대로 뜬다 — 기간 줄은 비우고 하루짜리 목록은 기간 결석을 빼지 않는다", async () => {
  const state = inboxState({ periodCarry: false });
  const { inbox, sqls } = loadInbox(state);
  const action = await inbox.getInboxRows({ bucket: "ACTION", kinds: ILLNESS_KINDS });
  const ongoing = await inbox.getInboxRows({ bucket: "ONGOING", kinds: ILLNESS_KINDS });
  assert.deepEqual(plain([action.failedKinds, ongoing.failedKinds]), [[], []], "조회 실패 없이");
  const rows = [...action.rows, ...ongoing.rows];
  assert.equal(rows.filter((row) => row.kind === "ILLNESS_PERIOD").length, 0);
  assert.equal(rows.filter((row) => row.kind === "ILLNESS_CARRY").length, 17, "예전처럼 날짜마다 한 줄(어디에도 안 뜨는 일이 없게)");
  assert.ok(!sqls.some((sql) => /carryState/.test(sql)), "없는 칸을 읽지 않는다");
  // 메뉴 숫자
  const counts = await inbox.getInboxCounts();
  assert.ok(counts, "메뉴 숫자가 null(숨김)로 떨어지지 않는다");
  assert.ok(!sqls.some((sql) => /carryState/.test(sql)));
  const legacySql = inbox.buildInboxCountsSql(false, false, true, true, false);
  assert.doesNotMatch(legacySql, /carryState/);
  assert.match(legacySql, /SELECT 'ILLNESS_PERIOD'::text AS kind[\s\S]{0,200}WHERE false\) x/);
  assert.match(legacySql, /SELECT 'ILLNESS_CARRY'::text AS kind/);
  // 칸이 있으면 두 종류 모두 새 식
  const readySql = inbox.buildInboxCountsSql(false, false, true, true, true);
  assert.match(readySql, /FROM "RegularAbsencePeriod" x/);
  assert.match(readySql, /AND NOT EXISTS \(SELECT 1 FROM "RegularAbsencePeriod" illness_period/);
  // 검토 표가 없는 DB — 두 종류 모두 비우고(검토 표를 읽지 않는다) 나머지는 그대로
  const noReview = inbox.buildInboxCountsSql(false, false, false, true, true);
  assert.doesNotMatch(noReview, /RegularAbsenceCarryReview/);
  assert.doesNotMatch(noReview, /carryState/);
  // 전부 예전 식(legacy=true)도 마찬가지
  assert.doesNotMatch(inbox.buildInboxCountsSql(true), /carryState|RegularAbsenceCarryReview/);
});

test("검토 표 없는 DB: 기간 줄만 비운다(신청함 전체가 죽지 않는다)", async () => {
  const state = inboxState({ reviewReady: false });
  const { inbox } = loadInbox(state);
  const result = await inbox.getInboxRows({ bucket: "ACTION", kinds: ILLNESS_KINDS });
  assert.deepEqual(plain(result.failedKinds), []);
  assert.deepEqual(plain(result.rows), []);
});

// ── 종류 등록·링크·화면 ────────────────────────────────────────────────────

test("종류 등록: 신청함 탭·작은 분류·어댑터·상세 칸·알림 링크가 모두 이어져 있다", async () => {
  const catalog = await loadTsModule("src/lib/requests/catalog.ts");
  assert.ok(catalog.isRequestKind("ILLNESS_PERIOD"));
  assert.equal(catalog.kindEntry("ILLNESS_PERIOD").adminHref, rules.ILLNESS_PERIOD_INBOX_HREF);
  assert.equal(rules.ILLNESS_PERIOD_INBOX_HREF, "/admin/inbox?kind=ILLNESS_PERIOD");
  assert.ok(readFileSync("src/app/admin/inbox/page.tsx", "utf8").includes("isRequestKind(params.kind)"), "«?kind=» 주소를 그 종류의 탭으로 연다");
  assert.equal(catalog.tabOfKind("ILLNESS_PERIOD"), "CHANGE");
  assert.ok(catalog.kindsOfTab("CHANGE", "ABSENCE").includes("ILLNESS_PERIOD"));
  assert.ok(catalog.kindsOfTab("CHANGE").includes("ILLNESS_PERIOD"));
  // 일괄 처리 대상이 아니다(증빙 확인이 필요하다)
  assert.ok(!catalog.BULK_ACTION_KINDS.includes("ILLNESS_PERIOD"));
  // 아직 만들지 않은 정산 상태는 지도에 없다 — 목록 SQL 이 읽지 않는다
  assert.deepEqual(catalog.statusesOf("ILLNESS_PERIOD").sort(), ["APPROVED", "DAY_DONE", "PENDING"]);

  const inbox = read("src/lib/requests/admin-inbox.ts");
  assert.equal((inbox.match(/^\s{4}kind: "ILLNESS_PERIOD",$/gm) ?? []).length, 1);
  const client = read("src/app/admin/inbox/InboxClient.tsx");
  assert.match(client, /const IllnessPeriodInboxDetail = dynamic\(\(\) => import\("\.\/IllnessPeriodInboxDetail"\)/);
  assert.match(client, /open\.kind === "ILLNESS_PERIOD" && \(\s*<IllnessPeriodInboxDetail key=\{keyOf\(open\)\} periodId=\{open\.id\}/);
  // 승인 뒤 «진행 중»으로 옮겨 가도 결과 문구를 보이려고 상세를 열어 둔다
  assert.match(client, /openSelection\.kind === "ILLNESS_PERIOD"/);
  // 학부모가 «여러 날» 질병·부상을 알리면 원장 알림이 기간 줄을 연다(칸이 없는 DB 는 예전 주소)
  assert.match(read("src/lib/regular/parent-absence-period.ts"), /periodCarryColumnsReady\(prisma\)\.catch\(\(\) => false\)\) \? ILLNESS_PERIOD_INBOX_HREF : ILLNESS_INBOX_HREF/);
});

test("상세 화면: 증빙 확인 체크 → 주 버튼 «부상 결석 승인» 하나, 승인 뒤 «승인 취소»(확인 창) — 금액·정산 버튼은 없다", () => {
  const detail = read("src/app/admin/inbox/IllnessPeriodInboxDetail.tsx");
  assert.match(detail, /disabled=\{pending \|\| !evidenceChecked\} onClick=\{approve\} className="academy-button-primary"/, "체크해야 승인 버튼이 켜진다");
  assert.equal((detail.match(/academy-button-primary/g) ?? []).length, 1, "주 버튼은 하나");
  // 인정하지 않는 기간을 닫는 길: 보조 버튼 «보강권으로 전환»(확인 창) — 결정 전인 날이 있을 때만
  assert.match(detail, /\{detail\.pendingCount > 0 && \(\s+<button type="button" disabled=\{pending\} onClick=\{\(\) => void toMakeup\(\)\} className="academy-button-secondary">보강권으로 전환<\/button>/);
  assert.match(detail, /confirmLabel: "보강권으로 전환",\s+tone: "primary"/);
  // 승인 취소 확인 창 글 = 실제 동작(거둔 보강권을 돌려준다)
  assert.match(detail, /detail\.heldCreditCount > 0 \? `승인하며 거둔 보강권 \$\{detail\.heldCreditCount\}장은 돌려줍니다/);
  assert.match(detail, /"부상 결석 승인"/);
  assert.match(detail, /hasPhotos \? "증빙 사진을 확인했습니다" : "증빙\(진단서·처방전 등\)을 직접 확인했습니다"/);
  assert.match(detail, /<label className="flex min-h-11 /, "체크 칸은 터치 44px");
  // 승인 취소는 위험 작업 — 기존 확인 창 부품
  assert.match(detail, /useAdminConfirm\(\)/);
  assert.match(detail, /confirmLabel: "승인 취소",\s+tone: "danger"/);
  assert.match(detail, /className="academy-button-danger">승인 취소<\/button>/);
  // 승인 뒤 안내 한 줄
  assert.equal(rules.PERIOD_APPROVED_ADMIN_NOTE, "금액은 복귀한 뒤 한 번에 정산해요");
  assert.match(detail, /PERIOD_APPROVED_ADMIN_NOTE/);
  // 이 단계에서는 만들지 않는다: 정산하기·발행 보류로 돌리기·예상 이월 금액
  assert.doesNotMatch(detail, /정산하기|발행 보류|예상 이월|toLocaleString|원<|canSeeAllMoney/);
  assert.match(detail, /\/api\/admin\/absence-evidence\//);
  // 아이콘 없이 글자 · 굵기 4단계 · 색은 토큰만
  assert.doesNotMatch(detail, /material-symbols|UiIcon|font-(extrabold|black)|#[0-9a-fA-F]{3,6}\b|lucide/);
  assert.match(detail, /var\(--color-academy-primary\)/);

  // 서버 액션: 둘 다 관리자 권한(원장·부원장) 확인이 맨 먼저, 문자·알림톡 없이 앱 알림만
  const action = read("src/app/actions/illness-period-admin.ts");
  for (const name of ["loadIllnessPeriodDetail", "approveIllnessPeriodAction", "cancelIllnessPeriodApprovalAction", "convertIllnessPeriodToMakeupAction"]) {
    assert.match(action, new RegExp(`export async function ${name}\\b[^\\n]*\\{\\n  (const admin = )?await requireAdmin\\(\\);`), name);
  }
  assert.doesNotMatch(action, /requireOwner|canSeeAllMoney/, "승인·승인 취소는 원장·부원장 모두");
  assert.match(action, /notifyParentsOfStudents\(\[studentId\], "ABSENCE", title, message, linkUrl\)/);
  // 같은 알림을 24시간 안에 보냈으면 다시 보내지 않는다 / «알림은 못 보냈어요» 분기는 없다(알림 함수는 실패를 알려 주지 않는다)
  assert.match(action, /const already = await parentNoticeSentRecently\(prisma, \{ studentId, title, message \}\)\.catch\(\(\) => false\);\s+if \(already\) return;/);
  assert.doesNotMatch(action, /알림은 못 보냈어요|notifyParentSafely/);
  assert.match(action, /`\$\{done\.converted\}회를 보강권으로 돌렸어요\./);
  for (const path of ["src/app/actions/illness-period-admin.ts", "src/lib/regular/illness-period-admin.ts"]) {
    assert.doesNotMatch(read(path), /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i, path);
    // Prisma ORM 기본 메서드 금지
    assert.doesNotMatch(read(path), /\.(findMany|findFirst|findUnique|create|update|upsert|delete|count)\(/, path);
    // 알림·로그에 사유 글(건강 정보)을 싣지 않는다
    for (const line of read(path).split("\n").filter((text) => /console\.(error|log|warn)\(|notifyParentsOfStudents\(|writeAudit\(/.test(text))) assert.doesNotMatch(line, /reasonText|note/, line.trim());
  }
  // 승인 한 번에 학부모 알림 한 번
  const approve = action.slice(action.indexOf("export async function approveIllnessPeriodAction"), action.indexOf("/** [승인 취소]"));
  assert.equal((approve.match(/notifyParentOnce\(/g) ?? []).length, 1);
});

test("학부모 화면: 승인된 기간의 상태 글자는 «부상 결석 인정 · 금액은 복귀 뒤 확정»(하루씩 이월 승인과 구분)", () => {
  assert.equal(rules.PERIOD_APPROVED_PARENT_LABEL, "부상 결석 인정 · 금액은 복귀 뒤 확정");
  const parent = read("src/lib/regular/parent-regular-absence.ts");
  const list = parent.slice(parent.indexOf("export async function getParentIllnessReviews"), parent.indexOf("export type UpcomingChild"));
  // 글자는 «검토 줄»이 아니라 기간 상태 기준 — 판정은 규칙 함수 한 곳
  assert.match(list, /const shown = parentPeriodDayStatus\(\{\s+reviewStatus: r\.status \?\? null, reason: r\.reason, periodCarryState: r\.periodCarryState \?\? null, settled: r\.settled === true,\s+\}\);/);
  assert.match(list, /statusLabel: amountPending \? PERIOD_APPROVED_PARENT_LABEL : illnessReviewLabel\(status\) \?\? ""/);
  const day = (reviewStatus, periodCarryState, settled = false, reason = ILLNESS) => rules.parentPeriodDayStatus({ reviewStatus, reason, periodCarryState, settled });
  // 승인된 기간: 검토 줄이 없는 날(승인 뒤 매일 연장)·검토 중(학부모 연장)·승인 모두 «인정»
  assert.deepEqual(day(null, "APPROVED"), { status: "APPROVED", amountPending: true });
  assert.deepEqual(day("PENDING", "APPROVED"), { status: "APPROVED", amountPending: true });
  assert.deepEqual(day("APPROVED", "APPROVED"), { status: "APPROVED", amountPending: true });
  // 하루씩 실제로 이월 적립된 날은 기존 «이월 승인» 그대로
  assert.deepEqual(day("APPROVED", "APPROVED", true), { status: "APPROVED", amountPending: false });
  // 보강권으로 전환된 날·승인되지 않은 기간·하루 결석·다른 사유는 검토 상태 그대로
  assert.deepEqual(day("MAKEUP", "APPROVED"), { status: "MAKEUP", amountPending: false });
  assert.deepEqual(day("PENDING", "NONE"), { status: "PENDING", amountPending: false });
  assert.deepEqual(day("APPROVED", null), { status: "APPROVED", amountPending: false });
  assert.deepEqual(day("PENDING", "APPROVED", false, "PERSONAL"), { status: "PENDING", amountPending: false });
  // 승인된 기간에 묶인 질병·부상 결석은 검토 줄이 없어도 목록에 올린다
  assert.match(list, /`OR \(r\."absenceId" IS NULL AND ra\.reason = '\$\{ILLNESS_REASON\}' AND \$\{periodCarrySql\} = 'APPROVED'\)`/);
  assert.match(list, /FROM "RegularAbsence" ra\s+LEFT JOIN "RegularAbsenceCarryReview" r ON r\."absenceId" = ra\.id/);
  // 검토 줄이 없는 날의 기준일 — 둘 다 timestamptz 라 KST 변환 한 번
  assert.match(list, /to_char\(COALESCE\(r\."requestedAt", ra\."createdAt"\) AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "requestedYmd"/);
  // 칸이 없는 DB 는 그 칸을 읽지 않는다(결석 화면이 빈 목록으로 떨어지지 않게) — 예전처럼 검토 줄이 있는 결석만
  assert.match(list, /const periodCarrySql = periodCarryReady\s+\? `\(SELECT ap\."carryState" FROM "RegularAbsencePeriod" ap WHERE ap\.id = ra\."periodId"\)`\s+: `NULL::text`/);
  assert.match(list, /const approvedPeriodDaySql = periodCarryReady\s+\? `OR[^`]+`\s+: "";/);
  assert.doesNotMatch(list, /reasonText/);
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /review\.amountPending \? PERIOD_APPROVED_PARENT_NOTE : "다음 달 수강료에서 1회분을 빼 드려요\."/);
  assert.match(client, /d\.carryAmountPending \? PERIOD_APPROVED_DAY_LABEL : illnessReviewLabel\(d\.carryReview\)/);
  assert.doesNotMatch(rules.PERIOD_APPROVED_PARENT_NOTE, /학원에 문의/);
});
