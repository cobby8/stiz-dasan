// 백업 «보관용 업무 자료» 회귀 테스트 (2026-11-13 원장 지시 f12 — 학생·결제·출결까지 백업).
// 지키는 것:
//  1) 스키마의 모든 표 = «백업됨(복원 대상·보관용)» 또는 «이유 있는 제외» 중 하나
//  2) 비밀값으로 보이는 칸은 가려지거나, 사람이 «비밀 아님»으로 검토한 칸뿐이다 — 새 칸이 생기면 여기서 깨진다
//  3) 파일 복원·클라우드 복원이 보관용(archive) 칸을 건드리지 않는다
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { NextRequest, NextResponse } from 'next/server.js';
import {
  ARCHIVE_EXCLUDED_TABLES, RESTORABLE_TABLES, MASKED_VALUE, classifyBackupTable, collectArchive,
  isSecretColumnName, maskSecretValues, serializeBackup,
} from '../src/lib/backup/archiveCore.ts';

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
    if (list || /^[A-Z]/.test(type) && !['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'].includes(type)) continue;
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
  // 처음 보는 표는 자동으로 보관용 — «넣을 표 목록»을 따로 관리하지 않는다
  assert.equal(classifyBackupTable('SomeTableAddedTomorrow'), 'archive');
});

test('학생·학부모·수강·출결·청구·결제·결석·체험 업무 표는 반드시 보관용으로 백업된다', () => {
  const mustArchive = ['User', 'Student', 'Guardian', 'ParentStudentAccess', 'Enrollment', 'EnrollmentApplication', 'EnrollmentChangeRequest',
    'MonthlyEnrollmentRegister', 'Session', 'Attendance', 'MakeupSession', 'MakeupCredit', 'Payment', 'PaymentInvoice', 'PaymentTransaction',
    'PaymentTransactionItem', 'PaymentWebhookEvent', 'PosChargeRequest', 'TrialLead', 'TrialFeePayment', 'RegularAbsence', 'RegularAbsencePeriod',
    'SpecialProgramApplication', 'SpecialProgramAbsence', 'StudentShuttleRide', 'UniformOrder', 'GymRentalRequest', 'ConsultRequest',
    'Notice', 'NotificationDelivery', 'OperationsAuditLog', 'PaymentAuditLog', 'ParentSignupVerification', 'ParentAccountClaim'];
  for (const table of mustArchive) {
    assert.ok(models.has(table), `${table} 이 스키마에 없다(이름 변경 시 이 목록도 고칠 것)`);
    assert.equal(classifyBackupTable(table), 'archive', table);
  }
  // 제외는 캐시·짧은 인증 세션·횟수 제한 로그·비밀값 표뿐 — 몰래 늘지 않게 개수도 묶는다
  assert.ok(Object.keys(ARCHIVE_EXCLUDED_TABLES).length <= 14, '제외 표가 늘었다 — 정말 업무 기록이 아닌지 확인하고 이 상한을 올릴 것');
});

// 비밀값으로 «보이는» 칸 — 넓게 잡는다. 가려지지 않는 칸은 아래 검토 목록에 이유와 함께 있어야 한다.
const LOOKS_SECRET = /token|secret|password|passwd|hash|otp|key|cipher|credential|salt|auth|endpoint|p256|nonce|signature|encrypt|pin$/i;
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
  otpConsumedAt: '인증 사용 시각', code: '짧은 링크·특강 코드', shortCode: 'POS 청구 짧은 코드', itemSignature: '주문 품목 조합',
};

test('비밀값으로 보이는 칸은 가려지거나 «비밀 아님»으로 검토된 칸뿐이다(새 칸이 생기면 여기서 깨진다)', () => {
  const unreviewed = [];
  for (const [table, fields] of models) {
    if (classifyBackupTable(table) !== 'archive') continue;
    for (const field of fields) {
      if (!LOOKS_SECRET.test(field) || isSecretColumnName(field) || Object.hasOwn(REVIEWED_NOT_SECRET, field)) continue;
      unreviewed.push(`${table}.${field}`);
    }
  }
  assert.deepEqual(unreviewed, [], '비밀이면 archiveCore 의 SECRET_NAME 에, 아니면 이 테스트 REVIEWED_NOT_SECRET 에 이유와 함께 넣을 것');
  // 꼭 가려야 하는 칸 — 실제 스키마 칸이 가려지는지 확인
  for (const field of ['tokenHash', 'otpHash', 'proofHash', 'phoneHash', 'token', 'lockToken', 'processingToken', 'userKeyHash', 'linkTokenHash', 'paymentTokenHash']) {
    assert.ok(isSecretColumnName(field), field);
  }
  for (const field of ['paymentKey', 'authUserId', 'name', 'phone', 'amount', 'tokenPrefix']) assert.equal(isSecretColumnName(field), false, field);
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
      rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      if (params.length) rows = rows.filter(r => r.id > params[0]);
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
  PushSubscription: { columns: ['id', 'endpoint', 'auth'], rows: [{ id: 'x', endpoint: 'e', auth: 'a' }] },
  _prisma_migrations: { columns: ['id', 'checksum'], rows: [{ id: 'm' }] },
});

test('DB 의 모든 표를 담되 복원 대상은 중복으로 안 담고, 제외 표는 이유만 남기며, id 순서로 나눠 읽는다', async () => {
  const db = fakeDb(sampleTables());
  const archive = await collectArchive(db.query, { pageSize: 2 });
  assert.equal(archive.complete, true);
  assert.equal(archive.restore, 'MANUAL_ONLY');
  assert.deepEqual(Object.keys(archive.tables).sort(), ['ParentAccountClaim', 'Student', '_StudentToTag']);
  assert.deepEqual(archive.tables.Student.map(r => r.id), ['s1', 's2', 's3', 's4', 's5']);
  assert.equal(archive.rowCounts.Student, 5);
  // 5줄을 2줄씩 = 3번, 이어 읽기는 마지막 id 를 인자로 넘긴다(문자열에 끼워 넣지 않는다)
  const studentReads = db.calls.filter(c => c.sql.includes('FROM "Student"'));
  assert.equal(studentReads.length, 3);
  assert.deepEqual(studentReads.map(c => c.params), [[], ['s2'], ['s4']]);
  assert.deepEqual(archive.tables.ParentAccountClaim, [{ id: 'c1', tokenHash: MASKED_VALUE, otpAttempts: 1 }]);
  assert.deepEqual(archive.maskedColumns, { ParentAccountClaim: ['tokenHash'] });
  assert.ok(archive.excluded.PushSubscription && archive.excluded._prisma_migrations);
  assert.ok(!db.calls.some(c => /FROM "(Program|PushSubscription|_prisma_migrations)"/.test(c.sql)));
  assert.ok(archive.restorableTables.includes('Program'));
});

test('표 하나가 실패해도 나머지는 담고 미완료로 표시하며 오류 원문을 남기지 않는다', async () => {
  const archive = await collectArchive(fakeDb(sampleTables(), { failTable: 'Student' }).query);
  assert.equal(archive.complete, false);
  assert.deepEqual(archive.failed, [{ table: 'Student', reason: 'READ_FAILED' }]);
  assert.equal(archive.tables.Student, undefined);
  assert.ok(archive.tables.ParentAccountClaim);
  assert.doesNotMatch(JSON.stringify(archive), /SYNTHETIC_CONNECTION_STRING/);
});

test('표 목록 조회 실패·시간 초과는 미완료로 남는다', async () => {
  const listFailed = await collectArchive(fakeDb(sampleTables(), { listFail: true }).query);
  assert.equal(listFailed.complete, false);
  assert.deepEqual(listFailed.failed, [{ table: '*', reason: 'LIST_FAILED' }]);
  let clock = 0;
  const timed = await collectArchive(fakeDb(sampleTables()).query, { timeBudgetMs: 10, now: () => (clock += 6) });
  assert.equal(timed.complete, false);
  assert.ok(timed.failed.every(f => f.reason === 'TIME_LIMIT') && timed.failed.length > 0);
});

test('직렬화는 bigint 를 숫자로 바꾸고, 상한을 넘으면 보관용 표 내용만 비운다', () => {
  const archive = { version: 1, restore: 'MANUAL_ONLY', note: '', complete: true, tables: { Attendance: [{ id: 'a', n: 7n }] },
    rowCounts: { Attendance: 1 }, restorableTables: [], excluded: {}, maskedColumns: {}, failed: [] };
  const ok = serializeBackup({ programs: [{ id: 'p', price: 100n }], archive: structuredClone(archive) });
  assert.deepEqual(JSON.parse(ok.body).archive.tables.Attendance, [{ id: 'a', n: 7 }]);
  assert.deepEqual(ok.summary, { tables: 1, rows: 1, complete: true, failedTables: [] });
  const cut = serializeBackup({ programs: [{ id: 'p', price: 100n }], archive: structuredClone(archive) }, 50);
  const parsed = JSON.parse(cut.body);
  assert.deepEqual(parsed.programs, [{ id: 'p', price: 100 }]);
  assert.deepEqual(parsed.archive.tables, {});
  assert.equal(parsed.archive.rowCounts.Attendance, 1); // 무엇이 빠졌는지는 남긴다
  assert.deepEqual(cut.summary, { tables: 0, rows: 0, complete: false, failedTables: ['*'] });
});

// ── 복원이 보관용 칸을 건드리지 않는다 (실제 POST 를 가짜 DB 로 실행)
const backupFile = {
  _meta: { version: 1, scope: 'SETTINGS_AND_ARCHIVE', restoreScope: 'SETTINGS_ONLY' },
  academySettings: { termsOfService: '약관' },
  programs: [{ id: 'p1', name: '프로그램' }], coaches: [{ id: 'c1', name: '코치', role: '코치' }],
  classSlotOverrides: [], customClassSlots: [],
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

test('파일 복원은 설정 표만 쓰고 보관용 업무 자료는 쓰지 않는다', async () => {
  const sqls = [];
  const route = loadRoute('../src/app/api/admin/backup/route.ts', {
    'next/server': { NextResponse },
    '@/lib/auth-guard': { async requireOwner() {} },
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(sql) { sqls.push(sql); return 1; }, async $queryRawUnsafe() { throw new Error('복원은 조회하지 않는다'); } } },
    '@/lib/backup/archive': { async collectBackupArchive() { throw new Error('복원에서 수집하지 않는다'); }, serializeBackup() { throw new Error('x'); }, DOWNLOAD_MAX_BYTES: 0 },
  });
  const res = await route.POST(new NextRequest('http://localhost/api/admin/backup', { method: 'POST', body: JSON.stringify(backupFile) }));
  assert.equal(res.status, 200);
  assert.deepEqual(writtenTables(sqls), ['Coach', 'Program']);
});

test('클라우드 복원도 설정 표만 쓰고 보관용 업무 자료는 쓰지 않는다', async () => {
  const sqls = [];
  const route = loadRoute('../src/app/api/admin/cloud-backups/route.ts', {
    'next/server': { NextResponse },
    '@/lib/auth-guard': { async requireOwner() {} },
    '@/lib/prisma': { prisma: { async $executeRawUnsafe(sql) { sqls.push(sql); return 1; } } },
    '@/lib/supabase/admin': { createAdminClient: () => ({ storage: { from: () => ({
      async download() { return { data: { text: async () => JSON.stringify(backupFile) }, error: null }; },
    }) } }) },
  });
  const res = await route.POST(new NextRequest('http://localhost/api/admin/cloud-backups', { method: 'POST', body: JSON.stringify({ filename: 'stiz-backup-x.json' }) }));
  assert.equal(res.status, 200);
  assert.deepEqual(writtenTables(sqls), ['AcademySettings', 'Coach', 'Program']);
});

test('복원 코드는 archive 칸을 읽지 않는다(주석 제외)', () => {
  for (const path of ['../src/app/api/admin/backup/route.ts', '../src/app/api/admin/cloud-backups/route.ts', '../src/app/api/admin/seed/route.ts']) {
    const code = readFileSync(new URL(path, import.meta.url), 'utf8').split(/\r?\n/).filter(line => !line.trim().startsWith('//')).join('\n');
    const restorePart = code.slice(code.indexOf('export async function POST'));
    assert.doesNotMatch(restorePart, /\.archive\b|\["archive"\]/, path);
  }
});
