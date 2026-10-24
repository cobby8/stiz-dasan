import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeApprovalClassIds } from '../src/lib/enrollment/approval-classes.ts';

test('반이 없거나 잘못된 입력이면 승인 불가', () => {
  for (const value of [undefined, null, [], 'class-1', [''], ['  '], [1], Array(31).fill('a')]) {
    assert.throws(() => normalizeApprovalClassIds(value));
  }
});
test('반 ID 공백과 중복을 정규화하고 원래 입력을 보존', () => {
  const ids = [' class-1 ', 'class-1', 'class-2'];
  assert.deepEqual(normalizeApprovalClassIds(ids), ['class-1', 'class-2']);
  assert.equal(ids[0], ' class-1 ');
});
test('force와 부작용 전에 정규반 검증을 수행', () => {
  const source = readFileSync('src/app/actions/admin.ts', 'utf8');
  const body = source.slice(source.indexOf('export async function approveEnrollApplication'));
  assert.ok(body.indexOf('normalizeApprovalClassIds') < body.indexOf('data.force !== true'));
  assert.ok(body.indexOf('validClasses.length') < body.indexOf('await prisma.$transaction'));
  assert.match(body, /c\."dayOfWeek" <> 'Seasonal' AND p\."deletedAt" IS NULL/);
  assert.match(body, /FOR SHARE OF c, p/);
  assert.ok(body.indexOf('lockedClasses.length') < body.indexOf('// 1. 신청서 조회'));
});
