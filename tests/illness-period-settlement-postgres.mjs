import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 부상·질병 «기간 결석» 복귀 정산(3단계, 2026-11-15 원장 결정) — 실제 PostgreSQL 로 돌리는 흐름 검증.
// tests/billing-workbench-postgres.integration.mjs 가 맨 끝에서 부른다(같은 임시 DB · 같은 청구 준비 모듈).
// 실행: node scripts/test-billing-workbench-postgres.mjs
//
// 흐름(윤수영 사례를 본뜬 합성 자료 — 월요반 105,000원 · 금요반 90,000원):
//   3월분 납부(월요반 = 청구 준비 발행·납부 / 금요반 = 초안 없는 납부 청구) → 4월 월요반 청구 발행(미납) → 부상 결석 승인 → 4월 청구 보류로 돌리기
//   → 미리보기(지금까지 예상 · 복귀일 기준 · 날짜 빼기) → 학부모 미리보기(같은 숫자 · 남의 아이 거절)
//   → 확정(지문 불일치·결석 취소·스위치 꺼짐 거절 → 성공) → 청구 준비 4월(다닌 만큼만 제안 · 이월 한 번 차감) → 5월(남은 이월 그대로)
//   → 확정 취소(쓰인 뒤 거절 / 안 쓰였으면 되돌림) → 다시 확정
export async function runIllnessSettlementPostgresTests({ pool, database, root, checks, readWorkbench, mutateWorkbench, cmd, absenceModuleUrl, modelUrl, serviceUrl, calendarUrl, periodAdmin }) {
  const { loadTsModule } = await import('./_ts-module.mjs');
  // 정산 연결부 — 이월 근거·적립은 통합 테스트가 이미 조립한 «같은» 모듈을 쓴다(식이 둘로 갈리지 않는지 실제로 본다)
  const settlement = await loadTsModule('src/lib/regular/illness-period-settlement.ts', { overrides: { '@/lib/billing/workbench-absence': absenceModuleUrl, '@/lib/billing/workbench': modelUrl } });
  const rules = await loadTsModule('src/lib/regular/illnessPeriodRules.ts');
  const periodPlan = await loadTsModule('src/lib/regular/absence-period-plan.ts');
  const { getMonthlyClassDates } = await import(calendarUrl);
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;

  // ── 표 보정: 기간 결석 복귀 처리(endAbsencePeriodInTx)·검토 표가 쓰는 칸 ──
  const reviewMigration = await readFile(path.join(root, 'prisma/migrations/20261114130000_illness_carry_review/migration.sql'), 'utf8');
  const createTable = (name) => { const found = reviewMigration.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\."${name}" \\([\\s\\S]*?\\n\\);`)); assert.ok(found, name); return found[0]; };
  await pool.query(`ALTER TABLE "RegularAbsence" ADD COLUMN note text, ADD COLUMN "reportedByUserId" text, ADD COLUMN "resolvedByUserId" text, ADD COLUMN "createdAt" timestamptz DEFAULT now(), ADD COLUMN "updatedAt" timestamptz DEFAULT now();
    ALTER TABLE "RegularAbsence" ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
    CREATE UNIQUE INDEX "RegularAbsence_student_class_date" ON "RegularAbsence"("studentId","classId",date);
    ALTER TABLE "RegularAbsencePeriod" ADD COLUMN "coveredUntil" date, ADD COLUMN "createdByUserId" text, ADD COLUMN "endedByUserId" text;
    ALTER TABLE "Class" ADD COLUMN "startTime" text;`);
  await pool.query(`${createTable('RegularAbsenceCarryReview')}\n${createTable('RegularAbsenceEvidence')}`);

  // ── 합성 자료 ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s7','합성 정산 원생','parent7',NULL),('s8','합성 남의 아이','parent8',NULL),('s9','합성 학부모기간 원생','parent9',NULL);
    INSERT INTO "Program"(id,price,name) VALUES('p7m',105000,'합성 월요 프로그램'),('p7f',90000,'합성 금요 프로그램');
    INSERT INTO "Class"(id,name,"programId","dayOfWeek","startTime") VALUES('m7','합성 월요반','p7m','Mon','18:00'),('f7','합성 금요반','p7f','Fri','18:00');
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e7m','s7','m7','ACTIVE','2026-01-01','2026-01-01'),('e7f','s7','f7','ACTIVE','2026-01-01','2026-01-01'),('e9m','s9','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "AnnualEvent"(id,title,date) VALUES('mar-open','3월 개강','2027-03-01'),('mar-close','3월 종강','2027-03-27'),('apr-open','4월 개강','2027-03-29'),('apr-close','4월 종강','2027-04-24'),('may-open','5월 개강','2027-04-26'),('may-close','5월 종강','2027-05-22');`);
  // 수업일(연간 일정 함수 — 청구 준비와 같은 DB 일정). 손으로 센 값을 옆에 적는다
  const events = (await all(`SELECT title,date,"endDate" FROM "AnnualEvent" ORDER BY date,id`)).map((e) => ({ title: e.title, date: new Date(e.date).toISOString(), ...(e.endDate ? { endDate: new Date(e.endDate).toISOString() } : {}) }));
  const classDatesForMonth = (month, dayOfWeek) => getMonthlyClassDates(events, month, dayOfWeek);
  assert.deepEqual(classDatesForMonth('2027-03', 'Mon'), ['2027-03-01', '2027-03-08', '2027-03-15', '2027-03-22'], '3월 월요일 4회');
  assert.deepEqual(classDatesForMonth('2027-03', 'Fri'), ['2027-03-05', '2027-03-12', '2027-03-19', '2027-03-26'], '3월 금요일 4회');
  assert.deepEqual(classDatesForMonth('2027-04', 'Mon'), ['2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19'], '4월 수강월 월요일 4회 — 첫 수업은 3/29');
  assert.deepEqual(classDatesForMonth('2027-04', 'Fri'), ['2027-04-02', '2027-04-09', '2027-04-16', '2027-04-23'], '4월 금요일 4회');
  const ctx = (todayYmd, actorUserId = 'admin') => ({ todayYmd, actorUserId, classDatesForMonth });
  const TODAY = '2027-04-12';
  const view = (month) => database.$transaction((tx) => readWorkbench(tx, month, true), { isolationLevel: 'RepeatableRead' });
  const issue = async (month, ids) => {
    let v = await view(month);
    v = (await mutateWorkbench(database, cmd('SAVE', v, ids), 'admin', true)).view;
    v = (await mutateWorkbench(database, cmd('CONFIRM', v, ids), 'admin', true)).view;
    return mutateWorkbench(database, cmd('ISSUE', v, ids), 'admin', true);
  };

  // 3월분: 월요반 = 청구 준비에서 발행하고 납부 / 금요반 = 초안 없이 납부된 청구(랠리즈 이관 모양)
  const marchMon = (await issue('2027-03', ['s7:m7'])).operationResult.paymentIds[0];
  await pool.query(`UPDATE "Payment" SET status='PAID' WHERE id=$1`, [marchMon]); await pool.query(`UPDATE "PaymentInvoice" SET status='PAID' WHERE "paymentId"=$1`, [marchMon]);
  await pool.query(`INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s7-mar-fri','s7','f7',90000,'PAID','MONTHLY',2027,3,'S7-MAR-FRI',NOW()),('s9-mar-mon','s9','m7',105000,'PAID','MONTHLY',2027,3,'S9-MAR-MON',NOW())`);
  // 4월분: 월요반만 발행(미납). 금요반은 아직 청구 전
  const aprilMon = (await issue('2027-04', ['s7:m7'])).operationResult.paymentIds[0];

  // 기간 결석(학원 등록 · 복귀 미정 · 승인됨): 3/12 ~. 결석 = 월 3/15·22·29·4/5·12·19, 금 3/12·19·26·4/2·9·16·23
  const note = periodPlan.periodAbsenceNote('ILLNESS_INJURY', '2027-03-12');
  await pool.query(`INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","carryApprovedAt","carryApprovedByUserId","carrySettlement","coveredUntil","createdByUserId")
    VALUES('settle-period','s7','ILLNESS_INJURY','2027-03-12',NULL,'ACTIVE',ARRAY[]::text[],'APPROVED',now(),'admin','{"approval":{"revokedCreditIds":["kept-mc"],"createdReviewAbsenceIds":["kept"]}}'::jsonb,'2027-05-31','admin')`);
  const absenceId = (classId, date) => `ab-${classId}-${date.slice(5)}`;
  for (const [classId, dates] of [['m7', ['2027-03-15', '2027-03-22', '2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19']], ['f7', ['2027-03-12', '2027-03-19', '2027-03-26', '2027-04-02', '2027-04-09', '2027-04-16', '2027-04-23']]]) {
    for (const date of dates) await pool.query(`INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,note,"periodId") VALUES($1,'s7',$2,$3::date,'ILLNESS_INJURY','CONFIRMED',$4,'settle-period')`, [absenceId(classId, date), classId, date, note]);
  }
  // 금 3/19 는 그날 출석으로 기록됨(정산에서 빠진다) · 월 3/15 는 미사용 보강권이 남아 있음(확정 때 회수)
  await pool.query(`INSERT INTO "Session" VALUES('settle-session','f7','2027-03-19');INSERT INTO "Attendance" VALUES('settle-att','s7','settle-session','PRESENT',NOW());
    INSERT INTO "MakeupCredit"(id,"studentId","sourceKey",status,"updatedAt","expiresAt") VALUES('settle-mc','s7','REGULAR:m7:2027-03-15','AVAILABLE',NOW(),NOW()+interval '30 days')`);

  // 낸 돈이 없는 달(4월)의 미납 청구가 그대로 살아 있는 동안에는 확정할 수 없다 — 그대로 확정하면 그 청구가 전액으로 남는다
  const openBill = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'settle-period', returnDate: '2027-04-12' }, ctx(TODAY));
  assert.deepEqual(openBill.plan.problems.map((problem) => [problem.code, problem.text]), [['OPEN_BILL', '4월 합성 월요반 미납 청구가 그대로 있습니다. 먼저 ‹발행 보류로 돌리기›를 해 주세요.']]);
  assert.ok(openBill.blockers.includes('4월 합성 월요반 미납 청구가 그대로 있습니다. 먼저 ‹발행 보류로 돌리기›를 해 주세요.'));
  await assert.rejects(settlement.settleIllnessPeriod(database, { periodId: 'settle-period', expectedFingerprint: openBill.fingerprint, returnDate: '2027-04-12' }, 'admin', true, ctx(TODAY)), /미납 청구가 그대로 있습니다\. 먼저 ‹발행 보류로 돌리기›를 해 주세요/);
  assert.deepEqual(await one(`SELECT status,"carryState" FROM "RegularAbsencePeriod" WHERE id='settle-period'`), { status: 'ACTIVE', carryState: 'APPROVED' });
  assert.equal((await one(`SELECT status FROM "Payment" WHERE id=$1`, [aprilMon])).status, 'PENDING');
  checks.push('낸 돈이 없는 달에 미납 청구가 살아 있으면 확정 차단(문제 목록·지문에 반영, 아무것도 바뀌지 않음)');
  // 4월 미납 청구를 보류로 돌린다(2단계) — 현장 결제 요청 재확인 SQL 도 이때 실제로 돈다
  const held = await periodAdmin.holdIssuedBillsForPeriod(database, { periodId: 'settle-period', expectedPaymentIds: [aprilMon] }, 'admin');
  assert.deepEqual(held.held.map((bill) => [bill.paymentId, bill.amount]), [[aprilMon, 105000]]);
  assert.equal((await one(`SELECT status FROM "Payment" WHERE id=$1`, [aprilMon])).status, 'CANCELED');
  // 보류 중: 4월 청구 준비에서 두 반 모두 발행 보류
  let april = await view('2027-04');
  assert.deepEqual(april.rows.filter((r) => r.studentId === 's7').map((r) => [r.id, r.hold === true]), [['s7:f7', true], ['s7:m7', true]]);
  checks.push('정산 준비: 3월 납부(발행 초안·납부 청구) · 4월 미납 청구 보류 전환(현장 결제 재확인 SQL 포함) · 청구 준비 발행 보류');

  // ── 미리보기 ──
  const estimate = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'settle-period' }, ctx(TODAY));
  assert.equal(estimate.returnDate, null); assert.equal(estimate.canSetReturnDate, true);
  assert.ok(estimate.blockers.includes('복귀일을 먼저 정해 주세요.'));
  assert.equal(estimate.plan.carryTotal, 97500, '지금까지 예상 = 3월 월 2회 52,500 + 금 2회 45,000');
  const preview = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'settle-period', returnDate: '2027-04-12' }, ctx(TODAY));
  assert.deepEqual(preview.blockers, []);
  assert.notEqual(preview.fingerprint, openBill.fingerprint, '보류로 돌리면 문제가 사라져 지문이 달라진다');
  assert.deepEqual(preview.plan.rows.map((row) => [row.month, row.className, row.evidence, row.tuition, row.sessions, row.dates, row.unitDisplay, row.subtotal]), [
    // 금요반 3월: 납부 청구 90,000 ÷ 4회 = 22,500 × 2회(3/12·3/26) = 45,000 — 3/19 는 출석 기록이 있어 제외
    ['2027-03', '합성 금요반', 'PAID_PAYMENT', 90000, 4, ['2027-03-12', '2027-03-26'], 22500, 45000],
    // 월요반 3월: 발행·납부 105,000 ÷ 4회 = 26,250 × 2회(3/15·3/22) = 52,500
    ['2027-03', '합성 월요반', 'WORKBENCH_ISSUED', 105000, 4, ['2027-03-15', '2027-03-22'], 26250, 52500],
    // 4월 수강월(낸 돈 없음): 금 4/2·4/9 · 월 3/29·4/5 — 이월 없음
    ['2027-04', '합성 금요반', 'UNPAID', 0, 4, ['2027-04-02', '2027-04-09'], 0, 0],
    ['2027-04', '합성 월요반', 'UNPAID', 0, 4, ['2027-03-29', '2027-04-05'], 0, 0],
  ]);
  assert.deepEqual(preview.plan.rows[0].excluded.map((item) => [item.date, item.code]), [['2027-03-19', 'ATTENDED']]);
  assert.equal(preview.plan.carryTotal, 97500);
  assert.equal(preview.availableMonth, '2027-04', '이월을 쓸 수 있는 달 = 복귀일이 속한 달');
  assert.deepEqual(preview.plan.unpaidGuides.map((g) => [g.classId, g.shape, g.attended, g.periodStart, g.periodEnd]), [['f7', 'PREFIX', 2, '2027-04-16', '2027-04-23'], ['m7', 'PREFIX', 2, '2027-04-12', '2027-04-19']]);
  // 날짜 빼기 → 금액·지문이 바뀐다 / 다시 넣으면 처음 지문
  const omitted = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'settle-period', returnDate: '2027-04-12', omitAbsenceIds: [absenceId('m7', '2027-03-22')] }, ctx(TODAY));
  assert.equal(omitted.plan.carryTotal, 71250); assert.notEqual(omitted.fingerprint, preview.fingerprint);
  assert.equal((await settlement.previewIllnessPeriodSettlement(database, { periodId: 'settle-period', returnDate: '2027-04-12', omitAbsenceIds: [] }, ctx(TODAY))).fingerprint, preview.fingerprint);
  // 미리보기는 아무것도 바꾸지 않는다
  assert.deepEqual(await one(`SELECT status,"carryState","returnDate" FROM "RegularAbsencePeriod" WHERE id='settle-period'`), { status: 'ACTIVE', carryState: 'APPROVED', returnDate: null });
  assert.equal(Number((await one(`SELECT count(*) FROM "RegularAbsence" WHERE "periodId"='settle-period' AND status='CANCELLED'`)).count), 0);
  checks.push('미리보기: 달별 표(납부 청구·발행 초안 근거, 수강월 3/29→4월) · 합계 97,500 · 낸 돈 없는 달 안내 2건 · 날짜 빼기 71,250·지문 변경 · 읽기만');

  // ── 학부모 미리보기(설계 H): 같은 숫자 · 남의 아이 거절 ──
  const ownChild = `s."parentId" = $1`;
  const parentView = await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: '2027-04-12' }, ctx(TODAY, 'parent7'), ownChild);
  assert.equal(parentView.state, 'ESTIMATE'); assert.equal(parentView.view.pendingCheck, false);
  assert.equal(parentView.view.total, preview.plan.carryTotal);
  assert.deepEqual(parentView.view.months, preview.plan.rows.filter((row) => row.evidence !== 'UNPAID').map((row) => ({ month: row.month, className: row.className, missed: row.dates.length, subtotal: row.subtotal })));
  assert.deepEqual(parentView.view.unpaid.map((row) => row.text), ['4월 합성 금요반 수강료는 다닌 2회만큼 다시 안내해요', '4월 합성 월요반 수강료는 다닌 2회만큼 다시 안내해요']);
  assert.equal(await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent8', periodId: 'settle-period', returnDate: '2027-04-12' }, ctx(TODAY, 'parent8'), ownChild), null, '남의 아이 기간');
  assert.equal(await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: '없는기간' }, ctx(TODAY, 'parent7'), ownChild), null);
  await assert.rejects(settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: '2027-03-12' }, ctx(TODAY, 'parent7'), ownChild), /복귀일을 다시 골라/);
  // 복귀일 상한(보안 검수): 오늘(4/12) + 28일 = 5/10 까지 — 2099·하루 넘는 날은 거절, 상한 당일은 통과
  for (const far of ['2099-01-01', '2027-05-11']) await assert.rejects(settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: far }, ctx(TODAY, 'parent7'), ownChild), /복귀일을 다시 골라/, far);
  assert.equal((await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: '2027-05-10' }, ctx(TODAY, 'parent7'), ownChild)).state, 'ESTIMATE');
  // 결석을 만들어 둔 끝(coveredUntil) 다음 날이 더 이르면 그날이 상한
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "coveredUntil"='2027-04-20' WHERE id='settle-period'`);
  await assert.rejects(settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: '2027-04-22' }, ctx(TODAY, 'parent7'), ownChild), /복귀일을 다시 골라/);
  assert.equal((await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period', returnDate: '2027-04-21' }, ctx(TODAY, 'parent7'), ownChild)).state, 'ESTIMATE');
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "coveredUntil"='2027-05-31' WHERE id='settle-period'`);
  checks.push('학부모 미리보기 = 원장 미리보기 같은 숫자(합계·달별 소계·미납 달 문구) · 남의 아이·없는 기간은 null · 시작일 이전 복귀일 거절 · 복귀일 상한(2099 거절·경계일 통과)');

  // ── 확정: 거절 사례 ──
  const settleInput = { periodId: 'settle-period', expectedFingerprint: preview.fingerprint, returnDate: '2027-04-12' };
  await assert.rejects(settlement.settleIllnessPeriod(database, settleInput, 'admin', false, ctx(TODAY)), /청구 준비 저장이 켜진 뒤/);
  await assert.rejects(settlement.settleIllnessPeriod(database, settleInput, '', true, ctx(TODAY)), /관리자 확인/);
  await assert.rejects(settlement.settleIllnessPeriod(database, { ...settleInput, expectedFingerprint: omitted.fingerprint }, 'admin', true, ctx(TODAY)), /정산 내용이 바뀌었습니다/);
  await assert.rejects(settlement.settleIllnessPeriod(database, { ...settleInput, returnDate: null }, 'admin', true, ctx(TODAY)), /복귀일을 먼저 정해/);
  // 미리보기 뒤 결석 하나가 취소됐다 → 지문이 달라 확정 거절, 같은 거래의 복귀 처리도 함께 되돌아간다
  await pool.query(`UPDATE "RegularAbsence" SET status='CANCELLED' WHERE id=$1`, [absenceId('f7', '2027-03-26')]);
  await assert.rejects(settlement.settleIllnessPeriod(database, settleInput, 'admin', true, ctx(TODAY)), /정산 내용이 바뀌었습니다/);
  assert.deepEqual(await one(`SELECT status,"carryState","returnDate" FROM "RegularAbsencePeriod" WHERE id='settle-period'`), { status: 'ACTIVE', carryState: 'APPROVED', returnDate: null });
  assert.equal((await one(`SELECT status FROM "RegularAbsence" WHERE id=$1`, [absenceId('m7', '2027-04-19')])).status, 'CONFIRMED', '복귀 처리가 되돌아갔다');
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s7'`)).count), 0);
  await pool.query(`UPDATE "RegularAbsence" SET status='CONFIRMED' WHERE id=$1`, [absenceId('f7', '2027-03-26')]);
  checks.push('확정 거절: 저장 스위치 꺼짐 · 다른 지문 · 복귀일 없음 · 미리보기 뒤 결석 취소 — 복귀 처리까지 전부 되돌아가고 이월 0건');

  // ── 확정 ──
  const settled = await settlement.settleIllnessPeriod(database, settleInput, 'admin', true, ctx(TODAY));
  assert.equal(database.lastIsolation, 'read committed', '확정은 DB 기본 격리 수준(잠근 뒤 다시 읽는 값이 최신이어야 한다)');
  assert.deepEqual(settled, { periodId: 'settle-period', studentId: 's7', startDate: '2027-03-12', returnDate: '2027-04-12', carryTotal: 97500, availableMonth: '2027-04', credited: 4, unpaidResolved: 4, unpaidMonths: 2 });
  const period = await one(`SELECT status,"carryState",to_char("returnDate",'YYYY-MM-DD') AS "returnDate","carrySettledByUserId","carrySettledAt" IS NOT NULL AS "settledAt","carrySettlement" FROM "RegularAbsencePeriod" WHERE id='settle-period'`);
  assert.deepEqual([period.status, period.carryState, period.returnDate, period.carrySettledByUserId, period.settledAt], ['ENDED', 'SETTLED', '2027-04-12', 'admin', true]);
  // 병합 저장 — 승인 기록·보류로 돌린 청구 사본을 지우지 않는다
  assert.deepEqual(period.carrySettlement.approval, { revokedCreditIds: ['kept-mc'], createdReviewAbsenceIds: ['kept'] });
  assert.deepEqual(period.carrySettlement.held.map((bill) => bill.paymentId), [aprilMon]);
  assert.equal(period.carrySettlement.settlement.carryTotal, 97500); assert.equal(period.carrySettlement.settlement.fingerprint, preview.fingerprint);
  assert.deepEqual(period.carrySettlement.unpaidGuides.map((g) => [g.month, g.classId, g.missedDates]), [['2027-04', 'f7', ['2027-04-02', '2027-04-09']], ['2027-04', 'm7', ['2027-03-29', '2027-04-05']]]);
  const credits = await all(`SELECT "absenceId",numerator::text,denominator::text,"availableMonth",basis FROM "BillingCarryCredit" WHERE "studentId"='s7' ORDER BY "absenceId"`);
  assert.deepEqual(credits.map((c) => [c.absenceId, c.numerator, c.denominator, c.availableMonth, c.basis.source, c.basis.originMonth, c.basis.periodId]), [
    ['ab-f7-03-12', '90000', '4', '2027-04', 'PAID_PAYMENT', '2027-03', 'settle-period'], ['ab-f7-03-26', '90000', '4', '2027-04', 'PAID_PAYMENT', '2027-03', 'settle-period'],
    ['ab-m7-03-15', '105000', '4', '2027-04', 'WORKBENCH_ISSUED', '2027-03', 'settle-period'], ['ab-m7-03-22', '105000', '4', '2027-04', 'WORKBENCH_ISSUED', '2027-03', 'settle-period'],
  ]);
  // 정산 기록 8건(이월 4 + 낸 돈 없는 달 4) — 출석 기록이 있던 3/19 와 복귀일 이후는 없다
  const resolutions = await all(`SELECT r."absenceId",r.reason FROM "BillingAbsenceResolution" r JOIN "RegularAbsence" a ON a.id=r."absenceId" WHERE a."periodId"='settle-period' ORDER BY r."absenceId"`);
  assert.deepEqual(resolutions.map((r) => r.absenceId), ['ab-f7-03-12', 'ab-f7-03-26', 'ab-f7-04-02', 'ab-f7-04-09', 'ab-m7-03-15', 'ab-m7-03-22', 'ab-m7-03-29', 'ab-m7-04-05']);
  assert.ok(resolutions.filter((r) => /낸 돈이 없는 달/.test(r.reason)).length === 4);
  assert.deepEqual((await all(`SELECT id FROM "RegularAbsence" WHERE "periodId"='settle-period' AND status='CANCELLED' ORDER BY id`)).map((r) => r.id), ['ab-f7-04-16', 'ab-f7-04-23', 'ab-m7-04-12', 'ab-m7-04-19'], '복귀일(4/12) 이후 결석은 취소');
  assert.equal((await one(`SELECT status FROM "MakeupCredit" WHERE id='settle-mc'`)).status, 'REVOKED', '미사용 보강권 회수');
  assert.equal(Number((await one(`SELECT count(*) FROM "RegularAbsenceCarryReview" WHERE status='APPROVED' AND "absenceId" LIKE 'ab-%'`)).count), 8, '검토 승인(없던 줄은 만든다)');
  assert.equal(Number((await one(`SELECT count(*) FROM "OperationsAuditLog" WHERE action='ILLNESS_PERIOD_SETTLED' AND "detailsJson"->>'periodId'='settle-period'`)).count), 1);
  // 두 번 누르면 두 번째는 상태 조건에서 끝난다 — 이월은 한 번만
  await assert.rejects(settlement.settleIllnessPeriod(database, settleInput, 'admin', true, ctx(TODAY)), /이미 이월을 확정한 기간/);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s7'`)).count), 4);
  // 확정된 표 사본(화면용)·학부모 화면 상태
  const stored = await database.$transaction((tx) => settlement.readSettledIllnessPeriod(tx, 'settle-period'), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual([stored.carryTotal, stored.returnDate, stored.availableMonth, stored.rows.length, stored.unpaidGuides.length, stored.used], [97500, '2027-04-12', '2027-04', 4, 2, false]);
  const parentSettled = await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'settle-period' }, ctx(TODAY, 'parent7'), ownChild);
  assert.deepEqual([parentSettled.state, parentSettled.settledTotal], ['SETTLED', 97500]);
  assert.equal(rules.periodSettledParentText(parentSettled.settledTotal), '이월 97,500원 확정 · 다음 수강료에서 빼 드려요');
  checks.push('확정: 복귀 처리(같은 거래)·이월 4건(쓸 수 있는 달 = 복귀 달, basis.periodId)·정산 기록 8건·보강권 회수·검토 승인·carrySettlement 병합·감사 기록·READ COMMITTED · 두 번 눌러도 한 번');

  // ── 청구 준비(4월): 보류 해제 · 낸 돈이 없는 달은 다닌 만큼만 제안 · 이월 자동 제안 ──
  april = await view('2027-04');
  const fri = april.rows.find((r) => r.id === 's7:f7'), mon = april.rows.find((r) => r.id === 's7:m7');
  assert.ok(!fri.hold && !mon.hold, '확정하면 발행 보류가 풀린다');
  assert.deepEqual([fri.blockingReasons, mon.blockingReasons], [[], []], '이 기간의 이월이 유효로 판정돼 발행이 막히지 않는다');
  assert.equal(fri.carryAvailable, 97500);
  // 금요반(초안 없음): 4회 중 앞 2회 빠짐 → 수강 4/16~4/23 · 기간 조정 45,000 · 이월 45,000 자동 제안 → 0원
  assert.deepEqual([fri.baseAmount, fri.prorationAmount, fri.carryAmount, fri.periodStart, fri.periodEnd, fri.scheduledDates], [90000, 45000, 45000, '2027-04-16', '2027-04-23', ['2027-04-16', '2027-04-23']]);
  assert.ok(fri.basis.includes('부상 결석 2회 제외 → 기간 조정 45,000원 제안(다닌 2회 · 수강 2027-04-16~2027-04-23)'));
  // 월요반(보류로 돌렸던 초안이 남아 있다 = 정산 전 금액 105,000): 수강료·할인은 저장값, 기간·기간 조정·이월은 제안값이 기본으로 나온다
  //   기간 조정 = 105,000 × 빠진 2회 ÷ 4회 = 52,500 · 수강 4/12~4/19 · 이월 52,500(금요반 제안 45,000을 뺀 나머지) → 0원
  assert.deepEqual([mon.draftStatus, mon.baseAmount, mon.prorationAmount, mon.carryAmount, mon.totalAmount, mon.periodStart, mon.periodEnd, mon.scheduledDates],
    ['DRAFT', 105000, 52500, 52500, 0, '2027-04-12', '2027-04-19', ['2027-04-12', '2027-04-19']]);
  assert.ok(mon.reviewReasons.includes('부상 결석 정산 뒤라 저장해 둔 금액 대신 제안값으로 바꿨습니다 — 기간 조정 52,500원(저장값 0원)·이월 52,500원(저장값 0원). 확인하고 다시 저장해 주세요.'));
  checks.push('청구 준비 4월: 보류 해제 · 초안 없는 행은 다닌 만큼만 제안(기간·기간 조정 45,000·이월 45,000) · 보류했던 초안도 기간·기간 조정·이월은 제안값이 기본(전액 105,000 이 아니라 0원)');
  // 저장: 금요반은 이월을 20,000원만 쓰고(다음 달로 남기려고 일부러 고침), 월요반은 «화면에 보이는 값 그대로» 저장한다(사람이 금액을 넣지 않는다)
  april = (await mutateWorkbench(database, cmd('SAVE', april, ['s7:f7'], { carryAmount: 20000, periodStart: fri.periodStart, periodEnd: fri.periodEnd }), 'admin', true)).view;
  const monAsShown = april.rows.find((r) => r.id === 's7:m7');
  assert.deepEqual([monAsShown.prorationAmount, monAsShown.carryAmount], [52500, 52500]);
  april = (await mutateWorkbench(database, cmd('SAVE', april, ['s7:m7'], { periodStart: monAsShown.periodStart, periodEnd: monAsShown.periodEnd }), 'admin', true)).view;
  assert.ok(!april.rows.find((r) => r.id === 's7:m7').reviewReasons.some((reason) => /부상 결석/.test(reason)), '다시 저장하면 알림이 걷힌다');
  assert.deepEqual([april.rows.find((r) => r.id === 's7:m7').prorationAmount, april.rows.find((r) => r.id === 's7:m7').totalAmount], [52500, 0]);
  april = (await mutateWorkbench(database, cmd('CONFIRM', april, ['s7:f7', 's7:m7']), 'admin', true)).view;
  const aprilIssue = cmd('ISSUE', april, ['s7:f7', 's7:m7']), aprilIssued = await mutateWorkbench(database, aprilIssue, 'admin', true);
  await mutateWorkbench(database, aprilIssue, 'admin', true); // 응답 유실 재시도 — 한 번만 차감돼야 한다
  assert.equal(aprilIssued.operationResult.zeroCount, 1, '월요반은 0원 발행');
  assert.deepEqual((await all(`SELECT amount,status FROM "Payment" WHERE "studentId"='s7' AND year=2027 AND month=4 AND status<>'CANCELED'`)).map((p) => [p.amount, p.status]), [[25000, 'PENDING']], '금요반 90,000 − 45,000 − 20,000 = 25,000');
  const usages = await all(`SELECT "draftId",amount,cardinality("sourceCreditIds") AS n FROM "BillingCarryUsage" WHERE "studentId"='s7' ORDER BY "draftId"`);
  assert.deepEqual(usages.map((u) => [u.draftId, u.amount]), [['s7:f7', 20000], ['s7:m7', 52500]]);
  assert.equal(usages.reduce((sum, u) => sum + u.amount, 0), 72500, '이중 차감 없음 — 이월 사용은 정확히 한 번씩');
  assert.equal(aprilIssued.view.rows.find((r) => r.id === 's7:f7').carryAvailable, 25000);
  // 5월: 남은 25,000원이 그대로 다음 달 제안에
  const may = await view('2027-05');
  assert.deepEqual(may.rows.filter((r) => r.studentId === 's7').map((r) => [r.id, r.carryAvailable, r.carryAmount, r.blockingReasons.length]), [['s7:f7', 25000, 25000, 0], ['s7:m7', 25000, 0, 0]]);
  checks.push('이중 차감 없음: 4월 발행에서 이월 72,500원 한 번만 차감(재시도 포함) · 다닌 만큼만 청구(25,000원·0원 발행) · 남은 25,000원이 5월 제안에 그대로');
  // 쓰인 뒤에는 확정 취소 불가
  await assert.rejects(settlement.cancelIllnessPeriodSettlement(database, { periodId: 'settle-period' }, 'admin', true), /이미 청구에서 차감된 이월이 있어 확정 취소할 수 없습니다/);
  assert.equal((await one(`SELECT "carryState" FROM "RegularAbsencePeriod" WHERE id='settle-period'`)).carryState, 'SETTLED');
  assert.equal((await database.$transaction((tx) => settlement.readSettledIllnessPeriod(tx, 'settle-period'), { isolationLevel: 'RepeatableRead' })).used, true);
  checks.push('확정 취소: 이월이 청구에서 차감된 뒤에는 거절(상태 그대로)');

  // ── 학부모가 알린 기간(끝일이 지남) · 확정 취소(미사용) · 다시 확정 · 동시 확정 ──
  const parentNote = '여러 날 결석 · 3/15(월)~3/28(일)';
  await pool.query(`INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","reportedByUserId","carryState","carryApprovedAt","carrySettlement","coveredUntil","createdByUserId")
    VALUES('parent-period','s9','ILLNESS_INJURY','2027-03-15','2027-03-29','ACTIVE',ARRAY[]::text[],'parent9','APPROVED',now(),'{"approval":{"revokedCreditIds":["s9-old-mc"],"createdReviewAbsenceIds":[]}}'::jsonb,'2027-03-28','parent9');
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,note,"periodId","reportedByUserId") VALUES('s9-0315','s9','m7','2027-03-15','ILLNESS_INJURY','REPORTED',$1,'parent-period','parent9'),('s9-0322','s9','m7','2027-03-22','ILLNESS_INJURY','REPORTED',$1,'parent-period','parent9');
    INSERT INTO "MakeupCredit"(id,"studentId","sourceKey",status,"updatedAt","expiresAt") VALUES('s9-mc','s9','REGULAR:m7:2027-03-22','AVAILABLE',NOW(),NOW()+interval '30 days')`.replaceAll('$1', `'${parentNote}'`));
  // 정산 필요·인정 안 함 판정 조각(신청함 상태식·학생 상세가 쓰는 것)을 실제로 돌린다 — 오늘은 DB 시계라 지난 날짜·먼 미래로 확인
  const flags = async (id) => one(`SELECT ${rules.illnessSettleNeededSql('p')} AS need, ${rules.illnessPeriodDeclinedSql('p')} AS declined FROM "RegularAbsencePeriod" p WHERE p.id=$1`, [id]);
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "returnDate"='2020-01-02',"startDate"='2020-01-01' WHERE id='parent-period'`);
  assert.deepEqual(await flags('parent-period'), { need: true, declined: false }, '복귀일이 지난 승인 기간 = 정산 필요');
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "returnDate"='2099-01-02' WHERE id='parent-period'`);
  assert.deepEqual(await flags('parent-period'), { need: false, declined: false });
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "returnDate"='2027-03-29',"startDate"='2027-03-15' WHERE id='parent-period'`);
  assert.deepEqual(await flags('settle-period'), { need: false, declined: false }, '확정된 기간은 정산 필요가 아니다');
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "carrySettlement"=COALESCE("carrySettlement",'{}'::jsonb) || '{"declined":{"byUserId":"admin","at":"2026-11-15T00:00:00.000Z"}}'::jsonb WHERE id='hold-period'`);
  assert.deepEqual(await flags('hold-period'), { need: false, declined: true }, '«인정 안 함» 표시');
  // 인정 안 한 기간의 새 날 전환 — 대상 조회 SQL 을 실제로 돌린다(결정 전인 날이 없으면 0건)
  await pool.query(`INSERT INTO "RegularAbsenceCarryReview"("absenceId",status,source,"decidedAt","decidedBy") SELECT id,'MAKEUP','STAFF',now(),'ADMIN' FROM "RegularAbsence" WHERE "periodId"='hold-period'`);
  const plainDb = { ...database, $queryRawUnsafe: async (sql, ...values) => (await pool.query(sql, values)).rows, $executeRawUnsafe: async (sql, ...values) => (await pool.query(sql, values)).rowCount };
  assert.deepEqual(await periodAdmin.convertDeclinedPeriodNewDays(plainDb, () => true), { periods: 0, converted: 0, failed: 0 });
  checks.push('판정 조각 실제 실행: 정산 필요(복귀 처리됨·복귀일 경과) · «인정 안 함» 표시 · 인정 안 한 기간의 새 날 대상 조회');

  const parentPreview = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'parent-period' }, ctx(TODAY));
  assert.deepEqual([parentPreview.returnDate, parentPreview.canSetReturnDate, parentPreview.blockers, parentPreview.plan.carryTotal], ['2027-03-29', false, [], 52500]);
  await assert.rejects(settlement.previewIllnessPeriodSettlement(database, { periodId: 'parent-period', returnDate: '2027-03-22' }, ctx(TODAY)), /학부모가 알린 기간은 여기서 복귀일을 바꿀 수 없습니다/);
  // 동시에 두 번 확정 → 한 번만 성공, 이월은 2건(결석 2회)
  const twice = await Promise.allSettled([1, 2].map(() => settlement.settleIllnessPeriod(database, { periodId: 'parent-period', expectedFingerprint: parentPreview.fingerprint }, 'admin', true, ctx(TODAY))));
  assert.deepEqual(twice.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String(twice.find((r) => r.status === 'rejected').reason?.message), /이미 이월을 확정한 기간/);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s9'`)).count), 2);
  // 학부모가 알린 결석(REPORTED)은 확정 때 «확정»으로 — 이월은 확정된 결석에만 유효하다. 기간은 복귀 처리하지 않는다(학부모 기간)
  assert.deepEqual((await all(`SELECT status FROM "RegularAbsence" WHERE "periodId"='parent-period' ORDER BY id`)).map((r) => r.status), ['CONFIRMED', 'CONFIRMED']);
  assert.deepEqual(await one(`SELECT status,"carryState" FROM "RegularAbsencePeriod" WHERE id='parent-period'`), { status: 'ACTIVE', carryState: 'SETTLED' });
  assert.equal((await view('2027-04')).rows.find((r) => r.id === 's9:m7').carryAvailable, 52500);
  checks.push('동시 확정 두 번 → 한 번만 적립(이월 2건) · 학부모 신고 결석은 확정 때 CONFIRMED · 4월 이월 52,500원');
  // 확정 취소(이월이 아직 쓰이지 않음) → 이월 0·정산 기록 0·상태 APPROVED·결석은 다시 «신고»·감사 사본
  await assert.rejects(settlement.cancelIllnessPeriodSettlement(database, { periodId: 'parent-period' }, 'admin', false), /청구 준비 저장이 켜진 뒤/);
  const cancelled = await settlement.cancelIllnessPeriodSettlement(database, { periodId: 'parent-period' }, 'admin', true);
  assert.deepEqual(cancelled, { periodId: 'parent-period', studentId: 's9', creditsRemoved: 2, resolutionsRemoved: 2, reopened: 2 });
  assert.equal(database.lastIsolation, 'read committed');
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s9'`)).count), 0);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingAbsenceResolution" WHERE "studentId"='s9'`)).count), 0);
  const back = await one(`SELECT "carryState","carrySettledAt","carrySettledByUserId","carrySettlement" FROM "RegularAbsencePeriod" WHERE id='parent-period'`);
  assert.deepEqual([back.carryState, back.carrySettledAt, back.carrySettledByUserId, Object.keys(back.carrySettlement).sort()], ['APPROVED', null, null, ['approval']]);
  // 확정 때 거둔 보강권은 승인이 거둔 목록에 합친다(승인 취소 때 함께 돌려준다)
  assert.deepEqual(back.carrySettlement.approval.revokedCreditIds, ['s9-old-mc', 's9-mc']);
  assert.deepEqual((await all(`SELECT status FROM "RegularAbsence" WHERE "periodId"='parent-period' ORDER BY id`)).map((r) => r.status), ['REPORTED', 'REPORTED']);
  const copy = (await one(`SELECT "detailsJson" FROM "OperationsAuditLog" WHERE action='ILLNESS_PERIOD_SETTLEMENT_CANCELED'`)).detailsJson;
  assert.deepEqual([copy.periodId, copy.credits.length, copy.resolutions.length, copy.settlement.carryTotal], ['parent-period', 2, 2, 52500]);
  assert.equal((await view('2027-04')).rows.find((r) => r.id === 's9:m7').carryAvailable, 0);
  await assert.rejects(settlement.cancelIllnessPeriodSettlement(database, { periodId: 'parent-period' }, 'admin', true), /이월을 확정한 기간만/);
  // 다시 확정 — 같은 표라 같은 지문
  const again = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'parent-period' }, ctx(TODAY));
  assert.equal(again.fingerprint, parentPreview.fingerprint);
  assert.equal((await settlement.settleIllnessPeriod(database, { periodId: 'parent-period', expectedFingerprint: again.fingerprint }, 'admin', true, ctx(TODAY))).carryTotal, 52500);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s9'`)).count), 2);
  checks.push('확정 취소(미사용): 이월 0·정산 기록 0·상태 APPROVED·결석 «신고»로·감사 사본·승인 기록 병합 유지 → 다시 확정 가능');

  // ── 근거를 정할 수 없는 달: 납부 청구가 2건이면 확정 차단, 학부모에게는 금액 대신 «확인 뒤 안내» ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s10','합성 근거불명 원생','parent10',NULL);INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e10','s10','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s10-a','s10','m7',105000,'PAID','MONTHLY',2027,3,'S10-A',NOW()),('s10-b','s10','m7',105000,'PAID','MONTHLY',2027,3,'S10-B',NOW());
    INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","coveredUntil","createdByUserId") VALUES('blocked-period','s10','ILLNESS_INJURY','2027-03-15','2027-03-22','ENDED',ARRAY[]::text[],'APPROVED','2027-03-21','admin');
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,"periodId") VALUES('s10-0315','s10','m7','2027-03-15','ILLNESS_INJURY','CONFIRMED','blocked-period')`);
  const blocked = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'blocked-period' }, ctx(TODAY));
  assert.equal(blocked.plan.rows[0].evidence, 'BLOCKED'); assert.match(blocked.blockers[0], /^3월 합성 월요반: 같은 반·같은 달에 납부된 수강료 청구가 여러 건입니다/);
  await assert.rejects(settlement.settleIllnessPeriod(database, { periodId: 'blocked-period', expectedFingerprint: blocked.fingerprint }, 'admin', true, ctx(TODAY)), /납부된 수강료 청구가 여러 건/);
  const blockedParent = await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent10', periodId: 'blocked-period' }, ctx(TODAY, 'parent10'), ownChild);
  assert.deepEqual(blockedParent.view, { pendingCheck: true, total: null, months: [], unpaid: [] });
  checks.push('근거를 정할 수 없는 달(납부 청구 2건): 확정 차단 · 학부모에게는 금액 대신 «학원에서 확인한 뒤 알려 드려요»');
  // ── 반이 지정되지 않은 납부 청구가 있는 달: «낸 돈이 없는 달»로 단정하지 않고 확정 차단 ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s11','합성 반없는청구 원생','parent11',NULL),('s12','합성 미납달 원생','parent12',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e11','s11','m7','ACTIVE','2026-01-01','2026-01-01'),('e12','s12','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s11-noclass','s11',NULL,105000,'PAID','MONTHLY',2027,3,'S11-NOCLASS',NOW());
    INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","coveredUntil","createdByUserId") VALUES
      ('classless-period','s11','ILLNESS_INJURY','2027-03-15','2027-03-22','ENDED',ARRAY[]::text[],'APPROVED','2027-03-21','admin'),
      ('guide-period','s12','ILLNESS_INJURY','2027-03-29','2027-04-12','ENDED',ARRAY[]::text[],'APPROVED','2027-04-11','admin');
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,"periodId") VALUES('s11-0315','s11','m7','2027-03-15','ILLNESS_INJURY','CONFIRMED','classless-period'),
      ('s12-0329','s12','m7','2027-03-29','ILLNESS_INJURY','CONFIRMED','guide-period'),('s12-0405','s12','m7','2027-04-05','ILLNESS_INJURY','CONFIRMED','guide-period')`);
  const classless = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'classless-period' }, ctx(TODAY));
  assert.equal(classless.plan.rows[0].evidence, 'BLOCKED');
  assert.match(classless.blockers[0], /^3월 합성 월요반: 반이 지정되지 않은 납부 청구가 있어요\. 어느 반의 수강료인지 직접 확인해 주세요\./);
  assert.deepEqual(classless.plan.unpaidGuides, [], '낸 돈이 없는 달 안내를 만들지 않는다');
  checks.push('반이 지정되지 않은 납부 청구가 있는 달: 낸 돈이 없는 달이 아니라 확정 차단(직접 확인)');

  // ── 낸 돈이 없는 달만 있는 기간: 이월 0원 확정 → 그 달을 다닌 만큼만 발행 → 그 뒤 확정 취소는 거절 ──
  const guideOnly = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'guide-period' }, ctx(TODAY));
  assert.deepEqual([guideOnly.plan.carryTotal, guideOnly.blockers, guideOnly.plan.unpaidGuides.map((g) => [g.month, g.shape, g.attended])], [0, [], [['2027-04', 'PREFIX', 2]]]);
  const guideSettled = await settlement.settleIllnessPeriod(database, { periodId: 'guide-period', expectedFingerprint: guideOnly.fingerprint }, 'admin', true, ctx(TODAY));
  assert.deepEqual([guideSettled.carryTotal, guideSettled.credited, guideSettled.unpaidResolved, guideSettled.unpaidMonths], [0, 0, 2, 1]);
  let guideApril = await view('2027-04');
  const guideRow = guideApril.rows.find((r) => r.id === 's12:m7');
  assert.deepEqual([guideRow.prorationAmount, guideRow.carryAmount, guideRow.totalAmount, guideRow.periodStart], [52500, 0, 52500, '2027-04-12']);
  guideApril = (await mutateWorkbench(database, cmd('SAVE', guideApril, ['s12:m7'], { periodStart: guideRow.periodStart, periodEnd: guideRow.periodEnd }), 'admin', true)).view;
  guideApril = (await mutateWorkbench(database, cmd('CONFIRM', guideApril, ['s12:m7']), 'admin', true)).view;
  const guideIssued = await mutateWorkbench(database, cmd('ISSUE', guideApril, ['s12:m7']), 'admin', true);
  assert.equal((await one(`SELECT amount FROM "Payment" WHERE id=$1`, [guideIssued.operationResult.paymentIds[0]])).amount, 52500, '전액 105,000 이 아니라 다닌 2회분');
  await assert.rejects(settlement.cancelIllnessPeriodSettlement(database, { periodId: 'guide-period' }, 'admin', true), /4월 청구를 이미 발행했어요\. 확정 취소 대신 수납 관리에서 직접 조정해 주세요/);
  assert.equal((await one(`SELECT "carryState" FROM "RegularAbsencePeriod" WHERE id='guide-period'`)).carryState, 'SETTLED');
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingAbsenceResolution" WHERE "studentId"='s12'`)).count), 2);
  checks.push('낸 돈이 없는 달만 있는 기간: 이월 0원 확정 → 그 달 청구가 다닌 만큼(52,500)으로 발행 → 그 뒤 확정 취소는 거절(이미 발행)');
  // 환불된 청구는 «발행됨»이 아니다 — 그 달 청구를 환불한 뒤에는 확정 취소가 된다(이월이 없던 정산이라 정산 기록만 지운다)
  await pool.query(`UPDATE "Payment" SET status='REFUNDED' WHERE id=$1`, [guideIssued.operationResult.paymentIds[0]]);
  assert.deepEqual(await settlement.cancelIllnessPeriodSettlement(database, { periodId: 'guide-period' }, 'admin', true), { periodId: 'guide-period', studentId: 's12', creditsRemoved: 0, resolutionsRemoved: 2, reopened: 0 });
  assert.equal((await one(`SELECT "carryState" FROM "RegularAbsencePeriod" WHERE id='guide-period'`)).carryState, 'APPROVED');
  checks.push('확정 취소: 그 달 청구가 환불됐으면 «발행됨»으로 보지 않아 취소된다');

  // ── 달 가운데만 빠진 달(한 달 안에서 시작하고 끝나는 2주 결석: 4/5·4/12) ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s13','합성 가운데결석 원생','parent13',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e13','s13','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","coveredUntil","createdByUserId") VALUES('middle-period','s13','ILLNESS_INJURY','2027-04-05','2027-04-19','ENDED',ARRAY[]::text[],'APPROVED','2027-04-18','admin');
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,"periodId") VALUES('s13-0405','s13','m7','2027-04-05','ILLNESS_INJURY','CONFIRMED','middle-period'),('s13-0412','s13','m7','2027-04-12','ILLNESS_INJURY','CONFIRMED','middle-period');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s13-open','s13','m7',105000,'PENDING','MONTHLY',2027,4,'S13-OPEN',NOW());
    INSERT INTO "PaymentInvoice"(id,"paymentId","studentId","classId","invoiceNo",status,amount,"createdAt","updatedAt") VALUES('s13-open-inv','s13-open','s13','m7','S13-OPEN','ISSUED',105000,NOW(),NOW());
    INSERT INTO "PaymentTransaction"(id,"paymentId",provider,status,"updatedAt") VALUES('s13-tx','s13-open','TOSS','READY',now())`);
  // 미납 청구가 살아 있고, 학부모가 결제하는 중이라 보류 버튼으로는 못 돌린다 → 문구가 갈 곳을 함께 알려 준다
  const stuck = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'middle-period' }, ctx(TODAY));
  assert.deepEqual(stuck.plan.problems.map((problem) => problem.text), ['4월 합성 월요반 미납 청구가 그대로 있습니다. 먼저 ‹발행 보류로 돌리기›를 해 주세요. 보류로 돌릴 수 없는 청구는 수납 관리에서 취소한 뒤 다시 열어 주세요.']);
  await pool.query(`DELETE FROM "PaymentTransaction" WHERE id='s13-tx'`);
  assert.deepEqual((await settlement.previewIllnessPeriodSettlement(database, { periodId: 'middle-period' }, ctx(TODAY))).plan.problems.map((problem) => problem.text), ['4월 합성 월요반 미납 청구가 그대로 있습니다. 먼저 ‹발행 보류로 돌리기›를 해 주세요.'], '돌릴 수 있는 청구뿐이면 덧붙이지 않는다');
  await pool.query(`DELETE FROM "PaymentInvoice" WHERE id='s13-open-inv';DELETE FROM "Payment" WHERE id='s13-open'`);
  checks.push('미납 청구 차단 문구: 보류로 돌릴 수 없는 청구(결제 진행 중)가 섞이면 «수납 관리에서 취소» 안내를 덧붙인다');
  const middle = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'middle-period' }, ctx(TODAY));
  assert.deepEqual([middle.blockers, middle.plan.unpaidGuides.map((g) => [g.shape, g.attended, g.missedDates])], [[], [['MIDDLE', 2, ['2027-04-05', '2027-04-12']]]]);
  await settlement.settleIllnessPeriod(database, { periodId: 'middle-period', expectedFingerprint: middle.fingerprint }, 'admin', true, ctx(TODAY));
  let middleApril = await view('2027-04');
  const middleRow = middleApril.rows.find((r) => r.id === 's13:m7');
  // 수강 기간은 그대로(3/29~4/19), 기간 조정 = 105,000 × 빠진 2회 ÷ 4회 = 52,500 → 52,500원(전액 105,000 이 아니다)
  // 수업일 목록에는 «다닌 날만» 남는다(4단계 숙제 — 이 달이 나중에 이월 근거가 될 때 한 번 값 = 52,500 ÷ 2회)
  assert.deepEqual([middleRow.periodStart, middleRow.periodEnd, middleRow.scheduledDates, middleRow.prorationAmount, middleRow.totalAmount], ['2027-03-29', '2027-04-19', ['2027-03-29', '2027-04-19'], 52500, 52500]);
  assert.ok(middleRow.basis.includes('부상 결석 2회(2027-04-05, 2027-04-12) 제외 → 기간 조정 52,500원 제안(다닌 2회 · 달 가운데가 빠져 수강 기간은 그대로)'));
  // 화면에 보이는 값 그대로 저장 → 확정 → 발행
  middleApril = (await mutateWorkbench(database, cmd('SAVE', middleApril, ['s13:m7'], { periodStart: middleRow.periodStart, periodEnd: middleRow.periodEnd }), 'admin', true)).view;
  middleApril = (await mutateWorkbench(database, cmd('CONFIRM', middleApril, ['s13:m7']), 'admin', true)).view;
  const middleIssued = await mutateWorkbench(database, cmd('ISSUE', middleApril, ['s13:m7']), 'admin', true);
  assert.equal((await one(`SELECT amount FROM "Payment" WHERE id=$1`, [middleIssued.operationResult.paymentIds[0]])).amount, 52500);
  checks.push('달 가운데만 빠진 달: 기간은 그대로·기간 조정 52,500 자동 제안 → 화면 값 그대로 저장·확정·발행 = 52,500원(전액 아님)');

  // ── 4단계: 퇴원 정산(환불 검토) + 3단계 검수 숙제 — 같은 임시 DB·같은 모듈 조립으로 이어서 돌린다 ──
  const { runIllnessRefundPostgresTests } = await import('./illness-period-refund-postgres.mjs');
  await runIllnessRefundPostgresTests({ pool, database, checks, readWorkbench, mutateWorkbench, cmd, absenceModuleUrl, modelUrl, serviceUrl, periodAdmin, settlement, rules, periodPlan, classDatesForMonth, issue, view });
}
