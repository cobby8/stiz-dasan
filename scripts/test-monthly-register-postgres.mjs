// 운영 환경변수를 읽지 않고 매번 새 로컬 DB만 만드는 통합 검사 실행기입니다.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { runMonthlyRegisterPostgresTests } from '../tests/monthly-register-postgres.integration.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = 'C:/Program Files/PostgreSQL/16/bin';
const port = 55432;
const dbName = 'stiz_monthly_register_test';
const restoreName = 'stiz_monthly_register_restore';
const user = 'monthly_register_test_owner';
const password = randomBytes(32).toString('hex');
// PG 서비스/접속 기본값과 운영 URL이 하위 명령으로 전파되지 않게 합니다.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$|MONTHLY_REGISTER_TEST_DATABASE_URL$)/i.test(key)));
const config = { host: '127.0.0.1', port, user, password, ssl: false,
  connectionTimeoutMillis: 5000, query_timeout: 15000, max: 8 };

async function command(name, args, auth = false) {
  try {
    return await exec(path.join(bin, `${name}.exe`), args, {
      cwd: root, windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024,
      env: auth ? { ...childEnv, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' } : childEnv,
    });
  } catch (error) {
    // 하위 프로세스 오류 객체 전체에는 인증 환경이 포함될 수 있어 출력하지 않습니다.
    throw new Error(`${name} failed (${error.code ?? 'unknown'}): ${String(error.stderr ?? '').replaceAll(password, '[REDACTED]').slice(0, 1500)}`);
  }
}

async function assertFreePort() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(resolve));
  });
}

function databaseFor(pool) {
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pool.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pool.query(sql, values)).rowCount,
    async $transaction(work, options = {}) {
    // 실제 GET 라우트가 요청하는 반복 읽기 격리 수준도 시험 DB에 그대로 적용합니다.
    assert.ok(options.isolationLevel === undefined || options.isolationLevel === 'RepeatableRead');
    const client = await pool.connect();
    try {
      await client.query(options.isolationLevel === 'RepeatableRead' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const tx = {
        $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
        $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
      };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  } };
}

async function assertOwnedConnection(pool, expectedDatabase, dataDir) {
  const { rows: [row] } = await pool.query(`SELECT current_database() AS db,
    host(inet_server_addr()) AS host, inet_server_port() AS port,
    current_setting('data_directory') AS directory`);
  assert.equal(row.db, expectedDatabase);
  assert.equal(row.host, '127.0.0.1');
  assert.equal(row.port, port);
  assert.equal((await realpath(row.directory)).toLowerCase(), (await realpath(dataDir)).toLowerCase());
}

async function snapshot(pool) {
  const result = {};
  const tables = ['Student', 'Class', 'Enrollment', 'MonthlyEnrollmentRegister', 'MonthlyEnrollmentRegisterRevision'];
  if ((await pool.query("SELECT to_regclass('public.\"User\"') AS users")).rows[0].users) tables.push('User');
  for (const table of tables) {
    result[table] = (await pool.query(`SELECT * FROM "${table}" ORDER BY id`)).rows;
  }
  // 복원기는 기본 소유자 권한을 NULL ACL로 생략할 수 있다. 문자열 표기 대신
  // 기본 ACL을 펼친 실효 권한을 비교해 공개 권한이 추가된 경우는 계속 잡는다.
  result.security = (await pool.query(`SELECT relname, relrowsecurity,
    COALESCE(relacl, acldefault('r', relowner))::text AS relacl
    FROM pg_class WHERE relname IN ('MonthlyEnrollmentRegister', 'MonthlyEnrollmentRegisterRevision', 'User') ORDER BY relname`)).rows;
  return result;
}

async function main() {
  const withApiBrowser = process.argv.length === 3 && process.argv[2] === '--with-api-browser';
  if (process.platform !== 'win32' || (process.argv.length !== 2 && !withApiBrowser)) {
    throw new Error('Windows local-only runner; only --with-api-browser is accepted, never connection URLs.');
  }
  for (const name of ['initdb', 'pg_ctl', 'pg_dump', 'pg_restore']) await access(path.join(bin, `${name}.exe`));
  await assertFreePort(); // 다른 프로그램이 사용 중이면 시작하지 않습니다.
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const owned = await mkdtemp(path.join(root, '.tmp', 'monthly-register-pg-'));
  const dataDir = path.join(owned, 'data');
  const passwordFile = path.join(owned, 'init-password');
  const pools = [];
  let startAttempted = false;
  let initialized = false;
  let stopping;
  let startup;
  let cancelled = false;
  const assertContinuing = () => { if (cancelled) throw new Error('사용자 중단: 임시 DB 정리 중'); };
  async function cleanup() {
    if (stopping) return stopping;
    stopping = (async () => {
      // 시작 중 중단됐으면 pg_ctl 결과를 먼저 기다려 뒤늦은 서버 생성을 막습니다.
      if (startup) await startup.catch(() => {});
      let stopError;
      try {
      // 연결 반납을 무한히 기다리지 않고 소유한 서버부터 정상 종료합니다.
      if (initialized && startAttempted) {
        try {
          await access(path.join(dataDir, 'postmaster.pid'));
          try {
            await command('pg_ctl', ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30']);
          } catch {
            // 정상 종료가 실패한 경우에도 이 실행기가 만든 가상 DB만 종료합니다.
            await command('pg_ctl', ['stop', '-D', dataDir, '-m', 'immediate', '-w', '-t', '10']);
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try {
          await access(path.join(dataDir, 'postmaster.pid'));
          throw new Error('임시 DB 종료 확인 실패: postmaster.pid가 남아 있습니다.');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        console.log('임시 DB 종료 확인 완료');
      }
      } catch (error) { stopError = error; }
      let timer;
      await Promise.race([
        Promise.allSettled(pools.map(pool => pool.end())),
        new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
      ]);
      clearTimeout(timer);
      try { await unlink(passwordFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      console.log(`가상 자료·백업·진단 로그 보존: ${owned}`);
      if (stopError) throw stopError;
    })();
    return stopping;
  }
  const interrupted = () => {
    cancelled = true;
    cleanup().then(() => process.exit(1)).catch(error => {
      console.error(`임시 DB 정리 확인 필요: ${error.message}`); process.exit(1);
    });
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  function makePool(database) {
    const pool = new pg.Pool({ ...config, database });
    pool.on('error', () => { if (!stopping) interrupted(); });
    pools.push(pool);
    return pool;
  }
  console.log('임시 PostgreSQL 검사 시작: localhost:55432 / 가상 자료만 사용');
  try {
    await writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 });
    assertContinuing();
    startup = command('initdb', ['-D', dataDir, '-U', user, '--auth-host=scram-sha-256',
      '--auth-local=scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--no-locale']);
    await startup;
    initialized = true;
    await unlink(passwordFile);
    assertContinuing();
    startAttempted = true;
    startup = command('pg_ctl', ['start', '-D', dataDir, '-l', path.join(owned, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30']);
    await startup;
    assertContinuing();
    const admin = makePool('postgres');
    await assertOwnedConnection(admin, 'postgres', dataDir);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.query(`CREATE DATABASE ${restoreName}`);
    await admin.query('CREATE ROLE anon NOLOGIN NOBYPASSRLS; CREATE ROLE authenticated NOLOGIN NOBYPASSRLS; CREATE ROLE service_role NOLOGIN BYPASSRLS');
    const pool = makePool(dbName);
    await assertOwnedConnection(pool, dbName, dataDir);
    await pool.query(`
      CREATE TABLE "Student" (id text PRIMARY KEY, name text, "mergedIntoStudentId" text);
      CREATE TABLE "Class" (id text PRIMARY KEY, name text);
      CREATE TABLE "Enrollment" (id text PRIMARY KEY, "studentId" text REFERENCES "Student"(id),
        "classId" text REFERENCES "Class"(id), status text, UNIQUE("studentId", "classId"));
      GRANT SELECT, UPDATE ON "Student", "Class", "Enrollment" TO service_role;
      INSERT INTO "Class" VALUES ('class-1', '가상 화요일반'), ('class-2', '가상 목요일반');
      INSERT INTO "Student" VALUES ('student-1', '가상학생1', NULL), ('student-2', '가상학생2', NULL),
        ('student-3', '가상학생3', NULL), ('student-4', '가상학생4', NULL), ('student-merged', '가상병합학생', 'student-1');
      INSERT INTO "Enrollment" SELECT s.id || '-' || c.id, s.id, c.id, 'ACTIVE'
        FROM "Student" s CROSS JOIN "Class" c WHERE s."mergedIntoStudentId" IS NULL;
    `);
    await pool.query(await readFile(path.join(root, 'prisma/migrations/20260904121549_add_monthly_enrollment_register/migration.sql'), 'utf8'));
    const fixtureBefore = await snapshot(pool);
    const result = await runMonthlyRegisterPostgresTests({ pool, database: databaseFor(pool) });
    for (const check of result.checks) console.log(`PASS ${check}`);
    if (withApiBrowser) {
      // 같은 소유권 검사를 통과한 임시 DB만 실제 API·화면 통합 검사에 전달합니다.
      assertContinuing();
      await assertOwnedConnection(pool, dbName, dataDir);
      const { runMonthlyRegisterApiBrowserTests } = await import('../tests/monthly-register-api-browser.integration.mjs');
      const integrated = await runMonthlyRegisterApiBrowserTests({ pool, database: databaseFor(pool) });
      console.log(`실제 API·권한·화면·격리 DB 통합 검사 ${integrated.passed}개 통과 (Auth 제공자 응답은 모의)`);
    }
    const before = await snapshot(pool);
    for (const table of ['Student', 'Class', 'Enrollment']) assert.deepEqual(before[table], fixtureBefore[table]);
    const archive = path.join(owned, 'monthly-register.dump');
    const connectionArgs = ['-h', '127.0.0.1', '-p', String(port), '-U', user, '-w'];
    await command('pg_dump', [...connectionArgs, '-d', dbName, '-Fc', '-f', archive], true);
    const restore = makePool(restoreName);
    await assertOwnedConnection(restore, restoreName, dataDir);
    await command('pg_restore', [...connectionArgs, '-d', restoreName, '--exit-on-error', '--single-transaction', archive], true);
    assert.deepEqual(await snapshot(restore), before);
    console.log('PASS 기존 학생·반·수강 자료 불변');
    console.log('PASS pg_dump/pg_restore 장부·감사 전체 내용·버전·RLS·권한 일치');
    console.log(`총 ${result.passed + 2}개 실제 PostgreSQL 검사 통과`);
  } finally {
    await cleanup();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

main().catch(error => {
  console.error(`FAIL ${String(error.message).replaceAll(password, '[REDACTED]')}`);
  process.exitCode = 1;
});
