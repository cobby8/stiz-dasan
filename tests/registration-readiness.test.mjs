import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationReadiness } from '../src/lib/enrollment/registration-readiness.ts';

const base = { applicationId: 'app-1', studentId: 'student-1', assignedClassIds: ['class-1'], activeClassIds: ['class-1'], shuttleNeeded: false, commands: [], invoiceCandidates: 0, now: Date.parse('2026-09-09T12:00:00Z') };
test('사이트 승인만으로 입학 완료로 표시하지 않는다', () => {
  const result = registrationReadiness(base);
  assert.equal(result.complete, false);
  assert.equal(result.checks[0].status, 'VERIFIED');
  assert.ok(!result.checks.some((row) => row.key === 'shuttle'));
});
test('반 미배정·일부 반 누락·학생 미연결을 차단한다', () => {
  for (const patch of [{ assignedClassIds: [] }, { activeClassIds: [] }, { studentId: null }, { assignedClassIds: ['class-1', 'class-2'] }]) {
    assert.equal(registrationReadiness({ ...base, ...patch }).checks[0].status, 'CHECK_REQUIRED');
  }
});
test('셔틀 요청자에게만 기사 안내 체크가 생긴다', () => {
  assert.ok(registrationReadiness({ ...base, shuttleNeeded: true }).checks.some((row) => row.key === 'shuttle'));
});
test('다른 등록일 수 있는 동기화·청구 후보는 완료 증거가 아니다', () => {
  const result = registrationReadiness({ ...base, invoiceCandidates: 1, commands: [{ status: 'SYNCED', syncAttempts: [{ target: 'RALLYZ', status: 'SUCCEEDED', verifiedAt: new Date() }] }] });
  assert.equal(result.complete, false);
  assert.ok(result.checks.slice(1).every((row) => row.status === 'CHECK_REQUIRED'));
});

const command = { id: 'command-1', studentId: 'student-1', kind: 'CLASS_ADD', status: 'SYNCED',
  effectiveMonth: '2026-09', createdAt: new Date('2026-09-09T01:00:00Z'),
  afterJson: { enrollmentApplicationId: 'app-1', classId: 'class-1', enrollmentId: 'enroll-1', effectiveDate: '2026-09-09', operationsEvent: { source: 'WEBSITE' } },
  syncAttempts: [{ target: 'SHEET', status: 'SUCCEEDED', verifiedAt: new Date('2026-09-09T02:00:00Z') },
    { target: 'RALLYZ', status: 'FAILED', verifiedAt: null }] };

test('신청 반 원장 출처가 모두 연결돼도 시작일 미확정이면 외부 등록 확인필요', () => {
  const result = registrationReadiness({ ...base, commands: [command] });
  assert.equal(result.complete, false);
  assert.ok(result.checks.slice(1).every(row => row.status === 'CHECK_REQUIRED'));
  const evidence = result.evidence[0];
  assert.equal(evidence.commandId, 'command-1');
  assert.equal(evidence.applicationId, 'app-1');
  assert.equal(evidence.classId, 'class-1');
  assert.equal(evidence.enrollmentId, 'enroll-1');
  assert.deepEqual(evidence.reasons, ['확정 수강 시작일 근거 없음']);
  // 2026-11-18: 시트·랠리즈는 은퇴해 «등록·재조회»·«보호자 초대» 확인 항목을 만들지 않는다
  assert.ok(!result.checks.some(row => ['SHEET', 'RALLYZ', 'rallyz-invite'].includes(row.key)));
});

test('과거 시트 재조회 기록만 남기고 랠리즈 칸은 보여 주지 않는다(2026-11-18)', () => {
  const targets = registrationReadiness({ ...base, commands: [command] }).evidence[0].targets;
  assert.deepEqual(targets.map(row => row.target), ['SHEET']);
  assert.equal(targets[0].attempts[0].status, 'SUCCEEDED');
  assert.equal(targets[0].attempts[0].issue, null);
  // 은퇴로 건너뛴 시트 칸은 실패가 아니라 «확인 대상 아님»
  const skipped = registrationReadiness({ ...base, commands: [{ ...command, syncAttempts: [{ target: 'SHEET', status: 'SKIPPED', verifiedAt: null }] }] });
  assert.equal(skipped.evidence[0].targets[0].attempts[0].issue, '시트 운영 종료로 건너뜀');
});

test('신청 학생 반 출처의 불일치를 숨기지 않는다', () => {
  for (const [patch, reason] of [
    [{ afterJson: { ...command.afterJson, enrollmentApplicationId: 'other-app' } }, /신청 ID/],
    [{ studentId: 'other-student' }, /학생 ID/],
    [{ afterJson: { ...command.afterJson, classId: 'other-class' } }, /배정 반/],
    [{ afterJson: { ...command.afterJson, enrollmentId: null } }, /수강 ID 누락/],
    [{ kind: 'RESUME' }, /신규 등록 증거가 아님/],
    [{ afterJson: { ...command.afterJson, operationsEvent: { source: 'SHEET' } } }, /신규 등록 증거가 아님/],
  ]) {
    const result = registrationReadiness({ ...base, commands: [{ ...command, ...patch }] });
    assert.match(result.evidence[0].reasons.join(' '), reason);
    assert.equal(result.checks[1].status, 'CHECK_REQUIRED');
  }
});

test('재조회 시각 누락·무효·생성전·미래를 경고한다', () => {
  for (const [verifiedAt, reason] of [[null, /유효한/], [new Date('invalid'), /유효한/],
    [new Date('2026-09-08T00:00:00Z'), /생성 전/], [new Date('2026-09-10T00:00:00Z'), /미래/]]) {
    const result = registrationReadiness({ ...base, commands: [{ ...command,
      syncAttempts: [{ target: 'SHEET', status: 'SUCCEEDED', verifiedAt }] }] });
    assert.match(result.evidence[0].targets[0].attempts[0].issue, reason);
  }
});

test('중복 타깃 기록은 모두 표시하고 최신 성공 하나로 덮지 않는다', () => {
  const result = registrationReadiness({ ...base, commands: [{ ...command,
    syncAttempts: [command.syncAttempts[0], { target: 'SHEET', status: 'FAILED', verifiedAt: null }] }] });
  assert.equal(result.evidence[0].targets[0].duplicate, true);
  assert.equal(result.evidence[0].targets[0].attempts.length, 2);
  assert.equal(result.evidence[0].targets.length, 1);
});

test('원장 없는 기존수강이나 출처 없는 옛 원장은 완료로 만들지 않는다', () => {
  const empty = registrationReadiness(base);
  assert.deepEqual(empty.evidence, []);
  assert.equal(empty.complete, false);
  for (const afterJson of [null, [], 'invalid', {}]) {
    const result = registrationReadiness({ ...base, commands: [{ ...command, afterJson }] });
    assert.equal(result.evidence[0].applicationId, null);
    assert.ok(result.evidence[0].reasons.length > 1);
  }
});

const dated = { ...base, requestedStartOn: '2026-09-09', enrollmentStarts: [{ classId: 'class-1', startsOn: '2026-09-09' }] };
// 2026-11-18: 바깥 장부 확인 항목이 없어져 «외부 재조회 성공»으로 완료를 승격하는 판정도 없다. 근거(이유) 대조만 남는다.
test('신청·현재 수강·연결 원장의 개시일이 일치하면 근거 이유가 비고, 그래도 완료는 아니다', () => {
  const result = registrationReadiness({ ...dated, commands: [command] });
  assert.deepEqual(result.evidence[0].reasons, []);
  assert.ok(!result.checks.some(row => row.key === 'SHEET' || row.key === 'RALLYZ'));
  assert.equal(result.complete, false);
});
test('신청일만 존재하거나 세 개시일 중 하나가 없거나 다르면 완료 증거가 아니다', () => {
  for (const patch of [{ requestedStartOn: null }, { enrollmentStarts: [] }, { enrollmentStarts: [{ classId: 'class-1', startsOn: null }] }, { enrollmentStarts: [{ classId: 'class-1', startsOn: '2026-09-10' }] }, { requestedStartOn: '2026-02-31' }]) {
    const result = registrationReadiness({ ...dated, ...patch, commands: [command] });
    assert.ok(result.evidence[0].reasons.includes('확정 수강 시작일 근거 없음'));
    assert.equal(result.complete, false);
  }
  assert.ok(registrationReadiness({ ...dated, commands: [{ ...command, afterJson: { ...command.afterJson, effectiveDate: '2026-09-10' } }] }).evidence[0].reasons.length > 0);
});
test('개시일이 일치해도 재조회 시각 오류·중복·취소 원장은 그대로 경고한다', () => {
  const cancelled = registrationReadiness({ ...dated, commands: [{ ...command, status: 'CANCELLED' }] });
  assert.ok(cancelled.evidence[0].reasons.includes('유효한 등록 처리 상태 확인 필요'));
  const future = registrationReadiness({ ...dated, commands: [{ ...command, syncAttempts: [{ target: 'SHEET', status: 'SUCCEEDED', verifiedAt: new Date('2026-09-10T00:00:00Z') }] }] });
  assert.match(future.evidence[0].targets[0].attempts[0].issue, /미래/);
  const duplicate = registrationReadiness({ ...dated, commands: [{ ...command, syncAttempts: [command.syncAttempts[0], command.syncAttempts[0]] }] });
  assert.equal(duplicate.evidence[0].targets[0].duplicate, true);
  for (const result of [cancelled, future, duplicate]) assert.equal(result.complete, false);
});
