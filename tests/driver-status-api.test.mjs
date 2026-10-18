import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// 실제 GET 라우트와 조회 함수를 실행하되 DB·인증 공급자는 격리한다.
function load(file, dependencies) {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, Date, Intl, URL,
    require(name) { if (!(name in dependencies)) throw new Error(`허용하지 않은 테스트 의존성: ${name}`); return dependencies[name]; },
  });
  return exports;
}
function fixture({ regular = true, seasonal = false, failRead = false } = {}) {
  const reads = [];
  const reader = load('src/lib/shuttle/driverStatusRead.ts', { '@/lib/prisma': { prisma: {
    async $queryRawUnsafe(sql, date, direction) {
      reads.push({ sql, date, direction });
      if (failRead) throw new Error('격리 저장소 조회 오류');
      return [{ shuttleRequestId: 'fixture-row', status: 'SELF', checkedAt: '2026-10-19T01:00:00Z' }];
    },
  } } });
  const dependencies = {
    'next/server': { NextResponse: { json(body, options = {}) { return new Response(JSON.stringify(body), { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); } } },
    '@/lib/shuttle/regularRun': { async isRegularRunToken() { return regular; } },
    '@/lib/shuttle/driverToken': { async isAnyDriverRunToken() { return regular || seasonal; } },
    '@/lib/seasonal/shuttleRun': { async resolveRunToken() { return seasonal ? { date: '2026-10-19' } : null; } },
    '@/lib/shuttle/driverStatusRead': reader,
  };
  const regularApi = load('src/app/api/shuttle/regular-boarding/route.ts', dependencies);
  const seasonalApi = load('src/app/api/shuttle/boarding/route.ts', dependencies);
  return { regularApi, seasonalApi, reads };
}
const request = date => new Request(`http://localhost/api/shuttle/boarding?token=fixture-only${date == null ? '' : `&date=${date}`}`);

test('유효하지 않은 운행 링크는 두 GET 모두 DB 조회 전에 거부한다', async () => {
  const f = fixture({ regular: false });
  for (const api of [f.regularApi, f.seasonalApi]) {
    const response = await api.GET(request('2026-10-19'));
    assert.ok([403, 404].includes(response.status));
  }
  assert.equal(f.reads.length, 0);
});
test('정규 GET은 달력에 없는 날짜를 거부하고 DB를 읽지 않는다', async () => {
  const f = fixture();
  assert.equal((await f.regularApi.GET(request('2026-02-30'))).status, 400);
  assert.equal(f.reads.length, 0);
});
test('정규 GET은 선택한 날짜와 기존 REGULAR 저장 키를 읽는다', async () => {
  const f = fixture(); const response = await f.regularApi.GET(request('2026-10-19'));
  const body = await response.json();
  assert.equal(body.boarding['fixture-row'], 'SELF');
  assert.equal(body.checkedAt['fixture-row'], '2026-10-19T01:00:00.000Z');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(f.reads[0].date, '2026-10-19'); assert.equal(f.reads[0].direction, 'REGULAR');
});
test('특강 GET은 정규 링크도 받아 등원·하원 저장 키를 분리한다', async () => {
  const f = fixture(); const response = await f.seasonalApi.GET(request('2026-10-19'));
  const body = await response.json();
  assert.equal(body.boarding.PICKUP['fixture-row'], 'SELF');
  assert.equal(body.boarding.DROPOFF['fixture-row'], 'SELF');
  assert.deepEqual(f.reads.map(row => row.direction).sort(), ['DROPOFF', 'PICKUP']);
});
test('특강 링크의 날짜 기본값 하위 호환을 유지한다', async () => {
  const f = fixture({ regular: false, seasonal: true });
  assert.equal((await f.seasonalApi.GET(request(null))).status, 200);
  assert.equal(f.reads[0].date, '2026-10-19');
});
test('두 종류 GET의 저장소 오류는 빈 미체크가 아닌 503이다', async () => {
  const f = fixture({ failRead: true });
  for (const api of [f.regularApi, f.seasonalApi]) {
    const response = await api.GET(request('2026-10-19'));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).boarding, undefined);
  }
});
