import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

// 실제 서버 함수를 실행하고 인증·DB·푸시는 명시적으로 대체한다. 네트워크 접근은 없다.
function load(file, modules = {}) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console: { error() {} }, Intl, Date,
    require(name) { if (name === 'node:crypto') return crypto; if (modules[name]) return modules[name]; throw new Error(`Unexpected import: ${name}`); } });
  return module.exports;
}
const summary = load('src/lib/parent-staff-status.ts');
const recipient = { studentId: 'student-test', userId: 'parent-test', studentName: '테스트' };
const input = { classId: 'class-test', title: '테스트 공지', content: '테스트 본문', operationId: 'test-operation-000001' };

function staffFixture(options = {}) {
  const notices = new Map(); const rows = []; let calls = 0; let actor = 'teacher-test';
  const prisma = { async $queryRawUnsafe(sql, ...args) {
    if (sql.includes('INSERT INTO "Notice"')) {
      if (notices.has(args[4])) return [];
      const row = { id: args[4], author: args[0], title: args[1], content: args[2], classes: args[3] }; notices.set(row.id, row); return [row];
    }
    if (sql.includes('FROM "Notice"')) {
      assert.match(sql, /"authorUserId"=\$2/); assert.match(sql, /"targetClassIds"=\$3/);
      const row = notices.get(args[0]); return row?.author === args[1] && row?.classes === args[2] ? [row] : [];
    }
    if (sql.includes('FROM "NotificationDelivery"')) {
      if (options.ledgerFails) throw new Error('synthetic ledger failure');
      return rows.filter(row => row.noticeId === args[0]);
    }
    throw new Error('Unexpected SQL');
  } };
  const actions = load('src/app/actions/staff-notices.ts', {
    '@/lib/prisma': { prisma }, '@/lib/parent-staff-status': summary,
    '@/lib/staff-class-access': { async requireStaffClassAccess(classId) { if (classId !== 'class-test' || options.deny) throw new Error('FORBIDDEN'); return { staff: { appUserId: actor } }; } },
    '@/lib/staff-contacts': { getStaffClassContacts() {} },
    '@/lib/staff-notifications': {
      async getClassParentRecipients() { if (options.recipientFails) throw new Error('synthetic recipients failure'); return options.zero ? [] : [recipient]; },
      async deliverParentNotification(info) {
        calls++; if (options.deliveryFails) throw new Error('synthetic delivery failure');
        if (!rows.some(row => row.noticeId === info.noticeId)) rows.push(
          { noticeId: info.noticeId, studentId: recipient.studentId, recipientUserId: recipient.userId, channel: 'IN_APP', status: 'SENT' },
          { noticeId: info.noticeId, studentId: recipient.studentId, recipientUserId: recipient.userId, channel: 'PUSH', status: options.partial ? 'PARTIAL' : 'SENT' });
        return { sent: true, inAppCreated: true, duplicate: false, push: { status: options.partial ? 'PARTIAL' : 'SENT' } };
      },
    },
  });
  return { ...actions, notices, rows, calls: () => calls, setActor(value) { actor = value; } };
}

test('같은 공지 작업 반복은 저장된 ID를 재사용하고 알림도 다시 만들지 않는다', async () => {
  const fixture = staffFixture();
  const first = await fixture.createStaffClassNotice(input);
  const again = await fixture.createStaffClassNotice(input);
  assert.equal(first.noticeId, again.noticeId); assert.equal(fixture.notices.size, 1); assert.equal(fixture.calls(), 1);
  assert.equal(again.notificationStatus.inAppCount, 1); assert.equal(again.notificationStatus.pushAcceptedCount, 1);
});
test('응답 유실 후 확인 전용 조회는 기존 공지·전달 결과를 찾고 발송하지 않는다', async () => {
  const fixture = staffFixture(); await fixture.createStaffClassNotice(input);
  const result = await fixture.getStaffClassNoticeStatus(input);
  assert.equal(result.ok, true); assert.equal(result.savedTitle, input.title); assert.equal(fixture.calls(), 1);
});

test('공지 기록 없음은 조회 실패와 구분하고 같은 작업 ID 재제출을 허용한다', async () => {
  const fixture = staffFixture();
  const missing = await fixture.getStaffClassNoticeStatus(input);
  assert.equal(missing.ok, false); assert.equal(missing.code, 'NOT_FOUND');
  await fixture.createStaffClassNotice(input);
  await fixture.createStaffClassNotice(input);
  assert.equal(fixture.notices.size, 1); assert.equal(fixture.calls(), 1);
});

test('같은 보호자의 형제 중 한 학생 PUSH 누락도 확인 필요로 남긴다', () => {
  const result = summary.summarizeDeliveryStatus([
    { recipientUserId: 'fixture-parent', studentId: 'fixture-one', channel: 'IN_APP', status: 'SENT' },
    { recipientUserId: 'fixture-parent', studentId: 'fixture-two', channel: 'IN_APP', status: 'SENT' },
    { recipientUserId: 'fixture-parent', studentId: 'fixture-one', channel: 'PUSH', status: 'SENT' },
  ]);
  assert.equal(result.recipientCount, 2); assert.equal(result.unknownCount, 1);
  assert.match(summary.deliveryStatusText(result), /결과 확인 필요 1건/);
});
test('공지 저장 후 수신자 조회 예외도 공지 저장 성공과 ID를 보존한다', async () => {
  const fixture = staffFixture({ recipientFails: true }); const result = await fixture.createStaffClassNotice(input);
  assert.equal(result.ok, true); assert.equal(result.deliveryLookupFailed, true); assert.ok(fixture.notices.has(result.noticeId));
});
test('누락 재처리는 기존 수신자 근거가 없으면 새 대상을 추측하지 않고 보류한다', async () => {
  const fixture = staffFixture({ deliveryFails: true }); await fixture.createStaffClassNotice(input);
  const result = await fixture.createStaffClassNotice({ ...input, resumeDelivery: true });
  assert.equal(result.ok, true); assert.equal(result.deliveryResumeHeld, true); assert.equal(fixture.calls(), 1);
});
test('일부 전달 예외를 저장 실패로 바꾸지 않고 누락된 알림 수로 반환한다', async () => {
  const fixture = staffFixture({ deliveryFails: true }); const result = await fixture.createStaffClassNotice(input);
  assert.equal(result.ok, true); assert.equal(result.deliveryAttemptFailedCount, 1); assert.equal(fixture.notices.size, 1);
});
test('수신자 0명은 공지 저장 성공·대상 0명이며 푸시 호출하지 않는다', async () => {
  const fixture = staffFixture({ zero: true }); const result = await fixture.createStaffClassNotice(input);
  assert.equal(result.ok, true); assert.equal(result.recipientCount, 0); assert.equal(fixture.calls(), 0);
});
test('푸시 PARTIAL을 완전 전송 접수와 분리하고 일부 기기 실패로 표시한다', async () => {
  const result = await staffFixture({ partial: true }).createStaffClassNotice(input);
  assert.equal(result.notificationStatus.pushAcceptedCount, 0); assert.equal(result.notificationStatus.pushPartialCount, 1);
  assert.match(summary.deliveryStatusText(result.notificationStatus), /일부 기기 실패 1건/);
});
test('같은 작업 ID로 다른 내용은 기존 공지를 덮어쓰거나 새로 발송하지 않는다', async () => {
  const fixture = staffFixture(); await fixture.createStaffClassNotice(input);
  const result = await fixture.createStaffClassNotice({ ...input, title: '다른 제목' });
  assert.equal(result.ok, false); assert.equal(fixture.notices.size, 1); assert.equal(fixture.calls(), 1);
});
test('다른 반·다른 작성자의 공지 조회를 차단한다', async () => {
  const fixture = staffFixture(); await fixture.createStaffClassNotice(input);
  await assert.rejects(fixture.getStaffClassNoticeStatus({ ...input, classId: 'other-class' }), /FORBIDDEN/);
  fixture.setActor('other-teacher'); assert.equal((await fixture.getStaffClassNoticeStatus(input)).ok, false);
});
test('장부 조회 실패는 빈 장부가 아닌 null 확인 필요로 반환한다', async () => {
  const fixture = staffFixture({ ledgerFails: true }); const result = await fixture.createStaffClassNotice(input);
  assert.equal(result.notificationStatus, null); assert.match(summary.deliveryStatusText(result.notificationStatus), /확인 필요/);
});

function shuttleFixture(options = {}) {
  const row = { id: 'exception-test', studentId: 'student-test', studentName: '테스트', serviceDate: '2099-10-19', direction: 'PICKUP', kind: 'SKIP', location: null, note: null, canceled: Boolean(options.canceled) };
  const rows = options.rows ?? []; let notified = 0;
  const prisma = { async $queryRawUnsafe(sql, ...args) {
    if (sql.includes('FROM "NotificationDelivery"')) { if (options.ledgerFails) throw new Error('synthetic ledger failure'); return rows; }
    if (sql.includes('SELECT s.id, s.name')) return options.unowned ? [] : [{ id: row.studentId, name: row.studentName }];
    if (sql.includes('WITH guard AS MATERIALIZED')) return [{ id: row.id, changed: !options.noOp }];
    if (sql.includes('UPDATE "ShuttleDayException" x')) {
      assert.match(sql, /s\."parentId" = \$1/); if (row.canceled || options.unowned) return []; row.canceled = true; return [row];
    }
    if (sql.includes('(x."canceledAt" IS NOT NULL)')) {
      assert.match(sql, /s\."parentId"=\$2/); return options.unowned ? [] : [row];
    }
    throw new Error('Unexpected SQL');
  } };
  const actions = load('src/lib/shuttle/parent-shuttle-exception.ts', {
    '@/lib/prisma': { prisma }, '@/lib/studentVisibility': { notMergedStudent: () => 'TRUE' }, '@/lib/parent-staff-status': summary,
    '@/lib/shuttle/dayExceptionRules': { SHUTTLE_EXCEPTION_MESSAGE: {}, validateShuttleException: () => ({ ok: true, direction: 'PICKUP', kind: 'SKIP' }), SHUTTLE_DIRECTION_LABEL: { PICKUP: '등원' }, SHUTTLE_EXCEPTION_KIND_LABEL: { SKIP: '안 타요' } },
    '@/lib/operational-staff-notification': { async notifyOperationalStaff() { notified++; if (options.notifyFails) throw new Error('synthetic notification failure'); return { driver: 'NOTIFIED' }; } },
  });
  return { ...actions, notified: () => notified, row };
}
test('부모 동일 셔틀 요청 noOp는 실패가 아니고 기존 장부를 읽으며 재발송하지 않는다', async () => {
  const fixture = shuttleFixture({ noOp: true }); const result = await fixture.submitShuttleException('parent-test', { studentId: 'student-test', serviceDate: '2099-10-19', direction: 'PICKUP', kind: 'SKIP' });
  assert.equal(result.ok, true); assert.equal(result.noOp, true); assert.equal(result.id, 'exception-test'); assert.equal(fixture.notified(), 0);
});
test('중복 취소는 소유권을 확인하고 성공 noOp로 반환하며 재발송하지 않는다', async () => {
  const fixture = shuttleFixture({ canceled: true }); const result = await fixture.cancelShuttleException('parent-test', 'exception-test');
  assert.equal(result.ok, true); assert.equal(result.noOp, true); assert.equal(fixture.notified(), 0);
});
test('다른 자녀 셔틀 조회·신청·취소는 데이터 또는 성공 상태를 공개하지 않는다', async () => {
  const fixture = shuttleFixture({ unowned: true, canceled: true });
  assert.equal(await fixture.getParentShuttleExceptionStatus('other-parent', 'exception-test'), null);
  assert.equal((await fixture.cancelShuttleException('other-parent', 'exception-test')).ok, false);
  assert.equal((await fixture.submitShuttleException('other-parent', { studentId: 'student-test' })).ok, false);
});
test('셔틀 저장 뒤 알림 예외는 저장 성공을 보존하고 조회 실패는 별도 확인 필요다', async () => {
  const fixture = shuttleFixture({ notifyFails: true, ledgerFails: true });
  const result = await fixture.submitShuttleException('parent-test', { studentId: 'student-test', serviceDate: '2099-10-19', direction: 'PICKUP', kind: 'SKIP' });
  assert.equal(result.ok, true); assert.equal(result.notificationStatus, null);
});
test('푸시 장부 누락은 구독 미등록으로 추측하지 않는다', () => {
  const result = summary.summarizeDeliveryStatus([{ recipientUserId: 'user-test', channel: 'IN_APP', status: 'SENT' }]);
  assert.equal(result.unknownCount, 1); assert.equal(result.skippedCount, 0); assert.match(summary.deliveryStatusText(result), /확인 필요 1건/);
});
test('응답 유실 재확인은 날짜·자녀·방향·종류·장소·메모가 모두 같아야 저장을 인정한다', () => {
  const row = { studentId: 'student-test', serviceDate: '2099-10-19', direction: 'PICKUP', kind: 'SKIP', location: null, note: null };
  assert.equal(summary.matchesShuttleChange(row, row), true);
  assert.equal(summary.matchesShuttleChange(row, { ...row, direction: 'DROPOFF' }), false);
  assert.equal(summary.matchesShuttleChange(row, { ...row, note: 'different' }), false);
});

function routeFixture(options = {}) {
  let reads = 0;
  const routes = load('src/app/api/mypage/shuttle-exception/route.ts', {
    'next/server': { NextResponse: { json(body, settings) { return { body, status: settings?.status ?? 200 }; } } },
    '@/lib/auth-guard': { async requireVerifiedParent() { if (options.unauthorized) throw new Error('UNAUTHORIZED'); return { appUserId: 'parent-test' }; } },
    '@/lib/shuttle/parent-shuttle-exception': {
      async getShuttleExceptionOptions(parentId) { reads++; assert.equal(parentId, 'parent-test'); if (options.lookupFails) throw new Error('LOOKUP_FAILED'); return { upcoming: [] }; },
      async getParentShuttleExceptionStatus(parentId, id) { reads++; assert.equal(parentId, 'parent-test'); return options.missing ? null : { id, canceled: true }; },
      async submitShuttleException() { return { ok: true, id: 'exception-test', notificationStatus: { recipientCount: 1 }, notification: { driver: 'NOTIFIED', admin: 'NOTIFIED', coach: 'NOT_APPLICABLE', recipientCount: 1, deliveredCount: 1, failedCount: 0, deliveries: [{ recipientUserId: 'private-internal-id' }] } }; },
      async cancelShuttleException() { return { ok: true, noOp: true, notification: null }; },
    },
  });
  return { ...routes, reads: () => reads };
}
test('부모 결과 조회 API는 인증 실패에서 DB 조회를 시작하지 않는다', async () => {
  const fixture = routeFixture({ unauthorized: true }); const result = await fixture.GET({ nextUrl: new URL('https://example.test/api') });
  assert.equal(result.status, 401); assert.equal(fixture.reads(), 0);
});
test('부모 조회 API는 접근 불가능한 기록과 장부 조회 실패를 구분한다', async () => {
  const missing = await routeFixture({ missing: true }).GET({ nextUrl: new URL('https://example.test/api?id=private') });
  assert.equal(missing.status, 404);
  const unavailable = await routeFixture({ lookupFails: true }).GET({ nextUrl: new URL('https://example.test/api') });
  assert.equal(unavailable.status, 503);
});
test('부모 POST API는 내부 수신자 ID를 제거한 요약만 반환한다', async () => {
  const result = await routeFixture().POST({ async json() { return {}; } });
  assert.equal(result.status, 200); assert.equal(result.body.ok, true); assert.equal(result.body.notification.driver, 'NOTIFIED');
  assert.equal(JSON.stringify(result.body).includes('private-internal-id'), false);
});
test('부모 반복 취소 API의 null 알림은 오류가 아니다', async () => {
  const result = await routeFixture().POST({ async json() { return { action: 'cancel', id: 'exception-test' }; } });
  assert.equal(result.body.ok, true); assert.equal(result.body.noOp, true); assert.equal(result.body.notification, null);
});
