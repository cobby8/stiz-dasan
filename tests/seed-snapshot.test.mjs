// 2026-11-16 — 핵심 데이터(seed) 스냅샷: 원장이 «seed 내보내기»를 누르지 않아도 매일 자동 저장되고,
// 복구(/api/admin/seed)가 그 최신본을 먼저 쓴다. 운영 DB·Storage 는 쓰지 않는다(전부 가짜).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { NextResponse } from 'next/server.js';
import * as seed from '../src/lib/backup/seedSnapshot.ts';
import * as kst from '../src/lib/datetime/kst.ts';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const meta = { exportedAt: '2026-11-15T15:00:05.000Z', source: 'cron' };
const programRow = { id: 'p1', name: '취미반', targetAge: '초등', description: null, days: 'Mon,Wed',
  priceWeek1: 100000, priceWeek2: '180000', priceWeek3: null, priceDaily: null, shuttleFeeOverride: 0, order: 2 };
const slotRow = { id: 'c1', slotKey: 'Mon-1', label: '월 1교시', note: null, isHidden: true, capacity: 10,
  startTimeOverride: '16:00', endTimeOverride: null, coachId: 'k1', programId: 'p1' };
const good = () => seed.buildSeedSnapshot({ programRows: [programRow], slotRows: [slotRow], termsOfService: '약관 `본문` ${x}' }, meta);

test('스냅샷은 정해진 칸만 담는다 — SELECT * 줄을 넘겨도 다른 칸은 버린다', () => {
  const snap = seed.buildSeedSnapshot({
    programRows: [{ ...programRow, price: 1, createdAt: 'x', internalMemo: '비밀' }],
    slotRows: [{ ...slotRow, updatedAt: 'x' }],
    termsOfService: '약관',
  }, meta);
  assert.deepEqual(Object.keys(snap.programs[0]), ['id', 'name', 'targetAge', 'description', 'days',
    'priceWeek1', 'priceWeek2', 'priceWeek3', 'priceDaily', 'shuttleFeeOverride', 'order',
    'frequency', 'weeklyFrequency', 'imageUrl', 'runsShuttle', 'deletedAt']);
  assert.deepEqual(Object.keys(snap.classSlotOverrides[0]), ['id', 'slotKey', 'label', 'note', 'isHidden', 'capacity',
    'startTimeOverride', 'endTimeOverride', 'coachId', 'programId']);
  assert.equal(snap.programs[0].priceWeek2, 180000); // 숫자 글자는 숫자로
  assert.equal(snap.programs[0].shuttleFeeOverride, 0); // 0(셔틀 없음)은 null 이 되면 안 된다
  assert.equal(snap.classSlotOverrides[0].isHidden, true);
  assert.deepEqual(snap._meta, { kind: 'SEED_SNAPSHOT', version: 1, ...meta, tables: seed.SEED_TABLES });
  assert.ok(!JSON.stringify(snap).includes('비밀'));
});

test('숨김·셔틀 운행·사진·주 횟수 칸을 담는다 — DB 의 Date 는 ISO 글자로, 없으면 기본값(숨김 아님·셔틀 운행)', () => {
  const hidden = new Date('2026-10-01T03:00:00.000Z');
  const snap = seed.buildSeedSnapshot({
    programRows: [
      { ...programRow, frequency: '주2회', weeklyFrequency: '2', imageUrl: 'https://img/x.png', runsShuttle: false, deletedAt: hidden },
      { ...programRow, id: 'p2' },
      { ...programRow, id: 'p3', deletedAt: '읽을 수 없음', runsShuttle: null },
    ],
    slotRows: [], termsOfService: null,
  }, meta);
  const [a, b, c] = snap.programs;
  assert.deepEqual([a.frequency, a.weeklyFrequency, a.imageUrl, a.runsShuttle, a.deletedAt],
    ['주2회', '2', 'https://img/x.png', false, '2026-10-01T03:00:00.000Z']);
  assert.deepEqual([b.frequency, b.weeklyFrequency, b.imageUrl, b.runsShuttle, b.deletedAt], [null, null, null, true, null]);
  assert.deepEqual([c.runsShuttle, c.deletedAt], [true, null]);
  // JSON 으로 오갔다 와도 그대로
  const checked = seed.validateSeedSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.snapshot.programs, snap.programs);
});

test('옛 모양 스냅샷(새 칸 다섯이 없는 파일)도 읽히고 기본값이 채워진다', () => {
  const g = good();
  const oldShape = { ...g, programs: g.programs.map(({ frequency, weeklyFrequency, imageUrl, runsShuttle, deletedAt, ...rest }) => rest) };
  const checked = seed.validateSeedSnapshot(JSON.parse(JSON.stringify(oldShape)));
  assert.equal(checked.ok, true);
  assert.equal(checked.snapshot.programs[0].runsShuttle, true);
  assert.equal(checked.snapshot.programs[0].deletedAt, null);
  assert.equal(checked.snapshot.programs[0].frequency, null);
});

test('칸 이름이 소문자로 와도 읽고, 빈 값은 기본값으로 채운다', () => {
  const snap = seed.buildSeedSnapshot({
    programRows: [{ id: 'p1', name: 'A', targetage: '유아', priceweek1: 5 }],
    slotRows: [{ id: 'c1', slotkey: 'Tue-2' }],
    termsOfService: undefined,
  }, meta);
  assert.equal(snap.programs[0].targetAge, '유아');
  assert.equal(snap.programs[0].priceWeek1, 5);
  assert.equal(snap.programs[0].order, 0);
  assert.equal(snap.classSlotOverrides[0].slotKey, 'Tue-2');
  assert.equal(snap.classSlotOverrides[0].capacity, 12);
  assert.equal(snap.classSlotOverrides[0].isHidden, false);
  assert.equal(snap.termsOfService, null);
});

test('모양 검사 — 정상 스냅샷은 통과하고 JSON 으로 오갔다 와도 같다', () => {
  const checked = seed.validateSeedSnapshot(JSON.parse(JSON.stringify(good())));
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.snapshot, JSON.parse(JSON.stringify(good())));
  // 수업 칸 설정이 0줄인 것은 정상(프로그램만 있는 학원)
  assert.equal(seed.validateSeedSnapshot({ ...good(), classSlotOverrides: [] }).ok, true);
  // 모르는 칸이 붙어 와도 버린다
  const extra = seed.validateSeedSnapshot({ ...good(), students: [{ name: '학생' }] });
  assert.equal(extra.ok && 'students' in extra.snapshot, false);
});

test('모양 검사 — 빈 스냅샷·이상한 모양은 쓰지 않는다(이유 코드)', () => {
  const g = good();
  const cases = [
    [null, 'NOT_OBJECT'], ['x', 'NOT_OBJECT'], [[], 'NOT_OBJECT'],
    [{ ...g, _meta: undefined }, 'BAD_META'],
    [{ ...g, _meta: { ...g._meta, kind: 'OTHER' } }, 'BAD_META'],
    [{ ...g, _meta: { ...g._meta, version: 2 } }, 'BAD_META'],
    [{ ...g, _meta: { ...g._meta, exportedAt: '어제' } }, 'BAD_EXPORTED_AT'],
    [{ ...g, programs: undefined }, 'PROGRAMS_NOT_ARRAY'],
    [{ ...g, programs: {} }, 'PROGRAMS_NOT_ARRAY'],
    [{ ...g, classSlotOverrides: null }, 'SLOTS_NOT_ARRAY'],
    [{ ...g, termsOfService: 1 }, 'BAD_TERMS'],
    [{ ...g, programs: [] }, 'NO_PROGRAMS'],
    [{ ...g, programs: [{ ...g.programs[0], id: '' }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: [{ ...g.programs[0], name: null }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: [{ ...g.programs[0], priceWeek1: '십만' }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: ['p1'] }, 'BAD_PROGRAM_ROW'],
    // 가격 칸이 아예 없는 줄은 스냅샷이 아니다
    [{ ...g, programs: [{ id: 'p1', name: 'A' }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: [(({ priceDaily, ...rest }) => rest)(g.programs[0])] }, 'BAD_PROGRAM_ROW'],
    // 새 칸은 없어도 되지만, 있으면 모양이 맞아야 한다
    [{ ...g, programs: [{ ...g.programs[0], runsShuttle: 'no' }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: [{ ...g.programs[0], deletedAt: '어제' }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, programs: [{ ...g.programs[0], imageUrl: 5 }] }, 'BAD_PROGRAM_ROW'],
    [{ ...g, classSlotOverrides: [{ id: 'c1' }] }, 'BAD_SLOT_ROW'],
    // 설정 백업 파일(stiz-backup-*.json)을 잘못 가리켜도 스냅샷으로 쓰지 않는다
    [{ _meta: { version: 1, scope: 'SETTINGS_ONLY', exportedAt: meta.exportedAt }, programs: [programRow], classSlotOverrides: [] }, 'BAD_META'],
  ];
  for (const [value, reason] of cases) assert.deepEqual(seed.validateSeedSnapshot(value), { ok: false, reason }, reason);
});

test('마지막 저장 판정 — 날짜별 사본 중 이름의 날짜가 가장 늦은 것(최신본·다른 이름은 보지 않는다)', () => {
  assert.equal(seed.latestSeedDated([]), null);
  assert.equal(seed.latestSeedDated([{ name: 'seed-latest.json', created_at: '2026-11-16T15:00:00Z' }, { name: 'other.json' }]), null);
  assert.deepEqual(seed.latestSeedDated([
    { name: 'seed-2026-11-14.json', created_at: '2026-11-13T15:00:03Z' },
    { name: 'seed-latest.json', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }, // 고친 시각이 안 바뀌어도 상관없다
    { name: 'seed-2026-11-16.json', created_at: '2026-11-15T15:00:04Z' },
    { name: 'seed-2026-11-15.json' },
  ]), { name: 'seed-2026-11-16.json', ymd: '2026-11-16', createdAt: '2026-11-15T15:00:04Z' });
  // 만든 시각이 없거나 읽을 수 없으면 null — 호출부가 이름의 날짜를 쓴다
  assert.deepEqual(seed.latestSeedDated([{ name: 'seed-2026-11-16.json', created_at: 'invalid' }]),
    { name: 'seed-2026-11-16.json', ymd: '2026-11-16', createdAt: null });
});

test('급감 판정 — 직전의 절반 «미만»일 때만', () => {
  assert.equal(seed.isSeedShrunk(10, 4), true);
  assert.equal(seed.isSeedShrunk(10, 5), false); // 딱 절반은 저장한다
  assert.equal(seed.isSeedShrunk(3, 1), true);
  assert.equal(seed.isSeedShrunk(2, 1), false);
  assert.equal(seed.isSeedShrunk(1, 1), false);
  assert.equal(seed.isSeedShrunk(5, 9), false);
});

test('지울 날짜별 사본 — 이름의 날짜가 기준일보다 앞인 것만, 최신본·다른 이름은 절대 고르지 않는다', () => {
  const names = ['seed-latest.json', 'seed-2026-10-16.json', 'seed-2026-10-17.json', 'seed-2026-11-16.json',
    'seed-2025-12-31.json', '../seed-2020-01-01.json', 'seed-2020-01-01.json.bak', 'stiz-backup-2020-01-01T00-00-00.json'];
  assert.deepEqual(seed.expiredSeedNames(names, '2026-10-17'), ['seed-2026-10-16.json', 'seed-2025-12-31.json']);
  assert.equal(seed.seedDatedName('2026-11-16'), 'seed-2026-11-16.json');
  assert.ok(seed.SEED_DATED_NAME.test(seed.seedDatedName(kst.todayKst())));
  assert.equal(seed.SEED_LATEST_PATH, 'seed/seed-latest.json');
  assert.equal(seed.SEED_KEEP_DAYS, 30);
});

// 가짜 Storage — 메모리에 파일을 둔다.
function fakeBucket(options = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const calls = { upload: [], remove: [] };
  const bucket = {
    async upload(path, body, config) {
      calls.upload.push({ path, config });
      if (options.throwOn === path) throw new Error('SECRET_CONNECTION');
      if (options.failOn === path) return { error: { message: 'SECRET_CONNECTION' } };
      files.set(path, body);
      return { error: null };
    },
    async download(path) {
      if (options.downloadThrows) throw new Error('SECRET_CONNECTION');
      if (!files.has(path)) return { data: null, error: { message: 'not found' } };
      return { data: { text: async () => files.get(path) }, error: null };
    },
    async list(path) {
      if (options.listFails) return { data: null, error: { message: 'x' } };
      return { data: [...files.keys()].filter(k => k.startsWith(`${path}/`)).map(k => ({ name: k.slice(path.length + 1) })), error: null };
    },
    async remove(paths) {
      calls.remove.push(paths);
      if (options.removeFails) return { data: null, error: { message: 'SECRET_CONNECTION' } };
      // removeOnly: Storage 가 일부만 지웠다고 답하는 경우. removeBasename: 경로 없이 이름만 돌려주는 경우.
      const done = paths.filter(p => !options.removeOnly || options.removeOnly.includes(p));
      for (const p of done) files.delete(p);
      return { data: done.map(p => ({ name: options.removeBasename ? p.split('/').pop() : p })), error: null };
    },
  };
  return { bucket, files, calls };
}
const dates = { todayYmd: '2026-11-16', cutoffYmd: '2026-10-17' };

// 프로그램 n 줄짜리 스냅샷
const withPrograms = (n) => seed.buildSeedSnapshot({
  programRows: Array.from({ length: n }, (_, i) => ({ ...programRow, id: `p${i + 1}` })), slotRows: [slotRow], termsOfService: '약관',
}, meta);

test('저장 — 직전 최신본보다 프로그램이 절반 미만이면 최신본을 덮어쓰지 않고 날짜별 사본만 남긴다', async () => {
  const previous = JSON.stringify(withPrograms(10));
  const f = fakeBucket({ files: { 'seed/seed-latest.json': previous } });
  const result = await seed.saveSeedSnapshot(() => f.bucket, withPrograms(4), dates);
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'SKIPPED_SHRUNK');
  assert.equal(result.datedSaved, true);
  assert.deepEqual([result.previousPrograms, result.programs], [10, 4]);
  assert.equal(f.files.get('seed/seed-latest.json'), previous); // 마지막 정상본 그대로
  assert.equal(JSON.parse(f.files.get('seed/seed-2026-11-16.json')).programs.length, 4); // 그날 모습은 사본으로 남는다
  assert.deepEqual(f.calls.upload.map(u => u.path), ['seed/seed-2026-11-16.json']);

  // 딱 절반·늘어난 경우·직전 것을 못 읽는 경우는 저장한다
  for (const [files, count] of [[{ 'seed/seed-latest.json': previous }, 5], [{ 'seed/seed-latest.json': previous }, 12],
    [{ 'seed/seed-latest.json': '{잘림' }, 1], [{}, 1]]) {
    const g = fakeBucket({ files });
    const saved = await seed.saveSeedSnapshot(() => g.bucket, withPrograms(count), dates);
    assert.equal(saved.saved, true, `${count}`);
    assert.equal(JSON.parse(g.files.get('seed/seed-latest.json')).programs.length, count);
  }
});

test('저장 — 30일 정리의 deleted 는 Storage 가 실제로 지웠다고 답한 것만', async () => {
  const old = { 'seed/seed-2026-10-15.json': '{}', 'seed/seed-2026-10-16.json': '{}' };
  const all = await seed.saveSeedSnapshot(() => fakeBucket({ files: { ...old } }).bucket, good(), dates);
  assert.deepEqual([all.deleted, all.cleanupFailed], [['seed-2026-10-15.json', 'seed-2026-10-16.json'], false]);
  // 이름만 돌려줘도 맞춘다
  const basename = await seed.saveSeedSnapshot(() => fakeBucket({ files: { ...old }, removeBasename: true }).bucket, good(), dates);
  assert.deepEqual([basename.deleted, basename.cleanupFailed], [['seed-2026-10-15.json', 'seed-2026-10-16.json'], false]);
  // 일부만 지워졌으면 그것만, 그리고 정리 실패로 표시
  const partial = await seed.saveSeedSnapshot(() => fakeBucket({ files: { ...old }, removeOnly: ['seed/seed-2026-10-16.json'] }).bucket, good(), dates);
  assert.deepEqual([partial.deleted, partial.cleanupFailed, partial.saved], [['seed-2026-10-16.json'], true, true]);
  for (const options of [{ removeFails: true }, { listFails: true }]) {
    const failed = await seed.saveSeedSnapshot(() => fakeBucket({ files: { ...old }, ...options }).bucket, good(), dates);
    assert.deepEqual([failed.deleted, failed.cleanupFailed, failed.saved], [[], true, true]);
    assert.ok(!JSON.stringify(failed).includes('SECRET_CONNECTION'));
  }
});

test('저장 — 날짜별 사본 → 30일 지난 사본 정리 → 최신본(덮어쓰기), 저장한 것을 다시 읽으면 같다', async () => {
  const f = fakeBucket({ files: { 'seed/seed-latest.json': '옛 것', 'seed/seed-2026-10-16.json': '{}', 'seed/seed-2026-10-17.json': '{}' } });
  const result = await seed.saveSeedSnapshot(() => f.bucket, good(), dates);
  assert.deepEqual(result, { saved: true, reason: null, latestPath: 'seed/seed-latest.json', datedPath: 'seed/seed-2026-11-16.json',
    datedSaved: true, programs: 1, classSlotOverrides: 1, previousPrograms: null, deleted: ['seed-2026-10-16.json'], cleanupFailed: false });
  assert.deepEqual(f.calls.upload.map(u => u.path), ['seed/seed-2026-11-16.json', 'seed/seed-latest.json']);
  assert.ok(f.calls.upload.every(u => u.config.upsert === true && u.config.contentType === 'application/json'));
  assert.deepEqual([...f.files.keys()].sort(), ['seed/seed-2026-10-17.json', 'seed/seed-2026-11-16.json', 'seed/seed-latest.json']);
  const loaded = await seed.loadLatestSeedSnapshot(() => f.bucket);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.snapshot, JSON.parse(JSON.stringify(good())));
});

test('저장 — 빈 스냅샷은 올리지 않아 마지막 정상본이 남는다', async () => {
  const f = fakeBucket({ files: { 'seed/seed-latest.json': JSON.stringify(good()) } });
  const empty = seed.buildSeedSnapshot({ programRows: [], slotRows: [], termsOfService: null }, meta);
  const result = await seed.saveSeedSnapshot(() => f.bucket, empty, dates);
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'SKIPPED_NO_PROGRAMS');
  assert.equal(f.calls.upload.length, 0);
  assert.equal((await seed.loadLatestSeedSnapshot(() => f.bucket)).ok, true);
});

test('저장 — 어떤 실패에도 예외를 던지지 않고 원문 오류를 돌려주지 않는다', async () => {
  const cases = [
    [() => { throw new Error('SECRET_CONNECTION'); }, { saved: false, reason: 'STORAGE_FAILED' }],
    [() => fakeBucket({ failOn: 'seed/seed-latest.json' }).bucket, { saved: false, reason: 'LATEST_UPLOAD_FAILED', datedSaved: true }],
    [() => fakeBucket({ throwOn: 'seed/seed-latest.json' }).bucket, { saved: false, reason: 'STORAGE_FAILED', datedSaved: true }],
    // 날짜별 사본만 실패 — 최신본은 저장된다
    [() => fakeBucket({ throwOn: 'seed/seed-2026-11-16.json' }).bucket, { saved: true, reason: null, datedSaved: false }],
    [() => fakeBucket({ failOn: 'seed/seed-2026-11-16.json' }).bucket, { saved: true, reason: null, datedSaved: false }],
    // 정리 실패 — 저장 결과는 그대로
    [() => fakeBucket({ listFails: true }).bucket, { saved: true, reason: null, datedSaved: true }],
  ];
  for (const [getBucket, expected] of cases) {
    const result = await seed.saveSeedSnapshot(getBucket, good(), dates);
    for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value, `${key} ${JSON.stringify(expected)}`);
    assert.ok(!JSON.stringify(result).includes('SECRET_CONNECTION'));
  }
});

test('읽기 — 없음·읽기 실패·깨진 글자·모양 이상은 ok:false 와 이유 코드', async () => {
  assert.deepEqual(await seed.loadLatestSeedSnapshot(() => fakeBucket().bucket), { ok: false, reason: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await seed.loadLatestSeedSnapshot(() => fakeBucket({ downloadThrows: true }).bucket), { ok: false, reason: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await seed.loadLatestSeedSnapshot(() => { throw new Error('x'); }), { ok: false, reason: 'DOWNLOAD_FAILED' });
  const withFile = (body) => fakeBucket({ files: { 'seed/seed-latest.json': body } }).bucket;
  assert.deepEqual(await seed.loadLatestSeedSnapshot(() => withFile('{잘림')), { ok: false, reason: 'PARSE_FAILED' });
  assert.deepEqual(await seed.loadLatestSeedSnapshot(() => withFile(JSON.stringify({ ...good(), programs: [] }))), { ok: false, reason: 'NO_PROGRAMS' });
});

test('수동 내려받기 코드 — 백틱·${·역슬래시가 들어 있어도 그대로 되살아난다', () => {
  const snap = seed.buildSeedSnapshot({
    programRows: [{ ...programRow, description: '경로 C:\\temp `코드` ${주입}' }], slotRows: [slotRow], termsOfService: '약관 `본문` ${x}',
  }, meta);
  const code = seed.renderSeedDataTs(snap, '2026. 11. 16. 오전 12:00:05');
  assert.match(code, /마지막 내보내기: 2026\. 11\. 16\./);
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.compileFunction(js, ['exports'])(exports);
  assert.deepEqual(exports.PROGRAMS, snap.programs);
  assert.deepEqual(exports.CLASS_SLOT_OVERRIDES, snap.classSlotOverrides);
  assert.equal(exports.TERMS_OF_SERVICE, snap.termsOfService);
});

// ── 복구 라우트: 어느 자료를 고르는가 ─────────────────────────────────────────
const seedRouteCompiled = ts.transpileModule(read('../src/app/api/admin/seed/route.ts'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
// seed-data.ts 는 새 칸 다섯이 없는 옛 모양일 수 있다
const filePrograms = [(({ frequency, weeklyFrequency, imageUrl, runsShuttle, deletedAt, ...rest }) => rest)({ ...good().programs[0], id: 'file-p', name: '파일 프로그램' })];

function seedRoute(options = {}) {
  const calls = { sql: [], logs: [], client: 0 };
  const storage = fakeBucket({ files: options.latest === undefined ? {} : { 'seed/seed-latest.json': options.latest }, downloadThrows: options.downloadThrows });
  const dependencies = {
    'next/server': { NextResponse },
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(sql, ...params) {
      const table = sql.match(/INSERT INTO "([^"]+)"/)[1];
      if (options.failTable === table) throw new Error('SECRET_CONNECTION');
      calls.sql.push({ table, sql, params }); return 1;
    } } },
    '@/lib/auth-guard': { async requireOwner() { if (options.unauthorized) throw new Error('no'); } },
    '@/lib/supabase/admin': { createAdminClient: () => {
      calls.client++;
      if (options.noStorage) throw new Error('SECRET_CONNECTION');
      return { storage: { from(name) { assert.equal(name, 'backups'); return storage.bucket; } } };
    } },
    '@/lib/backup/seedSnapshot': seed,
    '@/lib/datetime/kst': kst,
    '../../../../../prisma/seed-data': { PROGRAMS: options.filePrograms ?? filePrograms, CLASS_SLOT_OVERRIDES: [], TERMS_OF_SERVICE: null },
  };
  const exports = {};
  vm.compileFunction(seedRouteCompiled, ['require', 'exports', 'console'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `허용하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, { error: (...args) => calls.logs.push(args) });
  return { calls, storage, async run() {
    const response = await exports.POST();
    const body = await response.json();
    assert.ok(!JSON.stringify([body, calls.logs]).includes('SECRET_CONNECTION'));
    return { status: response.status, body };
  } };
}

test('복구 — Storage 최신 스냅샷이 있으면 그것을 쓰고 날짜를 알린다', async () => {
  const r = seedRoute({ latest: JSON.stringify(good()) });
  const { status, body } = await r.run();
  assert.equal(status, 200);
  assert.equal(body.source, 'storage-snapshot');
  assert.equal(body.seedFile, 'backups/seed/seed-latest.json');
  assert.equal(body.snapshotExportedAt, meta.exportedAt);
  assert.equal(body.snapshotDate, '2026-11-16'); // UTC 15:00 = KST 다음 날 0시
  assert.equal(body.fallbackReason, null);
  assert.deepEqual(r.calls.sql.map(c => c.table), ['Program', 'ClassSlotOverride', 'AcademySettings']);
  assert.equal(r.calls.sql[0].params[0], 'p1');
  assert.equal(r.calls.sql[1].params[1], 'Mon-1');
  assert.equal(r.calls.sql[2].params[0], '약관 `본문` ${x}');
  assert.equal(body.results.programs, '1/1개 복원됨');
  // 복구는 덮어쓰기(upsert)만 — 지우는 SQL 이 없다
  assert.ok(r.calls.sql.every(c => /ON CONFLICT/.test(c.sql) && !/\b(DELETE|TRUNCATE)\b/i.test(c.sql)));
});

for (const [name, options, reason] of [
  ['스냅샷 없음', {}, 'DOWNLOAD_FAILED'],
  ['Storage 연결 실패', { noStorage: true }, 'DOWNLOAD_FAILED'],
  ['읽기 실패', { latest: '{}', downloadThrows: true }, 'DOWNLOAD_FAILED'],
  ['깨진 파일', { latest: '{잘림' }, 'PARSE_FAILED'],
  ['프로그램 0줄', { latest: JSON.stringify({ ...good(), programs: [] }) }, 'NO_PROGRAMS'],
  ['모양 이상', { latest: JSON.stringify({ programs: [programRow] }) }, 'BAD_META'],
]) {
  test(`복구 — ${name}이면 seed-data.ts 로 넘어간다`, async () => {
    const r = seedRoute(options);
    const { status, body } = await r.run();
    assert.equal(status, 200);
    assert.equal(body.source, 'seed-data.ts');
    assert.equal(body.seedFile, 'prisma/seed-data.ts');
    assert.equal(body.snapshotDate, null);
    assert.equal(body.fallbackReason, reason);
    assert.deepEqual(r.calls.sql.map(c => [c.table, c.params[0]]), [['Program', 'file-p']]);
  });
}

test('복구 — 스냅샷도 없고 seed-data.ts 도 비어 있으면 아무것도 쓰지 않고 성공으로 답하지 않는다', async () => {
  const r = seedRoute({ filePrograms: [] });
  const { status, body } = await r.run();
  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'NO_SEED_DATA');
  assert.match(body.error, /복원할 프로그램 자료가 없습니다/);
  assert.equal(r.calls.sql.length, 0);
  assert.equal(body.results.programs, 'seed-data.ts에 프로그램 데이터가 없습니다.');
  assert.equal(body.source, 'seed-data.ts');
});

test('복구 — 프로그램 넣기가 전부 실패해도 성공으로 답하지 않는다', async () => {
  const r = seedRoute({ latest: JSON.stringify(good()), failTable: 'Program' });
  const { status, body } = await r.run();
  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.equal(body.reason, 'PROGRAM_RESTORE_FAILED');
  assert.equal(body.results.programs, '0/1개 복원됨');
});

test('복구 — 숨김·셔틀 운행·사진·주 횟수는 새로 넣는 줄에만 쓰고, 이미 있는 줄은 건드리지 않는다', async () => {
  const snap = seed.buildSeedSnapshot({
    programRows: [{ ...programRow, frequency: '주2회', weeklyFrequency: '2', imageUrl: 'https://img/x.png', runsShuttle: false, deletedAt: '2026-10-01T03:00:00.000Z' }],
    slotRows: [], termsOfService: null,
  }, meta);
  const r = seedRoute({ latest: JSON.stringify(snap) });
  assert.equal((await r.run()).body.success, true);
  const { sql, params } = r.calls.sql[0];
  const [insertPart, conflictPart] = sql.split('ON CONFLICT');
  for (const column of ['frequency', '"weeklyFrequency"', '"imageUrl"', '"runsShuttle"', '"deletedAt"']) {
    assert.ok(insertPart.includes(column), `INSERT 에 ${column}`);
    assert.ok(!conflictPart.includes(column), `ON CONFLICT 에는 ${column} 없음`);
  }
  assert.match(insertPart, /\$17::timestamp/); // 글자로 넘긴 숨긴 시각을 시각 칸에 넣는다
  assert.deepEqual(params.slice(12), ['주2회', '2', 'https://img/x.png', false, '2026-10-01T03:00:00.000Z']);
  assert.equal(params.length, 17);

  // 옛 모양 스냅샷·seed-data.ts(칸 없음)는 기본값 — 숨김 아님·셔틀 운행
  const old = seedRoute({});
  await old.run();
  assert.deepEqual(old.calls.sql[0].params.slice(12), [null, null, null, true, null]);
});

test('복구 — 원장이 아니면 Storage·DB 를 건드리기 전에 거부한다', async () => {
  const r = seedRoute({ unauthorized: true, latest: JSON.stringify(good()) });
  assert.equal((await r.run()).status, 403);
  assert.equal(r.calls.client + r.calls.sql.length, 0);
});

// ── 소스 고정: 연결이 빠지면 빌드·tsc 가 알려 주지 않는 것들 ────────────────────
test('자동 백업·즉시 백업 둘 다 스냅샷을 저장하고, 내보내기는 같은 함수를 쓴다', () => {
  for (const path of ['../src/app/api/cron/backup/route.ts', '../src/app/api/admin/backup-now/route.ts']) {
    const source = read(path);
    assert.match(source, /buildSeedSnapshot\(/, path);
    assert.match(source, /saveSeedSnapshot\(/, path);
    assert.equal(source.match(/await saveSeed\(\)/g)?.length, 2, path); // 정상 경로 + 본 백업 실패 경로
    assert.match(source, /addDaysKst\(todayYmd, -SEED_KEEP_DAYS\)/, path);
  }
  const exportSource = read('../src/app/api/admin/export-seed/route.ts');
  assert.match(exportSource, /buildSeedSnapshot\(/);
  assert.match(exportSource, /renderSeedDataTs\(/);
});

test('버킷 맨 위 목록을 읽는 곳은 seed 폴더 칸을 백업 파일로 세지 않는다', () => {
  assert.equal(seed.SEED_DIR, 'seed');
  for (const path of ['../src/app/api/admin/cloud-backups/route.ts', '../src/lib/siteOpsBot.ts', '../src/app/api/admin/dashboard/system/route.ts']) {
    assert.match(read(path), /f\.name !== SEED_DIR/, path);
    assert.doesNotMatch(read(path), /!== "seed"/, path); // 글자를 직접 쓰지 않는다
  }
});

test('마지막 저장 시각은 날짜별 사본으로 판정하고, 점검 봇도 이틀 넘게 없으면 알린다', () => {
  const system = read('../src/app/api/admin/dashboard/system/route.ts');
  assert.match(system, /latestSeedDated\(/);
  assert.doesNotMatch(system, /updated_at/); // 최신본의 «고친 시각»을 믿지 않는다
  const bot = read('../src/lib/siteOpsBot.ts');
  assert.match(bot, /id: "seed-snapshot"/);
  assert.match(bot, /latestSeedDated\(/);
  assert.match(bot, /diffDaysKst\(latestSeed\.ymd, todayKst\(\)\) > 2/);
  assert.match(bot, /핵심 데이터 저장이 이틀 넘게 없습니다/);
});

test('호출부는 날짜별 사본 저장 실패·30일 정리 실패·급감 건너뜀을 로그에 남긴다', () => {
  for (const path of ['../src/app/api/cron/backup/route.ts', '../src/app/api/admin/backup-now/route.ts']) {
    const source = read(path);
    assert.match(source, /!seed\.result\.datedSaved\) console\.error/, path);
    assert.match(source, /seed\.result\.cleanupFailed\) console\.error/, path);
    assert.match(source, /!seed\.result\.saved\) console\.error/, path);
  }
});

test('화면 — 사이드바는 «누르지 않아도 됩니다»를 알리고, 시스템 상태 카드는 자동 저장 시각을 보인다', () => {
  const buttons = read('../src/app/admin/AdminBackupButtons.tsx');
  // 2026-11-16 원장 «아예 내보내기가 없어도 되도록» — 사이드바에서 내보내기 버튼을 뺐다
  assert.doesNotMatch(buttons, /seed 내보내기|export-seed/);
  assert.match(buttons, /매일 자동 저장됩니다 — 따로 내보낼 필요가 없습니다/);
  assert.match(read('../src/app/api/admin/dashboard/system/route.ts'), /seedSnapshotAt/);
  const dashboard = read('../src/app/admin/AdminDashboardClient.tsx');
  assert.match(dashboard, /핵심 데이터 자동 저장/);
  assert.match(dashboard, /아직 저장 전/); // 기록이 없어도 줄을 숨기지 않는다
  assert.doesNotMatch(dashboard, /\{seedAt && \(/);
  assert.match(dashboard, /backup\?\.seedSnapshotAt/);
});
