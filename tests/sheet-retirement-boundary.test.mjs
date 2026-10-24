// 시트 원장 은퇴(Phase 2-D) 경계값 실행 검증 — tester 작성(2026-10-06).
// 순수 함수를 실제로 불러 실행해, 스위치 해석·칸별 완료 판정·배지·생성 상태가 표대로인지 못박는다.
// 핵심 원칙: SHEET 만 SKIPPED 를 «끝남»으로 인정한다. RALLYZ·WEBSITE 는 SUCCEEDED + verifiedAt 이 있어야만 끝.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSheetSyncRetired, isSheetTargetDone, initialSyncAttempt, SHEET_RETIRED_REFERENCE,
} from '../src/lib/operations-sync/sheetRetirement.ts';
import { hasVerifiedSyncTargets } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';

const AT = '2026-10-06T01:00:00Z';
const row = (target, status, verifiedAt = null) => ({ target, status, verifiedAt });

test('스위치 경계: undefined·"" ·"1"·"false" = 은퇴, "0"·" 0\\n" = 옛 방식', () => {
  const cases = [
    [undefined, true], ['', true], ['1', true], ['false', true],
    ['0', false], [' 0\n', false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(isSheetSyncRetired({ STIZ_SHEET_SYNC_RETIRED: value }), expected, JSON.stringify(value));
  }
  // 키 자체가 없는 환경(대시보드에 아예 안 넣음)도 은퇴
  assert.equal(isSheetSyncRetired({}), true);
});

test('isSheetTargetDone: SUCCEEDED·SKIPPED 만 끝남', () => {
  assert.equal(isSheetTargetDone('SKIPPED'), true);
  assert.equal(isSheetTargetDone('SUCCEEDED'), true);
  for (const s of ['FAILED', 'PENDING', 'skipped', null, undefined, '']) assert.equal(isSheetTargetDone(s), false, String(s));
});

test('완료 판정 표: SHEET SKIPPED + RALLYZ PENDING → 미완료 / 배지 "랠리즈 확인 필요"', () => {
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED'), row('RALLYZ', 'PENDING'), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  const badge = syncCheckBadge('SKIPPED', 'PENDING');
  assert.deepEqual(badge, { label: '사이트 반영됨 · 랠리즈 확인 필요', needsCheck: true });
});

test('완료 판정 표: SHEET SKIPPED + RALLYZ·WEBSITE SUCCEEDED(verifiedAt) → 완료 / 배지 "반영 완료"', () => {
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED'), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), true);
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SUCCEEDED'), { label: '반영 완료', needsCheck: false });
});

test('완료 판정 표: RALLYZ SKIPPED → 절대 완료 아님(시트가 무엇이든)', () => {
  for (const sheet of [row('SHEET', 'SKIPPED'), row('SHEET', 'SUCCEEDED', AT)]) {
    assert.equal(hasVerifiedSyncTargets([sheet, row('RALLYZ', 'SKIPPED'), row('WEBSITE', 'SUCCEEDED', AT)]), false);
    // verifiedAt 이 붙어 있어도 RALLYZ SKIPPED 는 완료가 아니다
    assert.equal(hasVerifiedSyncTargets([sheet, row('RALLYZ', 'SKIPPED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  }
  for (const sheet of ['SKIPPED', 'SUCCEEDED']) {
    const badge = syncCheckBadge(sheet, 'SKIPPED');
    assert.equal(badge?.needsCheck, true, sheet);
    assert.equal(badge?.label, '사이트 반영됨 · 랠리즈 확인 필요', sheet);
  }
});

test('완료 판정 표: WEBSITE SKIPPED → 미완료(verifiedAt 유무 무관)', () => {
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED'), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SKIPPED')]), false);
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED'), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SKIPPED', AT)]), false);
});

test('완료 판정 표: SHEET FAILED → 미완료 / 배지 "시트 확인 필요"', () => {
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'FAILED', AT), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  assert.deepEqual(syncCheckBadge('FAILED', 'SUCCEEDED'), { label: '사이트 반영됨 · 시트 확인 필요', needsCheck: true });
  assert.deepEqual(syncCheckBadge('FAILED', 'PENDING'), { label: '사이트 반영됨 · 시트·랠리즈 확인 필요', needsCheck: true });
});

test('완료 판정 표: SHEET SUCCEEDED 인데 verifiedAt 없음 → 미완료', () => {
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SUCCEEDED'), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  // 깨진 날짜 문자열도 확인 안 된 것으로 본다
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SUCCEEDED', 'not-a-date'), row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), false);
});

test('완료 판정: 칸 개수·중복이 어긋나면 미완료(SHEET SKIPPED 가 두 줄이어도 통과 못 함)', () => {
  assert.equal(hasVerifiedSyncTargets([row('RALLYZ', 'SUCCEEDED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED'), row('SHEET', 'SKIPPED'), row('WEBSITE', 'SUCCEEDED', AT)]), false);
});

test('생성 상태: 스위치 "0" 이면 SHEET 도 PENDING, 은퇴면 SHEET 만 SKIPPED+표식', () => {
  const legacy = isSheetSyncRetired({ STIZ_SHEET_SYNC_RETIRED: '0' });
  assert.equal(legacy, false);
  for (const target of ['SHEET', 'RALLYZ', 'WEBSITE']) {
    assert.deepEqual(initialSyncAttempt(target, legacy), { status: 'PENDING', externalReference: null }, target);
  }
  const retired = isSheetSyncRetired({});
  assert.deepEqual(initialSyncAttempt('SHEET', retired), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  for (const target of ['RALLYZ', 'WEBSITE']) {
    assert.deepEqual(initialSyncAttempt(target, retired), { status: 'PENDING', externalReference: null }, target);
  }
});
