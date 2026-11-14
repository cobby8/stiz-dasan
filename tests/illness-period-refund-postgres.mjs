import assert from 'node:assert/strict';

// 부상·질병 «기간 결석» 퇴원 정산 = 환불 검토(4단계, 2026-11-15 원장 결정) — 실제 PostgreSQL 로 돌리는 흐름 검증.
// tests/illness-period-settlement-postgres.mjs 가 맨 끝에서 부른다(같은 임시 DB · 같은 청구 준비·정산 모듈).
// 실행: node scripts/test-billing-workbench-postgres.mjs
//
// 흐름(합성 자료 — 월요반 105,000원):
//   3월분 납부 → 4월 청구 발행(미납) → 부상 결석 승인 → 4월 청구 보류로 돌리기 → 퇴원(수강 종료)
//   → 환불 검토 미리보기 → 환불 검토로 넘기기(이월 0건 · 정산 기록만) → 환불 검토 취소 → 다시 넘기기(같은 금액) → 환불 처리함(두 번 → 한 번)
//   + 수강 종료 정리 뒤에도 정산 대상 결석이 남는가 + 하루짜리 이월의 «수강월» 묶기 + 가운데 빠진 달이 이월 근거가 될 때의 한 번 값
export async function runIllnessRefundPostgresTests({ pool, database, checks, readWorkbench, mutateWorkbench, cmd, absenceModuleUrl, modelUrl, serviceUrl, periodAdmin, settlement, rules, periodPlan, classDatesForMonth, issue, view }) {
  const { loadTsModule } = await import('./_ts-module.mjs');
  const overrides = { '@/lib/billing/workbench-absence': absenceModuleUrl, '@/lib/billing/workbench': modelUrl };
  // 퇴원 정산 연결부 — 복귀 정산과 «같은» 읽기·계산 모듈 조립을 쓴다(식이 둘로 갈리지 않는지 실제로 본다)
  const refund = await loadTsModule('src/lib/regular/illness-period-refund.ts', { overrides });
  const guard = await loadTsModule('src/lib/billing/absence-compensation-guard.ts');
  const cleanup = await loadTsModule('src/lib/enrollment/enrollment-end-cleanup.ts');
  const absence = await import(absenceModuleUrl);
  const one = async (sql, values = []) => (await pool.query(sql, values)).rows[0];
  const all = async (sql, values = []) => (await pool.query(sql, values)).rows;
  const ctx = (todayYmd, actorUserId = 'admin') => ({ todayYmd, actorUserId, classDatesForMonth });
  const TODAY = '2027-04-12';
  const ownChild = `s."parentId" = $1`;

  // ── 합성 자료: 3월 납부(초안 없는 납부 청구) · 4월 발행(미납) · 승인된 기간(복귀 미정) ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s14','합성 퇴원 원생','parent14',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e14','s14','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s14-mar','s14','m7',105000,'PAID','MONTHLY',2027,3,'S14-MAR',NOW())`);
  const aprilBill = (await issue('2027-04', ['s14:m7'])).operationResult.paymentIds[0];
  const note = periodPlan.periodAbsenceNote('ILLNESS_INJURY', '2027-03-15');
  await pool.query(`INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","carryApprovedAt","carryApprovedByUserId","carrySettlement","coveredUntil","createdByUserId")
    VALUES('refund-period','s14','ILLNESS_INJURY','2027-03-15',NULL,'ACTIVE',ARRAY[]::text[],'APPROVED',now(),'admin','{"approval":{"revokedCreditIds":["old-mc"],"createdReviewAbsenceIds":[]}}'::jsonb,'2027-05-31','admin')`);
  for (const date of ['2027-03-15', '2027-03-22', '2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19']) {
    await pool.query(`INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,note,"periodId") VALUES($1,'s14','m7',$2::date,'ILLNESS_INJURY','CONFIRMED',$3,'refund-period')`, [`rf-${date.slice(5)}`, date, note]);
  }
  await pool.query(`INSERT INTO "MakeupCredit"(id,"studentId","sourceKey",status,"updatedAt","expiresAt") VALUES('refund-mc','s14','REGULAR:m7:2027-03-22','AVAILABLE',NOW(),NOW()+interval '30 days')`);
  // 승인 → 보류: 4월 미납 청구를 보류로 돌린다(2단계 함수 그대로)
  const held = await periodAdmin.holdIssuedBillsForPeriod(database, { periodId: 'refund-period', expectedPaymentIds: [aprilBill] }, 'admin');
  assert.deepEqual(held.held.map((bill) => [bill.paymentId, bill.amount]), [[aprilBill, 105000]]);

  // ── 퇴원 전: 대상 반을 아직 다니면 환불 검토로 넘길 수 없다 ──
  const flags = async (id) => one(`SELECT ${rules.illnessWithdrawnSql('p')} AS withdrawn, ${rules.illnessHoldPeriodSql('p')} AS hold FROM "RegularAbsencePeriod" p WHERE p.id=$1`, [id]);
  assert.deepEqual(await flags('refund-period'), { withdrawn: false, hold: true });
  const enrolled = await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-period' }, ctx(TODAY));
  assert.deepEqual([enrolled.withdrawn, enrolled.stillEnrolled, enrolled.blockers], [false, true, [refund.REFUND_NOT_WITHDRAWN_MESSAGE]]);
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, { periodId: 'refund-period', expectedFingerprint: enrolled.fingerprint }, 'admin', true, ctx(TODAY)), /수강 중인 대상 반이 있어 환불 검토로 넘길 수 없습니다/);
  assert.deepEqual(await one(`SELECT status,"carryState" FROM "RegularAbsencePeriod" WHERE id='refund-period'`), { status: 'ACTIVE', carryState: 'APPROVED' }, '거절되면 기간을 닫은 것도 되돌아간다');
  checks.push('퇴원 정산 준비: 승인 → 4월 미납 청구 보류 전환 · 대상 반을 아직 다니면 환불 검토로 넘기기 거절(아무것도 바뀌지 않음)');

  // ── 퇴원(수강 종료) → 정산 필요 · 퇴원 ──
  await pool.query(`UPDATE "Enrollment" SET status='WITHDRAWN' WHERE id='e14'`);
  assert.deepEqual(await flags('refund-period'), { withdrawn: true, hold: true }, '승인된 기간의 대상 반이 모두 수강 종료 = 정산 필요 · 퇴원');
  // 대상 반이 정해진 기간: 그 반이 끝났으면 다른 반을 다녀도 퇴원 정산 대상(반 이동) · 대상 반을 다니면 아니다
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY['m7']::text[] WHERE id='refund-period';INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e14f','s14','f7','ACTIVE','2026-01-01','2026-01-01')`);
  assert.equal((await flags('refund-period')).withdrawn, true);
  assert.deepEqual(await database.$transaction((tx) => refund.readIllnessPeriodWithdrawal(tx, 'refund-period'), { isolationLevel: 'RepeatableRead' }), { withdrawn: true, stillEnrolled: true });
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY['f7']::text[] WHERE id='refund-period'`);
  assert.equal((await flags('refund-period')).withdrawn, false, '대상 반(금요반)을 아직 다닌다');
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY[]::text[] WHERE id='refund-period';DELETE FROM "Enrollment" WHERE id='e14f'`);
  assert.deepEqual(await database.$transaction((tx) => refund.readIllnessPeriodWithdrawal(tx, 'refund-period'), { isolationLevel: 'RepeatableRead' }), { withdrawn: true, stillEnrolled: false });

  // ── 환불 검토 미리보기: 복귀 정산과 같은 계산 · 오늘(4/12)까지만 센다 ──
  const preview = await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-period' }, ctx(TODAY));
  assert.deepEqual([preview.returnDate, preview.canSetReturnDate, preview.availableMonth, preview.blockers, preview.withdrawn], ['2027-04-13', false, null, [], true]);
  assert.deepEqual(preview.plan.rows.map((row) => [row.month, row.evidence, row.tuition, row.sessions, row.dates, row.unitDisplay, row.subtotal]), [
    // 3월: 납부 청구 105,000 ÷ 4회 = 26,250 × 2회(3/15·3/22) = 52,500
    ['2027-03', 'PAID_PAYMENT', 105000, 4, ['2027-03-15', '2027-03-22'], 26250, 52500],
    // 4월 수강월(낸 돈 없음 — 보류로 돌린 청구는 취소된 채): 환불 대상이 아니다
    ['2027-04', 'UNPAID', 0, 4, ['2027-03-29', '2027-04-05', '2027-04-12'], 0, 0],
  ]);
  assert.equal(preview.plan.carryTotal, 52500, '환불 검토 금액 = 낸 돈이 있는 달의 빠진 수업 값');
  // 같은 날 기준으로 복귀 정산 미리보기를 돌리면 같은 표·같은 지문이다(식이 하나)
  const carryPreview = await settlement.previewIllnessPeriodSettlement(database, { periodId: 'refund-period', returnDate: '2027-04-13' }, ctx(TODAY));
  assert.deepEqual([carryPreview.plan.carryTotal, carryPreview.fingerprint], [preview.plan.carryTotal, preview.fingerprint]);
  // 날짜 빼기 → 금액·지문이 바뀐다
  const omitted = await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-period', omitAbsenceIds: ['rf-03-22'] }, ctx(TODAY));
  assert.equal(omitted.plan.carryTotal, 26250); assert.notEqual(omitted.fingerprint, preview.fingerprint);
  assert.deepEqual(await one(`SELECT status,"carryState","returnDate" FROM "RegularAbsencePeriod" WHERE id='refund-period'`), { status: 'ACTIVE', carryState: 'APPROVED', returnDate: null }, '미리보기는 아무것도 바꾸지 않는다');
  checks.push('퇴원 판정 조각 실제 실행(반 전부·대상 반 지정·반 이동) · 환불 검토 미리보기: 3월 52,500(납부 청구 근거) · 4월은 청구 없음 · 복귀 정산과 같은 지문 · 읽기만');

  // ── 환불 검토로 넘기기: 거절 사례 → 성공 ──
  const sendInput = { periodId: 'refund-period', expectedFingerprint: preview.fingerprint };
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, sendInput, 'admin', false, ctx(TODAY)), /청구 준비 저장이 켜진 뒤/);
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, sendInput, '', true, ctx(TODAY)), /관리자 확인/);
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, { ...sendInput, expectedFingerprint: omitted.fingerprint }, 'admin', true, ctx(TODAY)), /정산 내용이 바뀌었습니다/);
  assert.deepEqual(await one(`SELECT status,"carryState" FROM "RegularAbsencePeriod" WHERE id='refund-period'`), { status: 'ACTIVE', carryState: 'APPROVED' });
  const sent = await refund.sendIllnessPeriodToRefundReview(database, sendInput, 'admin', true, ctx(TODAY));
  assert.equal(database.lastIsolation, 'read committed', '넘기기는 DB 기본 격리 수준(잠근 뒤 다시 읽는 값이 최신이어야 한다)');
  assert.deepEqual(sent, { periodId: 'refund-period', studentId: 's14', startDate: '2027-03-15', refundTotal: 52500, refundAbsences: 2, unpaidAbsences: 3 });
  // 이월은 0건 — 정산 기록만 남는다
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s14'`)).count), 0, '퇴원 정산은 이월을 만들지 않는다');
  const resolutions = await all(`SELECT r."absenceId",r.resolution,r.reason FROM "BillingAbsenceResolution" r WHERE r."studentId"='s14' ORDER BY r."absenceId"`);
  assert.deepEqual(resolutions.map((r) => [r.absenceId, r.resolution, r.reason]), ['rf-03-15', 'rf-03-22', 'rf-03-29', 'rf-04-05', 'rf-04-12'].map((id) => [id, 'CARRY', '퇴원 정산 — 환불 검토']));
  const period = await one(`SELECT status,"carryState",to_char("returnDate",'YYYY-MM-DD') AS "returnDate","carrySettledByUserId","carrySettlement" FROM "RegularAbsencePeriod" WHERE id='refund-period'`);
  assert.deepEqual([period.status, period.carryState, period.returnDate, period.carrySettledByUserId], ['ENDED', 'REFUND_REVIEW', '2027-04-13', 'admin'], '진행 중이던 기간은 오늘까지로 닫는다');
  // 병합 저장 — 승인 기록·보류로 돌린 청구 사본을 지우지 않는다. 낸 돈이 없는 달 안내는 표 사본 안에만(청구 준비가 읽는 칸에 쓰지 않는다)
  assert.deepEqual(period.carrySettlement.approval, { revokedCreditIds: ['old-mc'], createdReviewAbsenceIds: [] });
  assert.deepEqual(period.carrySettlement.held.map((bill) => bill.paymentId), [aprilBill]);
  assert.deepEqual([period.carrySettlement.settlement.mode, period.carrySettlement.settlement.carryTotal, period.carrySettlement.settlement.fingerprint, period.carrySettlement.settlement.unpaidGuides.length], ['REFUND', 52500, preview.fingerprint, 1]);
  assert.equal('unpaidGuides' in period.carrySettlement, false);
  assert.equal((await one(`SELECT status FROM "RegularAbsence" WHERE id='rf-04-19'`)).status, 'CANCELLED', '오늘 이후 결석은 기간을 닫으며 취소');
  assert.equal((await one(`SELECT status FROM "MakeupCredit" WHERE id='refund-mc'`)).status, 'REVOKED', '미사용 보강권 회수');
  assert.equal(Number((await one(`SELECT count(*) FROM "RegularAbsenceCarryReview" WHERE status='APPROVED' AND "absenceId" LIKE 'rf-%'`)).count), 5);
  assert.equal(Number((await one(`SELECT count(*) FROM "OperationsAuditLog" WHERE action='ILLNESS_PERIOD_REFUND_REVIEW' AND "detailsJson"->>'periodId'='refund-period'`)).count), 1);
  // 보류로 돌린 미납 청구는 취소된 채 · 납부 청구는 그대로(이 기능은 돈을 움직이지 않는다)
  assert.deepEqual((await all(`SELECT id,status,amount FROM "Payment" WHERE "studentId"='s14' ORDER BY year,month`)).map((p) => [p.id, p.status, p.amount]), [['s14-mar', 'PAID', 105000], [aprilBill, 'CANCELED', 105000]]);
  // 두 번 누르면 두 번째는 상태 조건에서 끝난다
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, sendInput, 'admin', true, ctx(TODAY)), /이미 환불 검토로 넘긴 기간/);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingAbsenceResolution" WHERE "studentId"='s14'`)).count), 5);
  // 금액이 정해졌으므로 발행 보류·퇴원 판정이 모두 풀린다. 복귀 정산(이월 확정)·확정 취소로는 건드릴 수 없다
  assert.deepEqual(await flags('refund-period'), { withdrawn: false, hold: false });
  await assert.rejects(settlement.settleIllnessPeriod(database, { periodId: 'refund-period', expectedFingerprint: preview.fingerprint }, 'admin', true, ctx(TODAY)), /부상 결석으로 승인된 기간만 정산/);
  await assert.rejects(settlement.cancelIllnessPeriodSettlement(database, { periodId: 'refund-period' }, 'admin', true), /이월을 확정한 기간만/);
  checks.push('환불 검토로 넘기기: 이월 0건·정산 기록 5건(사유 «퇴원 정산 — 환불 검토»)·기간 닫힘·보강권 회수·carrySettlement 병합·감사 기록·READ COMMITTED · 청구는 그대로 · 두 번 눌러도 한 번');

  // ── 퇴원 뒤 그 결석으로 보강권이 나가지 않는다(기존 보강 가드 실제 실행) ──
  const makeupAllowed = (dateYmd) => database.$transaction((tx) => guard.assertRegularMakeupAllowed(tx, { studentId: 's14', classId: 'm7', dateYmd }), { isolationLevel: 'RepeatableRead' });
  for (const dateYmd of ['2027-03-15', '2027-04-12']) await assert.rejects(makeupAllowed(dateYmd), (error) => error.name === 'CompensationConflict' || error instanceof guard.CompensationConflict, dateYmd);
  assert.equal(Number((await one(`SELECT count(*) FROM "MakeupCredit" WHERE "studentId"='s14' AND status IN ('AVAILABLE','RESERVED')`)).count), 0);
  checks.push('퇴원 뒤 그 결석으로 보강권이 나가지 않음: 정산 기록이 보강 가드를 막고(낸 달·안 낸 달 모두), 쓸 수 있는 보강권 0장');

  // ── 화면용 사본 · 학부모 화면(본인 아이만) ──
  const stored = await database.$transaction((tx) => refund.readRefundIllnessPeriod(tx, 'refund-period'), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual([stored.carryState, stored.refundTotal, stored.rows.length, stored.unpaidGuides.length, stored.memo], ['REFUND_REVIEW', 52500, 2, 1, null]);
  assert.equal(await database.$transaction((tx) => settlement.readSettledIllnessPeriod(tx, 'refund-period'), { isolationLevel: 'RepeatableRead' }), null, '이월 확정 사본으로 읽히지 않는다');
  const parentReview = await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent14', periodId: 'refund-period' }, ctx(TODAY, 'parent14'), ownChild);
  assert.deepEqual([parentReview.state, parentReview.settledTotal, parentReview.view], ['REFUND_REVIEW', 52500, null]);
  assert.equal(rules.periodRefundReviewParentText(parentReview.settledTotal), '부상 결석 기간 수강료 52,500원을 환불 검토 중이에요');
  assert.equal(await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent7', periodId: 'refund-period' }, ctx(TODAY, 'parent7'), ownChild), null, '남의 아이 기간은 보이지 않는다');
  checks.push('환불 검토 사본(화면용) · 학부모는 본인 아이만: 환불 검토 중 52,500원 · 남의 아이는 null');

  // ── 환불 검토 취소 → 다시 넘기기(같은 금액) ──
  await assert.rejects(refund.cancelIllnessPeriodRefundReview(database, { periodId: 'refund-period' }, 'admin', false), /청구 준비 저장이 켜진 뒤/);
  const cancelled = await refund.cancelIllnessPeriodRefundReview(database, { periodId: 'refund-period' }, 'admin', true);
  assert.deepEqual(cancelled, { periodId: 'refund-period', studentId: 's14', resolutionsRemoved: 5, reopened: 0 });
  assert.equal(database.lastIsolation, 'read committed');
  const back = await one(`SELECT status,"carryState","carrySettledAt","carrySettledByUserId","carrySettlement" FROM "RegularAbsencePeriod" WHERE id='refund-period'`);
  assert.deepEqual([back.status, back.carryState, back.carrySettledAt, back.carrySettledByUserId, Object.keys(back.carrySettlement).sort()], ['ENDED', 'APPROVED', null, null, ['approval', 'held']]);
  assert.deepEqual(back.carrySettlement.approval.revokedCreditIds, ['old-mc', 'refund-mc'], '넘길 때 거둔 보강권은 승인이 거둔 목록에 합친다');
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingAbsenceResolution" WHERE "studentId"='s14'`)).count), 0);
  const copy = (await one(`SELECT "detailsJson" FROM "OperationsAuditLog" WHERE action='ILLNESS_PERIOD_REFUND_REVIEW_CANCELED'`)).detailsJson;
  assert.deepEqual([copy.periodId, copy.resolutions.length, copy.settlement.carryTotal], ['refund-period', 5, 52500], '지운 내용의 사본');
  assert.deepEqual(await flags('refund-period'), { withdrawn: true, hold: true }, '다시 «정산 필요 · 퇴원»');
  await makeupAllowed('2027-03-15');
  await assert.rejects(refund.cancelIllnessPeriodRefundReview(database, { periodId: 'refund-period' }, 'admin', true), /환불 검토 중인 기간만 취소/);
  const again = await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-period' }, ctx(TODAY));
  assert.deepEqual([again.plan.carryTotal, again.fingerprint, again.blockers], [52500, preview.fingerprint, []], '취소 뒤 다시 계산해도 같은 표·같은 금액');
  // 날이 지나도 닫힌 기간은 저장된 복귀일까지만 센다(금액이 달라지지 않는다)
  assert.equal((await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-period' }, ctx('2027-05-20'))).fingerprint, preview.fingerprint);
  const resent = await refund.sendIllnessPeriodToRefundReview(database, { periodId: 'refund-period', expectedFingerprint: again.fingerprint }, 'admin', true, ctx(TODAY));
  assert.deepEqual([resent.refundTotal, resent.refundAbsences, resent.unpaidAbsences], [52500, 2, 3]);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s14'`)).count), 0);
  checks.push('환불 검토 취소: 정산 기록 0·상태 APPROVED·감사 사본·승인 기록 병합 유지·다시 «정산 필요 · 퇴원» → 다시 넘기기 같은 금액(52,500) · 날이 지나도 같은 지문');

  // ── 환불 처리함: 메모 필수 · 두 번 → 한 번 · 되돌리지 않는다 ──
  await assert.rejects(refund.markIllnessPeriodRefundDone(database, { periodId: 'refund-period', memo: '   ' }, 'admin'), /환불 처리 메모를 적어 주세요/);
  await assert.rejects(refund.markIllnessPeriodRefundDone(database, { periodId: 'refund-period', memo: 'x'.repeat(501) }, 'admin'), /500자까지/);
  await assert.rejects(refund.markIllnessPeriodRefundDone(database, { periodId: 'refund-period', memo: '메모' }, ''), /관리자 확인/);
  await assert.rejects(refund.markIllnessPeriodRefundDone(database, { periodId: 'settle-period', memo: '메모' }, 'admin'), /환불 검토 중인 기간만 환불 처리/);
  const twice = await Promise.allSettled([1, 2].map(() => refund.markIllnessPeriodRefundDone(database, { periodId: 'refund-period', memo: '4/14 카드 취소 52,500원' }, 'admin')));
  assert.deepEqual(twice.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String(twice.find((r) => r.status === 'rejected').reason?.message), /이미 환불 처리한 기간/);
  assert.deepEqual(twice.find((r) => r.status === 'fulfilled').value, { periodId: 'refund-period', studentId: 's14', startDate: '2027-03-15', refundTotal: 52500 });
  const doneRow = await one(`SELECT "carryState","carrySettlement" FROM "RegularAbsencePeriod" WHERE id='refund-period'`);
  assert.deepEqual([doneRow.carryState, doneRow.carrySettlement.refund.memo, doneRow.carrySettlement.refund.doneByUserId, typeof doneRow.carrySettlement.refund.doneAt], ['REFUND_DONE', '4/14 카드 취소 52,500원', 'admin', 'string']);
  assert.deepEqual([doneRow.carrySettlement.settlement.carryTotal, doneRow.carrySettlement.held.length, doneRow.carrySettlement.approval.revokedCreditIds.length], [52500, 1, 2], '메모도 병합 저장 — 표 사본·보류 기록·승인 기록 그대로');
  assert.equal(Number((await one(`SELECT count(*) FROM "OperationsAuditLog" WHERE action='ILLNESS_PERIOD_REFUND_DONE' AND "detailsJson"->>'periodId'='refund-period'`)).count), 1, '감사 기록도 한 번');
  await assert.rejects(refund.cancelIllnessPeriodRefundReview(database, { periodId: 'refund-period' }, 'admin', true), /이미 환불 처리한 기간은 되돌릴 수 없습니다/);
  await assert.rejects(refund.sendIllnessPeriodToRefundReview(database, { periodId: 'refund-period', expectedFingerprint: preview.fingerprint }, 'admin', true, ctx(TODAY)), /이미 환불 처리한 기간/);
  const doneView = await database.$transaction((tx) => refund.readRefundIllnessPeriod(tx, 'refund-period'), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual([doneView.carryState, doneView.refundTotal, doneView.memo], ['REFUND_DONE', 52500, '4/14 카드 취소 52,500원']);
  const parentDone = await settlement.previewParentIllnessSettlement(database, { parentUserId: 'parent14', periodId: 'refund-period' }, ctx(TODAY, 'parent14'), ownChild);
  assert.deepEqual([parentDone.state, parentDone.settledTotal], ['REFUND_DONE', 52500]);
  assert.equal(Number((await one(`SELECT count(*) FROM "BillingCarryCredit" WHERE "studentId"='s14'`)).count), 0);
  assert.deepEqual((await all(`SELECT status FROM "Payment" WHERE "studentId"='s14' ORDER BY year,month`)).map((p) => p.status), ['PAID', 'CANCELED'], '환불 처리함도 청구를 바꾸지 않는다(환불은 수납 관리에서 원장이 직접)');
  checks.push('환불 처리함: 메모 필수(빈 값·501자 거절) · 동시에 두 번 → 한 번(감사 기록 1건) · REFUND_DONE 은 취소·다시 넘기기 불가 · 학부모 «환불 처리 완료» · 청구 행은 끝까지 그대로');

  // ── 학부모가 알린 기간의 퇴원 정산: 신고 결석은 넘길 때 확정, 취소하면 다시 «신고» ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s15','합성 퇴원 학부모기간 원생','parent15',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e15','s15','m7','WITHDRAWN','2026-01-01','2026-01-01');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s15-mar','s15','m7',105000,'PAID','MONTHLY',2027,3,'S15-MAR',NOW());
    INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","reportedByUserId","carryState","carryApprovedAt","coveredUntil","createdByUserId")
      VALUES('refund-parent','s15','ILLNESS_INJURY','2027-03-15','2027-03-29','ACTIVE',ARRAY[]::text[],'parent15','APPROVED',now(),'2027-03-28','parent15');
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,"periodId","reportedByUserId") VALUES('s15-0315','s15','m7','2027-03-15','ILLNESS_INJURY','REPORTED','refund-parent','parent15'),('s15-0322','s15','m7','2027-03-22','ILLNESS_INJURY','REPORTED','refund-parent','parent15')`);
  const parentPeriod = await refund.previewIllnessPeriodRefund(database, { periodId: 'refund-parent' }, ctx(TODAY));
  assert.deepEqual([parentPeriod.returnDate, parentPeriod.plan.carryTotal, parentPeriod.blockers], ['2027-03-29', 52500, []], '저장된 복귀일(끝일 다음 날)까지만 센다');
  await refund.sendIllnessPeriodToRefundReview(database, { periodId: 'refund-parent', expectedFingerprint: parentPeriod.fingerprint }, 'admin', true, ctx(TODAY));
  assert.deepEqual((await all(`SELECT status FROM "RegularAbsence" WHERE "periodId"='refund-parent' ORDER BY id`)).map((r) => r.status), ['CONFIRMED', 'CONFIRMED']);
  assert.deepEqual(await one(`SELECT status,"carryState" FROM "RegularAbsencePeriod" WHERE id='refund-parent'`), { status: 'ACTIVE', carryState: 'REFUND_REVIEW' }, '학부모가 알린 기간은 기간째로 닫지 않는다');
  assert.deepEqual(await refund.cancelIllnessPeriodRefundReview(database, { periodId: 'refund-parent' }, 'admin', true), { periodId: 'refund-parent', studentId: 's15', resolutionsRemoved: 2, reopened: 2 });
  assert.deepEqual((await all(`SELECT status FROM "RegularAbsence" WHERE "periodId"='refund-parent' ORDER BY id`)).map((r) => r.status), ['REPORTED', 'REPORTED']);
  checks.push('학부모가 알린 기간의 퇴원 정산: 신고 결석은 넘길 때 확정 · 취소하면 다시 «신고» · 기간은 닫지 않는다');

  // ── 수강 종료 정리(실제 실행): 승인된 기간의 «이미 지난 날» 결석은 남는다 — 오늘은 DB 시계라 오늘 기준으로 날짜를 만든다 ──
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s16','합성 종료정리 원생','parent16',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e16','s16','m7','WITHDRAWN','2026-01-01','2026-01-01');
    INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate","returnDate",status,"classIds","carryState","carryApprovedAt","coveredUntil","createdByUserId")
      VALUES('cleanup-period','s16','ILLNESS_INJURY',(now() AT TIME ZONE 'Asia/Seoul')::date - 21,NULL,'ACTIVE',ARRAY[]::text[],'APPROVED',now(),(now() AT TIME ZONE 'Asia/Seoul')::date + 30,'admin')`);
  await pool.query(`INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,note,"periodId")
      SELECT 'cl-' || tag, 's16', 'm7', (now() AT TIME ZONE 'Asia/Seoul')::date + shift, 'ILLNESS_INJURY', 'CONFIRMED', $1, CASE WHEN tag = 'single' THEN NULL ELSE 'cleanup-period' END
        FROM (VALUES ('before', -21), ('past', -7), ('today', 0), ('future', 7), ('single', -3)) AS d(tag, shift)`, [note]);
  const fromYmd = (await one(`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date - 14, 'YYYY-MM-DD') AS d`)).d;
  const cleaned = await database.$transaction((tx) => cleanup.cleanupEndedClassInTx(tx, { studentId: 's16', classId: 'm7', className: '합성 월요반', fromYmd, actorUserId: 'admin' }));
  assert.deepEqual((await all(`SELECT id,status FROM "RegularAbsence" WHERE "studentId"='s16' ORDER BY id`)).map((r) => [r.id, r.status]), [
    ['cl-before', 'CONFIRMED'],   // 효력일 전 — 원래 건드리지 않는다
    ['cl-future', 'CANCELLED'],   // 아직 오지 않은 날 — 취소
    ['cl-past', 'CONFIRMED'],     // 승인된 기간의 지난 날 — 정산 대상이라 남긴다
    ['cl-single', 'CANCELLED'],   // 기간에 묶이지 않은 결석 — 예전처럼 취소
    ['cl-today', 'CONFIRMED'],    // 오늘 — 정산 대상이라 남긴다
  ]);
  assert.deepEqual([cleaned.cancelledAbsences, cleaned.keptAbsences, cleaned.illnessSettle], [2, { billing: 0, makeup: 0, attendance: 0 }, { periods: 1, keptAbsences: 2 }]);
  assert.match(cleanup.cleanupResultMessage({ ...cleanup.emptyCleanupSummary(), ...cleaned }), /^결석 2건 취소 · 부상 결석 정산이 남아 있어요/);
  assert.equal((await flags('cleanup-period')).withdrawn, true);
  // 학생 상세의 기간 목록 조회(실제 실행): «퇴원 · 정산 필요» 표시와 환불 상태가 그대로 내려온다
  await pool.query(`ALTER TABLE "RegularAbsencePeriod" ADD COLUMN IF NOT EXISTS "createdAt" timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS "openEnded" boolean DEFAULT false`);
  const periodService = await loadTsModule('src/lib/regular/absence-period-service.ts');
  const listOf = async (studentId) => (await database.$transaction((tx) => periodService.listAbsencePeriodsInDb(tx, studentId), { isolationLevel: 'RepeatableRead' })).periods.map((p) => [p.id, p.carryState, p.withdrawnSettle, p.settleNeeded, p.billingHold]);
  assert.deepEqual(await listOf('s16'), [['cleanup-period', 'APPROVED', true, false, true]]);
  assert.deepEqual(await listOf('s14'), [['refund-period', 'REFUND_DONE', false, false, false]]);
  // 승인되지 않은 기간이면 예전처럼 지운다(보호는 승인된 기간의 날에만)
  await pool.query(`UPDATE "RegularAbsencePeriod" SET "carryState"='NONE' WHERE id='cleanup-period'`);
  const plain = await database.$transaction((tx) => cleanup.cleanupEndedClassInTx(tx, { studentId: 's16', classId: 'm7', className: '합성 월요반', fromYmd, actorUserId: 'admin' }));
  assert.deepEqual([plain.cancelledAbsences, plain.illnessSettle], [2, undefined]);
  assert.deepEqual((await all(`SELECT status FROM "RegularAbsence" WHERE id IN ('cl-past','cl-today') ORDER BY id`)).map((r) => r.status), ['CANCELLED', 'CANCELLED']);
  checks.push('수강 종료 정리 실제 실행: 승인된 기간의 지난 결석(오늘 포함)은 남고 미래·기간 밖 결석만 취소 · 결과에 «부상 결석 정산이 남아 있어요» · 승인 전 기간은 예전 그대로');

  // ── 숙제: 가운데 빠진 달로 발행한 초안이 이월 근거가 될 때 한 번 값 = 발행 금액 ÷ 다닌 횟수 ──
  // 앞의 «달 가운데만 빠진 달» 사례(s13 · 4월 4/5·4/12 결석 → 52,500원 발행)를 납부 처리한 뒤 근거를 읽는다
  const middleDraft = await one(`SELECT "scheduledDates","calculationBasis","paymentId" FROM "BillingWorkbenchDraft" WHERE id='s13:m7' AND month='2027-04'`);
  assert.deepEqual([middleDraft.scheduledDates, middleDraft.calculationBasis.illnessMissedDates], [['2027-03-29', '2027-04-19'], ['2027-04-05', '2027-04-12']], '수업일 사본에는 다닌 날만, 빠진 날은 근거에');
  await pool.query(`UPDATE "Payment" SET status='PAID' WHERE id=$1`, [middleDraft.paymentId]); await pool.query(`UPDATE "PaymentInvoice" SET status='PAID' WHERE "paymentId"=$1`, [middleDraft.paymentId]);
  const middleEvidence = await database.$transaction((tx) => absence.readClassMonthEvidenceInTx(tx, { studentId: 's13', classId: 'm7', originMonth: '2027-04' }, false), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual([middleEvidence.source, middleEvidence.numerator, middleEvidence.dates], ['WORKBENCH_ISSUED', 52500, ['2027-03-29', '2027-04-19']], '52,500 ÷ 2회 = 26,250 (4회로 나누면 13,125 — 과소 보상)');
  // 그 근거로 적립한 이월을 청구 준비가 유효로 본다(그 학생 발행이 막히지 않는다)
  await pool.query(`INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status) VALUES('s13-0419','s13','m7','2027-04-19','ILLNESS_INJURY','CONFIRMED')`);
  const middleCredit = await database.$transaction((tx) => absence.creditCarryForAbsenceInTx(tx, { absence: { id: 's13-0419', studentId: 's13', classId: 'm7', date: '2027-04-19', reason: 'ILLNESS_INJURY' }, originMonth: '2027-04', eligibility: 'ILLNESS_INJURY', actorId: 'admin' }));
  assert.deepEqual([middleCredit.numerator, middleCredit.denominator, middleCredit.availableMonth], [52500, 2, '2027-05']);
  const middleMay = (await view('2027-05')).rows.find((r) => r.id === 's13:m7');
  assert.deepEqual([middleMay.carryAvailable, middleMay.blockingReasons], [26250, []], '이월 26,250원이 유효 — «원결석 취소·출석 정정된 이월» 차단이 걸리지 않는다');
  checks.push('숙제(가운데 빠진 달): 발행 근거 수업일 사본 = 다닌 날만 → 그 달이 이월 근거가 되면 한 번 값 26,250원(52,500 ÷ 2회) · 청구 준비가 그 이월을 유효로 본다');

  // ── 숙제: 하루짜리 이월의 원기간 = «수업일이 있는 달»(수강월) ──
  // 오늘은 실제 시계라 «지난 날짜»로 만든다(정산 시작일 2026-10-05 이후): 11월 수강월을 10/26 에 시작시키면 10/26(월)은 달력은 10월, 수강월은 11월
  await pool.query(`UPDATE "AnnualEvent" SET date='2026-10-26' WHERE id='nov-open'`);
  const billingMonth = (date) => database.$transaction((tx) => absence.readAbsenceBillingMonthInTx(tx, { classId: 'm7', date }), { isolationLevel: 'RepeatableRead' });
  assert.deepEqual([await billingMonth('2026-10-19'), await billingMonth('2026-10-26'), await billingMonth('2026-11-09')], ['2026-10', '2026-11', '2026-11'], '달력 월에 수업일이 있으면 예전과 같은 달 · 10/26 은 11월 수강월');
  const carryAdmin = await loadTsModule('src/lib/regular/illness-carry-admin.ts', { overrides: { ...overrides, '@/lib/billing/workbench-service': serviceUrl } });
  await pool.query(`INSERT INTO "Student"(id,name,"parentId","mergedIntoStudentId") VALUES('s17','합성 수강월 원생','parent17',NULL);
    INSERT INTO "Enrollment"(id,"studentId","classId",status,"createdAt","updatedAt") VALUES('e17','s17','m7','ACTIVE','2026-01-01','2026-01-01');
    INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('s17-nov','s17','m7',105000,'PAID','MONTHLY',2026,11,'S17-NOV',NOW());
    INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status) VALUES('s17-1026','s17','m7','2026-10-26','ILLNESS_INJURY','CONFIRMED'),('s17-1109','s17','m7','2026-11-09','ILLNESS_INJURY','CONFIRMED')`);
  for (const absenceId of ['s17-1026', 's17-1109']) await carryAdmin.approveIllnessCarry(database, { absenceId, evidenceConfirmed: true }, 'admin', true);
  const novemberDates = ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'];
  const dayCredits = await all(`SELECT "absenceId",numerator::text,denominator::text,"availableMonth",basis FROM "BillingCarryCredit" WHERE "studentId"='s17' ORDER BY "absenceId"`);
  assert.deepEqual(dayCredits.map((c) => [c.absenceId, c.numerator, c.denominator, c.availableMonth, c.basis.originMonth, c.basis.scheduledDates]), [
    // 10/26: 달력 월(10월)로 잡으면 «수업일 아님»으로 거절되던 날 — 11월 수강월 근거(105,000 ÷ 5회)로 적립된다
    ['s17-1026', '105000', '5', '2026-12', '2026-11', novemberDates],
    ['s17-1109', '105000', '5', '2026-12', '2026-11', novemberDates],
  ]);
  // 기존 이월의 유효성 판정이 깨지지 않는다: 두 이월 모두 유효(차단 사유 없음) · 12월에 42,000원(105,000 × 2 ÷ 5) 제안
  const december = (await view('2026-12')).rows.find((r) => r.id === 's17:m7');
  assert.deepEqual([december.carryAvailable, december.blockingReasons], [42000, []]);
  checks.push('숙제(하루짜리 이월의 수강월): 10/26(달력 10월 · 11월 수강월의 첫 수업)이 11월 근거로 적립 · 달력 월에 수업일이 있는 날은 예전과 같은 달 · 청구 준비가 두 이월 모두 유효로 본다');
}
