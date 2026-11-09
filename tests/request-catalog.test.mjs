// 신청 종류 목록(src/lib/requests/catalog.ts) 실행 테스트 — 2026-11-10 신청함 통합
// 상태 → 칸·이름·색 뜻이 한 곳에서 일관되게 나오는지, 파생 상태와 SQL 용 상태 목록이 맞는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REQUEST_KINDS, INBOX_BUCKETS, BUCKET_LABEL, PARENT_BUCKET_LABEL, BULK_ACTION_KINDS,
  bucketFor, statusLabel, statusTone, statusBadgeClassFor, statusesOf, kindLabel, isRequestKind,
  deriveEnrollmentChangeStatus, deriveWithdrawalStatus, deriveShuttleDayStatus,
} from '../src/lib/requests/catalog.ts';
import { STATUS_TONES, TONE_BADGE_CLASS } from '../src/lib/ui/statusTones.ts';

test('원장 결정 d1 의 14종류가 모두 있고 이름이 겹치지 않는다', () => {
  const kinds = REQUEST_KINDS.map((k) => k.kind);
  assert.equal(kinds.length, 14);
  assert.equal(new Set(kinds).size, 14);
  assert.equal(new Set(REQUEST_KINDS.map((k) => k.label)).size, 14);
  for (const k of ['ENROLLMENT_CHANGE', 'REGULAR_ABSENCE', 'MAKEUP', 'SHUTTLE_DAY', 'SEASONAL_ABSENCE', 'SEASONAL_MAKEUP',
    'PARENT_REQUEST', 'PAYMENT_REQUEST', 'KAKAO', 'RENTAL', 'WITHDRAWAL', 'ROLE_GRANT', 'MEDIA_REVOCATION', 'STAFF_PAYMENT']) {
    assert.ok(isRequestKind(k), k);
  }
  assert.equal(isRequestKind('CHILD_LINK'), false); // 보호자끼리 연결 요청은 범위 밖(d1 제외)
});

test('모든 상태는 칸 세 개 중 하나·알려진 색 뜻·비지 않은 이름을 가진다', () => {
  for (const k of REQUEST_KINDS) {
    assert.ok(Object.keys(k.statuses).length > 0, k.kind);
    for (const [status, entry] of Object.entries(k.statuses)) {
      assert.ok(INBOX_BUCKETS.includes(entry.bucket), `${k.kind}.${status}`);
      assert.ok(STATUS_TONES.includes(entry.tone), `${k.kind}.${status}`);
      assert.ok(entry.label.trim().length > 0, `${k.kind}.${status}`);
    }
    assert.match(k.adminHref, /^\/admin\/[a-z/-]+$/);
  }
  assert.deepEqual(Object.keys(BUCKET_LABEL), ['ACTION', 'ONGOING', 'DONE']);
  assert.equal(PARENT_BUCKET_LABEL.ACTION, '검토 중');
});

test('기존 관리자 화면 주소가 실제 폴더로 있다(d2: 메뉴에서 빠져도 주소는 산다)', () => {
  for (const k of REQUEST_KINDS) {
    assert.ok(fs.existsSync(`src/app${k.adminHref}/page.tsx`), k.adminHref);
  }
});

test('대표 상태의 칸 — 처리 필요/진행 중/완료', () => {
  assert.equal(bucketFor('ENROLLMENT_CHANGE', 'PENDING'), 'ACTION');
  assert.equal(bucketFor('ENROLLMENT_CHANGE', 'APPROVED'), 'ONGOING'); // 승인 = 적용일 대기
  assert.equal(bucketFor('ENROLLMENT_CHANGE', 'APPLIED'), 'DONE');
  assert.equal(bucketFor('ENROLLMENT_CHANGE', 'REJECTED'), 'DONE');
  assert.equal(bucketFor('REGULAR_ABSENCE', 'REPORTED'), 'ACTION');
  assert.equal(bucketFor('REGULAR_ABSENCE', 'CONFIRMED'), 'DONE');
  assert.equal(bucketFor('MAKEUP', 'BOOKED'), 'ONGOING');
  assert.equal(bucketFor('SHUTTLE_DAY', 'ACTIVE'), 'DONE'); // 정보용 — 처리 없음 = 완료 칸
  assert.equal(bucketFor('SEASONAL_MAKEUP', 'REQUESTED'), 'ACTION');
  assert.equal(bucketFor('SEASONAL_MAKEUP', 'SCHEDULED'), 'ONGOING');
  assert.equal(bucketFor('PARENT_REQUEST', 'PENDING'), 'ACTION');
  assert.equal(bucketFor('PARENT_REQUEST', 'CONFIRMED'), 'ONGOING');
  assert.equal(bucketFor('PARENT_REQUEST', 'COMPLETED'), 'DONE');
  assert.equal(bucketFor('KAKAO', 'HELD'), 'ACTION');
  assert.equal(bucketFor('KAKAO', 'APPLIED'), 'DONE');
  assert.equal(bucketFor('RENTAL', 'REQUESTED'), 'ACTION');
  assert.equal(bucketFor('RENTAL', 'APPROVED'), 'ONGOING');
  assert.equal(bucketFor('WITHDRAWAL', 'REQUESTED'), 'ACTION');
  assert.equal(bucketFor('ROLE_GRANT', 'PENDING'), 'ACTION');
  assert.equal(bucketFor('MEDIA_REVOCATION', 'MANUAL_REQUIRED'), 'ACTION');
  assert.equal(bucketFor('MEDIA_REVOCATION', 'FAILED'), 'ONGOING');
  assert.equal(bucketFor('STAFF_PAYMENT', 'PENDING'), 'ACTION');
});

test('카카오 칸은 기존 접수함의 «처리·후속 필요/종결» 묶음과 같은 집합이다', () => {
  const page = fs.readFileSync('src/app/admin/kakao-requests/page.tsx', 'utf8');
  const listOf = (key) => {
    const m = page.match(new RegExp(`\\$1='${key}' AND r\\.status IN \\(([^)]*)\\)`));
    return m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  };
  const notDone = [...statusesOf('KAKAO', 'ACTION'), ...statusesOf('KAKAO', 'ONGOING')].sort();
  assert.deepEqual(notDone, listOf('ACTION'));
  assert.deepEqual(statusesOf('KAKAO', 'DONE').sort(), listOf('DONE'));
});

test('대관 상태는 대관 규칙 모듈의 상태 목록과 같은 집합이다', () => {
  // 규칙 모듈은 @/ 별칭을 import 해서 node 로 바로 못 읽는다 → 글자로 RENTAL_STATUSES 배열을 읽는다
  const src = fs.readFileSync('src/lib/rental/gym-rental-rules.ts', 'utf8');
  const block = src.match(/export const RENTAL_STATUSES = \[([\s\S]*?)\] as const/)[1];
  const rental = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(statusesOf('RENTAL').sort(), rental);
});

test('모르는 상태·모르는 종류는 «상태 확인 필요»·중립색으로 진행 중 칸에 둔다(완료로 숨기지 않음)', () => {
  assert.equal(bucketFor('PARENT_REQUEST', 'WEIRD'), 'ONGOING');
  assert.equal(statusLabel('PARENT_REQUEST', null), '상태 확인 필요');
  assert.equal(statusTone('NOPE', 'PENDING'), 'neutral');
  assert.equal(kindLabel('NOPE'), '기타');
});

test('배지 클래스는 statusTones 의 클래스 그대로다(색 직접 지정 없음)', () => {
  assert.equal(statusBadgeClassFor('REGULAR_ABSENCE', 'REPORTED'), TONE_BADGE_CLASS.warning);
  assert.equal(statusBadgeClassFor('ENROLLMENT_CHANGE', 'REJECTED'), TONE_BADGE_CLASS.danger);
  assert.equal(statusBadgeClassFor('ENROLLMENT_CHANGE', 'APPROVED'), TONE_BADGE_CLASS.info);
});

test('statusesOf — SQL status IN 목록', () => {
  assert.deepEqual(statusesOf('REGULAR_ABSENCE', 'ACTION'), ['REPORTED']);
  assert.deepEqual(statusesOf('PARENT_REQUEST'), ['PENDING', 'CONFIRMED', 'COMPLETED', 'REJECTED']);
  assert.deepEqual(statusesOf('STAFF_PAYMENT', 'ONGOING'), []);
  // SQL 에 그대로 들어가므로 영문 대문자·밑줄만 허용(따옴표 주입 차단)
  for (const k of REQUEST_KINDS) for (const s of statusesOf(k.kind)) assert.match(s, /^[A-Z_]+$/);
});

test('파생 상태 — 수강 변경 적용·탈퇴·셔틀 오늘만', () => {
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', new Date()), 'APPLIED');
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', null), 'APPROVED');
  assert.equal(deriveEnrollmentChangeStatus('REJECTED', new Date()), 'REJECTED');
  assert.equal(deriveWithdrawalStatus(null), 'REQUESTED');
  assert.equal(deriveWithdrawalStatus('2026-11-10T00:00:00Z'), 'WITHDRAWN');
  assert.equal(deriveShuttleDayStatus(null), 'ACTIVE');
  assert.equal(deriveShuttleDayStatus(new Date()), 'CANCELED');
});

test('일괄 처리는 결석 확정·문의 확인함 두 종류만(d4)', () => {
  assert.deepEqual([...BULK_ACTION_KINDS], ['REGULAR_ABSENCE', 'PARENT_REQUEST']);
});
