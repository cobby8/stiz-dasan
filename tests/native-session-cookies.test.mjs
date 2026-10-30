import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', js)((name) => {
    if (name in dependencies) return dependencies[name];
    throw Error(`Unexpected dependency: ${name}`);
  }, exports);
  return exports;
}

const policy = load('src/lib/native-session-cookies.ts');
for (const authenticated of [false, true]) {
  test(`native redirect retains refreshed or removed cookies, authenticated=${authenticated}`, async () => {
    const responses = [];
    const makeResponse = (redirect) => {
      const rows = [];
      const response = { redirect, cookies: {
        set: (name, value, options) => rows.push(typeof name === 'object' ? name : { name, value, ...options }),
        getAll: () => rows,
      } };
      responses.push(response);
      return response;
    };
    const module = load('src/lib/supabase/middleware.ts', {
      '@supabase/ssr': { createServerClient: (_url, _key, options) => ({ auth: {
        getClaims: async () => {
          options.cookies.setAll([{ name: 'sb-synthetic-auth-token', value: authenticated ? 'renewed' : '',
            options: { maxAge: authenticated ? 300 : 0 } }]);
          return { data: { claims: authenticated ? { sub: 'synthetic-user' } : null }, error: null };
        },
        getUser: async () => ({ data: { user: null }, error: null }),
      } }) },
      'next/server': { NextResponse: { next: () => makeResponse(null), redirect: (url) => makeResponse(url.pathname) } },
      '@/lib/native-session-cookies': policy,
    });
    const nextUrl = new URL(authenticated ? 'https://example.invalid/login' : 'https://example.invalid/admin');
    nextUrl.clone = () => new URL(nextUrl);
    const result = await module.updateSession({ nextUrl, cookies: {
      getAll: () => [{ name: policy.NATIVE_SESSION_COOKIE, value: '1' }], set: () => {},
    } });
    assert.equal(result.redirect, authenticated ? '/auth/continue' : '/login');
    const cookie = result.cookies.getAll()[0];
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.maxAge, authenticated ? 300 : 0);
    assert.equal(cookie.value, authenticated ? 'renewed' : '');
  });
}
test('native cookie marker controls protection only, never account authorization', () => {
  assert.equal(policy.isNativeSession([]), false);
  assert.equal(policy.isNativeSession([{ name: policy.NATIVE_SESSION_COOKIE, value: 'true' }]), false);
  assert.equal(policy.isNativeSession([{ name: 'STIZ-native-session', value: '1' }]), false);
  assert.equal(policy.isNativeSession([{ name: policy.NATIVE_SESSION_COOKIE, value: '1' }]), true);
});

test('ordinary web cookie options retain the same object and policy', () => {
  const options = { httpOnly: false, secure: false, sameSite: 'strict', path: '/existing', domain: 'existing.invalid', maxAge: 60 };
  assert.equal(policy.nativeSessionCookieOptions(options, false), options);
});

test('native refresh preserves HttpOnly and host restriction without changing expiry', () => {
  const options = { httpOnly: false, secure: false, domain: 'unexpected.invalid', path: '/wrong', maxAge: 60 };
  assert.deepEqual(policy.nativeSessionCookieOptions(options, true), {
    httpOnly: true, secure: true, path: '/', sameSite: 'lax', maxAge: 60,
  });
  assert.equal(options.domain, 'unexpected.invalid');
});

test('native logout cookie deletion retains maxAge zero and expiry', () => {
  const expires = new Date(0);
  const result = policy.nativeSessionCookieOptions({ maxAge: 0, expires }, true);
  assert.equal(result.maxAge, 0);
  assert.equal(result.expires, expires);
  assert.equal(result.httpOnly, true);
});

for (const native of [false, true]) {
  test(`actual server client refresh applies protection only for native=${native}`, async () => {
    const writes = [];
    let sdkOptions;
    const module = load('src/lib/supabase/server.ts', {
      '@supabase/ssr': { createServerClient: (_url, _key, options) => { sdkOptions = options; return {}; } },
      'next/headers': { cookies: async () => ({
        getAll: () => native ? [{ name: policy.NATIVE_SESSION_COOKIE, value: '1' }] : [],
        set: (name, value, options) => writes.push({ name, value, options }),
      }) },
      '@/lib/native-session-cookies': policy,
    });
    await module.createClient();
    const options = { path: '/', httpOnly: false, maxAge: 300 };
    sdkOptions.cookies.setAll([{ name: 'sb-synthetic-auth-token', value: 'synthetic', options }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options.httpOnly, native);
    assert.equal(writes[0].options.maxAge, 300);
    if (!native) assert.equal(writes[0].options, options);
  });

  test(`actual middleware refresh applies protection only for native=${native}`, async () => {
    const writes = [];
    const options = { path: '/', httpOnly: false, maxAge: 300 };
    const module = load('src/lib/supabase/middleware.ts', {
      '@supabase/ssr': { createServerClient: (_url, _key, sdkOptions) => ({ auth: {
        getClaims: async () => {
          sdkOptions.cookies.setAll([{ name: 'sb-synthetic-auth-token', value: 'synthetic', options }]);
          return { data: { claims: { sub: 'synthetic-user' } }, error: null };
        },
      } }) },
      'next/server': { NextResponse: { next: () => ({ cookies: { set: (name, value, opts) => writes.push({ name, value, options: opts }) } }) } },
      '@/lib/native-session-cookies': policy,
    });
    const request = { nextUrl: new URL('https://example.invalid/public'), cookies: {
      getAll: () => native ? [{ name: policy.NATIVE_SESSION_COOKIE, value: '1' }] : [], set: () => {},
    } };
    await module.updateSession(request);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options.httpOnly, native);
    assert.equal(writes[0].options.maxAge, 300);
    if (!native) assert.equal(writes[0].options, options);
  });
}
