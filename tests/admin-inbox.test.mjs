// 관리자 신청함(/admin/inbox) 연결 시험 — 2026-11-10 신청함 통합(설계 A, 원장 결정 d1~d4)
// 실제 SQL 실행 확인은 읽기 전용 트랜잭션 스크립트로 별도로 했다(구현 기록 참고). 여기서는 «빠지면 조용히 사라지는» 연결을 못박는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REQUEST_KINDS, BULK_ACTION_KINDS } from '../src/lib/requests/catalog.ts';

const inbox = fs.readFileSync('src/lib/requests/admin-inbox.ts', 'utf8');
const client = fs.readFileSync('src/app/admin/inbox/InboxClient.tsx', 'utf8');
const page = fs.readFileSync('src/app/admin/inbox/page.tsx', 'utf8');
const layout = fs.readFileSync('src/app/admin/layout.tsx', 'utf8');
const dashboardPage = fs.readFileSync('src/app/admin/page.tsx', 'utf8');
const dashboard = fs.readFileSync('src/app/admin/AdminDashboardClient.tsx', 'utf8');

test('catalog 의 14종류마다 어댑터가 정확히 하나 있다(빠지면 그 종류가 신청함에서 조용히 사라진다)', () => {
  const adapterKinds = [...inbox.matchAll(/^\s{4}kind: "([A-Z_]+)",$/gm)].map((m) => m[1]);
  assert.deepEqual([...adapterKinds].sort(), REQUEST_KINDS.map((k) => k.kind).sort());
  assert.equal(new Set(adapterKinds).size, adapterKinds.length);
});

test('조회는 $queryRawUnsafe 만, 쓰기 SQL·ORM 메서드는 없다(처리는 기존 server action 재사용)', () => {
  assert.match(inbox, /\$queryRawUnsafe/);
  assert.doesNotMatch(inbox, /\b(UPDATE|INSERT INTO|DELETE FROM)\b/);
  assert.doesNotMatch(inbox, /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|upsert|delete|count)\(/);
  assert.doesNotMatch(client, /prisma|\$queryRaw|\$executeRaw/);
});

test('상태 글자는 catalog 에서만 온다 — 목록·개수 SQL 이 statusesOf 로 상태 조건을 만든다', () => {
  assert.match(inbox, /statusesOf\(adapter\.kind, query\.bucket\)/);
  assert.match(inbox, /statusesOf\(adapter\.kind, "ACTION"\), \.\.\.statusesOf\(adapter\.kind, "ONGOING"\)/);
  // 개수는 SQL «한 번»(UNION ALL)
  assert.match(inbox, /pieces\.join\("\\nUNION ALL\\n"\)/);
});

test('학생 조인에는 병합 학생 제외 조건을 ON 절에 건다(신청 행은 살리고 이름만 비운다)', () => {
  assert.match(inbox, /const studentJoin = \(alias: string, onExpr: string\) => `LEFT JOIN "Student" \$\{alias\} ON \$\{alias\}\.id = \$\{onExpr\} AND \$\{notMergedStudent\(alias\)\}`/);
});

test('날짜는 KST — timestamptz 는 AT TIME ZONE 한 번, 서버 시계(getDay·toISOString 날짜 자르기) 금지', () => {
  assert.match(inbox, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.doesNotMatch(inbox + client, /toISOString\(\)\.slice\(0, ?10\)|\.getDay\(\)|\.getHours\(\)/);
});

test('화면은 관리자 권한을 거치고, 주소 값(칸·종류·날짜)을 그대로 믿지 않는다', () => {
  assert.match(page, /await requireAdmin\(\);/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /filter\(isRequestKind\)/);
  assert.match(page, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
});

test('처리 버튼은 각 화면의 기존 server action 을 그대로 쓴다(d3)', () => {
  for (const [name, from] of [
    ['decideEnrollmentChange', '@/app/actions/enrollment-changes'],
    ['confirmRegularAbsence', '@/app/actions/regular-absence-admin'],
    ['updateRequestStatus', '@/app/actions/admin'],
    ['decidePaymentRequest', '@/app/actions/payment-requests'],
    ['rejectWithdrawalRequest', '@/app/actions/account-withdrawal-admin'],
    ['reviewStaffPaymentConfirmation', '@/app/actions/staff-billing'],
  ]) {
    assert.match(client, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "${from.replace(/\//g, '\\/')}"`), name);
  }
  assert.match(client, /import \{ approveRoleRequest, rejectRoleRequest \} from "@\/app\/actions\/role-requests-admin"/);
  // 탈퇴 «처리»(되돌릴 수 없음)는 기존 화면에서만 — 신청함에서 부르지 않는다
  assert.doesNotMatch(client, /approveWithdrawalRequest/);
  // 복잡한 건 기존 화면으로
  assert.match(client, /기존 화면에서 열기/);
});

test('일괄 처리(d4)는 결석 확정·문의 «확인함» 두 가지뿐', () => {
  assert.deepEqual([...BULK_ACTION_KINDS], ['REGULAR_ABSENCE', 'PARENT_REQUEST']);
  const bulk = client.slice(client.indexOf('async function runBulk'), client.indexOf('return (', client.indexOf('async function runBulk')));
  assert.match(bulk, /confirmRegularAbsence\(\{ id: row\.id \}\)/);
  assert.match(bulk, /updateRequestStatus\(row\.id, "CONFIRMED"\)/);
  assert.doesNotMatch(bulk, /decide|approve|reject|review/i);
});

test('메뉴 배지·«오늘 업무» 카드 숫자는 같은 getInboxCounts 에서 온다', () => {
  assert.match(layout, /getInboxCounts\(\)/);
  assert.match(layout, /inboxCount=\{inboxCounts\?\.action \?\? null\}/);
  assert.match(dashboardPage, /getInboxCounts\(\)/);
  assert.match(dashboard, /const pendingCount = inboxCounts \? inboxCounts\.action : data\.pendingCount;/);
  assert.match(dashboard, /href="\/admin\/inbox"/);
});

test('컴팩트 UI — 필터는 버튼 하나+모달, 행은 한 줄(min-h-12), 터치 44px, 색은 토큰·statusTones', () => {
  assert.match(client, /onClick=\{\(\) => setFilterOpen\(true\)\}/);
  assert.match(client, /<AdminModal onClose=\{onClose\} titleId="inbox-filter-title"/);
  assert.match(client, /<ListDetailPanel /); // PC 오른쪽 칸 · 휴대폰 하단 시트
  assert.match(client, /flex min-h-12 min-w-0 flex-1 items-center/);
  assert.match(client, /statusBadgeClassFor\(row\.kind, row\.rawStatus\)/);
  assert.doesNotMatch(client, /text-\[(9|10|11)px\]/);
});
