import test from 'node:test';
import assert from 'node:assert/strict';
import { getDriverUpcoming } from '../src/lib/shuttle/driverUpcoming.ts';

const rows = [{ key: 'depot', time: '14:34', isTerminal: true }, { key: 'a', time: '14:38' }, { key: 'b', time: '14:45' }, { key: 'c', time: '14:52' }, { key: 'unknown', time: null }];
const at = (time, date = '2026-10-19') => new Date(`${date}T${time}`);
test('분 경계·임박·하루 종료를 기기 현재 시각으로 계산한다', () => {
  for (const [time, key, remaining] of [['14:33:00', 'a', 5], ['14:38:59', 'a', 0], ['14:39:00', 'b', 6], ['14:45:00', 'b', 0], ['14:46:00', 'c', 6], ['14:52:59', 'c', 0], ['14:53:00', null, null], ['23:59:00', null, null]]) {
    const result = getDriverUpcoming(rows, '2026-10-19', at(time));
    assert.equal(result.nextKey, key, time); assert.equal(result.remainingMinutes, remaining, time);
  }
});
test('과거·미래 날짜를 오늘의 시각과 비교하지 않는다', () => {
  for (const date of ['2026-10-18', '2026-10-20']) assert.equal(getDriverUpcoming(rows, date, at('14:35:00')).nextKey, null);
  const midnight = getDriverUpcoming(rows, '2026-10-19', at('00:00:00', '2026-10-20'));
  assert.equal(midnight.isViewingToday, false); assert.equal(midnight.clockLabel, '00:00');
});
test('시각 미정·잘못된 시각·안내 행은 다음 정류장에서 제외한다', () => {
  assert.equal(getDriverUpcoming([{ key: 'bad', time: '24:00' }, { key: 'bad2', time: '09:99' }, ...rows], '2026-10-19', at('14:33:00')).nextKey, 'a');
});
test('순서·시각 편집을 반영하고 동일 시각은 목록 순서를 따른다', () => {
  const edited = [{ key: 'b', time: '14:36' }, { key: 'a', time: '14:36' }];
  assert.equal(getDriverUpcoming(edited, '2026-10-19', at('14:35:00')).nextKey, 'b');
  assert.deepEqual(edited, [{ key: 'b', time: '14:36' }, { key: 'a', time: '14:36' }]);
});
test('빈 일정과 유효하지 않은 시계는 강조하지 않는다', () => {
  assert.equal(getDriverUpcoming([], '2026-10-19', at('14:35:00')).nextKey, null);
  assert.equal(getDriverUpcoming(rows, '2026-10-19', new Date('invalid')).clockLabel, null);
});
