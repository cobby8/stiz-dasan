// 관리자 신청함(/admin/inbox) 연결 시험 — 2026-11-10 신청함 통합(설계 A, 원장 결정 d1~d4)
// 실제 SQL 실행 확인은 읽기 전용 트랜잭션 스크립트로 별도로 했다(구현 기록 참고). 여기서는 «빠지면 조용히 사라지는» 연결을 못박는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REQUEST_KINDS, BULK_ACTION_KINDS, SEPARATE_LIST_KINDS } from '../src/lib/requests/catalog.ts';

const inbox = fs.readFileSync('src/lib/requests/admin-inbox.ts', 'utf8');
const client = fs.readFileSync('src/app/admin/inbox/InboxClient.tsx', 'utf8');
const page = fs.readFileSync('src/app/admin/inbox/page.tsx', 'utf8');
const layout = fs.readFileSync('src/app/admin/layout.tsx', 'utf8');
const dashboardPage = fs.readFileSync('src/app/admin/page.tsx', 'utf8');
const dashboard = fs.readFileSync('src/app/admin/AdminDashboardClient.tsx', 'utf8');

test('catalog 의 종류마다 어댑터가 정확히 하나 있다(빠지면 그 종류가 신청함에서 조용히 사라진다)', () => {
  const adapterKinds = [...inbox.matchAll(/^\s{4}kind: "([A-Z_]+)",$/gm)].map((m) => m[1]);
  // 상담(CONSULT)만 어댑터 대신 consult-inbox.ts 가 읽는다(SEPARATE_LIST_KINDS)
  assert.deepEqual([...adapterKinds].sort(), REQUEST_KINDS.map((k) => k.kind).filter((k) => !SEPARATE_LIST_KINDS.includes(k)).sort());
  assert.deepEqual([...SEPARATE_LIST_KINDS], ['CONSULT']);
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
  assert.match(page, /isRequestKind\(params\.kind\)/); // 옛 «?kind=» 주소 → 탭
  assert.match(page, /isInboxTab\(params\.tab\)/);
  assert.match(page, /subOf\(tab, /);
  assert.match(page, /isKstYmd\(value\)/);
  assert.match(client, /disabled=\{reversed\}/);
});

test('처리 버튼은 각 화면의 기존 server action 을 그대로 쓴다(d3)', () => {
  for (const [name, from] of [
    ['decideEnrollmentChange', '@/app/actions/enrollment-changes'],
    ['confirmRegularAbsence', '@/app/actions/regular-absence-admin'],
    ['cancelRegularAbsenceByAdmin', '@/app/actions/regular-absence-admin'],
    ['updateRequestStatus', '@/app/actions/admin'],
    ['updateMakeupStatus', '@/app/actions/admin'],
    ['cancelMakeupSession', '@/app/actions/admin'],
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
  // 메뉴 숫자 = 6탭 배지 합(체험 새 문의·수강신청 대기·상담 포함) — 한 곳에서 계산
  assert.match(inbox, /counts\.byTab = tabActionCounts\(counts\.byKind, extra\)/);
  assert.match(inbox, /counts\.action = Object\.values\(counts\.byTab\)/);
  assert.match(inbox, /FROM "TrialLead" WHERE status = 'NEW'/);
  assert.match(inbox, /FROM "EnrollmentApplication" WHERE status = 'PENDING'/);
});

test('컴팩트 UI — 필터는 버튼 하나+모달, 행은 한 줄(min-h-12), 터치 44px, 색은 토큰·statusTones', () => {
  assert.match(client, /onClick=\{\(\) => setFilterOpen\(true\)\}/);
  // 필터 모달은 날짜만 — 종류 체크박스 묶음은 탭이 대신한다(k2)
  const modal = client.slice(client.indexOf('function FilterModal'));
  assert.doesNotMatch(modal, /REQUEST_KINDS|picked/);
  assert.match(modal, /신청일/);
  assert.match(client, /<AdminModal onClose=\{onClose\} titleId="inbox-filter-title"/);
  assert.match(client, /<ListDetailPanel /); // PC 오른쪽 칸 · 휴대폰 하단 시트
  assert.match(client, /flex min-h-12 min-w-0 flex-1 items-center/);
  assert.match(client, /statusBadgeClassFor\(row\.kind, row\.rawStatus\)/);
  // 휴대폰: 탭 6개가 가로 스크롤 한 줄
  assert.match(client, /<nav\b[^>]*\boverflow-x-auto\b[^>]*aria-label="신청 종류">/);
  assert.doesNotMatch(client, /text-\[(9|10|11)px\]/);
});

test('수강 변경 «취소 요청 검토 중»(d8) — 신청함 목록·개수에 처리 필요로 들어오고, 상세 칸은 기존 취소 요청 action 을 쓴다', () => {
  // SQL 파생 식이 catalog 와 같은 조건·같은 이름(상수)을 쓴다
  assert.match(inbox, /x\.status = 'APPROVED' AND x\."cancelRequestStatus" = 'PENDING' THEN '\$\{ENROLLMENT_CANCEL_REQUESTED\}'/);
  // 처리 버튼 = 학부모 수업 탭 작업의 관리자 action 재사용, 적용일 지난 건은 거절만
  assert.match(client, /decideEnrollmentChangeCancelRequest\(\{ requestId: row\.id, approve: true, note \}\)/);
  assert.match(client, /decideEnrollmentChangeCancelRequest\(\{ requestId: row\.id, approve: false, note \}\)/);
  assert.match(client, /if \(row\.ref\?\.tooLate\) return \[reject\]/);
  assert.match(client, /label: "취소 승인"/);
  assert.match(client, /label: "요청 거절"/);
});

test('취소 요청 칸 마이그레이션(20261110130000) 적용 전에도 신청함·메뉴 숫자가 죽지 않는다 — 예전 식으로 다시 읽는다', () => {
  // 수강 변경 어댑터에 예전 식(fallback)이 있고, 목록·개수 둘 다 실패하면 그 식으로 다시 읽는다
  assert.match(inbox, /fallback: \{\s*createdAtExpr: `x\."createdAt"`,\s*rawExpr: `CASE WHEN x\.status = 'APPROVED' AND x\."appliedAt" IS NOT NULL THEN 'APPLIED' ELSE x\.status END`/);
  const start = inbox.indexOf('fallback: {');
  const fallbackBlock = inbox.slice(start, inbox.indexOf('format:', start));
  assert.doesNotMatch(fallbackBlock, /cancelRequest/);
  assert.match(inbox, /await read\(legacyOf\(adapter\)\)/);
  assert.match(inbox, /buildInboxCountsSql\(true\)/);
});

// ── 2026-11-10 원장 결정 k1~k4 재편 ──
const consult = fs.readFileSync('src/lib/requests/consult-inbox.ts', 'utf8');
const shell = fs.readFileSync('src/app/admin/AdminShellClient.tsx', 'utf8');
const settingsPage = fs.readFileSync('src/app/admin/inbox/settings/page.tsx', 'utf8');
const applyClient = fs.readFileSync('src/app/admin/apply/ApplyAdminClient.tsx', 'utf8');
const rentalClient = fs.readFileSync('src/app/admin/rental/RentalAdminClient.tsx', 'utf8');

test('상담 탭 자리 — consult-inbox.ts 두 함수(목록·개수)만 부른다(상담 작업이 그 파일만 채운다)', () => {
  assert.match(consult, /export async function listConsultInboxRows\(/);
  assert.match(consult, /export async function countConsultAction\(/);
  assert.match(page, /import \{ listConsultInboxRows \} from "@\/lib\/requests\/consult-inbox"/);
  // 통합(11-10): 스텁 대신 상담 작업의 실제 구현 — 신청함 InboxQuery 의 같은 칸(bucket·from·to·limitPerKind)을 받는다
  assert.match(consult, /query: Pick<InboxQuery, "bucket" \| "from" \| "to" \| "limitPerKind">,\s*\): Promise<ConsultInboxRow\[\]>/);
  // 조회 오류를 빈 목록으로 바꾸지 않고, 상담 탭이 자체 오류 메시지를 표시한다.
  assert.doesNotMatch(consult.slice(consult.indexOf('export async function listConsultInboxRows'), consult.indexOf('export async function countConsultAction')), /catch/);
  assert.match(page, /listConsultInboxRows\(\{ bucket: "ACTION", from, to \}\)/);
  assert.match(inbox, /import \{ countConsultAction \} from "@\/lib\/requests\/consult-inbox"/);
  // 상담 목록 실패가 다른 탭을 죽이지 않는다
  assert.match(page, /consultFailed: true/);
  assert.match(client, /rowsData.failedKinds.length > 0 \|\| rowsData.consultFailed/);
});

test('체험·수강·대관 탭은 기존 화면 컴포넌트를 그대로 끼운다(처리 로직 두 벌 금지)', () => {
  assert.match(client, /import\("@\/app\/admin\/apply\/ApplyAdminClient"\)/);
  assert.match(client, /import\("@\/app\/admin\/rental\/RentalAdminClient"\)/);
  assert.match(client, /<ApplyAdminClient\s+mode="trial"/);
  assert.match(client, /mode=\{sub === "WAITLIST" \? "waitlist" : "applications"\}/);
  assert.match(client, /<RentalAdminClient embedded /);
  // 끼운 모양은 제목·업무 탭 줄만 숨긴다
  assert.match(applyClient, /const embedded = mode === "trial" \|\| mode === "applications" \|\| mode === "waitlist";/);
  assert.match(applyClient, /\{!embedded && \(/);
  // 대관: 처리할 것 먼저, 완료는 맨 아래 «완료 보기»(catalog 같은 칸 판정)
  assert.match(rentalClient, /bucketFor\("RENTAL", deriveRentalStatus\(row\.status, row\.deposit\)\)/);
  assert.match(rentalClient, /완료 보기 \$\{doneRows\.length\}/);
});

test('탭 안: 처리할 것(처리 필요→진행 중) 먼저, 완료는 «완료 보기»를 눌렀을 때만 읽는다(k2)', () => {
  assert.match(page, /getInboxRows\(\{ bucket: "ACTION", kinds, from, to \}\)/);
  assert.match(page, /getInboxRows\(\{ bucket: "ONGOING", kinds, from, to \}\)/);
  assert.match(page, /showDone \? getInboxRows\(\{ bucket: "DONE"/);
  assert.match(client, /\{showDone \? "완료 접기" : "완료 보기"\}/);
});

test('진행 중 건 상세 칸 처리(k3) — 보강 예약·결석 신고의 ⚡ 버튼과 같은 action, 취소는 확인 한 번', () => {
  assert.match(client, /run: \(\) => cancelMakeupSession\(row\.id\)/);
  assert.match(client, /updateMakeupStatus\(row\.id, "ATTENDED"\)/);
  assert.match(client, /updateMakeupStatus\(row\.id, "NO_SHOW"\)/);
  assert.match(client, /run: \(\) => cancelRegularAbsenceByAdmin\(\{ id: row\.id \}\)/);
  for (const key of ['cancel', 'status-cancelled']) {
    const at = client.indexOf(`key: "${key}", label:`);
    assert.ok(at > 0, key);
    assert.match(client.slice(at, at + 300), /confirm: \{/, key);
  }
});

test('신청 설정(⚙, k4) — 유입 통계·안내 설정·입학 점검, 메뉴의 «신청·상담»은 빠지고 주소는 산다', () => {
  assert.match(client, /href="\/admin\/inbox\/settings"/);
  assert.match(settingsPage, /await requireAdmin\(\);/);
  assert.match(settingsPage, /<ApplyAdminClient mode="settings" \/>/);
  assert.match(settingsPage, /href="\/admin\/registration-readiness"/);
  assert.match(applyClient, /mode !== "settings" \|\| tab\.key === "sources" \|\| tab\.key === "settings"/);
  assert.doesNotMatch(shell, /label="신청·상담"/);
  assert.match(shell, /"\/admin\/apply"\] as const/); // 옛 주소로 들어와도 메뉴 «신청함»이 켜진다
  assert.ok(fs.existsSync('src/app/admin/apply/page.tsx'));
});

test('현장 수납 승인은 신청함 «기타» 탭에 남는다(POS 근거 없는 현금·계좌 수납 — 승인 필요)', () => {
  assert.match(inbox, /kind: "STAFF_PAYMENT",/);
  assert.match(client, /reviewStaffPaymentConfirmation\(\{ requestId: row\.id, decision: "APPROVED", note \}\)/);
});

// ── 2026-11-10 검수 후속(PM) ──
const trialClient = fs.readFileSync('src/app/admin/trial/TrialCrmClient.tsx', 'utf8');

test('오늘 업무 칩 = 신청함 6탭 배지(칩 합 = 처리할 신청 숫자), 누르면 그 탭', () => {
  assert.match(dashboard, /INBOX_TABS\.filter\(\(entry\) => inboxCounts\.byTab\[entry\.tab\] > 0\)/);
  assert.match(dashboard, /href=\{`\/admin\/inbox\?tab=\$\{entry\.tab\}`\}/);
  assert.doesNotMatch(dashboard, /inboxCounts\.byKind/);
});

test('«?kind=» 주소 — 그 종류의 탭을 열고 그 종류만, «…만 보기 ×» 칩으로 탭 전체', () => {
  assert.match(page, /const explicitTab = isInboxTab\(params\.tab\) \? params\.tab : kindParam \? KIND_TAB\[kindParam\] : null;/);
  assert.match(page, /const kinds = kind \? \[kind\] : kindsOfTab\(tab, sub\);/);
  assert.match(client, /if \(k\) params\.set\("kind", k\);/);
  assert.match(client, /\{kindLabel\(kind\)\}만 보기/);
  assert.match(client, /onClick=\{\(\) => go\(\{ kind: null, sub: null \}\)\}/);
});

test('체험·수강 탭 처리 후 배지·메뉴 숫자 갱신 — onChanged(선택 콜백) → router.refresh, 옛 /admin/apply 는 그대로', () => {
  assert.match(client, /const refreshCounts = \(\) => router\.refresh\(\);/);
  assert.equal((client.match(/onChanged=\{refreshCounts\}/g) ?? []).length, 2);
  assert.match(applyClient, /onChanged\?: \(\) => void;/);
  assert.match(applyClient, /if \(type === "success"\) onChangedRef\.current\?\.\(\);/);
  assert.match(applyClient, /onChanged=\{onChanged\}/); // 체험 화면에도 넘긴다
  assert.match(trialClient, /if \(type === "success"\) onChangedRef\.current\?\.\(\);/);
  const applyPage = fs.readFileSync('src/app/admin/apply/page.tsx', 'utf8');
  assert.doesNotMatch(applyPage, /onChanged/);
});

test('개수는 요청당 한 번(react.cache), 탭이 주소에 있으면 개수·탭 데이터 동시 조회', () => {
  assert.match(inbox, /import \{ cache \} from "react";/);
  assert.match(inbox, /export const getInboxCounts = cache\(readInboxCounts\);/);
  assert.match(page, /\[counts, data\] = await Promise\.all\(\[getInboxCounts\(\), loadTabData\(/);
});

test('대관 사용 완료 + 보증금 0원 = 완료 — 신청함 SQL 이 catalog 와 같은 이름(상수)을 쓴다', () => {
  assert.match(inbox, /CASE WHEN x\.status = 'COMPLETED' AND x\.deposit = 0 THEN '\$\{RENTAL_COMPLETED_NO_DEPOSIT\}' ELSE x\.status END/);
});
