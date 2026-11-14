// 신청 종류 목록(src/lib/requests/catalog.ts) 실행 테스트 — 2026-11-10 신청함 통합
// 상태 → 칸·이름·색 뜻이 한 곳에서 일관되게 나오는지, 파생 상태와 SQL 용 상태 목록이 맞는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REQUEST_KINDS, INBOX_BUCKETS, BUCKET_LABEL, PARENT_BUCKET_LABEL, BULK_ACTION_KINDS,
  bucketFor, statusLabel, statusTone, statusBadgeClassFor, statusesOf, kindLabel, isRequestKind,
  deriveEnrollmentChangeStatus, deriveWithdrawalStatus, deriveShuttleDayStatus, statusEntry, ENROLLMENT_CANCEL_REQUESTED,
  deriveRentalStatus, RENTAL_COMPLETED_NO_DEPOSIT,
  INBOX_TABS, KIND_TAB, TAB_SUBS, isInboxTab, kindsOfTab, subOf, tabOfKind, tabLabel, tabActionCounts,
} from '../src/lib/requests/catalog.ts';
import { STATUS_TONES, TONE_BADGE_CLASS } from '../src/lib/ui/statusTones.ts';

// 2026-11-14: 질병·부상 결석 «이월 검토»(ILLNESS_CARRY) 추가로 17종류
test('원장 결정 d1 의 14종류 + k1 학부모 연결·상담 + 질병·부상 이월 검토 = 17종류가 모두 있고 이름이 겹치지 않는다', () => {
  const kinds = REQUEST_KINDS.map((k) => k.kind);
  assert.equal(kinds.length, 17);
  assert.equal(new Set(kinds).size, 17);
  assert.equal(new Set(REQUEST_KINDS.map((k) => k.label)).size, 17);
  assert.ok(isRequestKind('ILLNESS_CARRY'));
  for (const k of ['ENROLLMENT_CHANGE', 'REGULAR_ABSENCE', 'MAKEUP', 'SHUTTLE_DAY', 'SEASONAL_ABSENCE', 'SEASONAL_MAKEUP',
    'PARENT_REQUEST', 'PAYMENT_REQUEST', 'KAKAO', 'RENTAL', 'WITHDRAWAL', 'ROLE_GRANT', 'MEDIA_REVOCATION', 'STAFF_PAYMENT', 'CHILD_LINK', 'CONSULT']) {
    assert.ok(isRequestKind(k), k);
  }
  assert.equal(kindLabel('CONSULT'), '상담');
  // 상담 상태 계약(상담 브랜치와 같은 값)
  assert.equal(bucketFor('CONSULT', 'NEW'), 'ACTION');
  assert.equal(bucketFor('CONSULT', 'CONTACTED'), 'ONGOING');
  assert.equal(bucketFor('CONSULT', 'DONE'), 'DONE');
  assert.equal(bucketFor('CONSULT', 'CANCELED'), 'DONE');
  assert.equal(statusLabel('CONSULT', 'NEW'), '새 상담');
  assert.equal(statusTone('CONSULT', 'CANCELED'), 'neutral');
});

test('모든 상태는 칸 세 개 중 하나·알려진 색 뜻·비지 않은 이름을 가진다', () => {
  for (const k of REQUEST_KINDS) {
    assert.ok(Object.keys(k.statuses).length > 0, k.kind);
    for (const [status, entry] of Object.entries(k.statuses)) {
      assert.ok(INBOX_BUCKETS.includes(entry.bucket), `${k.kind}.${status}`);
      assert.ok(STATUS_TONES.includes(entry.tone), `${k.kind}.${status}`);
      assert.ok(entry.label.trim().length > 0, `${k.kind}.${status}`);
    }
    assert.match(k.adminHref, /^\/admin\/[a-z/-]+(\?kind=[A-Z_]+)?$/); // 상담 = 신청함 상담 탭 주소
  }
  assert.deepEqual(Object.keys(BUCKET_LABEL), ['ACTION', 'ONGOING', 'DONE']);
  assert.equal(PARENT_BUCKET_LABEL.ACTION, '검토 중');
});

test('기존 관리자 화면 주소가 실제 폴더로 있다(d2: 메뉴에서 빠져도 주소는 산다)', () => {
  for (const k of REQUEST_KINDS) {
    assert.ok(fs.existsSync(`src/app${k.adminHref.split('?')[0]}/page.tsx`), k.adminHref);
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
  // 학부모 연결 — 기존 보호자가 승인하므로 원장에겐 «진행 중», 기한 지난 대기는 만료(완료)
  assert.equal(bucketFor('CHILD_LINK', 'PENDING'), 'ONGOING');
  assert.equal(bucketFor('CHILD_LINK', 'EXPIRED'), 'DONE');
  assert.deepEqual(statusesOf('CHILD_LINK', 'ACTION'), []);
});

test('카카오 칸은 기존 접수함의 «처리·후속 필요/종결» 묶음과 같은 집합이다', () => {
  const page = fs.readFileSync('src/app/admin/kakao-requests/kakaoRequestData.ts', 'utf8');
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
  // 파생 상태(사용 완료 + 보증금 0원)는 규칙 모듈에 없는 신청함 전용 이름이라 빼고 비교한다
  assert.deepEqual(statusesOf('RENTAL').filter((s) => s !== RENTAL_COMPLETED_NO_DEPOSIT).sort(), rental);
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

test('수강 변경 «취소 요청 검토 중»(d8) — 승인+취소 요청 대기는 처리 필요, 적용됐어도 먼저 본다', () => {
  assert.equal(ENROLLMENT_CANCEL_REQUESTED, 'CANCEL_REQUESTED');
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', null, 'PENDING'), 'CANCEL_REQUESTED');
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', new Date(), 'PENDING'), 'CANCEL_REQUESTED');
  // 거절·승인된 취소 요청, 승인 아닌 신청은 예전 판정 그대로
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', null, 'REJECTED'), 'APPROVED');
  assert.equal(deriveEnrollmentChangeStatus('APPROVED', new Date(), 'REJECTED'), 'APPLIED');
  assert.equal(deriveEnrollmentChangeStatus('CANCELED', null, 'APPROVED'), 'CANCELED');
  assert.equal(deriveEnrollmentChangeStatus('PENDING', null, 'PENDING'), 'PENDING');
  assert.deepEqual(statusEntry('ENROLLMENT_CHANGE', 'CANCEL_REQUESTED'), { bucket: 'ACTION', label: '취소 요청 검토 중', tone: 'warning' });
  assert.deepEqual(statusesOf('ENROLLMENT_CHANGE', 'ACTION'), ['PENDING', 'CANCEL_REQUESTED', 'APPLY_HELD', 'SYNC_CHECK', 'SETTLEMENT_CHECK']);
});

test('일괄 처리는 결석 확정·문의 확인함 두 종류만(d4)', () => {
  assert.deepEqual([...BULK_ACTION_KINDS], ['REGULAR_ABSENCE', 'PARENT_REQUEST']);
});

// ── 신청함 6탭(2026-11-10 원장 결정 k1·k2) ──

test('탭 6개 순서·이름 — 체험·수강·상담·대관·변경·기타', () => {
  assert.deepEqual(INBOX_TABS.map((t) => t.tab), ['TRIAL', 'ENROLL', 'CONSULT', 'RENTAL', 'CHANGE', 'OTHER']);
  assert.deepEqual(INBOX_TABS.map((t) => t.label), ['체험', '수강', '상담', '대관', '변경', '기타']);
  assert.ok(isInboxTab('CHANGE'));
  assert.equal(isInboxTab('ACTION'), false);
  assert.equal(tabLabel('OTHER'), '기타');
});

test('종류 → 탭 매핑(원장 결정 k1) — 모든 catalog 종류가 정확히 한 탭에 산다', () => {
  assert.deepEqual(Object.keys(KIND_TAB).sort(), REQUEST_KINDS.map((k) => k.kind).sort());
  const expected = {
    ENROLLMENT_CHANGE: 'CHANGE', REGULAR_ABSENCE: 'CHANGE', MAKEUP: 'CHANGE', SHUTTLE_DAY: 'CHANGE',
    SEASONAL_ABSENCE: 'CHANGE', SEASONAL_MAKEUP: 'CHANGE',
    RENTAL: 'RENTAL',
    PARENT_REQUEST: 'OTHER', PAYMENT_REQUEST: 'OTHER', KAKAO: 'OTHER', WITHDRAWAL: 'OTHER', ROLE_GRANT: 'OTHER',
    MEDIA_REVOCATION: 'OTHER', CHILD_LINK: 'OTHER', STAFF_PAYMENT: 'OTHER',
    CONSULT: 'CONSULT',
  };
  for (const [kind, tab] of Object.entries(expected)) assert.equal(tabOfKind(kind), tab, kind);
  // 체험·수강은 catalog 종류가 없다(기존 화면이 맡는다). 상담은 CONSULT 하나(목록은 consult-inbox.ts)
  for (const tab of ['TRIAL', 'ENROLL']) assert.deepEqual(kindsOfTab(tab), [], tab);
  assert.deepEqual(kindsOfTab('CONSULT'), ['CONSULT']);
  assert.deepEqual(kindsOfTab('RENTAL'), ['RENTAL']);
});

test('탭 안 작은 분류 — 변경(결석·보강/셔틀/수강)은 변경 탭 종류를 빠짐없이·겹치지 않게 나눈다', () => {
  const subs = TAB_SUBS.CHANGE;
  assert.deepEqual(subs.map((s) => s.label), ['결석·보강', '셔틀', '수강']);
  const all = subs.flatMap((s) => s.kinds);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...all].sort(), kindsOfTab('CHANGE').sort());
  assert.deepEqual(kindsOfTab('CHANGE', 'SHUTTLE'), ['SHUTTLE_DAY']);
  assert.deepEqual(kindsOfTab('CHANGE', 'ENROLLMENT'), ['ENROLLMENT_CHANGE']);
  // 모르는 분류 값은 무시하고 전체
  assert.equal(subOf('CHANGE', 'NOPE'), null);
  assert.deepEqual(kindsOfTab('CHANGE', 'NOPE').sort(), kindsOfTab('CHANGE').sort());
  // 수강 = 신청/대기, 기타·대관은 분류 없음
  assert.deepEqual(TAB_SUBS.ENROLL.map((s) => s.label), ['신청', '대기']);
  assert.equal(TAB_SUBS.OTHER, undefined);
});

test('탭 배지 = catalog 종류의 처리 필요 합 + 체험·수강·상담 숫자', () => {
  const byTab = tabActionCounts(
    { REGULAR_ABSENCE: { action: 2 }, ENROLLMENT_CHANGE: { action: 1 }, RENTAL: { action: 3 }, STAFF_PAYMENT: { action: 4 }, PARENT_REQUEST: { action: 1 } },
    { TRIAL: 5, ENROLL: 6, CONSULT: 0 },
  );
  assert.deepEqual(byTab, { TRIAL: 5, ENROLL: 6, CONSULT: 0, RENTAL: 3, CHANGE: 3, OTHER: 5 });
  assert.deepEqual(tabActionCounts({}), { TRIAL: 0, ENROLL: 0, CONSULT: 0, RENTAL: 0, CHANGE: 0, OTHER: 0 });
});

test('대관 «사용 완료» — 보증금 0원(재원생 무료)은 완료, 보증금 있으면 «보증금 환불 대기»(진행 중)', () => {
  assert.equal(RENTAL_COMPLETED_NO_DEPOSIT, 'COMPLETED_NO_DEPOSIT');
  assert.equal(deriveRentalStatus('COMPLETED', 0), 'COMPLETED_NO_DEPOSIT');
  assert.equal(deriveRentalStatus('COMPLETED', '0'), 'COMPLETED_NO_DEPOSIT');
  assert.equal(bucketFor('RENTAL', deriveRentalStatus('COMPLETED', 0)), 'DONE');
  assert.equal(statusLabel('RENTAL', deriveRentalStatus('COMPLETED', 0)), '사용 완료');
  assert.equal(deriveRentalStatus('COMPLETED', 20000), 'COMPLETED');
  assert.equal(bucketFor('RENTAL', deriveRentalStatus('COMPLETED', 20000)), 'ONGOING');
  assert.equal(statusLabel('RENTAL', 'COMPLETED'), '보증금 환불 대기');
  // 보증금을 모르면 예전 판정 그대로, 다른 상태는 보증금과 무관
  assert.equal(deriveRentalStatus('COMPLETED', null), 'COMPLETED');
  assert.equal(deriveRentalStatus('PAID', 0), 'PAID');
  assert.equal(deriveRentalStatus('REQUESTED', 0), 'REQUESTED');
});
