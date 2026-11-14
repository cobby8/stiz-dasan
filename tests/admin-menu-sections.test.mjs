// 2026-11-13 관리자 메뉴 정리(원장 점검표 승인) — 메뉴 항목 수·탭 연결을 못박는다.
// 메뉴에서 링크가 빠져도 빌드·tsc 는 통과한다(사고 2회) → 실제 메뉴를 렌더해 도달 가능성을 검사한다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { loadAdminModule, renderAdminNavigation } from './helpers/admin-navigation-render.mjs';

const { ADMIN_SECTIONS, findAdminSection, isInAdminSection } = loadAdminModule('src/lib/admin-sections.ts');
const sidebar = (html) => html.match(/<nav aria-label="관리자 업무 메뉴"[\s\S]*?<\/nav>/)?.[0] ?? '';
const tabBar = (html) => html.match(/<nav aria-label="[^"]* 화면 이동"[\s\S]*?<\/nav>/)?.[0] ?? '';
const hrefs = (html) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);
const activeHrefs = (html) => [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0].match(/href="([^"]+)"/)[1]);

// 2026-11-13 통계 개편(원장 결정표): «통계»를 설정 묶음에서 빼 «대시보드» 바로 아래로 → 맨 위 7 + 설정 4
// 2026-11-14 수업 영상: 설정 묶음에 «유튜브 연결» 추가 → 설정 5
test('사이드바 메뉴 = 맨 위 7 + 수업 2 + 홈페이지 2 + 설정 5 = 16칸(정리 전 33칸 + 홈페이지 보기)', () => {
  const nav = sidebar(renderAdminNavigation('/admin'));
  assert.deepEqual(hrefs(nav), [
    '/admin', '/admin/stats', '/admin/inbox', '/admin/students', '/admin/attendance', '/admin/finance', '/admin/shuttle/regular-dispatch',
    '/admin/schedule', '/admin/seasonal',
    '/admin/notices', '/admin/settings',
    '/admin/staff', '/admin/sms', '/admin/terms', '/admin/pos-plugin', '/admin/youtube',
  ]);
  for (const label of ['대시보드', '홈페이지 관리', '문자·알림', '약관·방침', 'POS 연결', '유튜브 연결', '통계', '시스템 도구']) assert.ok(nav.includes(label), label);
  for (const gone of ['오늘 업무', '돈·수납', '상세 통계', '수강생 이관', '유니폼 주문', '사진 빠른 업로드', '학원 설정']) assert.ok(!nav.includes(gone), gone);
});

test('«홈페이지 보기»는 메뉴 묶음이 아니라 맨 아래(로그아웃 근처) 작은 링크', () => {
  const html = renderAdminNavigation('/admin');
  assert.ok(!sidebar(html).includes('홈페이지 보기'));
  const bottom = html.slice(html.indexOf('aria-label="로그아웃"'));
  assert.match(bottom, /<a [^>]*href="\/"[^>]*>[\s\S]*?홈페이지 보기/);
});

// 탭 연결 표 — 사이드바 메뉴(부모) → 묶인 화면들(탭)
const PARENT = { attendance: '/admin/attendance', finance: '/admin/finance', homepage: '/admin/settings', messaging: '/admin/sms', policy: '/admin/terms' };
const EXPECTED_TABS = {
  attendance: ['/admin/attendance', '/admin/absence', '/admin/makeup', '/admin/attendance/report', '/admin/attendance/feed'],
  finance: ['/admin/finance', '/admin/payment-requests', '/admin/payment-confirmations', '/admin/pos-reconcile'],
  homepage: ['/admin/settings', '/admin/coaches', '/admin/programs', '/admin/gallery', '/admin/media-revocations', '/admin/faq', '/admin/testimonials'],
  messaging: ['/admin/sms', '/admin/notification-deliveries', '/admin/kakao-policy'],
  policy: ['/admin/terms', '/admin/privacy'],
};

test('탭 묶음 정의 = 원장 점검표 그대로, 모든 탭 화면 파일이 있다', () => {
  assert.deepEqual(Object.keys(ADMIN_SECTIONS), Object.keys(EXPECTED_TABS));
  for (const [key, list] of Object.entries(EXPECTED_TABS)) {
    assert.deepEqual(ADMIN_SECTIONS[key].tabs.map((t) => t.href), list, key);
    for (const href of list) assert.ok(existsSync(`src/app${href}/page.tsx`), `${href} 화면 누락`);
  }
});

test('묶인 화면마다: 위에 탭 줄이 뜨고, 그 탭과 부모 메뉴가 켜진다', () => {
  for (const [key, list] of Object.entries(EXPECTED_TABS)) {
    for (const href of list) {
      const html = renderAdminNavigation(href);
      const tabs = tabBar(html);
      assert.deepEqual(hrefs(tabs), list, `${href} 탭 줄`);
      assert.deepEqual(activeHrefs(tabs), [href], `${href} 켜진 탭`);
      assert.deepEqual(activeHrefs(sidebar(html)), [PARENT[key]], `${href} 켜진 메뉴`);
    }
  }
});

test('하위 주소·가장 긴 주소 판정 — 리포트 상세는 «수업 리포트», 청구 하위는 «청구·수납»', () => {
  assert.equal(findAdminSection('/admin/attendance/report/abc')?.activeHref, '/admin/attendance/report');
  assert.equal(findAdminSection('/admin/attendance')?.activeHref, '/admin/attendance');
  assert.equal(findAdminSection('/admin/finance/monthly-ledger')?.activeHref, '/admin/finance');
  assert.equal(findAdminSection('/admin/settings-x'), null, '접두사만 같은 주소는 아니다');
  assert.equal(findAdminSection('/admin/students'), null, '묶음 밖 화면엔 탭 줄이 없다');
  assert.equal(isInAdminSection('/admin/pos-reconcile', 'finance'), true);
  assert.equal(isInAdminSection('/admin/pos-plugin', 'finance'), false, 'POS 연결은 설정 메뉴');
  assert.equal(tabBar(renderAdminNavigation('/admin/students')), '');
});

test('탭 줄 = 가로 스크롤(넘쳐도 한 줄)·누르는 영역 44px·학원 토큰 색', () => {
  const src = readFileSync('src/components/admin/SectionTabs.tsx', 'utf8');
  assert.match(src, /overflow-x-auto/);
  assert.match(src, /min-h-11 shrink-0/);
  assert.match(src, /whitespace-nowrap/);
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,6}\b|bg-white|text-(red|blue|green|gray)-\d/);
});

test('사진 빠른 업로드는 갤러리 화면 위 «빠른 업로드» 버튼으로 들어간다(주소 그대로)', () => {
  const gallery = readFileSync('src/app/admin/gallery/GalleryAdminClient.tsx', 'utf8');
  assert.match(gallery, /href="\/staff\/quick-post"[\s\S]{0,600}빠른 업로드/);
  assert.ok(existsSync('src/app/staff/quick-post/page.tsx'));
  assert.ok(existsSync('src/app/admin/uniform/page.tsx'), '유니폼 주문은 메뉴에서만 뺐다');
});

test('수강생 이관 도구는 화면·API·전용 lib 까지 삭제(원장 지시), 과거 이력 조회는 남는다', () => {
  for (const gone of [
    'src/app/admin/import/page.tsx', 'src/app/admin/import/ImportClient.tsx',
    'src/app/api/admin/import-students/route.ts', 'src/app/api/admin/import-students/history/route.ts',
    'src/app/api/admin/import-students/details/route.ts', 'src/app/api/admin/import-students/reconcile/route.ts',
    'src/app/api/admin/import-students/relink/route.ts', 'src/app/api/admin/import-students/current-roster/route.ts',
    'src/lib/importStudents.ts', 'src/lib/studentSheetMatching.ts', 'src/lib/enrollmentReconcilePolicy.ts', 'src/lib/googleSheetsCsv.ts',
  ]) assert.ok(!existsSync(gone), `${gone} 남아 있음`);
  // 가져온 자료(StudentSheetImportBatch·장부)를 보여 주는 학생 상세 월별 이력은 그대로
  assert.match(readFileSync('src/lib/adminReadPayloads.ts', 'utf8'), /FROM "StudentSheetImportBatch" b/);
});
