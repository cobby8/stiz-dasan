import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { gunzipSync } from 'node:zlib';
import * as archiveCore from '../src/lib/backup/archiveCore.ts';
import { NextResponse } from 'next/server.js';

const source = readFileSync(new URL('../src/app/api/admin/backup-now/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const old = { name: 'stiz-backup-2020-01-01T00-00-00.json', created_at: '2020-01-01T00:00:00Z' };
const sensitive = 'SYNTHETIC_PRIVATE_CONNECTION_AND_STUDENT';

// 업무 자료 수집은 실제 collectArchive 를 가짜 DB(학생 1줄·출결 2줄)로 돌린다 — 운영 DB 는 쓰지 않는다.
async function fakeArchive(options) {
  if (options.archive) return options.archive;
  const tables = { Student: [{ id: 'st1', tokenHash: 'h' }], Attendance: [{ id: 'a1' }, { id: 'a2' }] };
  return archiveCore.collectArchive(async (sql) => {
    if (/information_schema\.tables/.test(sql)) return Object.keys(tables).map(tableName => ({ tableName }));
    if (/information_schema\.columns/.test(sql)) return Object.keys(tables).flatMap(tableName => ['id', 'tokenHash'].map(columnName => ({ tableName, columnName })));
    return tables[sql.match(/FROM "([^"]+)"/)[1]];
  });
}
const archiveModule = (calls, options) => ({
  async collectBackupArchive() { calls.archive = (calls.archive ?? 0) + 1; return fakeArchive(options); },
  packArchive: archiveCore.packArchive, archiveFilenameFor: archiveCore.archiveFilenameFor, backupReplacer: archiveCore.backupReplacer,
  ARCHIVE_BACKUP_NAME: archiveCore.ARCHIVE_BACKUP_NAME, SETTINGS_BACKUP_NAME: archiveCore.SETTINGS_BACKUP_NAME,
});

// 실제 라우트만 실행하고 운영 인증·DB·Storage 모듈은 가져오지 않는다.
function fixture(options = {}) {
  const calls = { archiveUpload: [], order: [], client: 0, query: 0, bucket: 0, create: 0, upload: [], list: 0, remove: [], logs: [] };
  const result = (key, data) => options.fail === key ? { data: null, error: { message: sensitive } } : { data, error: null };
  const storage = {
    async listBuckets() { calls.order.push('bucket'); calls.bucket++; return result('bucket', options.missingBucket ? [] : [{ name: 'backups' }]); },
    async createBucket() { calls.order.push('create'); calls.create++; return result('create', {}); },
    from(name) {
      assert.equal(name, 'backups');
      return {
        async upload(filename, body, config) {
          if (filename.endsWith('.gz')) {
            calls.order.push('archive-upload'); calls.archiveUpload.push({ filename, archive: JSON.parse(gunzipSync(body).toString('utf8')), config });
            if (options.fail === 'archive-upload-lost') throw new Error(sensitive);
            return result('archive-upload', {});
          }
          calls.order.push('upload'); calls.upload.push({ filename, snapshot: JSON.parse(body), config });
          if (options.fail === 'upload-response-lost') throw new Error(sensitive);
          return result('upload', {});
        },
        async list() { calls.order.push('list'); calls.list++; return result('list', options.files ?? []); },
        async remove(names) { calls.order.push('remove'); calls.remove.push(names); return result('remove', options.removed ?? names.map(name => ({ name }))); },
      };
    },
  };
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/prisma': { prisma: { async $queryRawUnsafe(sql) {
      calls.order.push('query'); calls.query++;
      if (options.failQuery && sql.includes(`"${options.failQuery}"`)) throw new Error(sensitive);
      return options.rows?.[sql.match(/FROM "([^"]+)"/)[1]] ?? [];
    } } },
    '@/lib/backup/archive': archiveModule(calls, options),
    '@/lib/supabase/admin': { createAdminClient: () => { calls.client++; return { storage }; } },
    '@/lib/auth-guard': { async requireOwner() { if (options.unauthorized) throw new Error(sensitive); } },
  };
  const exports = {};
  vm.compileFunction(compiled, ['require', 'exports', 'process', 'console'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `허용하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, { env: { NODE_ENV: 'production' } },
  { error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args) });
  return { calls, async run() {
    const response = await exports.POST();
    const body = await response.json();
    assert.ok(!JSON.stringify([body, calls.logs]).includes(sensitive));
    return { status: response.status, body };
  } };
}

test('수동 저장 권한 실패는 DB 및 Storage 접근 전에 거부한다', async () => {
  const f = fixture({ unauthorized: true });
  assert.equal((await f.run()).status, 403);
  assert.equal(f.calls.query + f.calls.client + f.calls.bucket, 0);
});

for (const table of ['AcademySettings', 'Program', 'Coach', 'ClassSlotOverride', 'CustomClassSlot', 'Route', 'Stop']) {
  test(`${table} 조회 실패는 업로드·과거 백업 정리를 실행하지 않는다`, async () => {
    const f = fixture({ failQuery: table, files: [old] });
    const { status, body } = await f.run();
    assert.equal(status, 500);
    assert.equal(body.stage, 'COLLECT');
    assert.equal(body.backupSaved, false);
    assert.equal(body.success, false);
    assert.equal(f.calls.bucket, 0);
    assert.equal(f.calls.upload.length + f.calls.list + f.calls.remove.length, 0);
  });
}

test('정상적인 빈 테이블은 설정 범위를 명시한 백업으로 저장한다', async () => {
  const f = fixture();
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.scope, 'SETTINGS_ONLY');
  assert.equal(f.calls.query, 7);
  assert.equal(f.calls.upload[0].snapshot._meta.scope, 'SETTINGS_ONLY');
  assert.equal(f.calls.upload[0].snapshot._meta.source, 'manual');
  assert.equal(f.calls.upload[0].snapshot.academySettings, null);
  assert.deepEqual(f.calls.upload[0].snapshot.routes, []);
  assert.equal(f.calls.upload[0].config.upsert, false);
});

test('노선과 정류장 자료를 기존 복원 형식으로 보존한다', async () => {
  const f = fixture({ rows: { Route: [{ id: 'r1' }], Stop: [{ id: 's1', routeId: 'r1' }] } });
  assert.equal((await f.run()).status, 200);
  assert.deepEqual(f.calls.upload[0].snapshot.routes, [{ id: 'r1', stops: [{ id: 's1', routeId: 'r1' }] }]);
});

for (const fail of ['bucket', 'create', 'upload']) {
  test(`${fail} 실패는 성공·삭제로 보고하지 않는다`, async () => {
    const f = fixture({ fail, missingBucket: fail === 'create', files: [old] });
    const { status, body } = await f.run();
    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.stage, fail === 'upload' ? 'UPLOAD' : 'BUCKET');
    assert.equal(body.backupSaved, fail === 'upload' ? null : false);
    assert.equal(body.filename, fail === 'upload' ? f.calls.upload[0].filename : null);
    assert.equal(f.calls.list + f.calls.remove.length, 0);
    assert.deepEqual(body.deleted, []);
  });
}

test('업로드 후 응답 유실은 후보 파일과 저장 여부 미확인을 보고한다', async () => {
  const f = fixture({ fail: 'upload-response-lost', files: [old] });
  const { status, body } = await f.run();
  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.equal(body.stage, 'UPLOAD');
  assert.equal(body.backupSaved, null);
  assert.equal(body.filename, f.calls.upload[0].filename);
  assert.equal(f.calls.upload.length, 1);
  assert.equal(f.calls.list + f.calls.remove.length, 0);
});

for (const fail of ['list', 'remove']) {
  test(`저장 후 ${fail} 실패는 저장 완료와 정리 실패를 구분한다`, async () => {
    const f = fixture({ fail, files: [old] });
    const { status, body } = await f.run();
    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.backupSaved, true);
    assert.equal(body.filename, f.calls.upload[0].filename);
    assert.equal(body.stage, fail === 'list' ? 'CLEANUP_LIST' : 'CLEANUP_REMOVE');
    assert.deepEqual(body.deleted, []);
    if (fail === 'list') assert.equal(f.calls.remove.length, 0);
  });
}

test('기간·이름·날짜가 확인된 백업만 정리하고 실제 삭제 응답만 보고한다', async () => {
  const f = fixture({ files: [old, { ...old, name: 'unrelated.json' }, { name: 'stiz-backup-2020-02-01T00-00-00.json' },
    { name: 'stiz-backup-2020-03-01T00-00-00.json', created_at: 'invalid' },
    { name: 'stiz-backup-2099-01-01T00-00-00.json', created_at: '2099-01-01T00:00:00Z' }] });
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.deepEqual(f.calls.remove, [[old.name]]);
  assert.deepEqual(body.deleted, [old.name]);
});

test('삭제 응답에서 확인되지 않은 항목을 삭제 완료로 만들지 않는다', async () => {
  const f = fixture({ files: [old], removed: [] });
  const { status, body } = await f.run();
  assert.equal(status, 500);
  assert.equal(body.backupSaved, true);
  assert.deepEqual(body.deleted, []);
});

// 다운로드 GET만 호출하며 복원 POST는 실행하지 않는다.
const downloadCompiled = ts.transpileModule(readFileSync(new URL('../src/app/api/admin/backup/route.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function downloadFixture(options = {}) {
  const calls = { query: 0, logs: [] };
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/auth-guard': { async requireOwner() { if (options.unauthorized) throw new Error(sensitive); } },
    '@/lib/prisma': { prisma: { async $queryRawUnsafe(sql) {
      calls.query++;
      const table = sql.match(/FROM "([^"]+)"/)[1];
      if (options.failQuery === table) throw new Error(sensitive);
      return options.rows?.[table] ?? [];
    } } },
  };
  const exports = {};
  vm.compileFunction(downloadCompiled, ['require', 'exports', 'console'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `허용하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, { error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args) });
  return { calls, async run() {
    const response = await exports.GET();
    const body = await response.json();
    assert.ok(!JSON.stringify([body, calls.logs]).includes(sensitive));
    return { status: response.status, body, attachment: response.headers.get('content-disposition') };
  } };
}

test('다운로드 권한 실패는 DB 조회 전에 거부한다', async () => {
  const f = downloadFixture({ unauthorized: true });
  assert.equal((await f.run()).status, 403);
  assert.equal(f.calls.query, 0);
});
for (const table of ['AcademySettings', 'Program', 'Coach', 'ClassSlotOverride', 'CustomClassSlot', 'Route', 'Stop']) {
  test(`다운로드 ${table} 조회 실패는 정상 첨부 파일을 반환하지 않는다`, async () => {
    const f = downloadFixture({ failQuery: table });
    const { status, body, attachment } = await f.run();
    assert.equal(status, 500);
    assert.equal(attachment, null);
    assert.notEqual(body.success, true);
    assert.equal(body._meta, undefined);
  });
}
test('빈 다운로드는 기존 필드와 설정 한정 범위를 유지한다', async () => {
  const f = downloadFixture();
  const { status, body, attachment } = await f.run();
  assert.equal(status, 200);
  assert.match(attachment, /^attachment; filename="stiz-backup-.*\.json"$/);
  assert.equal(body._meta.version, 1);
  assert.equal(body._meta.scope, 'SETTINGS_ONLY');
  assert.equal(body.academySettings, null);
  for (const key of ['programs', 'coaches', 'classSlotOverrides', 'customClassSlots', 'routes']) assert.deepEqual(body[key], []);
  assert.equal(f.calls.query, 7);
});
test('다운로드 노선/정류장과 bigint 숫자를 기존 형식으로 유지한다', async () => {
  const f = downloadFixture({ rows: { Program: [{ id: 'p1', price: 100n }], Route: [{ id: 'r1' }], Stop: [{ id: 's1', routeId: 'r1' }, { id: 's2', routeId: 'other' }] } });
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.deepEqual(body.routes, [{ id: 'r1', stops: [{ id: 's1', routeId: 'r1' }] }]);
  assert.equal(body.programs[0].price, 100);
});
test('수동 저장 일부 삭제 응답은 확인된 파일만 보고한다', async () => {
  const second = { name: 'stiz-backup-2020-02-01T00-00-00.json', created_at: old.created_at };
  const f = fixture({ files: [old, second], removed: [{ name: old.name }] });
  const { status, body } = await f.run();
  assert.equal(status, 500);
  assert.equal(body.stage, 'CLEANUP_REMOVE');
  assert.equal(body.backupSaved, true);
  assert.deepEqual(body.deleted, [old.name]);
});

test('수집 완료 후 버킷 생성·업로드·정리 순서와 30일 보관을 유지한다', async () => {
  const recent = { name: 'stiz-backup-recent.json', created_at: new Date(Date.now() - 29 * 86400000).toISOString() };
  const f = fixture({ missingBucket: true, files: [old, recent] });
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.filename, f.calls.upload[0].filename);
  assert.deepEqual(f.calls.order, [...Array(7).fill('query'), 'bucket', 'create', 'upload', 'archive-upload', 'list', 'remove']);
  assert.deepEqual(f.calls.remove, [[old.name]]);
});

// 2026-11-13 f12 — 즉시 저장도 업무 자료 압축 파일을 짝으로 저장한다. 다운로드는 설정만 + 안내.
test('즉시 저장은 업무 자료 압축 파일을 저장하고 응답에 표·행 수를 돌려준다', async () => {
  const f = fixture();
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.equal(f.calls.upload[0].snapshot._meta.source, 'manual');
  assert.equal(f.calls.upload[0].snapshot._meta.archiveFile, f.calls.archiveUpload[0].filename);
  assert.deepEqual(f.calls.archiveUpload[0].archive.tables.Attendance, [{ id: 'a1' }, { id: 'a2' }]);
  assert.equal(body.archive.tables, 2);
  assert.equal(body.archive.rows, 3);
  assert.equal(body.archive.saved, true);
});

test('즉시 저장 업무 자료 목록 조회 실패는 저장됨+미완료로 구분해 보고한다', async () => {
  const archive = await archiveCore.collectArchive(async () => { throw new Error(sensitive); });
  const f = fixture({ archive });
  const { status, body } = await f.run();
  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.equal(body.stage, 'ARCHIVE_INCOMPLETE');
  assert.equal(body.backupSaved, true);
  assert.deepEqual(body.archive.failedTables, ['*']);
});

test('다운로드는 설정만 내려주고 업무 자료는 클라우드 파일에 있다고 안내한다', async () => {
  const f = downloadFixture();
  const { status, body } = await f.run();
  assert.equal(status, 200);
  assert.equal(body.archive, undefined);
  assert.match(body._meta.archiveNote, /stiz-archive-/);
  assert.equal(f.calls.query, 7);
});
