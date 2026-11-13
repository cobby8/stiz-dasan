import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { gunzipSync } from 'node:zlib';
import * as archiveCore from '../src/lib/backup/archiveCore.ts';
import { NextRequest, NextResponse } from 'next/server.js';

const source = readFileSync(new URL('../src/app/api/cron/backup/route.ts', import.meta.url), 'utf8');
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
  const calls = { archiveUpload: [], query: 0, bucket: 0, create: 0, upload: [], list: 0, remove: [], logs: [] };
  const result = (key, data) => options.fail === key ? { data: null, error: { message: sensitive } } : { data, error: null };
  const storage = {
    async listBuckets() { calls.bucket++; return result('bucket', options.missingBucket ? [] : [{ name: 'backups' }]); },
    async createBucket() { calls.create++; return result('create', {}); },
    from(name) {
      assert.equal(name, 'backups');
      return {
        async upload(filename, body, config) {
          if (filename.endsWith('.gz')) {
            calls.archiveUpload.push({ filename, archive: JSON.parse(gunzipSync(body).toString('utf8')), config });
            if (options.fail === 'archive-upload-lost') throw new Error(sensitive);
            return result('archive-upload', {});
          }
          calls.upload.push({ filename, snapshot: JSON.parse(body), config });
          if (options.fail === 'upload-response-lost') throw new Error(sensitive);
          return result('upload', {});
        },
        async list() { calls.list++; return result('list', options.files ?? []); },
        async remove(names) { calls.remove.push(names); return result('remove', options.removed ?? names.map(name => ({ name }))); },
      };
    },
  };
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/prisma': { prisma: { async $queryRawUnsafe(sql) {
      calls.query++;
      if (options.failQuery && sql.includes(`"${options.failQuery}"`)) throw new Error(sensitive);
      return options.rows?.[sql.match(/FROM "([^"]+)"/)[1]] ?? [];
    } } },
    '@/lib/cron/withCronAlert': { withCronAlert: (_name, handler) => handler }, // 실패 알림 래퍼(d4)는 cron-alert.test 에서 따로 검사
    '@/lib/backup/archive': archiveModule(calls, options),
    '@/lib/supabase/admin': { createAdminClient: () => ({ storage }) },
  };
  const exports = {};
  vm.compileFunction(compiled, ['require', 'exports', 'process', 'console'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `허용하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, { env: { NODE_ENV: 'production', CRON_SECRET: options.noSecret ? undefined : 'synthetic' } },
  { error: (...args) => calls.logs.push(args), warn: (...args) => calls.logs.push(args) });
  return { calls, async run(authorized = true) {
    const response = await exports.GET(new NextRequest('http://localhost/api/cron/backup', {
      headers: authorized ? { authorization: 'Bearer synthetic' } : {},
    }));
    const body = await response.json();
    assert.ok(!JSON.stringify([body, calls.logs]).includes(sensitive));
    return { status: response.status, body };
  } };
}

test('인증 실패와 비밀값 미설정은 DB 및 Storage 호출 전에 거부한다', async () => {
  for (const options of [{}, { noSecret: true }]) {
    const f = fixture(options);
    assert.equal((await f.run(Boolean(options.noSecret))).status, 401);
    assert.equal(f.calls.query, 0);
    assert.equal(f.calls.bucket, 0);
  }
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

// 2026-11-13 f12 — 업무 자료는 같은 시각의 별도 gzip 파일(stiz-archive-*.json.gz)로 저장한다.
test('설정 파일 다음에 업무 자료 압축 파일을 짝으로 저장하고 설정 _meta 에 경로를 적는다', async () => {
  const f = fixture();
  const { status, body } = await f.run();
  assert.equal(status, 200);
  const settings = f.calls.upload[0];
  const archive = f.calls.archiveUpload[0];
  assert.equal(archive.filename, settings.filename.replace('stiz-backup-', 'stiz-archive-').replace('.json', '.json.gz'));
  assert.equal(settings.snapshot._meta.archiveFile, archive.filename);
  assert.equal(settings.snapshot._meta.scope, 'SETTINGS_ONLY');
  assert.equal(settings.snapshot.archive, undefined); // 설정 파일에는 업무 자료가 없다(복원 경로가 읽는 파일)
  assert.deepEqual(archive.archive.tables.Attendance, [{ id: 'a1' }, { id: 'a2' }]);
  assert.deepEqual(archive.archive.tables.Student, [{ id: 'st1', tokenHash: '[가림]' }]);
  assert.equal(archive.archive.restore, 'MANUAL_ONLY');
  assert.equal(archive.archive.settingsFile, settings.filename);
  assert.equal(archive.config.contentType, 'application/gzip');
  assert.equal(archive.config.upsert, false);
  assert.deepEqual(archive.config.metadata, { archiveTables: 2, archiveRows: 3, archiveComplete: true });
  assert.equal(body.archive.filename, archive.filename);
  assert.equal(body.archive.saved, true);
  assert.equal(body.archive.rows, 3);
});

test('설정 조회가 실패하면 업무 자료를 모으지 않는다', async () => {
  const f = fixture({ failQuery: 'Program' });
  assert.equal((await f.run()).status, 500);
  assert.equal(f.calls.archive, undefined);
  assert.equal(f.calls.archiveUpload.length, 0);
});

test('업무 자료 일부 표 실패는 설정·나머지를 저장하고 정리한 뒤 500 으로 알린다(슬랙 알림)', async () => {
  const archive = await archiveCore.collectArchive(async (sql) => {
    if (/information_schema\.tables/.test(sql)) return [{ tableName: 'Student' }, { tableName: 'Attendance' }];
    if (/information_schema\.columns/.test(sql)) return [{ tableName: 'Student', columnName: 'id' }, { tableName: 'Attendance', columnName: 'id' }];
    if (sql.includes('"Attendance"')) throw new Error(sensitive);
    return [{ id: 's1' }];
  });
  const f = fixture({ archive, files: [old, { name: 'stiz-archive-2020-01-01T00-00-00.json.gz', created_at: old.created_at }] });
  const { status, body } = await f.run();
  assert.equal(status, 500);
  assert.equal(body.stage, 'ARCHIVE_INCOMPLETE');
  assert.equal(body.backupSaved, true);
  assert.deepEqual(body.archive.failedTables, ['Attendance']);
  assert.deepEqual(f.calls.archiveUpload[0].archive.tables.Student, [{ id: 's1' }]);
  // 30일 지난 설정·업무 자료 파일 둘 다 정리
  assert.deepEqual(f.calls.remove, [[old.name, 'stiz-archive-2020-01-01T00-00-00.json.gz']]);
});

for (const fail of ['archive-upload', 'archive-upload-lost']) {
  test(`업무 자료 파일 저장 실패(${fail})도 설정 저장은 유지하고 500 으로 알린다`, async () => {
    const f = fixture({ fail });
    const { status, body } = await f.run();
    assert.equal(status, 500);
    assert.equal(body.stage, 'ARCHIVE_INCOMPLETE');
    assert.equal(body.backupSaved, true);
    assert.equal(body.archive.saved, fail === 'archive-upload' ? false : null);
    assert.equal(f.calls.upload.length, 1);
  });
}
