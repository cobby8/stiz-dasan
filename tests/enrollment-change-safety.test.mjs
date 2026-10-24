import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/lib/enrollment/admin-change-request.ts', import.meta.url), 'utf8');

// 원장 결정(2026-10-05, 선택지 A): 적용일이 된 휴원·퇴원은 사이트 수강 상태를 자동으로 바꾸고,
// 시트·랠리즈는 "확인 필요(PENDING)"로 운영 원장에 남긴다. 반 변경은 예전처럼 HELD 로 보류한다.
// 예전 계약("사이트는 절대 바꾸지 않는다")은 이 결정으로 바뀌었고, 대신 아래 안전장치를 못박는다.
test('due PAUSE/WITHDRAW are applied to website with guarded update; others stay HELD', () => {
  const due = source.slice(source.indexOf('export type DueEnrollmentChangeSummary'), source.indexOf('export async function issueProrationInvoice'));
  // 이중 적용 방지: 신청 행 잠금 + 조건 재확인 + 같은 idempotencyKey
  assert.match(due, /AND "appliedAt" IS NULL FOR UPDATE/);
  assert.match(due, /const key = `enrollment-change:\$\{row\.id\}`/);
  assert.match(due, /idempotencyKey: key/);
  assert.match(due, /AND NOT EXISTS \(SELECT 1 FROM "OperationsCommand"/);
  // 수강 행도 잠그고, 기대 상태일 때만 바꾸는 조건부 UPDATE 여야 한다(덮어쓰기 금지)
  assert.match(due, /FOR UPDATE OF e/);
  assert.match(due, /UPDATE "Enrollment" SET status = \$2, "updatedAt" = now\(\) WHERE id = \$1 AND status = \$3/);
  assert.match(due, /if \(changed !== 1\) throw/);
  // 신청은 관리자 즉시 변경과 같은 의미(APPLIED + appliedAt), 역시 조건부
  assert.match(due, /SET status = 'APPLIED', "appliedAt" = now\(\)[\s\S]*WHERE id = \$1 AND status = 'APPROVED' AND "appliedAt" IS NULL/);
  // 운영 원장: 홈페이지만 완료, 랠리즈는 확인 필요. 시트는 은퇴(2026-10-06~) 시 SKIPPED, 스위치 "0" 이면 PENDING.
  assert.match(due, /websiteDone \? "SUCCEEDED" : initial\.status/);
  assert.match(due, /initialSyncAttempt\("SHEET", isSheetSyncRetired\(process\.env\)\)/);
  assert.match(due, /'APPROVED',\$4,\$4,now\(\),now\(\)/);
  // 적용 경로의 새 SQL 은 raw 만 쓴다(PgBouncer)
  const ledger = due.slice(due.indexOf('async function insertAutoAppliedLedger'));
  assert.doesNotMatch(ledger, /tx\.\w+\.(create|update|upsert)\(/);
  // 반 변경·예상 밖 상태는 기존 HELD 원장
  assert.match(due, /status: "HELD"/);
  assert.match(due, /\["SHEET", "RALLYZ", "WEBSITE"\]/);
  assert.match(due, /target\._count\.enrollments >= target\.capacity/);
  assert.match(due, /student\.parentId === row\.requestedByUserId/);
  assert.match(due, /toClassId: row\.toClassId, parentConfirmed,/);
  // 반을 옮기는(classId 변경) 자동 적용은 여전히 없다
  assert.doesNotMatch(due, /SET "classId"|"classId"\s*=\s*\$/);
});

test('decision does not send parent notifications', () => {
  assert.doesNotMatch(source, /notifyParentsOfStudents|notifyParentOfDecision/);
  assert.match(source, /ENROLLMENT_CHANGE_NOTIFICATION_HELD/);
});

test('proration locks request and atomically creates and links payment', () => {
  const invoice = source.slice(source.indexOf('export async function issueProrationInvoice'));
  assert.match(invoice, /return prisma\.\$transaction/);
  assert.match(invoice, /FOR UPDATE OF r/);
  assert.match(invoice, /tx\.\$queryRawUnsafe/);
  assert.match(invoice, /tx\.\$executeRawUnsafe/);
  assert.match(invoice, /if \(row\.invoicedPaymentId\)/);
  assert.match(invoice, /tx\.paymentInvoice\.create/);
  assert.match(invoice, /tx\.paymentAuditLog\.create/);
  assert.match(invoice, /input\.expectedPreviewKey !== invoicePreviewKey/);
  assert.match(invoice, /invoiceNo: `STIZ-CHANGE-/);
});
