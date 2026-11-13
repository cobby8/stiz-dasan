// 백업 «보관용 업무 자료» 회귀 테스트 (2026-11-13 원장 지시 f12 — 학생·결제·출결까지 백업).
// 지키는 것:
//  1) 스키마의 모든 표 = «백업됨(복원 대상·보관용)» 또는 «이유 있는 제외» 중 하나
//  2) 비밀값으로 보이는 칸은 가려지거나, 사람이 «비밀 아님»으로 검토한 칸뿐이다 — 새 칸이 생기면 여기서 깨진다
//  3) 파일 복원·클라우드 복원이 보관용 업무 자료(stiz-archive-*.json.gz)를 건드리지 않는다
//  4) 업무 자료 파일 = gzip, 크기 상한을 넘으면 큰 표부터 빼고 나머지는 저장
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { gunzipSync } from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server.js';
import * as archiveCore from '../src/lib/backup/archiveCore.ts';

const {
  ARCHIVE_EXCLUDED_TABLES, RESTORABLE_TABLES, MASKED_VALUE, classifyBackupTable, collectArchive,
  isSecretColumn, isSecretColumnName, maskSecretValues, packArchive, archiveFilenameFor, ARCHIVE_BACKUP_NAME, SETTINGS_BACKUP_NAME,
} = archiveCore;
// 업무 자료 파일을 풀어 JSON 으로 — 표마다 gzip 조각을 이어 붙였으므로 하나로 풀리는지도 함께 확인된다
const unpack = (archive, maxBytes) => JSON.parse(gunzipSync(packArchive(archive, {}, maxBytes).body).toString('utf8'));

// ── 스키마 읽기 (@@map 이 없어 모델 이름 = 표 이름. 생기면 아래 검사가 깨진다)
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const models = new Map();
for (const match of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
  const fields = [];
  for (const line of match[2].split(/\r?\n/)) {
    const field = line.match(/^\s+(\w+)\s+([A-Z]\w*)(\[\])?(\?)?/);
    if (!field) continue;
    const [, name, type, list] = field;
    // 관계 칸(다른 모델 타입)·목록 칸은 DB 칸이 아니다
    if (list || !['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'].includes(type)) continue;
    fields.push(name);
  }
  models.set(match[1], fields);
}

test('스키마를 읽었고 표 이름을 바꾸는 @@map 이 없다', () => {
  assert.ok(models.size >= 140, `모델 ${models.size}개`);
  assert.doesNotMatch(schema, /@@map\(/, '@@map 이 생기면 표 이름 = 모델 이름 가정이 깨진다 — 이 테스트와 제외 목록을 고칠 것');
});

test('스키마의 모든 표는 «복원 대상·보관용» 또는 «이유 있는 제외» 중 하나다', () => {
  for (const table of models.keys()) {
    const kind = classifyBackupTable(table);
    assert.ok(['restore', 'archive', 'exclude'].includes(kind), table);
    if (kind === 'exclude') assert.ok(ARCHIVE_EXCLUDED_TABLES[table]?.trim().length > 5, `${table} 제외 이유가 비었다`);
  }
  // 제외 목록·복원 목록에 스키마에 없는 이름이 남지 않게(표 이름 오타면 제외가 조용히 안 먹는다)
  for (const table of Object.keys(ARCHIVE_EXCLUDED_TABLES)) {
    if (table === '_prisma_migrations') continue;
    assert.ok(models.has(table), `제외 목록의 ${table} 이 스키마에 없다`);
  }
  for (const table of RESTORABLE_TABLES) assert.ok(models.has(table), `복원 목록의 ${table} 이 스키마에 없다`);
  // 처음 보는 표(스키마에 없는 DB 표 포함)는 자동으로 보관용 — «넣을 표 목록»을 따로 관리하지 않는다
  assert.equal(classifyBackupTable('SomeTableAddedTomorrow'), 'archive');
});

test('학생·학부모·수강·출결·청구·결제·결석·체험 업무 표는 반드시 보관용으로 백업된다', () => {
  const mustArchive = ['User', 'Student', 'Guardian', 'ParentStudentAccess', 'Enrollment', 'EnrollmentApplication', 'EnrollmentChangeRequest',
    'MonthlyEnrollmentRegister', 'Session', 'Attendance', 'MakeupSession', 'MakeupCredit', 'Payment', 'PaymentInvoice', 'PaymentTransaction',
    'PaymentTransactionItem', 'PaymentWebhookEvent', 'PosChargeRequest', 'TrialLead', 'TrialFeePayment', 'RegularAbsence', 'RegularAbsencePeriod',
    'SpecialProgramApplication', 'SpecialProgramAbsence', 'StudentShuttleRide', 'UniformOrder', 'GymRentalRequest', 'ConsultRequest',
    'Notice', 'NotificationDelivery', 'OperationsAuditLog', 'PaymentAuditLog', 'ParentSignupVerification', 'ParentAccountClaim',
    'StudentRegistrationLedger', 'StudentChangeLog', 'StudentTeamRosterEntry', 'StudentSheetImportBatch'];
  for (const table of mustArchive) {
    assert.ok(models.has(table), `${table} 이 스키마에 없다(이름 변경 시 이 목록도 고칠 것)`);
    assert.equal(classifyBackupTable(table), 'archive', table);
  }
  // 시트 가져오기 원본·오류(운영 실측 110MB·8MB)는 재생성 가능한 부산물이라 뺀다 — 가져온 결과 표는 위에서 보관용
  for (const table of ['StudentSheetRawRow', 'StudentSheetImportIssue']) assert.equal(classifyBackupTable(table), 'exclude', table);
  // 제외는 캐시·가져오기 부산물·짧은 인증 세션·횟수 제한 로그·비밀값 표뿐 — 몰래 늘지 않게 개수도 묶는다
  assert.ok(Object.keys(ARCHIVE_EXCLUDED_TABLES).length <= 15, '제외 표가 늘었다 — 정말 업무 기록이 아닌지 확인하고 이 상한을 올릴 것');
});

// 비밀값으로 «보이는» 칸 — 넓게 잡는다. 가려지지 않는 칸은 아래 검토 목록에 이유와 함께 있어야 한다.
const LOOKS_SECRET = /token|secret|password|passwd|hash|otp|key|cipher|credential|salt|auth|endpoint|p256|nonce|signature|encrypt|pin$|^code$/i;
const REVIEWED_NOT_SECRET = {
  // 식별자·업무 키 — 비밀이 아니고 대조에 필요
  slotKey: '수업 칸 이름', dayKey: '요일 키', sessionKey: '수업 회차 키', idempotencyKey: '중복 처리 방지 키', previewKey: '정산 미리보기 키',
  studentKey: '학생 대조 키', selectedSlotKeysJSON: '선택한 수업 칸', preferredSlotKey: '희망 수업 칸', preferredSlotKeys: '희망 수업 칸',
  stableEventKey: '알림 이벤트 키', dedupeKey: '중복 발송 방지 키', noticeKey: '청구 안내 키', periodKey: '청구 기간 키', routeKey: '노선 키',
  batchKey: '예약 발송 묶음 키', sourceKey: '보강권 출처 키', errorCode: '오류 종류', failureCode: '결제 실패 종류',
  // 결제 증빙 — 토스 비밀키 없이는 쓸 수 없고 환불·대조에 필요
  paymentKey: '토스 결제 키(증빙)', providerPaymentKey: '결제사 결제 키(증빙)',
  // 사용자 연결 — Supabase 사용자 번호(비밀 아님)
  authUserId: '로그인 사용자 번호', pendingAuthUserId: '가입 중 사용자 번호', recoveryAuthUserId: '복구 사용자 번호', authorUserId: '작성자 번호',
  claimedByTokenId: 'POS 기기 토큰 행 번호', cancelClaimedByTokenId: 'POS 기기 토큰 행 번호', tokenPrefix: 'POS 토큰 앞 몇 글자(식별용)',
  // 인증 진행 상태(값 아님)
  otpExpiresAt: '인증번호 만료 시각', otpSentAt: '인증번호 발송 시각', otpAttempts: '인증 시도 횟수', otpVerifiedAt: '인증 완료 시각',
  otpConsumedAt: '인증 사용 시각', shortCode: 'POS 청구 짧은 번호(직원 화면 표시용)', itemSignature: '주문 품목 조합',
  // code — 접근 권한 역할인 표는 SECRET_COLUMNS_BY_TABLE 로 가리고, 나머지는 분류용 코드
  code: '분류용 코드(EnrollmentShortLink.code 는 표별 지정으로 가림)',
};

test('비밀값으로 보이는 칸은 가려지거나 «비밀 아님»으로 검토된 칸뿐이다(새 칸이 생기면 여기서 깨진다)', () => {
  const unreviewed = [];
  for (const [table, fields] of models) {
    if (classifyBackupTable(table) !== 'archive') continue;
    for (const field of fields) {
      if (!LOOKS_SECRET.test(field) || isSecretColumn(table, field) || Object.hasOwn(REVIEWED_NOT_SECRET, field)) continue;
      unreviewed.push(`${table}.${field}`);
    }
  }
  assert.deepEqual(unreviewed, [], '비밀이면 archiveCore 의 SECRET_NAME·SECRET_COLUMNS_BY_TABLE 에, 아니면 이 테스트 REVIEWED_NOT_SECRET 에 이유와 함께 넣을 것');
  // 꼭 가려야 하는 칸 — 실제 스키마 칸이 가려지는지 확인
  for (const field of ['tokenHash', 'otpHash', 'proofHash', 'phoneHash', 'token', 'lockToken', 'processingToken', 'userKeyHash', 'linkTokenHash', 'paymentTokenHash']) {
    assert.ok(isSecretColumnName(field), field);
  }
  for (const field of ['paymentKey', 'authUserId', 'name', 'phone', 'amount', 'tokenPrefix']) assert.equal(isSecretColumnName(field), false, field);
  // 접근 권한 역할의 code 는 표+칸으로만 가린다(검수 LOW-1) — 다른 표의 분류용 code 는 남긴다
  assert.ok(models.get('EnrollmentShortLink').includes('code'));
  assert.equal(isSecretColumn('EnrollmentShortLink', 'code'), true);
  assert.equal(isSecretColumn('SpecialProgramOffering', 'code'), false);
  for (const [table, columns] of Object.entries(archiveCore.SECRET_COLUMNS_BY_TABLE)) {
    for (const column of columns) assert.ok(models.get(table)?.includes(column), `가림 지정 ${table}.${column} 이 스키마에 없다`);
  }
});

test('JSON 칸 속 비밀 키(웹훅 secret·설정 apiKey)도 재귀로 가리고 Date 는 그대로 둔다', () => {
  const at = new Date('2026-11-13T00:00:00Z');
  const masked = maskSecretValues({ id: 'w1', paymentKey: 'pk', createdAt: at, tokenHash: null,
    payload: { secret: 's', data: { apiKey: 'k', items: [{ accessToken: 't', amount: 1000 }] } } });
  assert.deepEqual(masked, { id: 'w1', paymentKey: 'pk', createdAt: at, tokenHash: null,
    payload: { secret: MASKED_VALUE, data: { apiKey: MASKED_VALUE, items: [{ accessToken: MASKED_VALUE, amount: 1000 }] } } });
});

// ── 수집: 가짜 DB 로 실제 collectArchive 를 돌린다
function fakeDb(tables, options = {}) {
  const calls = [];
  const query = async (sql, ...params) => {
    calls.push({ sql, params });
    if (/information_schema\.tables/.test(sql)) {
      if (options.listFail) throw new Error('SYNTHETIC_CONNECTION_STRING');
      return Object.keys(tables).map(tableName => ({ tableName }));
    }
    if (/information_schema\.columns/.test(sql)) {
      return Object.entries(tables).flatMap(([tableName, def]) => def.columns.map(columnName => ({ tableName, columnName })));
    }
    const table = sql.match(/FROM "([^"]+)"/)[1];
    if (options.failTable === table) throw new Error('SYNTHETIC_CONNECTION_STRING');
    let rows = [...tables[table].rows];
    const limit = sql.match(/LIMIT (\d+)/);
    if (limit) {
      // Postgres 와 같이 id 를 text 로 비교한다 — 인자가 text 가 아니면 실제 DB 에서 uuid > text 오류
      assert.match(sql, /"id"::text/);
      for (const param of params) assert.equal(typeof param, 'string');
      rows.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
      if (params.length) rows = rows.filter(r => String(r.id) > params[0]);
      rows = rows.slice(0, Number(limit[1]));
    }
    return rows;
  };
  return { query, calls };
}

const sampleTables = () => ({
  Program: { columns: ['id', 'name'], rows: [{ id: 'p1', name: '설정' }] },
  Student: { columns: ['id', 'name'], rows: [1, 2, 3, 4, 5].map(n => ({ id: `s${n}`, name: `학생${n}` })) },
  ParentAccountClaim: { columns: ['id', 'tokenHash', 'otpAttempts'], rows: [{ id: 'c1', tokenHash: 'abc', otpAttempts: 1 }] },
  _StudentToTag: { columns: ['A', 'B'], rows: [{ A: 's1', B: 't1' }] },
  EnrollmentShortLink: { columns: ['id', 'code', 'url'], rows: [{ id: 'l1', code: 'ABC123', url: '/apply' }] },
  PushSubscription: { columns: ['id', 'endpoint', 'auth'], rows: [{ id: 'x', endpoint: 'e', auth: 'a' }] },
  _prisma_migrations: { columns: ['id', 'checksum'], rows: [{ id: 'm' }] },
});

test('DB 의 모든 표를 담되 복원 대상은 중복으로 안 담고, 제외 표는 이유만 남기며, id 를 text 로 나눠 읽는다', async () => {
  const db = fakeDb(sampleTables());
  const archive = await collectArchive(db.query, { pageSize: 2 });
  assert.equal(archive.complete, true);
  assert.equal(archive.restore, 'MANUAL_ONLY');
  const file = unpack(archive);
  assert.deepEqual(Object.keys(file.tables).sort(), ['EnrollmentShortLink', 'ParentAccountClaim', 'Student', '_StudentToTag']);
  assert.deepEqual(file.tables.Student.map(r => r.id), ['s1', 's2', 's3', 's4', 's5']);
  assert.equal(file.rowCounts.Student, 5);
  // 5줄을 2줄씩 = 3번, 이어 읽기는 마지막 id(text)를 인자로 넘긴다(문자열에 끼워 넣지 않는다)
  const studentReads = db.calls.filter(c => c.sql.includes('FROM "Student"'));
  assert.equal(studentReads.length, 3);
  assert.deepEqual(studentReads.map(c => c.params), [[], ['s2'], ['s4']]);
  assert.deepEqual(file.tables.ParentAccountClaim, [{ id: 'c1', tokenHash: MASKED_VALUE, otpAttempts: 1 }]);
  assert.deepEqual(file.tables.EnrollmentShortLink, [{ id: 'l1', code: MASKED_VALUE, url: '/apply' }]);
  assert.deepEqual(file.maskedColumns, { EnrollmentShortLink: ['code'], ParentAccountClaim: ['tokenHash'] });
  assert.ok(file.excluded.PushSubscription && file.excluded._prisma_migrations);
  assert.ok(!db.calls.some(c => /FROM "(Program|PushSubscription|_prisma_migrations)"/.test(c.sql)));
  assert.ok(file.restorableTables.includes('Program'));
});

test('uuid·숫자 id 표도 text 로 이어 읽어 줄을 빠뜨리지 않는다(검수 MED-2)', async () => {
  const uuids = ['0f8c2a1e-0000-4000-8000-000000000001', '5b1d9c3e-0000-4000-8000-000000000002', 'a3e4f5d6-0000-4000-8000-000000000003'];
  const db = fakeDb({
    DriverMobileTrackingSession: { columns: ['id', 'label'], rows: uuids.map((id, n) => ({ id, label: `세션${n}` })) },
    Counter: { columns: ['id'], rows: [1, 2, 3, 10, 20].map(id => ({ id })) },
  });
  const archive = await collectArchive(db.query, { pageSize: 2 });
  const file = unpack(archive);
  assert.equal(archive.complete, true);
  assert.deepEqual(file.tables.DriverMobileTrackingSession.map(r => r.id), uuids);
  assert.deepEqual(file.tables.Counter.map(r => r.id).sort((a, b) => a - b), [1, 2, 3, 10, 20]);
  assert.deepEqual(db.calls.filter(c => c.sql.includes('"DriverMobileTrackingSession"')).map(c => c.params), [[], [uuids[1]]]);
  // 숫자 id 도 문자열로 넘긴다(10 < 2 같은 text 순서여도 빠짐없이 다 읽힌다)
  assert.deepEqual(db.calls.filter(c => c.sql.includes('"Counter"')).map(c => c.params), [[], ['10'], ['20']]);
});

test('표 하나가 실패해도 나머지는 담고 미완료로 표시하며 오류 원문을 남기지 않는다', async () => {
  const archive = await collectArchive(fakeDb(sampleTables(), { failTable: 'Student' }).query);
  assert.equal(archive.complete, false);
  assert.deepEqual(archive.failed, [{ table: 'Student', reason: 'READ_FAILED' }]);
  const file = unpack(archive);
  assert.equal(file.tables.Student, undefined);
  assert.ok(file.tables.ParentAccountClaim);
  assert.doesNotMatch(JSON.stringify(file), /SYNTHETIC_CONNECTION_STRING/);
});

test('표 목록 조회 실패·시간 초과는 미완료로 남는다', async () => {
  const listFailed = await collectArchive(fakeDb(sampleTables(), { listFail: true }).query);
  assert.equal(listFailed.complete, false);
  assert.deepEqual(listFailed.failed, [{ table: '*', reason: 'LIST_FAILED' }]);
  assert.deepEqual(unpack(listFailed).tables, {});
  let clock = 0;
  const timed = await collectArchive(fakeDb(sampleTables()).query, { timeBudgetMs: 10, now: () => (clock += 6) });
  assert.equal(timed.complete, false);
  assert.ok(timed.failed.every(f => f.reason === 'TIME_LIMIT') && timed.failed.length > 0);
});

test('압축 파일은 bigint 를 숫자로 바꾸고, 상한을 넘으면 큰 표부터 빼고 나머지는 저장한다', async () => {
  // 압축이 잘 안 되는 큰 표 하나 + 작은 표 둘
  const noisy = Array.from({ length: 3000 }, (_, i) => ({ id: `n${String(i).padStart(5, '0')}`, body: Math.random().toString(36).repeat(4) }));
  const db = fakeDb({
    Big: { columns: ['id', 'body'], rows: noisy },
    Attendance: { columns: ['id', 'n'], rows: [{ id: 'a1', n: 7n }] },
    Student: { columns: ['id'], rows: [{ id: 's1' }] },
  });
  const full = await collectArchive(db.query);
  const fileAll = unpack(structuredClone(full));
  assert.deepEqual(fileAll.tables.Attendance, [{ id: 'a1', n: 7 }]);
  assert.equal(fileAll.tables.Big.length, 3000);
  const bigBytes = full.chunks.Big.length;
  const packed = packArchive(full, { settingsFile: 'stiz-backup-x.json' }, 64 * 1024 + bigBytes - 1);
  const file = JSON.parse(gunzipSync(packed.body).toString('utf8'));
  assert.equal(file.settingsFile, 'stiz-backup-x.json');
  assert.deepEqual(Object.keys(file.tables).sort(), ['Attendance', 'Student']);
  assert.deepEqual(file.failed, [{ table: 'Big', reason: 'SIZE_LIMIT' }]);
  assert.equal(file.rowCounts.Big, 3000); // 무엇이 빠졌는지는 남긴다
  assert.equal(file.complete, false);
  assert.deepEqual(packed.summary, { tables: 2, rows: 2, bytes: packed.body.length, complete: false, failedTables: ['Big'] });
});

test('업무 자료 파일 이름은 설정 파일과 같은 시각이고, 30일 정리 이름 규칙에 들어간다', () => {
  const settings = 'stiz-backup-2026-11-13T00-00-01.json';
  const archiveName = archiveFilenameFor(settings);
  assert.equal(archiveName, 'stiz-archive-2026-11-13T00-00-01.json.gz');
  assert.ok(SETTINGS_BACKUP_NAME.test(settings) && ARCHIVE_BACKUP_NAME.test(archiveName));
  assert.ok(!ARCHIVE_BACKUP_NAME.test('../secret.json.gz') && !ARCHIVE_BACKUP_NAME.test('stiz-archive-x.json.gz'));
});

// ── 복원이 업무 자료를 건드리지 않는다 (실제 POST 를 가짜 DB 로 실행)
const backupFile = {
  _meta: { version: 1, scope: 'SETTINGS_ONLY', archiveFile: 'stiz-archive-2026-11-13T00-00-01.json.gz' },
  academySettings: { termsOfService: '약관' },
  programs: [{ id: 'p1', name: '프로그램' }], coaches: [{ id: 'c1', name: '코치', role: '코치' }],
  classSlotOverrides: [], customClassSlots: [],
  // 누가 업무 자료를 끼워 넣은 파일이어도 복원은 이 칸을 쓰지 않아야 한다
  archive: { version: 1, restore: 'MANUAL_ONLY', tables: { Student: [{ id: 's1' }], Attendance: [{ id: 'a1' }], Payment: [{ id: 'pay1' }] } },
};
function loadRoute(path, dependencies) {
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.compileFunction(compiled, ['require', 'exports', 'console'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `허용하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, { error() {}, warn() {} });
  return exports;
}
const writtenTables = sqls => [...new Set(sqls.map(sql => sql.match(/INSERT INTO "([^"]+)"/)?.[1] ?? `?${sql.slice(0, 30)}`))].sort();

test('파일 복원은 설정 표만 쓰고 업무 자료는 쓰지 않는다', async () => {
  const sqls = [];
  const route = loadRoute('../src/app/api/admin/backup/route.ts', {
    'next/server': { NextResponse },
    '@/lib/auth-guard': { async requireOwner() {} },
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(sql) { sqls.push(sql); return 1; }, async $queryRawUnsafe() { throw new Error('복원은 조회하지 않는다'); } } },
  });
  const res = await route.POST(new NextRequest('http://localhost/api/admin/backup', { method: 'POST', body: JSON.stringify(backupFile) }));
  assert.equal(res.status, 200);
  assert.deepEqual(writtenTables(sqls), ['Coach', 'Program']);
});

// 클라우드 백업 라우트 — 가짜 Storage
function cloudRoute(options = {}) {
  const calls = { sqls: [], signed: [], downloads: [] };
  const route = loadRoute('../src/app/api/admin/cloud-backups/route.ts', {
    'next/server': { NextResponse },
    '@/lib/auth-guard': { async requireOwner() { if (options.unauthorized) throw new Error('no'); } },
    '@/lib/backup/archiveCore': archiveCore,
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(sql) { calls.sqls.push(sql); return 1; } } },
    '@/lib/supabase/admin': { createAdminClient: () => ({ storage: { from: () => ({
      async download(name) { calls.downloads.push(name); return { data: { text: async () => JSON.stringify(backupFile) }, error: null }; },
      async list() { return { data: options.files ?? [], error: null }; },
      async createSignedUrl(name, seconds, opts) { calls.signed.push({ name, seconds, opts }); return { data: { signedUrl: `https://signed/${name}` }, error: null }; },
    }) } }) },
  });
  return { route, calls };
}

test('클라우드 복원도 설정 표만 쓰고 업무 자료는 쓰지 않으며, 업무 자료 파일 복원은 거부한다', async () => {
  const { route, calls } = cloudRoute();
  const res = await route.POST(new NextRequest('http://localhost/api/admin/cloud-backups', { method: 'POST', body: JSON.stringify({ filename: 'stiz-backup-x.json' }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(writtenTables(calls.sqls), ['AcademySettings', 'Coach', 'Program']);
  const rejected = await route.POST(new NextRequest('http://localhost/api/admin/cloud-backups', { method: 'POST', body: JSON.stringify({ filename: 'stiz-archive-2026-11-13T00-00-01.json.gz' }) }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(calls.downloads, ['stiz-backup-x.json']);
});

test('클라우드 목록은 복원용(files)과 업무 자료(archives)를 나눠 «최신 자동백업 복원»이 압축 파일을 고르지 않게 한다', async () => {
  const files = [
    { name: 'stiz-archive-2026-11-13T00-00-01.json.gz', created_at: '2026-11-12T15:00:02Z', metadata: { size: 9 } },
    { name: 'stiz-backup-2026-11-13T00-00-01.json', created_at: '2026-11-12T15:00:01Z', metadata: { size: 1 } },
  ];
  const { route } = cloudRoute({ files });
  const body = await (await route.GET(new NextRequest('http://localhost/api/admin/cloud-backups'))).json();
  assert.deepEqual(body.files.map(f => f.filename), ['stiz-backup-2026-11-13T00-00-01.json']);
  assert.deepEqual(body.archives.map(f => f.filename), ['stiz-archive-2026-11-13T00-00-01.json.gz']);
});

test('업무 자료 내려받기는 원장만·이름 규칙에 맞는 파일만 1분짜리 주소로 준다', async () => {
  const ok = cloudRoute();
  const name = 'stiz-archive-2026-11-13T00-00-01.json.gz';
  const res = await ok.route.GET(new NextRequest(`http://localhost/api/admin/cloud-backups?archive=${name}`));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, `https://signed/${name}`);
  assert.deepEqual(ok.calls.signed, [{ name, seconds: 60, opts: { download: true } }]);
  for (const bad of ['../x.json.gz', 'stiz-backup-2026-11-13T00-00-01.json', 'other.gz']) {
    const r = await ok.route.GET(new NextRequest(`http://localhost/api/admin/cloud-backups?archive=${encodeURIComponent(bad)}`));
    assert.equal(r.status, 400, bad);
  }
  assert.equal(ok.calls.signed.length, 1);
  const denied = cloudRoute({ unauthorized: true });
  assert.equal((await denied.route.GET(new NextRequest(`http://localhost/api/admin/cloud-backups?archive=${name}`))).status, 403);
  assert.equal(denied.calls.signed.length, 0);
});

test('복원 코드는 archive 칸을 읽지 않는다(주석 제외)', () => {
  for (const path of ['../src/app/api/admin/backup/route.ts', '../src/app/api/admin/cloud-backups/route.ts', '../src/app/api/admin/seed/route.ts']) {
    const code = readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
    const restorePart = code.slice(code.indexOf('export async function POST'));
    assert.doesNotMatch(restorePart, /\.archive\b|\["archive"\]/, path);
  }
});
