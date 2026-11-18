// 시트 원장 은퇴(Phase 2-D) 경계값 실행 검증 — tester 작성(2026-10-06).
// 순수 함수를 실제로 불러 실행해, 스위치 해석·칸별 완료 판정·배지·생성 상태가 표대로인지 못박는다.
// 핵심 원칙: 바깥 장부(SHEET·RALLYZ)만 SKIPPED 를 «끝남»으로 인정한다. WEBSITE 는 SUCCEEDED + verifiedAt 이 있어야만 끝.
// (2026-11-14 랠리즈 은퇴: RALLYZ 도 SKIPPED 를 끝으로 본다 — 그전에는 SHEET 만이었다.)
// (2026-11-18 결정표 sheet-switch «완전히 지운다»: 되돌리기 스위치를 지워 스위치 경계 검사는 뺐다. 판정 표는 그대로.)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExternalTargetDone, initialSyncAttempt, SHEET_RETIRED_REFERENCE, RALLYZ_RETIRED_REFERENCE,
} from '../src/lib/operations-sync/externalLedgerRetirement.ts';
import { hasVerifiedSyncTargets } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';

const AT = '2026-10-06T01:00:00Z';
const row = (target, status, verifiedAt = null) => ({ target, status, verifiedAt });

test('isExternalTargetDone: SUCCEEDED·SKIPPED 만 끝남', () => {
  assert.equal(isExternalTargetDone('SKIPPED'), true);
  assert.equal(isExternalTargetDone('SUCCEEDED'), true);
  for (const s of ['FAILED', 'PENDING', 'skipped', null, undefined, '']) assert.equal(isExternalTargetDone(s), false, String(s));
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

// 2026-11-14 랠리즈 은퇴: 옛 단언은 «RALLYZ SKIPPED → 절대 완료 아님»이었다. 원장 결정으로 랠리즈 확인이 없어져 뒤집는다.
test('완료 판정 표: RALLYZ SKIPPED → 끝난 칸(시트가 끝났고 홈페이지가 확인됐으면 완료)', () => {
  for (const sheet of [row('SHEET', 'SKIPPED'), row('SHEET', 'SUCCEEDED', AT)]) {
    assert.equal(hasVerifiedSyncTargets([sheet, row('RALLYZ', 'SKIPPED'), row('WEBSITE', 'SUCCEEDED', AT)]), true);
    assert.equal(hasVerifiedSyncTargets([sheet, row('RALLYZ', 'SKIPPED', AT), row('WEBSITE', 'SUCCEEDED', AT)]), true);
    // 홈페이지가 안 끝났으면 랠리즈를 건너뛰어도 완료가 아니다
    assert.equal(hasVerifiedSyncTargets([sheet, row('RALLYZ', 'SKIPPED'), row('WEBSITE', 'PENDING')]), false);
  }
  // 시트가 안 끝났으면(옛 대기 건) 랠리즈 건너뜀만으로 완료되지 않는다
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'PENDING'), row('RALLYZ', 'SKIPPED'), row('WEBSITE', 'SUCCEEDED', AT)]), false);
  for (const sheet of ['SKIPPED', 'SUCCEEDED']) {
    assert.deepEqual(syncCheckBadge(sheet, 'SKIPPED'), { label: '반영 완료', needsCheck: false }, sheet);
  }
  // 랠리즈 칸이 대기·실패(옛 방식 건)면 여전히 확인 필요
  for (const rallyz of ['PENDING', 'FAILED']) {
    assert.equal(syncCheckBadge('SKIPPED', rallyz)?.label, '사이트 반영됨 · 랠리즈 확인 필요', rallyz);
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

test('생성 상태: SHEET·RALLYZ 는 언제나 SKIPPED+표식, WEBSITE 는 PENDING', () => {
  assert.deepEqual(initialSyncAttempt('SHEET'), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  assert.deepEqual(initialSyncAttempt('RALLYZ'), { status: 'SKIPPED', externalReference: RALLYZ_RETIRED_REFERENCE });
  assert.deepEqual(initialSyncAttempt('WEBSITE'), { status: 'PENDING', externalReference: null });
});
