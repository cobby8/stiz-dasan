import { loadChildAccess } from "./_child-access-fixture.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function load(source, dependencies) {
  const exports = {};
  const compiled = ts.transpileModule(source, { fileName: 'fixture.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require', 'exports', compiled)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const publicErrors = load(await readFile('src/lib/user-facing-error.ts', 'utf8'), {});
const routes = load(await readFile('src/lib/auth-routes.ts', 'utf8'), {});
const roles = load(await readFile('src/lib/account/roles.ts', 'utf8'), {});
const views = load(await readFile('src/lib/account-views.ts', 'utf8'), { '@/lib/account/roles': roles });
const accessSource = await readFile('src/lib/account-view-access.ts', 'utf8');
function fixture({ role = 'ADMIN', account = null, signedOut = false, dbFailure = false } = {}) {
  const queries = [];
  const access = load(accessSource, {
    '@/lib/account/child-access': loadChildAccess(),
    '@/lib/auth-guard': { requireAuth: async () => { if (signedOut) throw new Error('Signed out'); return { id: 'auth-owner' }; } },
    '@/lib/account-views': views,
    // 로그인 직후 목적지용 열린 화면 묶음을 계산한다(다중 역할, 2026-10-25). DB 없는 순수 모듈이라 원본 그대로.
    '@/lib/account/roles': roles,
    '@/lib/public-account': { getPublicAccountRole: async () => role },
    '@/lib/prisma': { prisma: { $queryRawUnsafe: async (query, ...args) => {
      queries.push({ query, args }); if (dbFailure) throw new Error('Offline'); return account ? [account] : [];
    } } },
  });
  return { access, queries };
}

for (const role of ['ADMIN', 'VICE_ADMIN', 'INSTRUCTOR']) {
  test(`${role}: 자녀 보기는 별도 자격이며 대표 권한은 유지`, async () => {
    const { access, queries } = fixture({ role, account: { role, hasOwnChildren: true, username: null, phoneVerifiedAt: null } });
    const result = await access.getAccountViewAccess();
    assert.equal(result.role, role);
    assert.deepEqual(result.views.map(x => x.key), role === 'INSTRUCTOR' ? ['teacher', 'parent'] : ['admin', 'teacher', 'parent']);
    assert.deepEqual(queries[0].args, ['auth-owner']);
    assert.match(queries[0].query, /"authUserId" = \$1 OR \(u\."authUserId" IS NULL AND u\.id = \$1\)/);
    assert.doesNotMatch(queries[0].query, /email|UPDATE|INSERT|DELETE/i);
    assert.equal(JSON.stringify(result).includes('auth-owner'), false);
  });
  test(`${role}: 본인 자녀가 없으면 학부모 보기 숨김`, async () => {
    const { access } = fixture({ role, account: { role, hasOwnChildren: false, username: null, phoneVerifiedAt: null } });
    assert.equal((await access.getAccountViewAccess()).views.some(x => x.key === 'parent'), false);
  });
}
test('이메일로 직원 계정만 찾았어도 직접 Auth 연결이 없으면 자녀 보기는 안 열림', async () => {
  const { access } = fixture({ role: 'ADMIN', account: null });
  assert.deepEqual((await access.getAccountViewAccess()).views.map(x => x.key), ['admin', 'teacher']);
});
for (const [description, username, phoneVerifiedAt, allowed] of [
  ['휴대폰 확인', 'parent-user', new Date(), true],
  ['직접 연결된 기존 학부모', null, null, true],
  ['미인증 학부모', 'parent-user', null, false],
]) {
  test(`${description}: 관리자·선생님 자격은 부여하지 않음`, async () => {
    const { access } = fixture({ role: 'PARENT', account: { role: 'PARENT', username, phoneVerifiedAt, hasOwnChildren: true } });
    assert.deepEqual((await access.getAccountViewAccess()).views.map(x => x.key), allowed ? ['parent'] : []);
  });
}
// 2026-10-25 원장 결정으로 바뀐 규칙 — 예전에는 「기사 계정에는 화면 전환 메뉴를 추가하지 않음」이었다.
// 다중 역할(기사님 + 학부모, 선생님 + 기사님)을 허용하면서 기사님 화면도 전환 대상에 넣는다.
// 기사님 화면만 있는 사람은 화면이 하나라 전환 버튼 자체가 숨는다(AccountViewSwitcher: 2개 미만이면 숨김).
test('기사님도 화면 전환에 들어가고, 기사님 + 학부모를 오갈 수 있다', () => {
  assert.deepEqual(views.resolveAccountViews('DRIVER', true).map(x => x.key), ['driver', 'parent']);
  assert.deepEqual(views.resolveAccountViews('DRIVER', false).map(x => x.key), ['driver']);
  assert.equal(views.resolveAccountViews('DRIVER', true).find(x => x.key === 'driver').href, '/staff/shuttle');
});
test('승인된 추가 역할만 화면을 열고, 신청 중인 역할은 열지 않는다', () => {
  const active = [{ role: 'INSTRUCTOR', status: 'ACTIVE' }, { role: 'DRIVER', status: 'ACTIVE' }];
  assert.deepEqual(views.resolveAccountViews('PARENT', true, active).map(x => x.key), ['teacher', 'driver', 'parent']);
  // 고르기만 해서(PENDING) 선생님 화면이 열리면 아무나 학생 개인정보를 본다.
  assert.deepEqual(views.resolveAccountViews('PARENT', true, [{ role: 'INSTRUCTOR', status: 'PENDING' }]).map(x => x.key), ['parent']);
  // 추가 역할로는 관리자 화면이 열리지 않는다.
  assert.equal(views.resolveAccountViews('PARENT', true, [{ role: 'ADMIN', status: 'ACTIVE' }]).some(x => x.key === 'admin'), false);
  // 관리자는 셔틀을 관리자 화면에서 다루므로 기사님 화면을 따로 띄우지 않는다.
  assert.deepEqual(views.resolveAccountViews('ADMIN', false, [{ role: 'DRIVER', status: 'ACTIVE' }]).map(x => x.key), ['admin', 'teacher']);
});
test('로그아웃·조회 실패는 권한을 추정하지 않고 메뉴 닫음', async () => {
  for (const option of [{ signedOut: true }, { dbFailure: true }]) {
    assert.deepEqual(await fixture(option).access.getAccountViewAccess(), { role: null, views: [] });
  }
});
test('로그인과 계속 화면은 같은 직접 자녀 연결 결과로 목적지 결정', async () => {
  for (const role of ['ADMIN', 'VICE_ADMIN', 'INSTRUCTOR']) {
    assert.equal(routes.resolveRedirectForRole(role, '/mypage', { hasOwnChildren: true }), '/mypage');
    assert.notEqual(routes.resolveRedirectForRole(role, '/mypage', { hasOwnChildren: false }), '/mypage');
  }
  const action = await readFile('src/app/actions/auth.ts', 'utf8');
  const continuation = await readFile('src/app/auth/continue/page.tsx', 'utf8');
  assert.match(action, /getParentViewAccessForAuthUser\(data\.user\)/);
  assert.match(continuation, /getParentViewAccessForAuthUser\(user\)/);
  for (const source of [action, continuation]) assert.match(source, /hasOwnChildren: parentView\.hasOwnChildren/);
  assert.equal(routes.canRoleAccessPath('PARENT', '/admin', { hasOwnChildren: true }), false);
  assert.equal(routes.canRoleAccessPath('INSTRUCTOR', '/admin', { hasOwnChildren: true }), false);
});

const loginSource = await readFile('src/app/actions/auth.ts', 'utf8');
const continueSource = await readFile('src/app/auth/continue/page.tsx', 'utf8');
function authFlowFixture(role, hasOwnChildren) {
  let childChecks = 0;
  const redirect = href => { throw Object.assign(new Error('Redirect'), { digest: 'NEXT_REDIRECT', href }); };
  const user = { id: 'auth-owner', email: 'owner@fixture.invalid', user_metadata: { role: 'PARENT' } };
  const dependencies = {
    'next/cache': { revalidatePath: () => undefined },
    'next/navigation': { redirect },
    'next/link': { default: () => null },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@/lib/auth-routes': routes,
    '@/lib/prisma': { prisma: { $queryRawUnsafe: async () => [{ role, username: null, phoneVerifiedAt: null }] } },
    '@/lib/supabase/server': { createClient: async () => ({ auth: {
      signInWithPassword: async () => ({ data: { user }, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
      updateUser: async () => ({ error: null }),
    } }) },
    '@/lib/user-facing-error': publicErrors,
    '@/lib/enrollment-account-handoff': { linkEnrollmentAccount: async () => { throw new Error('Unexpected account write'); } },
    '@/lib/account-view-access': { getParentViewAccessForAuthUser: async principal => {
      assert.equal(principal.id, user.id); childChecks++; return { hasOwnChildren, canUseParentView: hasOwnChildren || role === 'PARENT' };
    } },
    '@/app/actions/auth': { logout: async () => undefined },
  };
  return { login: load(loginSource, dependencies).login, continuation: load(continueSource, dependencies).default, childChecks: () => childChecks };
}
for (const [role, children, expected] of [
  ['ADMIN', true, '/mypage'], ['ADMIN', false, '/admin'],
  ['VICE_ADMIN', true, '/mypage'], ['INSTRUCTOR', true, '/mypage'],
  ['INSTRUCTOR', false, '/staff'], ['PARENT', false, '/mypage'], ['DRIVER', false, '/staff/shuttle'],
]) {
  test(`${role} 실제 로그인·계속 함수 목적지 일치 (자녀 ${children})`, async () => {
    const fixture = authFlowFixture(role, children);
    const form = new FormData(); form.set('email', 'owner@fixture.invalid'); form.set('password', 'synthetic-password'); form.set('redirectTo', '/mypage');
    await assert.rejects(fixture.login(form), error => error.digest === 'NEXT_REDIRECT' && error.href === expected);
    await assert.rejects(fixture.continuation({ searchParams: Promise.resolve({ redirect: '/mypage' }) }), error => error.digest === 'NEXT_REDIRECT' && error.href === expected);
    assert.equal(fixture.childChecks(), 2);
  });
}
