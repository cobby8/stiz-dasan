import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
let pathname = '/admin';
const Link = ({ children, prefetch, ...props }) => React.createElement('a', props, children);
function compile(file) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', code)((id) => {
    if (id === 'next/link') return { default: Link };
    if (id === 'next/image') return { default: () => null };
    if (id === 'next/navigation') return { usePathname: () => pathname };
    if (id === 'next/dynamic') return { default: () => () => null };
    if (id === '@/app/actions/auth') return { logout: '/logout' };
    if (id === '@/components/academy/AcademyTheme') return { default: ({ children }) => children };
    if (id === '@/components/AccountViewSwitcher') return { default: () => React.createElement('span', null, '화면 전환') };
    if (id.startsWith('@/components/')) return { default: () => null };
    // 대시보드 «처리할 신청» 종류 칩 이름(신청함 catalog) — 이 렌더 시험에선 종류 코드 그대로
    if (id === '@/lib/requests/catalog') return { kindLabel: (kind) => kind };
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports.default;
}
const Shell = compile('src/app/admin/AdminShellClient.tsx');
const Dashboard = compile('src/app/admin/AdminDashboardClient.tsx');
function shell(path = '/admin') {
  pathname = path;
  return renderToStaticMarkup(React.createElement(Shell, { initialUserName: '시험 관리자', initialUserEmail: 'masked@preview.invalid', accountViews: [{}, {}] }, '시험 본문'));
}
const mainLinks = (html) => html.match(/<nav aria-label="관리자 업무 메뉴"[\s\S]*?<details/)?.[0] ?? '';
const fixture = (count = 0) => ({
  stats: { studentCount: 3, programCount: 2, coachCount: 1, classCount: 2 },
  pendingRequests: [], pendingCount: count, enrollStats: { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0, total: 0 },
  extendedStats: { thisMonthRevenue: 0, lastMonthRevenue: 0, attendanceRate: 0, unpaidCount: 0, unpaidAmount: 0, monthlyRevenue: [], monthlyAttendance: [], programStudents: [] },
  todayClasses: [], recentStudents: [], todayLabel: '화요일',
});

test('주요 업무 일곱 개는 탭 전환 없이 렌더링되고 셔틀은 정규 배차로 연결된다', () => {
  const html = shell();
  const primary = mainLinks(html);
  // 2026-11-10 신청함 통합: «오늘 업무» 바로 아래 «신청함»이 최상위 메뉴로 들어왔다
  // 2026-11-10 원장 결정 k4: «신청·상담»은 신청함 체험·수강 탭과 ⚙ 신청 설정으로 옮겨 메뉴에서 빠졌다(주소는 산다)
  assert.equal((primary.match(/<a /g) ?? []).length, 6);
  for (const label of ['오늘 업무', '신청함', '원생', '수업·출결', '청구·수납', '셔틀']) assert.ok(primary.includes(label));
  assert.ok(!primary.includes('신청·상담'));
  assert.ok(primary.includes('href="/admin/inbox"'));
  assert.ok(primary.includes('href="/admin/shuttle/regular-dispatch"'));
  assert.ok(!html.includes('>사이트</button>'));
  assert.ok(!html.includes('href="/staff"'));
  assert.ok(html.includes('화면 전환'));
});

test('이전 보조 기능의 진입이 남고 실제 페이지 파일이 존재한다', () => {
  const html = shell();
  const paths = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  // 옛 «요청·신청함» 화면(학부모 요청·수강 변경·카카오 등)은 신청함 상세 칸에서 연다 — 아래 별도 시험
  for (const route of ['/admin/inbox', '/admin/absence', '/admin/makeup', '/admin/attendance/report', '/staff/quick-post', '/admin/seasonal', '/admin/payment-requests', '/admin/payment-confirmations', '/admin/pos-reconcile', '/admin/pos-plugin', '/admin/uniform', '/admin/settings', '/admin/coaches', '/admin/programs', '/admin/schedule', '/admin/notices', '/admin/gallery', '/admin/faq', '/admin/testimonials', '/admin/terms', '/admin/privacy', '/admin/notification-deliveries', '/admin/kakao-policy', '/admin/stats', '/admin/sms', '/admin/import', '/admin/staff', '/admin/media-revocations']) {
    assert.ok(paths.includes(route), `${route} 진입 누락`);
  }
  for (const route of paths.filter((path) => path.startsWith('/admin') || path.startsWith('/staff'))) {
    assert.ok(existsSync(`src/app${route}/page.tsx`), `${route} 페이지 누락`);
  }
});

test('셔틀 하위 경로는 방학특강 메뉴와 중복 활성화되지 않는다', () => {
  for (const path of ['/admin/shuttle/regular-dispatch', '/admin/seasonal/dispatch', '/admin/seasonal/shuttle-notice']) {
    const html = shell(path);
    const active = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)];
    assert.equal(active.length, 1, path);
    assert.ok(active[0][0].includes('href="/admin/shuttle/regular-dispatch"'));
  }
});

test('보조 업무는 직접 진입해도 그룹이 열리며 원생과 신청 경로가 혼동되지 않는다', () => {
  const html = shell('/admin/absence');
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /href="\/admin\/absence"[^>]*aria-current="page"/);
  assert.doesNotMatch(shell('/admin/students-extra'), /aria-current="page"/);
});

test('옛 신청 화면에 직접 들어와도 메뉴 «신청함»이 켜지고, 그 화면은 신청함 상세 칸에서 열린다(d2)', () => {
  const catalog = readFileSync('src/lib/requests/catalog.ts', 'utf8');
  for (const route of ['/admin/requests', '/admin/enrollment-changes', '/admin/withdrawals', '/admin/role-requests', '/admin/kakao-requests', '/admin/rental']) {
    const active = [...shell(route).matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
    assert.equal(active.length, 1, route);
    assert.ok(active[0].includes('href="/admin/inbox"'), route);
    assert.ok(catalog.includes(`adminHref: "${route}"`), `${route} — 신청함 «기존 화면에서 열기» 주소`);
    assert.ok(existsSync(`src/app${route}/page.tsx`), `${route} 페이지(주소는 살린다)`);
  }
});

test('요청이 없으면 수업 영역이 두 열의 반쪽 공간에 갇히지 않는다', () => {
  const empty = renderToStaticMarkup(React.createElement(Dashboard, { initialData: fixture() }));
  const pending = renderToStaticMarkup(React.createElement(Dashboard, { initialData: fixture(2) }));
  assert.ok(!empty.includes('xl:grid-cols-2'));
  assert.ok(pending.includes('xl:grid-cols-2'));
  assert.ok(empty.includes('>수업 진행</a>'));
  assert.ok(!empty.includes('현재 처리할 학부모 요청이 없습니다.'));
});
