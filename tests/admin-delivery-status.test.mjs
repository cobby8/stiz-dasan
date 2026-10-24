import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOperationalDeliveries, operationalDeliveryView } from '../src/lib/admin-delivery-status.ts';

const row = { id: 'fixture-one', eventType: 'SHUTTLE_DAY_EXCEPTION_SUBMITTED', stableEventKey: 'fixture-event', recipientUserId: 'fixture-recipient', channel: 'IN_APP', status: 'SENT' };
test('사이트 알림 SENT는 등록이며 푸시 SENT는 전송 접수다', () => {
  assert.equal(operationalDeliveryView(row).label, '사이트 알림 등록 완료');
  assert.equal(operationalDeliveryView({ ...row, channel: 'PUSH' }).label, '푸시 전송 접수');
});
test('일부 기기 실패 재시도는 일반 처리 대기와 구분한다', () => {
  assert.match(operationalDeliveryView({ ...row, status: 'PENDING', partialRetry: true }).label, /일부 기기 실패/);
  assert.equal(operationalDeliveryView({ ...row, status: 'PENDING' }).label, '자동 재시도 중');
});
test('알 수 없는 장부 상태를 실패나 성공으로 단정하지 않는다', () => {
  assert.equal(operationalDeliveryView({ ...row, status: 'NEW_STATUS' }).label, '결과 확인 필요');
});
test('같은 사건·수신자 채널만 묶고 이름이나 시각으로 연결하지 않는다', () => {
  const groups = groupOperationalDeliveries([row,
    { ...row, id: 'fixture-push', channel: 'PUSH' },
    { ...row, id: 'fixture-other-event', stableEventKey: 'another-event' },
    { ...row, id: 'fixture-other-recipient', recipientUserId: 'another-recipient' },
  ]);
  assert.deepEqual(groups.map(group => group.length), [2, 1, 1]);
});
test('사건·수신자 키가 없는 과거 기록은 서로 합치지 않는다', () => {
  assert.deepEqual(groupOperationalDeliveries([{ ...row, stableEventKey: null }, { ...row, id: 'fixture-two', stableEventKey: null }]).map(group => group.length), [1, 1]);
});
