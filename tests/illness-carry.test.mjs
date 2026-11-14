import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 질병·부상 결석 «이월 검토»(2026-11-14 원장 결정표 a1~a8) — 실행 테스트.
//
// 규칙(순수)·트랜잭션 쓰기·cron·사진 권한을 «실제로 돌려» 본다. 가짜 DB 는 들어온 SQL 의 조건 문구를 읽어
// 그 조건이 있을 때만 걸러 준다 — 코드에서 조건(예: «올린 본인만»)이 빠지면 테스트가 깨진다.
// 학부모 신고·사유 변경·카카오 분기는 tests/absence-change-and-makeup-link.test.mjs,
// 이월 승인(기존 CARRY 규칙 재사용)은 tests/billing-workbench.test.mjs 에 있다.

const rules = await loadTsModule("src/lib/regular/illnessCarryRules.ts");
const carryTx = await loadTsModule("src/lib/regular/illness-carry-tx.ts");
const cron = await loadTsModule("src/lib/regular/illness-carry-cron.ts");
const access = await loadTsModule("src/lib/regular/illness-evidence-access.ts");
const sheet = await loadTsModule("src/lib/regular/attendance-absence-reason.ts");
const read = (path) => readFileSync(path, "utf8");
const migration = read("prisma/migrations/20261114130000_illness_carry_review/migration.sql");

const KEY = (classId, ymd) => `REGULAR:${classId}:${ymd}`;
const issuable = (ymd) => ymd >= "2026-10-05";

/** 결석·검토·증빙·보강권 표를 메모리에 들고 SQL 문구대로 답하는 가짜 DB */
function fakeDb(init = {}) {
  const db = {
    ready: true,
    absences: [],   // { id, studentId, classId, date, reason, status, note, reportedByUserId }
    reviews: [],    // { absenceId, status, source, reasonText, requestedYmd, decidedYmd, decidedBy, decidedByUserId, convertReason }
    evidence: [],   // { id, absenceId, storageBucket, storagePath, uploadedByUserId, removed, removedMinutes, purged }
    credits: [],    // { id, studentId, sourceKey, status, makeupSessionId, note }
    carried: [],    // 이월(CARRY)로 정산된 결석 id
    attendance: [], // 출결 { studentId, classId, date, status }
    students: [{ id: "s1", parentId: "p1" }, { id: "s9", parentId: "p9" }],
    today: "2026-11-14",
    calls: [],
    order: [],
    seq: 0,
    ...init,
  };
  // 여러 날 결석(기간): 같은 기간의 결석들은 사진을 함께 쓴다 / 기한 기준은 기간의 마지막(취소 안 된) 결석일
  const scopeIds = (absenceId) => {
    const me = db.absences.find((a) => a.id === absenceId);
    return me?.periodId ? db.absences.filter((a) => a.periodId === me.periodId).map((a) => a.id) : [absenceId];
  };
  const liveCount = (absenceId) => db.evidence.filter((e) => scopeIds(absenceId).includes(e.absenceId) && !e.removed).length;
  const anchorYmd = (absenceId) => {
    const me = db.absences.find((a) => a.id === absenceId);
    if (!me?.periodId) return me?.date;
    return db.absences.filter((a) => a.periodId === me.periodId && a.status !== "CANCELLED").map((a) => a.date).sort().pop() ?? me.date;
  };
  /** 증빙을 세는 SQL 은 반드시 «기간 한 묶음» 조각을 쓴다(그 결석에 붙은 사진만 세면 기간의 다른 날이 사진 없음으로 전환된다) */
  const assertScope = (sql) => assert.match(sql, /"absenceId" = \w+\.id OR \(\w+\."periodId" IS NOT NULL AND e\."absenceId" IN \(\s*SELECT period_absence\.id FROM "RegularAbsence" period_absence WHERE period_absence\."periodId" = \w+\."periodId"\)\)/);
  const assertAnchor = (sql) => assert.match(sql, /to_char\(COALESCE\(\(SELECT max\(period_last\.date\) FROM "RegularAbsence" period_last\s+WHERE period_last\."periodId" = ra\."periodId" AND period_last\.status <> 'CANCELLED'\), ra\.date\), 'YYYY-MM-DD'\) AS "absenceYmd"/);
  const parentOf = (studentId) => db.students.find((s) => s.id === studentId)?.parentId;

  db.$queryRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    // 2026-11-14: 청구 준비 읽기용 표 확인은 한 번에 묶어 묻는다(name 목록 → 표마다 found)
    if (/unnest\(\$1::text\[\]\) AS name/.test(sql)) return v[0].map((name) => ({ name, found: true }));
    if (/to_regclass/.test(sql)) {
      if (/RegularAbsenceCarryReview/.test(sql)) return [db.ready ? { review: "present", evidence: "present", found: "present" } : { review: null, evidence: null, found: null }];
      return [{ found: "present" }];
    }
    // 이월로 정산된 결석인가(기존 보상 가드)
    if (/JOIN "BillingAbsenceResolution" r ON r\."absenceId"=a\.id/.test(sql)) {
      return db.absences.filter((a) => a.studentId === v[0] && a.classId === v[1] && a.date === v[2] && db.carried.includes(a.id)).map((a) => ({ id: a.id }));
    }
    if (/FROM "RegularAbsence" WHERE id = \$1 FOR UPDATE/.test(sql)) {
      return db.absences.filter((a) => a.id === v[0]).map((a) => ({ studentId: a.studentId, classId: a.classId, absenceYmd: a.date, reason: a.reason, status: a.status }));
    }
    if (/SELECT status FROM "RegularAbsenceCarryReview" WHERE "absenceId" = \$1 FOR UPDATE/.test(sql)) {
      return db.reviews.filter((r) => r.absenceId === v[0]).map((r) => ({ status: r.status }));
    }
    if (/SELECT status FROM "MakeupCredit" WHERE "studentId" = \$1 AND "sourceKey" = \$2 FOR UPDATE/.test(sql)) {
      return db.credits.filter((c) => c.studentId === v[0] && c.sourceKey === v[1]).map((c) => ({ status: c.status }));
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM "RegularAbsenceEvidence" e JOIN "RegularAbsence" ra ON ra\.id = \$1/.test(sql)) {
      assertScope(sql);
      return [{ n: liveCount(v[0]) }];
    }
    // 그날 출석·지각으로 기록됐나 — Session.date 는 변환 없이 글자 그대로 비교한다
    if (/FROM "Attendance" a\s+JOIN "Session" se ON se\.id = a\."sessionId"/.test(sql)) {
      assert.match(sql, /to_char\(se\."date", 'YYYY-MM-DD'\) = \$3/);
      assert.doesNotMatch(sql, /AT TIME ZONE/);
      const wanted = /a\.status = 'ABSENT'/.test(sql) ? ["ABSENT"] : ["PRESENT", "LATE"];
      if (wanted[0] !== "ABSENT") assert.match(sql, /a\.status IN \('PRESENT', 'LATE'\)/);
      return db.attendance.filter((a) => a.studentId === v[0] && a.classId === v[1] && a.date === v[2] && wanted.includes(a.status)).map(() => ({ found: 1 }));
    }
    if (/INSERT INTO "MakeupCredit"/.test(sql)) {
      const found = db.credits.find((c) => c.studentId === v[0] && c.sourceKey === v[1]);
      if (!found) { const row = { id: `mc${++db.seq}`, studentId: v[0], sourceKey: v[1], status: "AVAILABLE", makeupSessionId: null, note: v[5] }; db.credits.push(row); return [{ id: row.id }]; }
      assert.match(sql, /"MakeupCredit"\.status = 'REVOKED' AND "MakeupCredit"\."makeupSessionId" IS NULL/);
      if (found.status === "REVOKED" && found.makeupSessionId == null) { found.status = "AVAILABLE"; found.note = v[5]; return [{ id: found.id }]; }
      return [];
    }
    // 출결 결석 때 보강권 자동 발급을 멈출 결석인가 — 조건 문구가 있을 때만 그 조건으로 거른다
    if (/FROM "RegularAbsence" ra\s+LEFT JOIN "RegularAbsenceCarryReview" r ON r\."absenceId" = ra\.id/.test(sql)) {
      assert.match(sql, /ra\.date = \$3::date/, "결석일은 date 칼럼 그대로 비교(시간대 변환 없음)");
      return db.absences.filter((a) => a.studentId === v[0] && a.classId === v[1] && a.date === v[2])
        .filter((a) => !/ra\.status <> 'CANCELLED'/.test(sql) || a.status !== "CANCELLED")
        .filter((a) => !/ra\.reason = \$4/.test(sql) || a.reason === v[3])
        .filter((a) => !/COALESCE\(r\.status, ''\) NOT IN \('MAKEUP', 'CLOSED'\)/.test(sql) || !["MAKEUP", "CLOSED"].includes(db.reviews.find((r) => r.absenceId === a.id)?.status))
        .map(() => ({ found: 1 }));
    }
    if (/FROM "RegularAbsenceCarryReview" r\s+JOIN "RegularAbsence" ra ON ra\.id = r\."absenceId"\s+WHERE ra\."studentId" = \$1 AND ra\."classId" = \$2 AND ra\.date = \$3::date\s+AND ra\.status <> 'CANCELLED' AND r\.status = 'CLOSED'/.test(sql)) {
      db.order.push("peek-closed");
      return db.absences.filter((a) => a.studentId === v[0] && a.classId === v[1] && a.date === v[2] && a.status !== "CANCELLED"
        && db.reviews.find((r) => r.absenceId === a.id)?.status === "CLOSED").map(() => ({ found: 1 }));
    }
    // cron ①: 7일 지난 검토 후보
    if (/FROM "RegularAbsenceCarryReview" r\s+JOIN "RegularAbsence" ra ON ra\.id = r\."absenceId"\s+WHERE r\.status = 'PENDING' AND r\.source IN \('PARENT', 'KAKAO'\)/.test(sql)) {
      // 결석일 기준 = 기간의 마지막 결석일(하루 결석이면 그 날) — date 칼럼이라 변환 없음. 사진은 기간 한 묶음으로 센다
      assertAnchor(sql);
      assertScope(sql);
      // timestamptz → KST 는 «한 번»만 건다. 오늘도 DB 시계의 KST 날짜
      assert.match(sql, /to_char\(r\."requestedAt" AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "requestedYmd"/);
      assert.match(sql, /to_char\(now\(\) AT TIME ZONE 'Asia\/Seoul', 'YYYY-MM-DD'\) AS "todayYmd"/);
      assert.doesNotMatch(sql, /AT TIME ZONE 'UTC'/);
      return db.reviews.filter((r) => r.status === "PENDING" && ["PARENT", "KAKAO"].includes(r.source))
        .map((r) => ({ absenceId: r.absenceId, status: r.status, source: r.source, photoCount: liveCount(r.absenceId), requestedYmd: r.requestedYmd, absenceYmd: anchorYmd(r.absenceId), todayYmd: db.today }));
    }
    // cron ②: 지울 사진 후보
    if (/FROM "RegularAbsenceEvidence" e\s+LEFT JOIN "RegularAbsenceCarryReview" r ON r\."absenceId" = e\."absenceId"\s+WHERE e\."purgedAt" IS NULL/.test(sql)) {
      assert.match(sql, /e\."removedAt" < now\(\) - interval '10 minutes'/, "방금 올리는 중인 예약 행은 건드리지 않는다");
      assert.match(sql, /r\.status IN \('APPROVED', 'MAKEUP', 'CLOSED'\)/, "검토 중(PENDING)인 사진은 지우지 않는다");
      return db.evidence.filter((e) => !e.purged).map((e) => {
        const review = db.reviews.find((r) => r.absenceId === e.absenceId);
        const decided = review && ["APPROVED", "MAKEUP", "CLOSED"].includes(review.status) ? review.decidedYmd : null;
        return { e, review, row: { id: e.id, storageBucket: e.storageBucket, storagePath: e.storagePath, removed: Boolean(e.removed), orphan: e.absenceId == null, decidedYmd: decided, todayYmd: db.today } };
      }).filter(({ e, row }) => (e.removed && (e.removedMinutes ?? 60) > 10) || row.orphan || row.decidedYmd != null).map(({ row }) => row);
    }
    // 사진 올리기 줄 세우기 잠금(따로 한 문장)
    // 여러 날 결석이면 기간 행을 먼저 잠근다(하루 결석은 0행)
    if (sql === access.EVIDENCE_PERIOD_LOCK_SQL) { db.order.push("period-lock"); return db.absences.find((a) => a.id === v[0])?.periodId ? [{ locked: 1 }] : []; }
    if (sql === access.EVIDENCE_LOCK_SQL) { db.order.push("lock"); db.onLock?.(); return [{ locked: 1 }]; }
    // 사진 권한: 학부모가 올릴 결석
    if (/FROM "RegularAbsence" ra\s+JOIN "Student" s ON s\.id = ra\."studentId"\s+JOIN "RegularAbsenceCarryReview" r ON r\."absenceId" = ra\.id/.test(sql)) {
      db.order.push("count");
      assert.doesNotMatch(sql, /FOR UPDATE/, "장수를 세는 문장에는 잠금을 붙이지 않는다(잠금은 앞 문장)");
      assertAnchor(sql);
      assertScope(sql);
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건(childAccessSql 조각)");
      assert.match(sql, /"mergedIntoId" IS NULL|mergedInto/i, "병합된 학생 제외");
      return db.absences.filter((a) => a.id === v[1] && parentOf(a.studentId) === v[0])
        .filter((a) => !/ra\.status <> 'CANCELLED'/.test(sql) || a.status !== "CANCELLED")
        .filter((a) => !/ra\.reason = 'ILLNESS_INJURY'/.test(sql) || a.reason === "ILLNESS_INJURY")
        .flatMap((a) => db.reviews.filter((r) => r.absenceId === a.id).map((r) => ({ absenceId: a.id, status: r.status, requestedYmd: r.requestedYmd, absenceYmd: anchorYmd(a.id), todayYmd: db.today, photoCount: liveCount(a.id) })));
    }
    // 사진 권한: 학부모가 열거나 지울 사진
    if (/FROM "RegularAbsenceEvidence" e\s+JOIN "RegularAbsence" ra ON ra\.id = e\."absenceId"\s+JOIN "Student" s/.test(sql)) {
      assert.match(sql, /s\."parentId" = \$1/, "보호자 조건(childAccessSql 조각)");
      return db.evidence.filter((e) => e.id === v[1])
        .filter((e) => !/e\."uploadedByUserId" = \$1/.test(sql) || e.uploadedByUserId === v[0])
        .filter((e) => !/e\."removedAt" IS NULL/.test(sql) || !e.removed)
        .filter((e) => !/e\."purgedAt" IS NULL/.test(sql) || !e.purged)
        .filter((e) => parentOf(db.absences.find((a) => a.id === e.absenceId)?.studentId) === v[0])
        .map((e) => { const r = db.reviews.find((x) => x.absenceId === e.absenceId); return { id: e.id, storageBucket: e.storageBucket, storagePath: e.storagePath, absenceId: e.absenceId, status: r?.status, requestedYmd: r?.requestedYmd, absenceYmd: anchorYmd(e.absenceId), todayYmd: db.today }; });
    }
    // 사진 권한: 관리자
    if (/FROM "RegularAbsenceEvidence" e\s+WHERE e\.id = \$1/.test(sql)) {
      return db.evidence.filter((e) => e.id === v[0])
        .filter((e) => !/e\."removedAt" IS NULL/.test(sql) || !e.removed)
        .filter((e) => !/e\."purgedAt" IS NULL/.test(sql) || !e.purged)
        .map((e) => ({ id: e.id, storageBucket: e.storageBucket, storagePath: e.storagePath, absenceId: e.absenceId }));
    }
    // 출석부 «질병·부상 표시»가 읽고 쓰는 결석 행
    if (/INSERT INTO "RegularAbsence"/.test(sql)) {
      const [studentId, classId, date, reason, status, note] = v;
      if (db.absences.some((a) => a.studentId === studentId && a.classId === classId && a.date === date)) return [];
      const row = { id: `ra${++db.seq}`, studentId, classId, date, reason, status, note, reportedByUserId: null };
      db.absences.push(row);
      return [{ id: row.id }];
    }
    if (/FROM "RegularAbsence" ra\s+WHERE ra\."studentId" = \$1 AND ra\."classId" = \$2 AND ra\.date = \$3::date/.test(sql)) {
      return db.absences.filter((a) => a.studentId === v[0] && a.classId === v[1] && a.date === v[2]).map((a) => ({ ...a, resolved: false }));
    }
    throw new Error(`예상하지 않은 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  };

  db.$executeRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    if (/pg_advisory_xact_lock/.test(sql)) { db.order.push("global-lock"); return 1; }
    if (/UPDATE "MakeupCredit"\s+SET status = 'REVOKED'/.test(sql)) {
      assert.match(sql, /"sourceKey" = \$2 AND status = 'AVAILABLE'/, "미사용(AVAILABLE)만 거둔다 — 예약·사용분은 건드리지 않는다");
      const c = db.credits.find((x) => x.studentId === v[0] && x.sourceKey === v[1] && x.status === "AVAILABLE");
      if (!c) return 0;
      c.status = "REVOKED"; c.note = v[2];
      return 1;
    }
    if (/INSERT INTO "RegularAbsenceCarryReview"/.test(sql)) {
      assert.match(sql, /WHERE "RegularAbsenceCarryReview"\.status IN \('PENDING', 'CLOSED'\)/, "끝난 결정(이월 승인·보강권 전환)은 덮어쓰지 않는다");
      const toMakeup = /VALUES \(\$1, 'MAKEUP', 'STAFF', now\(\), \$2, \$3, \$4\)/.test(sql);
      const found = db.reviews.find((r) => r.absenceId === v[0]);
      const decided = toMakeup ? { status: "MAKEUP", decidedYmd: db.today, decidedBy: v[1], decidedByUserId: v[2], convertReason: v[3] } : null;
      if (!found) {
        db.reviews.push(toMakeup
          ? { absenceId: v[0], source: "STAFF", reasonText: null, requestedYmd: db.today, ...decided }
          : { absenceId: v[0], status: "PENDING", source: v[1], reasonText: v[2], requestedYmd: db.today });
        return 1;
      }
      if (!["PENDING", "CLOSED"].includes(found.status)) return 0;
      if (toMakeup) Object.assign(found, decided);
      else if (found.status === "CLOSED") Object.assign(found, { status: "PENDING", source: v[1], reasonText: v[2], requestedYmd: db.today, decidedYmd: null, decidedBy: null, convertReason: null });
      else found.reasonText = v[2] ?? found.reasonText;
      return 1;
    }
    // 출석부가 취소됐던 결석 행을 질병·부상으로 되살린다
    if (/UPDATE "RegularAbsence"\s+SET reason = \$2, status = \$3, note = \$4/.test(sql)) {
      const row = db.absences.find((a) => a.id === v[0] && a.status === "CANCELLED");
      if (!row) return 0;
      Object.assign(row, { reason: v[1], status: v[2], note: v[3], reportedByUserId: null });
      return 1;
    }
    // 닫힌 검토 다시 열기(출석부가 질병·부상으로 다시 표시)
    if (/UPDATE "RegularAbsenceCarryReview" r\s+SET status = 'PENDING', "requestedAt" = now\(\)/.test(sql)) {
      assert.match(sql, /ra\.status <> 'CANCELLED' AND r\.status = 'CLOSED'/, "닫힌 검토만 다시 연다(검토 중·끝난 결정은 그대로)");
      db.order.push("reopen");
      assert.match(sql, /source = CASE WHEN ra\."reportedByUserId" IS NULL THEN 'STAFF' ELSE r\.source END/);
      let n = 0;
      for (const a of db.absences.filter((x) => x.studentId === v[0] && x.classId === v[1] && x.date === v[2] && x.status !== "CANCELLED")) {
        const r = db.reviews.find((x) => x.absenceId === a.id && x.status === "CLOSED");
        if (!r) continue;
        Object.assign(r, { status: "PENDING", requestedYmd: db.today, source: a.reportedByUserId ? r.source : "STAFF", decidedYmd: null, decidedBy: null, convertReason: null });
        n += 1;
      }
      return n;
    }
    if (/UPDATE "RegularAbsenceCarryReview"\s+SET status = 'CLOSED'/.test(sql)) {
      assert.match(sql, /status = ANY\(\$2::text\[\]\)/);
      const found = db.reviews.find((r) => r.absenceId === v[0] && v[1].includes(r.status));
      if (!found) return 0;
      Object.assign(found, { status: "CLOSED", decidedYmd: db.today });
      return 1;
    }
    // 검토를 닫을 때: 같은 기간에 살아 있는 형제(취소 안 된 결석의 검토 중·결정됨)가 있으면 사진을 그 결석으로 옮긴다(하루 결석은 0행)
    if (/UPDATE "RegularAbsenceEvidence" e SET "absenceId" = heir\.id/.test(sql)) {
      assert.match(sql, /sibling\."periodId" = me\."periodId" AND sibling\.id <> me\.id AND sibling\.status <> 'CANCELLED'/);
      assert.match(sql, /sr\.status IN \('PENDING', 'APPROVED', 'MAKEUP'\)/);
      assert.match(sql, /WHERE e\."absenceId" = \$1 AND e\."removedAt" IS NULL/);
      const me = db.absences.find((x) => x.id === v[0]);
      if (!me?.periodId) return 0;
      // 검토 중인 날 먼저, 그다음 이른 날짜(SQL 의 ORDER BY 그대로)
      assert.match(sql, /ORDER BY \(sr\.status = 'PENDING'\) DESC, sibling\.date, sibling\.id\s+LIMIT 1/);
      const statusOf = (x) => db.reviews.find((r) => r.absenceId === x.id)?.status;
      const heir = db.absences
        .filter((x) => x.periodId === me.periodId && x.id !== me.id && x.status !== "CANCELLED" && ["PENDING", "APPROVED", "MAKEUP"].includes(statusOf(x)))
        .sort((x, y) => (Number(statusOf(y) === "PENDING") - Number(statusOf(x) === "PENDING")) || x.date.localeCompare(y.date))[0];
      if (!heir) return 0;
      let n = 0;
      for (const e of db.evidence) if (e.absenceId === me.id && !e.removed) { e.absenceId = heir.id; n += 1; }
      return n;
    }
    if (/UPDATE "RegularAbsenceEvidence" SET "removedAt" = now\(\) WHERE "absenceId" = \$1 AND "removedAt" IS NULL/.test(sql)) {
      // (살아 있는 형제가 있으면 바로 앞 문장이 사진을 옮겨 갔다 — 여기 남은 것은 옮길 곳이 없는 사진뿐)
      let n = 0;
      for (const e of db.evidence) if (e.absenceId === v[0] && !e.removed) { e.removed = true; n += 1; }
      return n;
    }
    if (/UPDATE "RegularAbsenceEvidence" SET "purgedAt" = now\(\)/.test(sql)) {
      const e = db.evidence.find((x) => x.id === v[0] && !x.purged);
      if (!e) return 0;
      e.purged = true; e.removed = true;
      return 1;
    }
    throw new Error(`예상하지 않은 실행: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
  };

  /** 트랜잭션: 안에서 오류가 나면 표를 통째로 되돌린다 */
  db.$transaction = async (work) => {
    const snapshot = structuredClone({ absences: db.absences, reviews: db.reviews, evidence: db.evidence, credits: db.credits });
    try { return await work(db); } catch (error) { Object.assign(db, snapshot); throw error; }
  };
  return db;
}

const ABSENCE = { id: "a1", studentId: "s1", classId: "c1", date: "2026-11-09", reason: "ILLNESS_INJURY", status: "REPORTED" };
const pending = (extra = {}) => ({ absenceId: "a1", status: "PENDING", source: "PARENT", reasonText: "독감", requestedYmd: "2026-11-09", ...extra });
const photo = (id, extra = {}) => ({ id, absenceId: "a1", storageBucket: rules.EVIDENCE_BUCKET, storagePath: rules.evidenceStoragePath("a1", id), uploadedByUserId: "p1", removed: false, purged: false, ...extra });

// ═════════════════════════════════════════════════════════════════════════
// ① 규칙(순수)
// ═════════════════════════════════════════════════════════════════════════
test("상태 한 단어: 이월 검토 중 / 이월 승인 / 보강권으로 전환", () => {
  assert.equal(rules.illnessReviewLabel("PENDING"), "이월 검토 중");
  assert.equal(rules.illnessReviewLabel("APPROVED"), "이월 승인");
  assert.equal(rules.illnessReviewLabel("MAKEUP"), "보강권으로 전환");
  assert.equal(rules.illnessReviewLabel(null), null);
  assert.equal(rules.illnessReviewLabel("모르는값"), null);
});

test("사진 기간 7일: 알린 날 +7일 밤까지 올릴 수 있고, 그 다음 날부터 끝 — 자정·월말·연말·윤년 경계", () => {
  assert.equal(rules.EVIDENCE_WINDOW_DAYS, 7);
  assert.equal(rules.evidenceDeadlineYmd("2026-11-14"), "2026-11-21");
  // 마지막 날(11/21)은 아직 열려 있고 11/22 0시부터 닫힌다
  assert.equal(rules.isEvidenceWindowOver("2026-11-14", "2026-11-21"), false);
  assert.equal(rules.isEvidenceWindowOver("2026-11-14", "2026-11-22"), true);
  assert.equal(rules.isEvidenceWindowOver("2026-11-14", "2026-11-14"), false);
  // 월말·연말을 넘는 경우
  assert.equal(rules.evidenceDeadlineYmd("2026-11-27"), "2026-12-04");
  assert.equal(rules.isEvidenceWindowOver("2026-11-27", "2026-12-04"), false);
  assert.equal(rules.isEvidenceWindowOver("2026-11-27", "2026-12-05"), true);
  assert.equal(rules.evidenceDeadlineYmd("2026-12-28"), "2027-01-04");
  assert.equal(rules.isEvidenceWindowOver("2026-12-28", "2027-01-05"), true);
  // 윤년 2월(2028-02-29 가 있다) · 평년 2월
  assert.equal(rules.evidenceDeadlineYmd("2028-02-23"), "2028-03-01");
  assert.equal(rules.evidenceDeadlineYmd("2027-02-23"), "2027-03-02");
  // 날짜를 모르면 닫지 않는다(자동 전환은 되돌리기 어렵다)
  assert.equal(rules.isEvidenceWindowOver("", "2026-11-22"), false);
  assert.equal(rules.isEvidenceWindowOver("2026-11-14", "오늘"), false);
});

test("사진 추가·삭제 가능 여부: 검토 중 + 기간 안 + 3장 미만", () => {
  const open = { status: "PENDING", requestedYmd: "2026-11-14", todayYmd: "2026-11-21" };
  assert.equal(rules.EVIDENCE_MAX_PHOTOS, 3);
  assert.equal(rules.canAddEvidence({ ...open, photoCount: 0 }), true);
  assert.equal(rules.canAddEvidence({ ...open, photoCount: 2 }), true);
  assert.equal(rules.canAddEvidence({ ...open, photoCount: 3 }), false, "3장이 차면 더 못 올린다");
  assert.equal(rules.canEditEvidence(open), true, "3장이어도 지울 수는 있다(교체)");
  assert.equal(rules.canAddEvidence({ ...open, todayYmd: "2026-11-22", photoCount: 0 }), false, "7일이 지나면 못 올린다");
  for (const status of ["APPROVED", "MAKEUP", "CLOSED", null]) {
    assert.equal(rules.canAddEvidence({ ...open, status, photoCount: 0 }), false, `${status} 는 못 올린다`);
    assert.equal(rules.canEditEvidence({ ...open, status }), false);
  }
});

test("7일 기준점 = 알린 날과 결석일 중 더 늦은 날 — 미리 알린 결석은 결석일부터 7일(올리기·자동 전환·기한 안내가 같은 함수)", () => {
  assert.equal(rules.evidenceBaseYmd("2026-11-14", "2026-12-05"), "2026-12-05", "3주 뒤 결석을 미리 알림 → 결석일 기준");
  assert.equal(rules.evidenceBaseYmd("2026-11-14", "2026-11-14"), "2026-11-14", "당일");
  assert.equal(rules.evidenceBaseYmd("2026-11-14", "2026-11-09"), "2026-11-14", "결석 뒤에 생긴 검토(학원 등록 등) → 알린 날 기준");
  assert.equal(rules.evidenceBaseYmd("2026-11-14", null), "2026-11-14");
  assert.equal(rules.evidenceBaseYmd("2026-11-14", "날짜아님"), "2026-11-14", "결석일을 모르면 알린 날 그대로");
  // 기한 안내(화면 «○월 ○일까지»)
  assert.equal(rules.evidenceDeadlineYmd("2026-11-14", "2026-12-05"), "2026-12-12");
  assert.equal(rules.evidenceDeadlineYmd("2026-11-14", "2026-11-09"), "2026-11-21");
  // 월말·연말을 넘는 결석일
  assert.equal(rules.evidenceDeadlineYmd("2026-12-01", "2026-12-28"), "2027-01-04");
  // 올리기: 결석일 전에도, 결석일 +7일 밤까지 열려 있다
  const early = { status: "PENDING", requestedYmd: "2026-11-14", absenceYmd: "2026-12-05", photoCount: 0 };
  assert.equal(rules.canAddEvidence({ ...early, todayYmd: "2026-11-22" }), true, "알린 날 +8일 — 예전 기준이면 닫혔을 날");
  assert.equal(rules.canAddEvidence({ ...early, todayYmd: "2026-12-12" }), true, "결석일 +7일(마지막 날)");
  assert.equal(rules.canAddEvidence({ ...early, todayYmd: "2026-12-13" }), false);
  assert.equal(rules.canEditEvidence({ ...early, todayYmd: "2026-12-13" }), false);
  // 자동 전환: 결석일이 오기 전에는 절대 전환하지 않는다
  const auto = { status: "PENDING", source: "PARENT", photoCount: 0, requestedYmd: "2026-11-14", absenceYmd: "2026-12-05" };
  assert.equal(rules.shouldAutoConvertToMakeup({ ...auto, todayYmd: "2026-11-22" }), false, "결석일 전");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...auto, todayYmd: "2026-12-05" }), false, "결석 당일");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...auto, todayYmd: "2026-12-12" }), false, "마지막 날");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...auto, todayYmd: "2026-12-13" }), true, "마지막 날 다음 날 자정 뒤");
  // 호출부가 모두 결석일을 넘긴다
  // (여러 날 결석은 기간의 마지막 결석일이 기준 — anchorYmd)
  assert.match(read("src/lib/regular/parent-regular-absence.ts"), /evidenceDeadlineYmd\(r\.requestedYmd, anchorYmd\)/);
  assert.match(read("src/lib/regular/parent-regular-absence.ts"), /requestedYmd: r\.requestedYmd, absenceYmd: anchorYmd, todayYmd: today/);
  assert.equal((read("src/lib/regular/illness-evidence-access.ts").match(/\$\{evidenceAnchorYmdSql\("ra"\)\} AS "absenceYmd"/g) ?? []).length, 2);
});

test("cron 자동 전환: 미리 알린 결석은 결석일 +7일이 지나야 전환된다(결석일 전에는 그대로)", async () => {
  const seed = (today) => fakeDb({ today, absences: [{ ...ABSENCE, date: "2026-12-05" }], reviews: [pending({ requestedYmd: "2026-11-14" })] });
  for (const today of ["2026-11-22", "2026-12-05", "2026-12-12"]) {
    const db = seed(today);
    assert.equal((await cron.autoConvertOverdueIllnessReviews(db, issuable)).converted.length, 0, today);
    assert.equal(db.reviews[0].status, "PENDING");
    assert.equal(db.credits.length, 0);
  }
  const due = seed("2026-12-13");
  assert.deepEqual((await cron.autoConvertOverdueIllnessReviews(due, issuable)).converted, [{ studentId: "s1", absenceYmd: "2026-12-05", creditIssued: true }]);
});

test("관리자가 검토 중 결석을 취소했는데 그날 출결이 결석이면 거둬 둔 보강권을 되살린다(예전 동작과 같게)", async () => {
  const key = { studentId: "s1", classId: "c1", absenceYmd: "2026-11-09", issuable };
  const held = () => ({ id: "mc0", studentId: "s1", sourceKey: KEY("c1", "2026-11-09"), status: "REVOKED", makeupSessionId: null });
  const att = (status) => [{ studentId: "s1", classId: "c1", date: "2026-11-09", status }];
  // 출결 결석 → 같은 한 장을 되살린다
  const absent = fakeDb({ credits: [held()], attendance: att("ABSENT") });
  assert.deepEqual(await carryTx.ensureCreditForAbsentAfterCancelInTx(absent, key), { restored: true });
  assert.deepEqual(absent.credits.map((c) => [c.id, c.status]), [["mc0", "AVAILABLE"]]);
  // 검토 중에 처음부터 보강권이 없던 결석(질병·부상으로 바로 알림) → 새로 한 장
  const none = fakeDb({ attendance: att("ABSENT") });
  assert.deepEqual(await carryTx.ensureCreditForAbsentAfterCancelInTx(none, key), { restored: true });
  assert.equal(none.credits.length, 1);
  // 출결이 없거나 출석이면 아무것도 하지 않는다(신고 취소 = 결석이 없던 일)
  for (const attendance of [[], att("PRESENT"), att("LATE")]) {
    const db = fakeDb({ credits: [held()], attendance });
    assert.deepEqual(await carryTx.ensureCreditForAbsentAfterCancelInTx(db, key), { restored: false });
    assert.equal(db.credits[0].status, "REVOKED");
  }
  // 발급 시작일 전 결석·이월로 정산된 결석은 되살리지 않는다
  assert.deepEqual(await carryTx.ensureCreditForAbsentAfterCancelInTx(fakeDb({ attendance: [{ studentId: "s1", classId: "c1", date: "2026-10-01", status: "ABSENT" }] }), { ...key, absenceYmd: "2026-10-01" }), { restored: false });
  const carried = fakeDb({ absences: [{ ...ABSENCE }], carried: ["a1"], attendance: att("ABSENT") });
  assert.deepEqual(await carryTx.ensureCreditForAbsentAfterCancelInTx(carried, key), { restored: false });
  // 호출부: 검토를 닫은 경우에만, 보강권 되돌리기(settle) 뒤에 같은 거래에서 부른다
  const action = read("src/app/actions/regular-absence-admin.ts");
  const body = action.slice(action.indexOf("export async function cancelRegularAbsenceByAdmin"), action.indexOf("// ── 4) 보강 지정"));
  assert.match(body, /const review = await illnessReviewReady\(tx\) \? await closeIllnessReviewInTx\(tx, id, \{ canceled: true \}\) : \{ closed: false \};/);
  assert.match(body, /if \(review\.closed\) \{\s*await ensureCreditForAbsentAfterCancelInTx\(tx, \{[\s\S]{0,160}issuable: isMakeupCreditIssuableYmd,/);
  assert.ok(body.indexOf("settleCreditOnAbsenceCancel(tx,") < body.indexOf("ensureCreditForAbsentAfterCancelInTx(tx,"));
});

test("출석부가 질병·부상으로 다시 표시하면 닫혔던 검토를 다시 열어 신청함 «이월 검토»에 다시 뜬다", async () => {
  const key = { studentId: "s1", classId: "c1", dateYmd: "2026-11-09" };
  const db = fakeDb({ today: "2026-11-20", absences: [{ ...ABSENCE, status: "CANCELLED", note: null, reportedByUserId: "p1" }], reviews: [pending({ status: "CLOSED" })] });
  const applied = await sheet.applyAttendanceAbsenceReasonInTx(db, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: "admin1" });
  assert.equal(applied.plan, "REACTIVATE");
  // 되살아난 행은 출석부 행(학부모 표시 없음) → 학원 등록으로 바뀌어 7일 자동 전환 대상이 아니다. 기준점은 지금
  assert.deepEqual([db.reviews[0].status, db.reviews[0].source, db.reviews[0].requestedYmd], ["PENDING", "STAFF", "2026-11-20"]);

  // ③ 학부모가 알린 결석: 그날 출석으로 기록돼 검토가 자동으로 닫힌 뒤, 출결을 결석+질병·부상으로 정정하면 다시 열린다
  const parent = fakeDb({
    today: "2026-11-20", absences: [{ ...ABSENCE, note: null, reportedByUserId: "p1" }], reviews: [pending({ status: "CLOSED" })],
    credits: [{ id: "mc0", studentId: "s1", sourceKey: KEY("c1", "2026-11-09"), status: "AVAILABLE", makeupSessionId: null }],
  });
  const again = await sheet.applyAttendanceAbsenceReasonInTx(parent, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: null });
  assert.equal(again.plan, "NONE", "결석 행 자체는 바꿀 것이 없다");
  assert.deepEqual([parent.reviews[0].status, parent.reviews[0].source], ["PENDING", "PARENT"], "학부모 신고는 출처 그대로");
  assert.equal(parent.credits[0].status, "REVOKED", "다시 검토 중 — 보강권은 거둬 둔다");
  // 잠금 순서(코드 리뷰): 닫힌 검토 유무를 잠금 없이 먼저 보고 → 전역 잠금 → 다시 열기(다른 경로와 같은 «전역 잠금 → 검토 행»)
  assert.deepEqual(parent.order.filter((step) => ["peek-closed", "global-lock", "reopen"].includes(step)), ["peek-closed", "global-lock", "reopen"]);
  assert.equal(await carryTx.isIllnessCreditHeld(parent, { studentId: "s1", classId: "c1", absenceYmd: "2026-11-09" }), true);
  // 사유 표시 없이 결석만 찍으면(또는 검토가 닫혀 있지 않으면) 건드리지 않는다
  const plain = fakeDb({ absences: [{ ...ABSENCE, note: null, reportedByUserId: "p1" }], reviews: [pending({ status: "CLOSED" })] });
  await sheet.applyAttendanceAbsenceReasonInTx(plain, { ...key, attendanceStatus: "ABSENT", intent: undefined, confirmedByUserId: null });
  assert.equal(plain.reviews[0].status, "CLOSED");
  // 닫힌 검토가 없으면 전역 잠금을 잡지 않는다(대부분의 출석 저장이 여기다)
  const none = fakeDb({ absences: [{ ...ABSENCE, note: null, reportedByUserId: "p1" }], reviews: [pending()] });
  await sheet.applyAttendanceAbsenceReasonInTx(none, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: null });
  assert.deepEqual(none.order.filter((step) => ["peek-closed", "global-lock", "reopen"].includes(step)), ["peek-closed"]);
  // 검토 중·끝난 결정은 지우지 않는다
  for (const status of ["PENDING", "APPROVED", "MAKEUP"]) {
    const keep = fakeDb({ absences: [{ ...ABSENCE, status: "CANCELLED", note: null, reportedByUserId: "p1" }], reviews: [pending({ status })] });
    await sheet.applyAttendanceAbsenceReasonInTx(keep, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: "admin1" });
    assert.equal(keep.reviews[0].status, status);
  }
});

test("cron 실패 알림: 전환 실패·알림 실패·사진 삭제 실패(5건 이상)는 cron 오류 알림으로 올리고, 알림 한 건 실패가 나머지를 막지 않는다", () => {
  const route = read("src/app/api/cron/makeup-credits/route.ts");
  assert.match(route, /for \(const item of result\.converted\) \{[\s\S]{0,400}try \{\s*await notifyParentsOfStudents\([\s\S]{0,500}\} catch \(error\) \{\s*notifyFailed \+= 1;/);
  assert.match(route, /if \(result\.failed > 0\) errors\.push\(`자동 전환 \$\{result\.failed\}건 실패`\);/);
  assert.match(route, /if \(notifyFailed > 0\) errors\.push\(`전환 알림 \$\{notifyFailed\}건 실패`\);/);
  // 여러 실패는 한 문장(건수 포함)으로 합쳐 던진다 — 첫 실패만 알리지 않는다
  assert.match(route, /if \(errors\.length > 0\) throw new Error\(`질병·부상 결석 정리: \$\{errors\.join\(" · "\)\}`\);/);
  assert.match(route, /const EVIDENCE_PURGE_ALERT_AT = 5;/);
  assert.match(route, /if \(evidence\.failed >= EVIDENCE_PURGE_ALERT_AT\) errors\.push\(`증빙 사진 삭제 \$\{evidence\.failed\}건 실패`\);/);
  // 마지막에 던져 withCronAlert(원장 슬랙)이 받는다 — 그 전에 보강권 소멸·전환·삭제는 모두 끝까지 돈다
  assert.ok(route.indexOf("if (errors.length > 0) throw new Error(") > route.indexOf("purgeIllnessEvidence(prisma"));
  assert.match(route, /export const GET = withCronAlert\("makeup-credits", handleGet\);/);
  // 오류 글에 건강 정보·이름이 없다(건수만)
  for (const line of route.split("\n").filter((l) => l.includes("errors.push("))) assert.doesNotMatch(line, /reasonText|studentName|absenceYmd|error\.message/);
});

test("청구 준비 화면에서 검토 중 결석을 «보강»으로 정산하려 하면 신청함의 [보강권으로]를 안내한다", () => {
  assert.match(read("src/lib/billing/workbench-absence.ts"), /과거 결석의 보강권을 소급 발급하지 않습니다\. 질병·부상 이월 검토 중인 결석은 신청함의 \[보강권으로\]를 눌러 주세요\.",409\)/);
});

// ── 여러 날 결석(기간, 2026-11-15): 증빙은 기간 한 묶음 · 기한은 기간의 마지막 결석일 기준 ──
const PERIOD = [
  { ...ABSENCE, id: "d1", date: "2026-11-16", periodId: "per1" },
  { ...ABSENCE, id: "d2", date: "2026-11-23", periodId: "per1" },
  { ...ABSENCE, id: "d3", date: "2026-11-30", periodId: "per1" },
];
const periodReviews = (extra = {}) => PERIOD.map((a) => pending({ absenceId: a.id, requestedYmd: "2026-11-14", ...extra }));

test("여러 날 결석: 기간의 한 날에 올린 사진이 기간 전체에 쓰인다 — 장수 3장도 기간 전체로, 기한은 마지막 결석일 +7일", async () => {
  const db = fakeDb({ today: "2026-12-07", absences: PERIOD.map((a) => ({ ...a })), reviews: periodReviews(), evidence: [photo("e1", { absenceId: "d1" })] });
  // 어느 날짜로 물어도 사진 1장·기준일은 11/30(마지막 결석일)
  for (const id of ["d1", "d2", "d3"]) {
    const target = await access.findEvidenceTargetForParent(db, ACCESS, "p1", id);
    assert.deepEqual([target.photoCount, target.absenceYmd], [1, "2026-11-30"], id);
    assert.equal(access.evidenceAddRefusal(target), null, "12/7 = 마지막 결석일 +7일(마지막 날)까지 올릴 수 있다");
  }
  // 기간 전체로 3장이 차면 어느 날짜에도 더 못 올린다
  db.evidence.push(photo("e2", { absenceId: "d2" }), photo("e3", { absenceId: "d3" }));
  assert.match(access.evidenceAddRefusal(await access.findEvidenceTargetForParent(db, ACCESS, "p1", "d1")), /3장까지/);
  // 12/8 부터는 닫힌다(날짜마다 따로가 아니라 기간 단위로 한 번에)
  db.today = "2026-12-08";
  for (const id of ["d1", "d3"]) assert.match(access.evidenceAddRefusal({ ...(await access.findEvidenceTargetForParent(db, ACCESS, "p1", id)), photoCount: 0 }), /지났어요/, id);
});

test("여러 날 결석 자동 전환: 사진이 한 장이라도 있으면 기간의 어느 날도 전환하지 않고, 없으면 마지막 결석일 +7일 뒤 한 번에 전환한다", async () => {
  // 사진 1장(첫 날에 붙음) — 3주 뒤에도 기간의 다른 날이 «사진 없음»으로 전환되지 않는다
  const withPhoto = fakeDb({ today: "2026-12-20", absences: PERIOD.map((a) => ({ ...a })), reviews: periodReviews(), evidence: [photo("e1", { absenceId: "d1" })] });
  assert.equal((await cron.autoConvertOverdueIllnessReviews(withPhoto, issuable)).converted.length, 0);
  assert.deepEqual(withPhoto.reviews.map((r) => r.status), ["PENDING", "PENDING", "PENDING"]);
  // 사진 없음 — 첫 결석일(11/16)+7일이 지나도 기간이 끝나기 전에는 전환하지 않는다
  for (const today of ["2026-11-24", "2026-11-30", "2026-12-07"]) {
    const db = fakeDb({ today, absences: PERIOD.map((a) => ({ ...a })), reviews: periodReviews() });
    assert.equal((await cron.autoConvertOverdueIllnessReviews(db, issuable)).converted.length, 0, today);
  }
  const due = fakeDb({ today: "2026-12-08", absences: PERIOD.map((a) => ({ ...a })), reviews: periodReviews() });
  assert.deepEqual((await cron.autoConvertOverdueIllnessReviews(due, issuable)).converted.map((c) => c.absenceYmd), ["2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.equal(due.credits.length, 3, "날짜마다 보강권 1장(하루 신고와 같은 결과)");
  // «복귀했어요»로 뒤 날짜가 취소되면 기준일도 앞당겨진다(남은 마지막 결석일 11/16 +7일 = 11/23)
  const returned = fakeDb({ today: "2026-11-24", absences: PERIOD.map((a, i) => ({ ...a, status: i === 0 ? "REPORTED" : "CANCELLED" })), reviews: [pending({ absenceId: "d1", requestedYmd: "2026-11-14" })] });
  assert.deepEqual((await cron.autoConvertOverdueIllnessReviews(returned, issuable)).converted.map((c) => c.absenceYmd), ["2026-11-16"]);
});

test("여러 날 결석: 한 날의 검토를 닫아도 기간의 다른 날이 쓰는 사진은 남고, 마지막 검토가 닫힐 때 빠진다", async () => {
  const db = fakeDb({ absences: PERIOD.map((a) => ({ ...a })), reviews: periodReviews(), evidence: [photo("e1", { absenceId: "d1" })] });
  db.absences[0].status = "CANCELLED";
  await carryTx.closeIllnessReviewInTx(db, "d1", { canceled: true }); // 사진이 붙은 날을 취소
  // 사진은 살아 있는 형제(가장 이른 d2)로 옮겨 간다 — 기간의 증빙은 그대로이고, 학부모가 계속 지우거나 바꿀 수 있다
  assert.deepEqual([db.evidence[0].absenceId, db.evidence[0].removed], ["d2", false]);
  assert.equal((await access.findEvidenceTargetForParent(db, ACCESS, "p1", "d3")).photoCount, 1);
  const stillMine = await access.findEvidenceForParent(db, ACCESS, "p1", "e1");
  assert.equal(stillMine.status, "PENDING", "사진이 붙은 결석의 검토가 살아 있어 삭제·교체(canEditEvidence)가 계속 된다");
  assert.equal(rules.canEditEvidence(stillMine), true);
  db.absences[1].status = "CANCELLED";
  await carryTx.closeIllnessReviewInTx(db, "d2", { canceled: true });
  assert.deepEqual([db.evidence[0].absenceId, db.evidence[0].removed], ["d3", false], "d3 가 아직 검토 중 — 다시 옮겨 간다");
  // 기간의 마지막 검토가 닫히면 옮길 곳이 없어 사진도 빠진다(전부 취소 뒤 진단서 사진이 살아남지 않는다)
  db.absences[2].status = "CANCELLED";
  await carryTx.closeIllnessReviewInTx(db, "d3", { canceled: true });
  assert.deepEqual(db.reviews.map((r) => r.status), ["CLOSED", "CLOSED", "CLOSED"]);
  assert.equal(db.evidence[0].removed, true, "전부 취소 뒤 살아 있는 사진 0장");
  assert.equal((await access.findEvidenceForAdmin(db, "e1")), null, "관리자도 더는 열 수 없다(파일은 cron 이 지운다)");
  // 결정이 난 날(이월 승인·보강권 전환)이 남아 있으면 그 증빙이므로 남긴다
  for (const kept of ["APPROVED", "MAKEUP"]) {
    const part = fakeDb({ absences: PERIOD.map((a) => ({ ...a })), reviews: [...periodReviews().slice(0, 2), pending({ absenceId: "d3", status: kept })], evidence: [photo("e1", { absenceId: "d1" })] });
    await carryTx.closeIllnessReviewInTx(part, "d1", { canceled: true });
    await carryTx.closeIllnessReviewInTx(part, "d2", { canceled: true });
    assert.deepEqual([part.evidence[0].absenceId, part.evidence[0].removed], ["d3", false], `${kept}: 결정이 난 날로 옮겨 가 그 증빙으로 남는다`);
  }
  // 하루 결석(기간 없음)은 예전 그대로 — 닫으면 바로 뺀다
  const single = fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending()], evidence: [photo("e1")] });
  await carryTx.closeIllnessReviewInTx(single, "a1");
  assert.equal(single.evidence[0].removed, true);
});

test("여러 날 결석: 닫힌 날의 사진은 «검토 중인 날»로 먼저 옮긴다 — 결정이 끝난 날로 가면 학부모가 지우거나 바꿀 수 없다", async () => {
  // d2(11/23) 는 이미 이월 승인, d3(11/30) 은 검토 중 — 날짜로는 d2 가 이르지만 d3 로 간다
  const db = fakeDb({
    absences: PERIOD.map((a) => ({ ...a })),
    reviews: [pending({ absenceId: "d1", requestedYmd: "2026-11-14" }), pending({ absenceId: "d2", status: "APPROVED" }), pending({ absenceId: "d3", requestedYmd: "2026-11-14" })],
    evidence: [photo("e1", { absenceId: "d1" })],
  });
  await carryTx.closeIllnessReviewInTx(db, "d1", { canceled: true });
  assert.deepEqual([db.evidence[0].absenceId, db.evidence[0].removed], ["d3", false]);
  assert.equal(rules.canEditEvidence(await access.findEvidenceForParent(db, ACCESS, "p1", "e1")), true);
  // 검토 중인 날이 없으면 결정이 끝난 날로(그 결정의 증빙으로 남는다)
  await carryTx.closeIllnessReviewInTx(db, "d3", { canceled: true });
  assert.deepEqual([db.evidence[0].absenceId, db.evidence[0].removed], ["d2", false]);
});

test("자동 전환 대상: 학부모가 알린 검토 중 + 사진 0장 + 7일 지남일 때만", () => {
  const base = { status: "PENDING", source: "PARENT", photoCount: 0, requestedYmd: "2026-11-14", todayYmd: "2026-11-22" };
  assert.equal(rules.shouldAutoConvertToMakeup(base), true);
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, source: "KAKAO" }), true);
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, todayYmd: "2026-11-21" }), false, "마지막 날은 아직");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, photoCount: 1 }), false, "사진이 있으면 원장이 고른다");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, source: "STAFF" }), false, "학원이 등록한 결석은 자동 전환하지 않는다");
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, status: "APPROVED" }), false);
  assert.equal(rules.shouldAutoConvertToMakeup({ ...base, status: "CLOSED" }), false);
});

test("사진 90일 보관: 처리 끝난 날 +90일째부터 삭제 대상 — 연말·윤년 경계", () => {
  assert.equal(rules.EVIDENCE_RETENTION_DAYS, 90);
  assert.equal(rules.isEvidencePurgeDue("2026-11-14", "2027-02-11"), false, "89일째");
  assert.equal(rules.isEvidencePurgeDue("2026-11-14", "2027-02-12"), true, "90일째");
  // 윤년(2028-02-29 포함): 2027-12-01 + 90일 = 2028-02-29
  assert.equal(rules.isEvidencePurgeDue("2027-12-01", "2028-02-28"), false);
  assert.equal(rules.isEvidencePurgeDue("2027-12-01", "2028-02-29"), true);
  assert.equal(rules.isEvidencePurgeDue(null, "2030-01-01"), false, "처리 전(결정일 없음)은 지우지 않는다");
  assert.equal(rules.isEvidencePurgeDue("없는날", "2030-01-01"), false);
});

test("사유 글: 앞뒤 공백·줄바꿈 정리, 1~100자", () => {
  assert.equal(rules.normalizeReasonText("  독감\n(고열)  "), "독감 (고열)");
  assert.equal(rules.normalizeReasonText("   "), null);
  assert.equal(rules.normalizeReasonText(123), null);
  assert.equal(rules.isValidReasonText("발목 염좌"), true);
  assert.equal(rules.isValidReasonText(""), false);
  assert.equal(rules.isValidReasonText("가".repeat(100)), true);
  assert.equal(rules.isValidReasonText("가".repeat(101)), false);
});

test("승인 버튼을 켤지: 결석일 전·보강 사용·청구 발행 전·저장 꺼짐이면 이유 한 줄, 아니면 null", () => {
  const ok = { absenceYmd: "2026-11-09", todayYmd: "2026-11-14", creditStatus: null, billReady: true, writesEnabled: true };
  assert.equal(rules.carryApprovalBlocker(ok), null);
  assert.equal(rules.carryApprovalBlocker({ ...ok, absenceYmd: "2026-11-14" }), null, "결석 당일은 지난 것으로 본다(기존 이월 규칙과 같은 기준)");
  assert.match(rules.carryApprovalBlocker({ ...ok, absenceYmd: "2026-11-15" }), /결석일이 지난 뒤/);
  assert.match(rules.carryApprovalBlocker({ ...ok, creditStatus: "USED" }), /이미 보강을 들은/);
  assert.match(rules.carryApprovalBlocker({ ...ok, creditStatus: "NO_SHOW" }), /이미 보강을 들은/);
  assert.equal(rules.carryApprovalBlocker({ ...ok, creditStatus: "AVAILABLE" }), null, "이미 나간 미사용 보강권은 승인 때 회수된다(a7)");
  assert.equal(rules.carryApprovalBlocker({ ...ok, creditStatus: "RESERVED" }), null, "예약은 확인 창에서 함께 취소를 묻는다");
  assert.match(rules.carryApprovalBlocker({ ...ok, billReady: false }), /청구를 발행한 뒤/);
  assert.equal(rules.carryApprovalBlocker({ ...ok, billReady: null }), null, "근거 표를 모르면 막지 않는다 — 서버 규칙이 최종 판정");
  assert.match(rules.carryApprovalBlocker({ ...ok, writesEnabled: false }), /꺼져 있어/);
});

test("사진 경로: 우리가 만든 모양(regular-absence/{결석}/{사진}.jpg)만 인정한다", () => {
  const path = rules.evidenceStoragePath("a1b2-c3", "11111111-2222-3333-4444-555555555555");
  assert.equal(path, "regular-absence/a1b2-c3/11111111-2222-3333-4444-555555555555.jpg");
  assert.equal(rules.isValidEvidencePath(path), true);
  for (const bad of ["staff-sessions/c/s/p.jpg", "regular-absence/../x/y.jpg", "regular-absence/a/b.png", "regular-absence/a/b/c.jpg", "", null, "uploads/a.jpg"]) {
    assert.equal(rules.isValidEvidencePath(bad), false, String(bad));
  }
  assert.equal(rules.EVIDENCE_BUCKET, "absence-evidence");
});

// ═════════════════════════════════════════════════════════════════════════
// ② 마이그레이션 — 코드 상수와 DB 제약이 같은 집합(한쪽만 고치면 UPDATE 가 통째로 거부된다)
// ═════════════════════════════════════════════════════════════════════════
test("마이그레이션: 상태·출처 제약 = 코드 상수, 멱등, RLS, timestamptz, 되돌림 SQL 주석", () => {
  const inList = (name) => [...migration.match(new RegExp(`"${name}"\\s+CHECK \\((?:"?\\w+"? IS NULL OR )?"?\\w+"? IN \\(([^)]*)\\)\\)`))[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inList("RegularAbsenceCarryReview_status_check").sort(), [...rules.ILLNESS_REVIEW_STATUSES].sort());
  assert.deepEqual(inList("RegularAbsenceCarryReview_source_check").sort(), [...rules.ILLNESS_REVIEW_SOURCES].sort());
  assert.deepEqual(inList("RegularAbsenceCarryReview_decidedBy_check").sort(), ["ADMIN", "AUTO"]);
  assert.deepEqual(inList("RegularAbsenceCarryReview_convertReason_check").sort(), ["NO_EVIDENCE", "REJECTED"]);
  assert.match(migration, new RegExp(`char_length\\("reasonText"\\) <= ${rules.REASON_TEXT_MAX}\\)`));
  // 멱등 — 다시 실행해도 안전
  assert.equal((migration.match(/CREATE TABLE IF NOT EXISTS public\./g) ?? []).length, 3);
  assert.doesNotMatch(migration, /CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
  assert.match(migration, /ON CONFLICT \("absenceId"\) DO NOTHING/, "기존 정산 채우기도 다시 실행해 같은 결과");
  // 서버만 접근(RLS 켜고 정책 없음 + 권한 회수)
  assert.equal((migration.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length, 3);
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 3);
  for (const table of ["RegularAbsenceCarryReview", "RegularAbsenceEvidence", "RegularAbsenceEvidenceView"]) {
    assert.ok(migration.includes(`REVOKE ALL ON TABLE public."${table}" FROM PUBLIC;`), table);
    assert.ok(migration.includes(`EXECUTE format('REVOKE ALL ON TABLE public."${table}" FROM %I', r);`), table);
    assert.ok(new RegExp(`--\\s+DROP TABLE IF EXISTS public\\."${table}";`).test(migration), `되돌림 주석: ${table}`);
  }
  // 열람 기록 표: 누가·어느 사진·언제만(사유 글·파일 내용 없음), 사진 행과 FK 로 묶지 않는다(사진을 지워도 기록은 남는다)
  const viewTable = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS public."RegularAbsenceEvidenceView"'), migration.indexOf('"RegularAbsenceEvidenceView_evidenceId_viewedAt_idx"'));
  assert.deepEqual([...viewTable.matchAll(/^\s+"?(\w+)"? (?:TEXT|TIMESTAMPTZ)/gm)].map((m) => m[1]), ["id", "evidenceId", "viewerUserId", "viewedAt"]);
  assert.match(viewTable, /"viewedAt" TIMESTAMPTZ\(6\) NOT NULL DEFAULT NOW\(\)/);
  assert.doesNotMatch(viewTable, /REFERENCES|reasonText/);
  assert.match(read("prisma/schema.prisma"), /model RegularAbsenceEvidenceView \{/);
  assert.match(migration, /REVOKE ALL ON TABLE public\."RegularAbsenceEvidence" FROM %I/);
  assert.doesNotMatch(migration, /CREATE POLICY/);
  // 새 시간 칼럼은 전부 timestamptz
  assert.doesNotMatch(migration, /TIMESTAMP(?!TZ)/);
  // 되돌림 SQL 이 주석으로 있다
  assert.match(migration, /--\s+DROP TABLE IF EXISTS public\."RegularAbsenceEvidence";/);
  assert.match(migration, /--\s+DROP TABLE IF EXISTS public\."RegularAbsenceCarryReview";/);
  // 사진 행은 결석이 지워져도 남아 cron 이 파일을 치운다
  assert.match(migration, /"RegularAbsenceEvidence_absenceId_fkey"[\s\S]{0,120}ON DELETE SET NULL/);
  // 스키마 사본에도 두 모델이 있다
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model RegularAbsenceCarryReview \{/);
  assert.match(schema, /model RegularAbsenceEvidence \{/);
});

// ═════════════════════════════════════════════════════════════════════════
// ③ 보강권으로 전환(원장 [보강권으로] · 7일 자동)
// ═════════════════════════════════════════════════════════════════════════
test("원장 [보강권으로]: 거둬 둔 같은 보강권을 되살리고 검토는 «보강권으로 전환»", async () => {
  const db = fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending()], credits: [{ id: "mc0", studentId: "s1", sourceKey: KEY("c1", "2026-11-09"), status: "REVOKED", makeupSessionId: null }] });
  const out = await db.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "ADMIN", actorUserId: "admin1", issuable }));
  assert.deepEqual(out, { converted: true, studentId: "s1", classId: "c1", absenceYmd: "2026-11-09", creditIssued: true });
  assert.deepEqual(db.credits.map((c) => [c.id, c.status]), [["mc0", "AVAILABLE"]], "한 결석 한 장 — 새로 만들지 않는다");
  assert.deepEqual([db.reviews[0].status, db.reviews[0].decidedBy, db.reviews[0].decidedByUserId, db.reviews[0].convertReason], ["MAKEUP", "ADMIN", "admin1", "REJECTED"]);
  // 두 번 눌러도 한 번
  const again = await db.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "ADMIN", actorUserId: "admin1", issuable }));
  assert.deepEqual(again, { converted: false, reason: "DECIDED" });
  assert.equal(db.credits.length, 1);
});

test("학원이 등록한 결석(검토 줄 없음)도 [보강권으로] 가능 — 보강권이 없으면 새로 한 장", async () => {
  const db = fakeDb({ absences: [{ ...ABSENCE, status: "CONFIRMED" }] });
  const out = await db.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "ADMIN", actorUserId: "admin1", issuable }));
  assert.equal(out.converted, true);
  assert.equal(out.creditIssued, true);
  assert.deepEqual(db.credits.map((c) => [c.sourceKey, c.status]), [[KEY("c1", "2026-11-09"), "AVAILABLE"]]);
  assert.deepEqual(db.reviews.map((r) => [r.status, r.source]), [["MAKEUP", "STAFF"]]);
});

test("이미 보강권이 나가 있던 결석(a7): 전환해도 보강권은 그대로 한 장", async () => {
  const db = fakeDb({ absences: [{ ...ABSENCE }], credits: [{ id: "mc0", studentId: "s1", sourceKey: KEY("c1", "2026-11-09"), status: "AVAILABLE", makeupSessionId: null }] });
  const out = await db.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "ADMIN", actorUserId: "admin1", issuable }));
  assert.equal(out.converted, true);
  assert.equal(out.creditIssued, false, "이미 있던 보강권 — 새로 나가지 않는다");
  assert.deepEqual(db.credits.map((c) => c.status), ["AVAILABLE"]);
});

test("전환 거절: 없는·취소된 결석, 다른 사유, 이월로 정산된 결석, 발급 시작일 전 결석", async () => {
  const run = (db, by = "ADMIN") => db.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by, actorUserId: null, issuable }));
  assert.deepEqual(await run(fakeDb()), { converted: false, reason: "NOT_FOUND" });
  assert.deepEqual(await run(fakeDb({ absences: [{ ...ABSENCE, status: "CANCELLED" }] })), { converted: false, reason: "NOT_FOUND" });
  assert.deepEqual(await run(fakeDb({ absences: [{ ...ABSENCE, reason: "PERSONAL" }] })), { converted: false, reason: "NOT_ILLNESS" });
  // 이월 승인이 먼저 끝난 결석 — 검토 줄 기준
  assert.deepEqual(await run(fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending({ status: "APPROVED" })] })), { converted: false, reason: "DECIDED" });
  // 검토 줄은 없는데 청구 준비 화면에서 이월로 정산된 결석 — 기존 보상 가드가 막는다(이중 보상 없음)
  const carried = fakeDb({ absences: [{ ...ABSENCE }], carried: ["a1"] });
  assert.deepEqual(await run(carried), { converted: false, reason: "CARRY" });
  assert.equal(carried.credits.length, 0);
  assert.equal(carried.reviews.length, 0);
  // 보강권 발급 시작일(2026-10-05) 전 결석 — 검토는 닫되 보강권은 만들지 않는다
  const old = fakeDb({ absences: [{ ...ABSENCE, date: "2026-10-01" }], reviews: [pending()] });
  const out = await run(old);
  assert.equal(out.converted, true);
  assert.equal(out.creditIssued, false);
  assert.equal(old.credits.length, 0);
});

test("검토 닫기: 사유 변경은 «검토 중»만, 신고 취소는 «보강권 전환»까지 — «이월 승인»은 어느 쪽도 닫지 않는다", async () => {
  const run = async (status, options) => {
    const db = fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending({ status })], evidence: [photo("e1")] });
    const out = await carryTx.closeIllnessReviewInTx(db, "a1", options);
    return [out.closed, db.reviews[0].status, db.evidence[0].removed];
  };
  assert.deepEqual(await run("PENDING"), [true, "CLOSED", true], "닫으면 사진도 화면에서 뺀다");
  assert.deepEqual(await run("MAKEUP"), [false, "MAKEUP", false]);
  assert.deepEqual(await run("MAKEUP", { canceled: true }), [true, "CLOSED", true]);
  assert.deepEqual(await run("PENDING", { canceled: true }), [true, "CLOSED", true]);
  assert.deepEqual(await run("APPROVED"), [false, "APPROVED", false]);
  assert.deepEqual(await run("APPROVED", { canceled: true }), [false, "APPROVED", false]);
  // 관리자 신고 취소도 같은 함수를 쓴다
  assert.match(read("src/app/actions/regular-absence-admin.ts"), /closeIllnessReviewInTx\(tx, id, \{ canceled: true \}\)/);
  assert.match(read("src/lib/regular/parent-regular-absence.ts"), /closeIllnessReviewInTx\(tx, canceled\[0\]\.id, \{ canceled: true \}\)/);
});

test("cron 자동 전환: 7일 지나 사진 없는 것만 — 마지막 날·사진 있음·학원 등록·끝난 결정은 건드리지 않는다", async () => {
  const mk = (id, review) => [{ ...ABSENCE, id, classId: `c-${id}` }, { ...review, absenceId: id }];
  const rows = [
    mk("late", pending({ requestedYmd: "2026-11-14" })),                       // 11/22 = 8일째 → 전환
    mk("kakao", pending({ requestedYmd: "2026-11-10", source: "KAKAO" })),     // 카카오 접수도 전환
    mk("lastday", pending({ requestedYmd: "2026-11-15" })),                    // 11/22 = 마지막 날 → 아직
    mk("photo", pending({ requestedYmd: "2026-11-01" })),                      // 사진 있음 → 원장이 고른다
    mk("staff", pending({ requestedYmd: "2026-11-01", source: "STAFF" })),     // 학원 등록 → 자동 전환 없음
    mk("done", pending({ requestedYmd: "2026-11-01", status: "APPROVED" })),   // 이미 승인
  ];
  const db = fakeDb({ today: "2026-11-22", absences: rows.map((r) => r[0]), reviews: rows.map((r) => r[1]), evidence: [photo("e1", { absenceId: "photo" })] });
  const result = await cron.autoConvertOverdueIllnessReviews(db, issuable);
  assert.deepEqual(result.converted.map((c) => c.absenceYmd), ["2026-11-09", "2026-11-09"]);
  assert.equal(result.failed, 0);
  const status = Object.fromEntries(db.reviews.map((r) => [r.absenceId, [r.status, r.decidedBy ?? null, r.convertReason ?? null]]));
  assert.deepEqual(status.late, ["MAKEUP", "AUTO", "NO_EVIDENCE"]);
  assert.deepEqual(status.kakao, ["MAKEUP", "AUTO", "NO_EVIDENCE"]);
  assert.deepEqual(status.lastday, ["PENDING", null, null]);
  assert.deepEqual(status.photo, ["PENDING", null, null]);
  assert.deepEqual(status.staff, ["PENDING", null, null]);
  assert.equal(status.done[0], "APPROVED");
  assert.deepEqual(db.credits.map((c) => c.sourceKey).sort(), [KEY("c-kakao", "2026-11-09"), KEY("c-late", "2026-11-09")]);
  // 다시 돌려도 더 전환하지 않는다(멱등)
  const again = await cron.autoConvertOverdueIllnessReviews(db, issuable);
  assert.equal(again.converted.length, 0);
  assert.equal(db.credits.length, 2);
});

test("그날 출석·지각으로 기록된 결석은 보강권을 주지 않는다 — 자동 전환은 검토를 닫고, 원장에게는 이유를 알린다", async () => {
  const seed = (status) => fakeDb({
    today: "2026-11-22", absences: [{ ...ABSENCE }], reviews: [pending({ requestedYmd: "2026-11-09" })],
    attendance: [{ studentId: "s1", classId: "c1", date: "2026-11-09", status }],
  });
  for (const status of ["PRESENT", "LATE"]) {
    const auto = seed(status);
    const result = await cron.autoConvertOverdueIllnessReviews(auto, issuable);
    assert.equal(result.converted.length, 0, status);
    assert.equal(auto.credits.length, 0, "수업을 들었으니 보강권 없음");
    assert.equal(auto.reviews[0].status, "CLOSED", "다음 날 다시 후보로 잡히지 않게 닫는다");

    const admin = seed(status);
    const out = await admin.$transaction((tx) => carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "ADMIN", actorUserId: "admin1", issuable }));
    assert.deepEqual(out, { converted: false, reason: "ATTENDED" });
    assert.equal(admin.credits.length, 0);
    assert.equal(admin.reviews[0].status, "PENDING", "원장이 누른 경우는 그대로 두고 이유를 알린다");
  }
  // 결석으로 기록된 날은 그대로 전환한다
  const absent = seed("ABSENT");
  assert.equal((await cron.autoConvertOverdueIllnessReviews(absent, issuable)).converted.length, 1);
  assert.equal(absent.credits.length, 1);
  assert.match(read("src/app/actions/illness-carry-admin.ts"), /ATTENDED: "그날 출석\(지각\)으로 기록돼 있어 보강권을 줄 수 없습니다\./);
});

test("cron 자동 전환: 후보를 읽은 뒤 학부모가 사진을 올렸으면 전환하지 않는다(잠근 뒤 다시 확인)", async () => {
  const db = fakeDb({ today: "2026-11-22", absences: [{ ...ABSENCE }], reviews: [pending({ requestedYmd: "2026-11-14" })] });
  const out = await db.$transaction((tx) => {
    db.evidence.push(photo("e-late")); // 후보 조회와 전환 사이에 사진이 들어온 상황
    return carryTx.convertIllnessToMakeupInTx(tx, { absenceId: "a1", by: "AUTO", actorUserId: null, issuable });
  });
  assert.deepEqual(out, { converted: false, reason: "HAS_EVIDENCE" });
  assert.equal(db.reviews[0].status, "PENDING");
  assert.equal(db.credits.length, 0);
});

test("검토 표가 없으면(마이그레이션 전) cron·출결 분기는 아무것도 하지 않는다", async () => {
  const db = fakeDb({ ready: false, absences: [{ ...ABSENCE }], reviews: [pending({ requestedYmd: "2026-10-01" })] });
  assert.deepEqual(await cron.autoConvertOverdueIllnessReviews(db, issuable), { checked: 0, converted: [], failed: 0 });
  assert.deepEqual(await cron.purgeIllnessEvidence(db, async () => true), { purged: 0, failed: 0 });
  assert.equal(await carryTx.isIllnessCreditHeld(db, { studentId: "s1", classId: "c1", absenceYmd: "2026-11-09" }), false, "예전처럼 발급한다");
});

// ═════════════════════════════════════════════════════════════════════════
// ④ 출결을 «결석»으로 찍을 때 — 질병·부상이면 보강권 자동 발급하지 않는다
// ═════════════════════════════════════════════════════════════════════════
test("출결 결석: 질병·부상 결석은 보강권 보류(검토 대기), [보강권으로] 결정·다른 사유·취소된 신고는 예전처럼 발급", async () => {
  const held = (db) => carryTx.isIllnessCreditHeld(db, { studentId: "s1", classId: "c1", absenceYmd: "2026-11-09" });
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending()] })), true, "학부모 신고 — 검토 중");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE, status: "CONFIRMED" }] })), true, "기간 결석·출석부 표시(검토 줄 없음)도 보류");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending({ status: "APPROVED" })] })), true, "이월 승인된 결석 — 보강권 없음");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending({ status: "MAKEUP" })] })), false, "[보강권으로] 결정이 난 결석은 발급");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending({ status: "CLOSED" })] })), false, "닫힌 검토(그날 출석으로 닫힘 → 뒤에 결석으로 정정)는 보통 결석처럼 발급");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE, reason: "PERSONAL" }] })), false, "다른 사유는 지금처럼 발급");
  assert.equal(await held(fakeDb({ absences: [{ ...ABSENCE, status: "CANCELLED" }] })), false, "취소된 신고");
  assert.equal(await held(fakeDb()), false, "신고 없는 결석");
});

test("출결 저장 경로: 정규 결석은 발급 전에 보류 여부를 보고, 호출부는 «사유 저장 → 보강권 맞춤» 순서다", () => {
  const service = read("src/lib/makeup/credit-service.ts");
  const fn = service.slice(service.indexOf("export async function syncCreditForRegularSession"), service.indexOf("/** 방학특강 좌석 출결용"));
  assert.match(fn, /if \(input\.status === "ABSENT" && await isIllnessCreditHeld\(prisma, \{ studentId: input\.studentId, classId: row\.classId, absenceYmd \}\)\) \{\s*return \{ action: "held" \};/);
  assert.ok(fn.indexOf("isIllnessCreditHeld(") < fn.indexOf("return syncMakeupCreditForAttendance("), "발급 함수보다 먼저 본다");
  // 출석·지각으로 정정할 때의 회수는 사유와 상관없이 그대로(ABSENT 일 때만 보류를 본다)
  assert.doesNotMatch(fn, /status !== "ABSENT" && await isIllnessCreditHeld/);
  for (const [path, name] of [["src/app/actions/staff-sessions.ts", "saveStaffAttendance"], ["src/app/actions/admin.ts", "saveAttendance"]]) {
    const source = read(path);
    const reasonAt = source.indexOf("applyAttendanceAbsenceReasonInTx(tx,");
    const syncAt = source.indexOf("await syncCreditForRegularSession(");
    assert.ok(reasonAt > 0 && syncAt > reasonAt, `${name}: 사유(질병·부상 표시) 저장 뒤에 보강권을 맞춘다`);
    assert.equal(source.split("await syncCreditForRegularSession(").length - 1, 1, `${name}: 정규 보강권 맞춤은 한 곳`);
  }
  // 2026-11-14 출결 취소(clearStaffAttendance)는 따로 도는 맞춤 함수를 부르지 않는다 —
  // 사유 정리 → 출결 삭제 → 안 쓴 보강권 회수를 «같은 트랜잭션»에서 이 순서로 한다(회수는 결석이 사라질 때뿐이라 보류 판정이 필요 없다).
  const staffSource = read("src/app/actions/staff-sessions.ts");
  const staffClear = staffSource.slice(staffSource.indexOf("export async function clearStaffAttendance"), staffSource.indexOf("async function getMakeupCompletedParentRecipients"));
  assert.ok(staffClear.length > 500, "clearStaffAttendance 를 찾지 못했다");
  assert.doesNotMatch(staffClear, /syncCreditForRegularSession\(/);
  const clearReasonAt = staffClear.indexOf("applyAttendanceAbsenceReasonInTx(tx,");
  const clearDeleteAt = staffClear.indexOf(`DELETE FROM "Attendance" WHERE "sessionId" = $1 AND "studentId" = $2 AND status = $3 RETURNING id`);
  const clearRevokeAt = staffClear.indexOf("await revokeMakeupCreditInTx(tx,");
  assert.ok(clearReasonAt > 0 && clearDeleteAt > clearReasonAt && clearRevokeAt > clearDeleteAt, "clearStaffAttendance: 사유 정리 → 출결 삭제 → 보강권 회수 순서");
  assert.equal(staffClear.split("await revokeMakeupCreditInTx(").length - 1, 1, "clearStaffAttendance: 보강권 회수는 한 곳");
  assert.equal(staffSource.split("revokeMakeupCreditInTx(").length - 1, 1, "선생님 쪽에서 보강권을 직접 회수하는 곳은 출결 취소 하나뿐");
  // 랠리즈 출결 동기화도 같은 함수를 쓴다(분기가 따로 필요 없다)
  assert.match(read("src/app/actions/rallyz-attendance-sync.ts"), /await syncCreditForRegularSession\(target\)/);
});

test("출석부 «질병·부상 표시»: 표시하는 순간 먼저 나가 있던 미사용 보강권을 거둔다(예약·사용분은 그대로)", async () => {
  const key = { studentId: "s1", classId: "c1", dateYmd: "2026-11-09" };
  const credit = (status) => ({ id: "mc0", studentId: "s1", sourceKey: KEY("c1", "2026-11-09"), status, makeupSessionId: null });
  const db = fakeDb({ credits: [credit("AVAILABLE")] });
  const applied = await sheet.applyAttendanceAbsenceReasonInTx(db, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: null });
  assert.equal(applied.plan, "INSERT");
  assert.equal(db.absences[0].reason, "ILLNESS_INJURY");
  assert.equal(db.credits[0].status, "REVOKED");
  assert.match(db.credits[0].note, /이월 검토/);
  // 그 뒤 도는 보강권 맞춤은 발급하지 않는다(보류)
  assert.equal(await carryTx.isIllnessCreditHeld(db, { studentId: "s1", classId: "c1", absenceYmd: "2026-11-09" }), true);

  const reserved = fakeDb({ credits: [credit("RESERVED")] });
  await sheet.applyAttendanceAbsenceReasonInTx(reserved, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: null });
  assert.equal(reserved.credits[0].status, "RESERVED", "보강 예약은 건드리지 않는다");

  // 표가 없으면(마이그레이션 전) 예전 그대로 — 보강권을 거두지 않는다
  const legacy = fakeDb({ ready: false, credits: [credit("AVAILABLE")] });
  await sheet.applyAttendanceAbsenceReasonInTx(legacy, { ...key, attendanceStatus: "ABSENT", intent: "ILLNESS_INJURY", confirmedByUserId: null });
  assert.equal(legacy.credits[0].status, "AVAILABLE");
});

// ═════════════════════════════════════════════════════════════════════════
// ⑤ 증빙 사진 — 권한·삭제 대상
// ═════════════════════════════════════════════════════════════════════════
const ACCESS = `s."parentId" = $1`; // childAccessSql("s", "$1") 가 만드는 조각(연결 표가 없을 때)

test("사진 올리기 대상: 내 아이의 검토 중인 질병·부상 결석만 — 다른 가정·다른 사유·취소된 신고는 «없음»", async () => {
  const db = fakeDb({ absences: [{ ...ABSENCE }, { ...ABSENCE, id: "a9", studentId: "s9" }], reviews: [pending(), pending({ absenceId: "a9" })] });
  const mine = await access.findEvidenceTargetForParent(db, ACCESS, "p1", "a1");
  assert.deepEqual(mine, { absenceId: "a1", status: "PENDING", requestedYmd: "2026-11-09", absenceYmd: "2026-11-09", todayYmd: "2026-11-14", photoCount: 0 });
  assert.equal(access.evidenceAddRefusal(mine), null);
  assert.equal(await access.findEvidenceTargetForParent(db, ACCESS, "p1", "a9"), null, "다른 가정의 결석");
  assert.equal(await access.findEvidenceTargetForParent(db, ACCESS, "p9", "a1"), null, "다른 가정의 보호자");
  assert.equal(await access.findEvidenceTargetForParent(fakeDb({ absences: [{ ...ABSENCE, reason: "PERSONAL" }], reviews: [pending()] }), ACCESS, "p1", "a1"), null);
  assert.equal(await access.findEvidenceTargetForParent(fakeDb({ absences: [{ ...ABSENCE, status: "CANCELLED" }], reviews: [pending()] }), ACCESS, "p1", "a1"), null);
  assert.equal(await access.findEvidenceTargetForParent(fakeDb({ absences: [{ ...ABSENCE }] }), ACCESS, "p1", "a1"), null, "검토 줄이 없는 결석(학원 등록)");
});

test("동시 업로드: 잠금을 «먼저 따로» 잡고 그 뒤에 장수를 센다 — 기다리는 동안 올라온 사진까지 세어 3장을 넘지 않는다", async () => {
  const db = fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending()], evidence: [photo("e1"), photo("e2")] });
  // 잠금을 기다리는 사이 다른 요청이 세 번째 사진을 확정한 상황
  db.onLock = () => db.evidence.push(photo("e3"));
  const locked = await access.findEvidenceTargetForParent(db, ACCESS, "p1", "a1", true);
  assert.deepEqual(db.order, ["period-lock", "lock", "count"], "기간 잠금 → 검토 잠금 → 세기 순서");
  // 기간 잠금 = 그 결석이 속한 기간 행(같은 기간의 다른 날짜로 동시에 올려도 한 줄로 선다)
  assert.match(access.EVIDENCE_PERIOD_LOCK_SQL, /FROM "RegularAbsencePeriod" p\s+JOIN "RegularAbsence" ra ON ra\."periodId" = p\.id WHERE ra\.id = \$1 FOR NO KEY UPDATE OF p/);
  assert.equal(locked.photoCount, 3);
  assert.match(access.evidenceAddRefusal(locked), /3장까지/);
  // 잠금 없이 부르면 잠금 문장을 보내지 않는다(거래 밖 미리보기)
  const plain = fakeDb({ absences: [{ ...ABSENCE }], reviews: [pending()] });
  await access.findEvidenceTargetForParent(plain, ACCESS, "p1", "a1");
  assert.deepEqual(plain.order, ["count"]);
  assert.equal(access.EVIDENCE_LOCK_SQL, 'SELECT 1 AS locked FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1 FOR UPDATE');
  // 호출부: 확정 거래 안에서 잠금 포함으로 다시 본다
  const route = read("src/app/api/mypage/regular-absence/evidence/route.ts");
  assert.match(route, /prisma\.\$transaction\(async \(tx\) => \{\s*const locked = await findEvidenceTargetForParent\(tx, access, parent\.appUserId, absenceId, true\);/);
});

test("업로드 형식: 인코딩 전에 실제 형식(jpeg·png·webp)을 확인하고 아니면 400", () => {
  for (const ok of ["jpeg", "png", "webp"]) assert.equal(rules.isAllowedEvidenceFormat(ok), true, ok);
  for (const bad of ["gif", "svg", "tiff", "heif", "pdf", "", undefined, null, "JPEG"]) assert.equal(rules.isAllowedEvidenceFormat(bad), false, String(bad));
  const storage = read("src/lib/regular/illness-evidence-storage.ts");
  const fn = storage.slice(storage.indexOf("export async function encodeEvidencePhoto"), storage.indexOf("export async function uploadEvidencePhoto"));
  assert.match(fn, /\.metadata\(\);\s*if \(!isAllowedEvidenceFormat\(meta\.format\)\) throw new Error\(EVIDENCE_FORMAT_REJECTED\);/);
  assert.ok(fn.indexOf(".metadata()") < fn.indexOf(".jpeg("), "형식 확인이 인코딩보다 먼저");
  const route = read("src/app/api/mypage/regular-absence/evidence/route.ts");
  assert.match(route, /error\.message === EVIDENCE_FORMAT_REJECTED;\s*return json\(\{ error: badFormat \? "사진은 JPG, PNG, WebP 만 올릴 수 있어요\." : "[^"]+" \}, 400\);/);
  assert.ok(route.indexOf("encodeEvidencePhoto(") < route.indexOf("uploadEvidencePhoto("), "거절된 파일은 저장소에 올라가지 않는다");
});

test("관리자 열람 기록: 누가·어느 사진을 열었는지 남기고, 기록이 실패해도 열람은 막지 않는다", () => {
  const route = read("src/app/api/admin/absence-evidence/[id]/route.ts");
  assert.match(route, /INSERT INTO "RegularAbsenceEvidenceView" \("evidenceId", "viewerUserId"\) VALUES \(\$1, \$2\)`,\s*photo\.id, admin\.appUserId,\s*\)\.catch\(/);
  assert.match(route, /admin = await requireAdmin\(\);/);
  // 권한 확인 → 사진 찾기 → 파일 읽기 → 기록 → 응답 순서(없는 사진·못 읽은 사진은 기록하지 않는다)
  const at = (text) => route.indexOf(text);
  assert.ok(at("await requireAdmin()") < at("findEvidenceForAdmin(prisma, id)"));
  assert.ok(at("downloadEvidencePhoto(photo.storagePath)") < at('INSERT INTO "RegularAbsenceEvidenceView"'));
  assert.ok(at('INSERT INTO "RegularAbsenceEvidenceView"') < at("return new NextResponse(bytes"));
  // 사유 글·파일 경로·내용은 기록하지 않는다
  const insert = route.slice(at('INSERT INTO "RegularAbsenceEvidenceView"'), at("return new NextResponse(bytes"));
  assert.doesNotMatch(insert, /reasonText|storagePath|bytes/);
  // 90일 삭제는 사진 파일·사진 행 표시만 — 열람 기록은 건드리지 않는다
  assert.doesNotMatch(read("src/lib/regular/illness-carry-cron.ts"), /RegularAbsenceEvidenceView/);
});

test("사진 올리기 거절 사유: 3장 참 · 7일 지남 · 처리 끝남", () => {
  const base = { absenceId: "a1", status: "PENDING", requestedYmd: "2026-11-09", todayYmd: "2026-11-14", photoCount: 0 };
  assert.equal(access.evidenceAddRefusal(base), null);
  assert.match(access.evidenceAddRefusal({ ...base, photoCount: 3 }), /3장까지/);
  assert.match(access.evidenceAddRefusal({ ...base, todayYmd: "2026-11-17" }), /결석일부터 7일\)이 지났어요/);
  // 미리 알린 결석: 결석일(11/20) 기준으로 11/27 까지 올릴 수 있다
  assert.equal(access.evidenceAddRefusal({ ...base, absenceYmd: "2026-11-20", todayYmd: "2026-11-27" }), null);
  assert.match(access.evidenceAddRefusal({ ...base, absenceYmd: "2026-11-20", todayYmd: "2026-11-28" }), /지났어요/);
  assert.equal(access.evidenceAddRefusal({ ...base, todayYmd: "2026-11-16" }), null, "마지막 날(11/16)은 올릴 수 있다");
  assert.match(access.evidenceAddRefusal({ ...base, status: "APPROVED" }), /처리가 끝난/);
  assert.match(access.evidenceAddRefusal({ ...base, status: "MAKEUP" }), /처리가 끝난/);
});

test("사진 열람: 올린 학부모 본인과 관리자만 — 다른 가정은 물론 같은 아이의 다른 보호자도 못 연다", async () => {
  const db = fakeDb({
    students: [{ id: "s1", parentId: "p1" }, { id: "s9", parentId: "p9" }],
    absences: [{ ...ABSENCE }],
    reviews: [pending()],
    evidence: [photo("e1"), photo("e-other", { uploadedByUserId: "p2" }), photo("e-removed", { removed: true }), photo("e-purged", { removed: true, purged: true })],
  });
  assert.equal((await access.findEvidenceForParent(db, ACCESS, "p1", "e1")).storagePath, rules.evidenceStoragePath("a1", "e1"));
  assert.equal(await access.findEvidenceForParent(db, ACCESS, "p9", "e1"), null, "다른 가정");
  assert.equal(await access.findEvidenceForParent(db, ACCESS, "p1", "e-other"), null, "같은 아이의 다른 보호자가 올린 사진");
  assert.equal(await access.findEvidenceForParent(db, ACCESS, "p2", "e-other"), null, "올린 사람이어도 지금 그 아이의 보호자가 아니면 못 연다");
  assert.equal(await access.findEvidenceForParent(db, ACCESS, "p1", "e-removed"), null, "지운 사진");
  assert.equal(await access.findEvidenceForParent(db, ACCESS, "p1", "없는id"), null);
  // 관리자: 살아 있는 사진은 누가 올렸든 연다 / 지운·삭제된 사진은 없다
  assert.equal((await access.findEvidenceForAdmin(db, "e-other")).id, "e-other");
  assert.equal(await access.findEvidenceForAdmin(db, "e-removed"), null);
  assert.equal(await access.findEvidenceForAdmin(db, "e-purged"), null);
});

test("사진 API: 학부모 길은 보호자 확인 + 본인 사진만, 관리자 길은 requireAdmin, 공개 버킷·서명 주소 없음", () => {
  const parentRoute = read("src/app/api/mypage/regular-absence/evidence/route.ts");
  const adminRoute = read("src/app/api/admin/absence-evidence/[id]/route.ts");
  const storage = read("src/lib/regular/illness-evidence-storage.ts");
  // 세 동작 모두 로그인한 학부모만, 권한 조각은 childAccessSql
  assert.equal(parentRoute.split("await parentOrNull()").length - 1, 3);
  assert.match(parentRoute, /requireVerifiedParent\(\)/);
  assert.equal(parentRoute.split(`childAccessSql("s", "$1")`).length - 1, 3);
  assert.match(parentRoute, /findEvidenceForParent\(prisma, await childAccessSql\("s", "\$1"\), parent\.appUserId, id\)/);
  // 올리기: 서버가 대상·기간·장수를 다시 보고, 잠근 뒤 한 번 더 본다
  assert.match(parentRoute, /const refusal = evidenceAddRefusal\(target\);\s*if \(refusal\) return json\(\{ error: refusal \}, 409\);/);
  assert.match(parentRoute, /findEvidenceTargetForParent\(tx, access, parent\.appUserId, absenceId, true\)/);
  // 지우기: 본인 사진 + 기간 안
  assert.match(parentRoute, /if \(!canEditEvidence\(photo\)\) return json\(/);
  assert.match(parentRoute, /"uploadedByUserId" = \$2 AND "removedAt" IS NULL/);
  // 관리자 길: 권한 확인이 조회보다 먼저
  assert.ok(adminRoute.indexOf("await requireAdmin()") < adminRoute.indexOf("findEvidenceForAdmin(prisma, id)"));
  assert.doesNotMatch(adminRoute, /requireStaff|requireVerifiedParent/);
  // 저장소: 비공개 버킷, EXIF 제거(재인코딩), 공개·서명 주소를 만들지 않는다
  assert.match(storage, /public: false/);
  assert.match(storage, /\.rotate\(\)[\s\S]{0,160}\.jpeg\(/);
  assert.doesNotMatch(parentRoute + adminRoute + storage, /getPublicUrl|createSignedUrl|from\("uploads"\)|\/api\/upload/);
  assert.match(storage, /"Cache-Control": "private, no-store, max-age=0"/);
  // 건강 정보 — 오류 로그에는 오류 이름만(오류 객체·본문을 통째로 찍지 않는다)
  for (const source of [parentRoute, adminRoute]) {
    for (const line of source.split("\n").filter((l) => l.includes("console.error("))) {
      assert.match(line, /error instanceof Error \? error\.name : ""\)/, line.trim());
    }
  }
});

test("사진 삭제 대상: 처리 끝나고 90일 지난 것 + 화면에서 뺀 것 + 결석이 사라진 것 — 검토 중·89일째·방금 예약은 남긴다", async () => {
  const mkReview = (id, status, decidedYmd) => ({ absenceId: id, status, source: "PARENT", requestedYmd: "2026-08-01", decidedYmd });
  const db = fakeDb({
    today: "2027-02-12",
    reviews: [mkReview("old", "APPROVED", "2026-11-14"), mkReview("young", "MAKEUP", "2026-11-15"), mkReview("open", "PENDING", null), mkReview("closed", "CLOSED", "2026-11-01")],
    evidence: [
      photo("p-old", { absenceId: "old", storagePath: rules.evidenceStoragePath("old", "p-old") }),          // 90일째 → 삭제
      photo("p-young", { absenceId: "young", storagePath: rules.evidenceStoragePath("young", "p-young") }),  // 89일째 → 남김
      photo("p-open", { absenceId: "open", storagePath: rules.evidenceStoragePath("open", "p-open") }),      // 검토 중 → 남김
      photo("p-closed", { absenceId: "closed", storagePath: rules.evidenceStoragePath("closed", "p-closed"), removed: true }), // 닫힌 검토 → 삭제
      photo("p-removed", { absenceId: "open", storagePath: rules.evidenceStoragePath("open", "p-removed"), removed: true }),   // 학부모가 지움 → 삭제
      photo("p-uploading", { absenceId: "open", storagePath: rules.evidenceStoragePath("open", "p-uploading"), removed: true, removedMinutes: 2 }), // 올리는 중 → 남김
      photo("p-orphan", { absenceId: null, storagePath: rules.evidenceStoragePath("gone", "p-orphan") }),    // 결석 행이 사라짐 → 삭제
      photo("p-badpath", { absenceId: "old", storagePath: "staff-sessions/c/s/x.jpg" }),                     // 우리 경로가 아님 → 건드리지 않음
      photo("p-done", { absenceId: "old", purged: true, removed: true }),                                     // 이미 지움
    ],
  });
  const removed = [];
  const result = await cron.purgeIllnessEvidence(db, async (bucket, path) => { removed.push(`${bucket}:${path}`); return true; });
  assert.deepEqual(result, { purged: 4, failed: 1 });
  assert.deepEqual(db.evidence.filter((e) => e.purged).map((e) => e.id).sort(), ["p-closed", "p-done", "p-old", "p-orphan", "p-removed"]);
  assert.ok(removed.every((entry) => entry.startsWith("absence-evidence:regular-absence/")), "우리 버킷·경로만 지운다");
  assert.equal(removed.length, 4);

  // 저장소 삭제가 실패하면 표시하지 않고 다음 날 다시 시도한다
  const retry = fakeDb({ today: "2027-02-12", reviews: [mkReview("old", "APPROVED", "2026-11-14")], evidence: [photo("p1", { absenceId: "old", storagePath: rules.evidenceStoragePath("old", "p1") })] });
  assert.deepEqual(await cron.purgeIllnessEvidence(retry, async () => false), { purged: 0, failed: 1 });
  assert.equal(retry.evidence[0].purged, false);
  assert.deepEqual(await cron.purgeIllnessEvidence(retry, async () => { throw new Error("storage down"); }), { purged: 0, failed: 1 });
  assert.deepEqual(await cron.purgeIllnessEvidence(retry, async () => true), { purged: 1, failed: 0 });
});

// ═════════════════════════════════════════════════════════════════════════
// ⑥ 연결부 — cron·신청함·알림·카카오·FAQ(소스 계약)
// ═════════════════════════════════════════════════════════════════════════
test("cron: 기존 보강권 정리(KST 00:30)에 붙어 돌고, 학부모에게는 앱 알림만 보낸다", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.deepEqual(vercel.crons.filter((c) => c.path === "/api/cron/makeup-credits"), [{ path: "/api/cron/makeup-credits", schedule: "30 15 * * *" }], "UTC 15:30 = KST 00:30");
  const route = read("src/app/api/cron/makeup-credits/route.ts");
  assert.match(route, /autoConvertOverdueIllnessReviews\(prisma, isMakeupCreditIssuableYmd\)/);
  assert.match(route, /purgeIllnessEvidence\(prisma, removeEvidencePhoto\)/);
  assert.match(route, /if \(errors\.length > 0\) throw new Error\(/, "실패는 삼키지 않고 cron 알림으로 보낸다");
  // 고객 발송(문자·알림톡)을 새로 만들지 않는다 — 앱 안 알림 함수만
  for (const path of ["src/app/api/cron/makeup-credits/route.ts", "src/app/actions/illness-carry-admin.ts", "src/lib/regular/illness-carry-cron.ts", "src/lib/regular/illness-carry-admin.ts", "src/lib/regular/illness-carry-tx.ts"]) {
    assert.doesNotMatch(read(path), /sendParentSms|sendTrackedSms|sendFailClosedTrackedSms|alimtalk|sendSms/i, path);
  }
  assert.match(route, /notifyParentsOfStudents\(/);
});

test("알림·로그에 사유 글(건강 정보)을 싣지 않는다", () => {
  const sources = ["src/app/actions/illness-carry-admin.ts", "src/app/api/cron/makeup-credits/route.ts", "src/lib/regular/illness-carry-cron.ts", "src/lib/regular/illness-carry-tx.ts", "src/lib/regular/illness-carry-admin.ts"].map(read);
  for (const source of sources) {
    for (const line of source.split("\n").filter((l) => /console\.(error|log|warn)\(|notifyParentsOfStudents\(|notifyOperationalStaff\(/.test(l))) {
      assert.doesNotMatch(line, /reasonText/, line.trim());
    }
  }
  // 학부모 화면으로 내려가는 검토 목록에도 사유 글 칸이 없다
  const parent = read("src/lib/regular/parent-regular-absence.ts");
  const list = parent.slice(parent.indexOf("export async function getParentIllnessReviews"), parent.indexOf("export type UpcomingChild"));
  assert.doesNotMatch(list, /reasonText/);
  // 신청함 목록(어댑터)에도 싣지 않는다 — 상세를 열 때만 관리자 action 이 읽는다
  const inbox = read("src/lib/requests/admin-inbox.ts");
  const adapter = inbox.slice(inbox.indexOf('kind: "ILLNESS_CARRY"'), inbox.indexOf('kind: "MAKEUP"'));
  assert.doesNotMatch(adapter, /reasonText/);
  assert.match(read("src/app/actions/illness-carry-admin.ts"), /export async function loadIllnessCarryDetail[\s\S]{0,200}await requireAdmin\(\);/);
});

test("신청함: «질병·부상 결석» 종류 — 결석일 전은 진행 중, 지나면 처리 필요, 표가 없으면 그 종류만 비운다", async () => {
  const catalog = await loadTsModule("src/lib/requests/catalog.ts");
  assert.equal(catalog.kindLabel("ILLNESS_CARRY"), "질병·부상 결석");
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "PENDING"), "ACTION");
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "WAITING"), "ONGOING");
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "APPROVED"), "DONE");
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "MAKEUP"), "DONE");
  assert.equal(catalog.statusLabel("ILLNESS_CARRY", "APPROVED"), "이월 승인");
  assert.equal(catalog.tabOfKind("ILLNESS_CARRY"), "CHANGE");
  assert.ok(catalog.kindsOfTab("CHANGE", "ABSENCE").includes("ILLNESS_CARRY"));
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "NOT_READY"), "ONGOING", "모르는 상태는 목록 SQL 이 읽지 않는다(statusesOf 에 없음)");
  assert.ok(!catalog.statusesOf("ILLNESS_CARRY").includes("NOT_READY"));

  const inbox = read("src/lib/requests/admin-inbox.ts");
  const adapter = inbox.slice(inbox.indexOf('kind: "ILLNESS_CARRY"'), inbox.indexOf('kind: "MAKEUP"'));
  // 학부모 신고·기간 결석·출석부 표시가 모두 같은 표 — 기간 결석을 빼지 않는다(일반 결석 어댑터와 다르다)
  assert.match(adapter, /x\.reason = 'ILLNESS_INJURY' AND x\.status <> 'CANCELLED'/);
  assert.doesNotMatch(adapter, /"periodId" IS NULL/);
  // 결석일 비교: date 칼럼은 달력 값 그대로, now() 만 KST 로 한 번 변환
  assert.match(adapter, /WHEN x\.date > \(now\(\) AT TIME ZONE 'Asia\/Seoul'\)::date THEN 'WAITING' ELSE 'PENDING' END/);
  // 이미 보강을 들은(검토 줄 없는) 결석은 고를 것이 없어 뺀다 / 미사용 보강권이 나간 결석은 남는다(a7)
  assert.match(adapter, /used\.status IN \('USED', 'NO_SHOW'\)/);
  // 닫힌 검토(그날 출석으로 자동으로 닫힌 건 등)는 «이월 검토»에 남지 않는다
  assert.match(adapter, /where: `[^`]*AND COALESCE\(r\.status, ''\) <> 'CLOSED'/);
  // 마이그레이션 전: 그 종류만 빈 목록
  assert.match(adapter, /fallback: \{[\s\S]*where: "false",[\s\S]*rawExpr: `'NOT_READY'::text`/);
  assert.match(inbox, /original\.kind === "ILLNESS_CARRY" && !illnessTableReady\) \? legacyOf\(original\) : original/);

  const client = read("src/app/admin/inbox/InboxClient.tsx");
  assert.match(client, /open\.kind === "ILLNESS_CARRY" && \(\s*<IllnessCarryInboxDetail/);
  const detail = read("src/app/admin/inbox/IllnessCarryInboxDetail.tsx");
  assert.match(detail, />보강권으로<\/button>/);
  assert.match(detail, /disabled=\{pending \|\| Boolean\(detail\.blocker\)\}[\s\S]{0,80}className="academy-button-primary">이월 승인<\/button>/, "조건이 안 맞으면 승인 버튼을 꺼 둔다");
  assert.match(detail, /acknowledgeLabel: hasPhotos \? "증빙 사진을 확인했습니다" : "증빙\(진단서·처방전 등\)을 직접 확인했습니다"/);
  assert.match(detail, /useAdminConfirm\(\)/);
  // 사진 기한은 «결석일부터 7일» 같은 설명이 아니라 실제 날짜로(학부모 화면·자동 전환과 같은 함수)
  assert.match(detail, /kstLabel\(kstAt\(detail\.evidenceDeadlineYmd\)\)\}까지 사진이 없으면 보강권 1장으로 바뀝니다\./);
  assert.match(read("src/lib/regular/illness-carry-admin.ts"), /evidenceDeadlineYmd\(review\.requestedYmd, anchors\[0\]\?\.anchorYmd \?\? absence\.date\)/);
  assert.match(detail, /\/api\/admin\/absence-evidence\//);
  // 아이콘 없이 글자 · 굵기 4단계 · 색은 토큰만
  assert.doesNotMatch(detail, /material-symbols|font-(extrabold|black)|#[0-9a-fA-F]{3,6}\b|lucide/);
});

test("이월 승인은 기존 CARRY 규칙을 그대로 부른다 — 계산·표를 둘로 만들지 않는다", () => {
  const admin = read("src/lib/regular/illness-carry-admin.ts");
  assert.match(admin, /await resolveWorkbenchAbsence\(/);
  assert.match(admin, /resolution: "CARRY", evidenceConfirmed: true, eligibility: "ILLNESS_INJURY"/);
  assert.doesNotMatch(admin, /INSERT INTO "BillingCarryCredit"|INSERT INTO "BillingAbsenceResolution"|numerator|denominator/, "적립·금액 계산을 여기서 다시 하지 않는다");
  assert.match(admin, /isolationLevel: "Serializable"/);
  // 청구 준비 화면과 같은 스위치
  assert.match(read("src/app/actions/illness-carry-admin.ts"), /process\.env\.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true"/);
  // 기존 규칙 쪽이 검토 상태를 같은 거래에서 맞춘다(표가 있을 때만)
  const workbench = read("src/lib/billing/workbench-absence.ts");
  assert.match(workbench, /to_regclass\(\$1\)::text AS found`,'public\."RegularAbsenceCarryReview"'\)/);
  assert.match(workbench, /b\.resolution==="CARRY"\?"APPROVED":"MAKEUP"/);
});

test("카카오 결석·FAQ: 사진은 앱에서 올리라고 안내하고, FAQ 는 «증빙 사진 → 다음 달 수강료에서 차감»으로 말한다", async () => {
  const kakao = read("src/lib/kakao-absence-flow.ts");
  assert.match(kakao, /reason: state\.reason, source: "KAKAO" \}\)/);
  assert.match(kakao, /carryPending \? ILLNESS_KAKAO_NOTICE :/);
  assert.match(kakao, /export const ILLNESS_KAKAO_NOTICE = "[^"]*앱 「결석 알리기」에서 결석일부터 7일 안에 증빙 사진[^"]*다음 달 수강료에서 빼 드려요[^"]*보강권 1장으로 바뀌어요\."/);
  assert.match(read("src/lib/kakao-parent-intake-routing.ts"), /source: "KAKAO",/);
  const faq = read("src/app/faq/FaqClient.tsx");
  assert.match(faq, /증빙 사진\(진단서·진료확인서·처방전·약 봉투\)을 결석일부터 7일 안에 올려 주세요\. 확인 후 다음 달 수강료에서 1회분을 빼 드립니다/);
  // 신청 화면의 같은 안내·약관 요약도 같은 취지(옛 «진단서 제출 가능한 경우 … 이월 또는 환불» 문구 없음)
  const applyFaq = read("src/app/apply/ApplyPageClient.tsx");
  const terms = read("src/app/apply/enroll/EnrollApplicationLaterSteps.tsx");
  assert.match(applyFaq, /증빙 사진\(진단서·진료확인서·처방전·약 봉투\)을 결석일부터 7일 안에 올려 주세요\. 확인 후 다음 달 수강료에서 1회분을 빼 드립니다/);
  assert.match(terms, /질병이나 부상으로 결석한 경우 결석일부터 7일 안에 증빙 사진을 올리면, 확인 후 다음 달 수강료에서 1회분을 뺍니다\./);
  for (const source of [faq, applyFaq, terms]) assert.doesNotMatch(source, /진단서 제출 가능한 경우|증빙이 가능한 경우에는 확인 후 이월 또는 환불/);
});
