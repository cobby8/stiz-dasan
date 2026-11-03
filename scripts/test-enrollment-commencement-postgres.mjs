import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import ts from 'typescript';

// 외부 URL·환경파일을 받지 않고 이 실행기가 만든 임시 DB에만 접속한다.
const root = process.cwd(), bin = 'C:/Program Files/PostgreSQL/16/bin';
const host = '127.0.0.1', port = 55482, user = 'commencement_fixture';
const password = randomBytes(32).toString('hex');
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$|NODE_OPTIONS$)/i.test(key)));
const exec = promisify(execFile), cases = [];
let owned, pool, prisma, started = false;
const cleanup = { prismaDisconnected: false, poolClosed: false, databaseStopped: false, databaseDeleted: false, passwordFileDeleted: false };
async function command(name, args) {
  try { return await exec(path.join(bin, `${name}.exe`), args, { env: safeEnv, windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error(`격리 PostgreSQL ${name} 명령 실패`); }
}
async function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(await readFile(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Date, Intl, Request, Response, console, require(id) {
    if (!Object.hasOwn(dependencies, id)) throw new Error('격리 로더 허용 범위 밖 의존성');
    return dependencies[id];
  } }, { filename: file });
  return exports;
}
async function run(name, work) {
  try { await work(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, errorType: error.name, code: error.code ?? null }); console.log(`FAIL ${name} (${error.name})`); }
}

function findFunction(source,name){const ast=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);return ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);}
function queryFrom(source,needle){const ast=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);let found;function visit(n){if((ts.isTemplateExpression(n)||ts.isNoSubstitutionTemplateLiteral(n))&&n.getText(ast).includes(needle))found??=n.getText(ast);ts.forEachChild(n,visit);}visit(ast);assert.ok(found,needle);return vm.runInNewContext(found,{notMergedStudent:()=>"true"});}
try {
 assert.equal(process.platform,'win32');assert.equal(process.argv.length,2);
 await access(path.join(bin,'initdb.exe'));
 await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,host,()=>server.close(resolve));});
 await mkdir(path.join(root,'.tmp'),{recursive:true});owned=await mkdtemp(path.join(root,'.tmp','enrollment-commencement-pg-'));
 const data=path.join(owned,'data'),pwfile=path.join(owned,'init-password');
 await writeFile(pwfile,password,{mode:0o600,flag:'wx'});
 try{await command('initdb',['-D',data,'-U',user,'--auth-host=scram-sha-256','--auth-local=scram-sha-256',`--pwfile=${pwfile}`,'--encoding=UTF8','--no-locale']);}finally{await unlink(pwfile);cleanup.passwordFileDeleted=true;}
 started=true;await command('pg_ctl',['start','-D',data,'-l',path.join(owned,'postgres.log'),'-o',`-h ${host} -p ${port} -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0`,'-w','-t','30']);
 pool=new pg.Pool({host,port,user,password,database:'postgres',ssl:false,connectionTimeoutMillis:5000});pool.on('error',()=>console.error('격리 DB 연결 오류'));
 const {rows:[identity]}=await pool.query("SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory");
 assert.equal(identity.host,host);assert.equal(identity.port,port);assert.equal((await realpath(identity.directory)).toLowerCase(),(await realpath(data)).toLowerCase());
 prisma=new PrismaClient({datasources:{db:{url:`postgresql://${user}:${password}@${host}:${port}/postgres?schema=public`}},log:[]});
 await pool.query(`CREATE TABLE "Program"(id text PRIMARY KEY,"deletedAt" timestamp);
 CREATE TABLE "Class"(id text PRIMARY KEY,"programId" text,"dayOfWeek" text,name text);
 CREATE TABLE "Student"(id text PRIMARY KEY,name text,"parentId" text,"birthDate" timestamptz,gender text,grade text,school text,phone text,address text,"referralSource" text,"enrollDate" timestamp,"createdAt" timestamp DEFAULT now(),"updatedAt" timestamp DEFAULT now());
 CREATE TABLE "EnrollmentApplication"(id text PRIMARY KEY,status text,"convertedStudentId" text,"childName" text,"childBirthDate" timestamptz,"parentName" text,"parentPhone" text,"enrollmentMonths" text,"shuttleNeeded" boolean,"processedAt" timestamp,"processedNote" text,"assignedClassId" text,"parentUserId" text,"updatedAt" timestamp DEFAULT now());
 CREATE TABLE "Enrollment"(id text PRIMARY KEY,"studentId" text,"classId" text,status text,"createdAt" timestamp DEFAULT now(),"updatedAt" timestamp DEFAULT now(),UNIQUE("studentId","classId"));
 CREATE TABLE "Guardian"(id text PRIMARY KEY,"studentId" text,relation text,name text,phone text,"isPrimary" boolean,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "Attendance"(id text PRIMARY KEY,"sessionId" text,"studentId" text,status text,note text,"arrivedAt" timestamp);
 CREATE TABLE "RegularAbsence"("studentId" text,"classId" text,date date,reason text,status text);
 CREATE TABLE "Session"(id text PRIMARY KEY,"classId" text,date timestamp,notes text,"specialProgramSessionDateId" text);`);
 await pool.query(`INSERT INTO "Program"(id) VALUES('program-a');INSERT INTO "Class"(id,"programId","dayOfWeek",name) VALUES('class-a','program-a','Mon','합성반');INSERT INTO "Student"(id,name,"parentId","birthDate") VALUES('student-a','합성학생','parent-a','2018-01-01');INSERT INTO "Enrollment"(id,"studentId","classId",status) VALUES('old','legacy-baseline','old-class','ACTIVE');INSERT INTO "EnrollmentApplication"(id,status,"childName","enrollmentMonths") VALUES('legacy','PENDING','합성기존','2026년 10월,2026년 11월');`);
 await run('새 개시일 마이그레이션은 DATE 2개만 추가하고 기존 월·수강을 그대로 보존',async()=>{
  await pool.query(await readFile(path.join(root,'prisma/migrations/20261103103000_enrollment_commencement/migration.sql'),'utf8'));
  assert.equal((await pool.query(`SELECT "enrollmentMonths","requestedStartOn" FROM "EnrollmentApplication" WHERE id='legacy'`)).rows[0].requestedStartOn,null);
  assert.equal((await pool.query(`SELECT "startsOn" FROM "Enrollment" WHERE id='old'`)).rows[0].startsOn,null);
 });
 const kst=await load('src/lib/datetime/kst.ts');const commencement=await load('src/lib/enrollment/commencement.ts',{'@/lib/datetime/kst':kst});const hooks=await load('src/lib/operations-events/admin-hooks.ts');const events=[];
 const adminSource=await readFile(path.join(root,'src/app/actions/admin.ts'),'utf8');
 const compiled=ts.transpileModule(findFunction(adminSource,'approveEnrollApplication').replace('export async function','async function'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const ctx=vm.createContext({console,Date,Set,Number,String,Boolean,Error,Array,Object,prisma,...commencement,requireAdmin:async()=>({appUserId:'admin-a'}),normalizeApprovalClassIds:ids=>ids,ApprovalAbort:class extends Error{},ParentSelectionRequired:class extends Error{},parentPhoneDigits:()=>"01000000000",resolveApprovalParent:async()=>"parent-a",verifyEnrollmentParentAuth(){},notMergedStudent:()=>"true",SHUTTLE_LOCATION_CONSENT_VERSION:'test',buildEnrollmentOperationsEvent:hooks.buildEnrollmentOperationsEvent,enqueueWebsiteOperationsEventInTransaction:async(_tx,event)=>events.push(event),revalidatePath(){},revalidateApplyAdminCaches(){},revalidateStudentAdminCaches(){}});
 const approve=vm.runInContext(compiled+';approveEnrollApplication',ctx);
 await pool.query(`INSERT INTO "EnrollmentApplication"(id,status,"childName","childBirthDate","parentName","parentPhone","requestedStartOn","shuttleNeeded") VALUES('new','PENDING','합성학생','2018-01-01','합성보호자','01000000000','2026-12-01',false)`);
 await run('실제 승인 함수와 실제 Prisma 거래는 미래 개시일을 신청·수강·원장에 일치시킴',async()=>{
  assert.equal((await approve('new',{classIds:['class-a'],force:true,resolvedStudentId:'student-a'})).approved,true);
  const row=(await pool.query(`SELECT status,"startsOn"::text AS start FROM "Enrollment" WHERE "studentId"='student-a' AND "classId"='class-a'`)).rows[0];assert.equal(row.status,'ACTIVE');assert.equal(row.start,'2026-12-01');assert.equal(events[0].effectiveDate,'2026-12-01');
  assert.equal((await pool.query(`SELECT "requestedStartOn"::text AS start,status FROM "EnrollmentApplication" WHERE id='new'`)).rows[0].start,'2026-12-01');
 });
 await pool.query(`INSERT INTO "Student"(id,name,"parentId") VALUES('legacy-student','합성기존','parent-a'),('paused-student','합성휴원','parent-a');INSERT INTO "Enrollment"(id,"studentId","classId",status,"startsOn") VALUES('null-start','legacy-student','class-a','ACTIVE',null),('paused','paused-student','class-a','PAUSED','2026-12-01');`);
 const queries=await readFile(path.join(root,'src/lib/queries.ts'),'utf8');const rosterSql=queryFrom(queries,'SELECT e."studentId", s.name AS student_name');
 await run('관리자 실제 날짜 출석 SQL은 개시 전 제외·당일 포함하며 legacy null/휴원 구분',async()=>{
  assert.deepEqual((await pool.query(rosterSql,['class-a','2026-11-30'])).rows.map(r=>r.studentId).sort(),['legacy-student']);
  assert.deepEqual((await pool.query(rosterSql,['class-a','2026-12-01'])).rows.map(r=>r.studentId).sort(),['legacy-student','student-a']);
 });
 const staffSource=await readFile(path.join(root,'src/lib/staff-session-queries.ts'),'utf8');const staffSql=queryFrom(staffSource,'SELECT st.id, st.name, a.status');
 await run('선생님 실제 회차 로스터 SQL도 동일한 개시일 경계·휴원 제외',async()=>{
  assert.deepEqual((await pool.query(staffSql,['session-a','class-a','2026-11-30'])).rows.map(r=>r.id).sort(),['legacy-student']);
  assert.deepEqual((await pool.query(staffSql,['session-a','class-a','2026-12-01'])).rows.map(r=>r.id).sort(),['legacy-student','student-a']);
 });
 await run('기존 ACTIVE 반에 새 신청 개시일을 승인하면 실제 거래가 롤백되어 자료 불일치 없음',async()=>{
  await pool.query(`INSERT INTO "EnrollmentApplication"(id,status,"childName","parentName","parentPhone","requestedStartOn","shuttleNeeded") VALUES('duplicate','PENDING','합성학생','합성보호자','01000000000','2026-12-15',false)`);
  await assert.rejects(()=>approve('duplicate',{classIds:['class-a'],force:true,resolvedStudentId:'student-a'}),/이미 수강 중인 반/);
  assert.equal((await pool.query(`SELECT "startsOn"::text AS start FROM "Enrollment" WHERE "studentId"='student-a' AND "classId"='class-a'`)).rows[0].start,'2026-12-01');
  assert.equal((await pool.query(`SELECT status FROM "EnrollmentApplication" WHERE id='duplicate'`)).rows[0].status,'PENDING');
 });
 await run('관리자 출석 저장 검증 SQL은 날짜 이전 학생을 유효 명단으로 인정하지 않음',async()=>{
  const sql=queryFrom(findFunction(adminSource,'saveAttendance'),'SELECT e."studentId" FROM "Enrollment"');
  assert.equal((await pool.query(sql,['class-a','2026-11-30'])).rows.some(r=>r.studentId==='student-a'),false);assert.equal((await pool.query(sql,['class-a','2026-12-01'])).rows.some(r=>r.studentId==='student-a'),true);
 });
 await run('재등록 개시일 전이라도 같은 반·동일 회차의 기존 출결만 조회·정정 허용',async()=>{
  await pool.query(`INSERT INTO "Session"(id,"classId",date) VALUES('old-session','class-a','2026-11-23'),('other-session','other-class','2026-11-23');INSERT INTO "Attendance"(id,"sessionId","studentId",status) VALUES('attendance-old','old-session','student-a','PRESENT');`);
  const adminSql=queryFrom(findFunction(adminSource,'saveAttendance'),'SELECT e."studentId" FROM "Enrollment"');
  assert.equal((await pool.query(rosterSql,['class-a','2026-11-23'])).rows.some(r=>r.studentId==='student-a'),true);
  assert.equal((await pool.query(staffSql,['old-session','class-a','2026-11-23'])).rows.some(r=>r.id==='student-a'),true);
  assert.equal((await pool.query(adminSql,['class-a','2026-11-23'])).rows.some(r=>r.studentId==='student-a'),true);
  assert.equal((await pool.query(rosterSql,['class-a','2026-11-24'])).rows.some(r=>r.studentId==='student-a'),false);
  assert.equal((await pool.query(adminSql,['other-class','2026-11-23'])).rows.some(r=>r.studentId==='student-a'),false);
  assert.equal((await pool.query(staffSql,['other-session','class-a','2026-11-23'])).rows.some(r=>r.id==='student-a'),false);
  const staffActions=await readFile(path.join(root,'src/app/actions/staff-sessions.ts'),'utf8');
  const staffGuard=queryFrom(findFunction(staffActions,'isSessionRosterStudent'),'SELECT e.id FROM "Enrollment"');
  assert.equal((await pool.query(staffGuard,['class-a','student-a','2026-11-23'])).rows.length,1);
  assert.equal((await pool.query(staffGuard,['class-a','student-a','2026-11-24'])).rows.length,0);
 });
 await run('학생 대표 상태는 오래된 장부와 달라도 개시 전 예정·개시 당일 ACTIVE로 바뀜',async()=>{
  const statusSql=queries.slice(queries.indexOf('CASE WHEN EXISTS (SELECT 1 FROM "Enrollment" due'),queries.indexOf(' AS current_status')).replaceAll("(NOW() AT TIME ZONE 'Asia/Seoul')::date",'$1::date');
  const sql=`SELECT ${statusSql} AS status FROM "Student" s LEFT JOIN (VALUES ('student-a','WITHDRAWN'),('legacy-student','PAUSED')) css("studentId",status) ON css."studentId"=s.id WHERE s.id=$2`;
  assert.equal((await pool.query(sql,['2026-11-30','student-a'])).rows[0].status,'SCHEDULED');
  assert.equal((await pool.query(sql,['2026-12-01','student-a'])).rows[0].status,'ACTIVE');
  assert.equal((await pool.query(sql,['2026-12-01','legacy-student'])).rows[0].status,'PAUSED');
 });
} catch (error) {
  cases.push({ name: '격리 준비 또는 실행', pass: false, errorType: error.name, code: error.code ?? null });
  console.error(`격리 검증 중단 (${error.name})`);
} finally {
  if (prisma) { await prisma.$disconnect(); cleanup.prismaDisconnected = true; }
  if (pool) { await pool.end(); cleanup.poolClosed = true; }
  if (started && owned) {
    try { await command('pg_ctl', ['stop', '-D', path.join(owned, 'data'), '-m', 'fast', '-w']); cleanup.databaseStopped = true; }
    catch { console.error('HELD: 소유 임시 DB 종료 재확인 필요'); }
  }
  if (owned && cleanup.databaseStopped) {
    const target = path.join(owned, 'data');
    const expectedRoot = path.join(await realpath(path.join(root, '.tmp')), path.basename(owned));
    assert.equal((await realpath(owned)).toLowerCase(), expectedRoot.toLowerCase());
    assert.equal((await realpath(target)).toLowerCase(), path.join(expectedRoot, 'data').toLowerCase());
    await rm(target, { recursive: true, force: true }); cleanup.databaseDeleted = true;
  }
  if (owned) {
    const evidence = { isolated: true, database: '새 소유 loopback PostgreSQL만 사용', realPrisma: true, syntheticAdminGuard: true, cases, cleanup,
      limits: ['합성 최소 테이블·실제 PostgreSQL/Prisma/개시일 마이그레이션·실제 승인 함수·실제 출결 SQL 검증', '운영 DB/발송/외부 인증/배포/실기기 미실행'] };
    await writeFile(path.join(owned, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`증거: ${path.relative(root, path.join(owned, 'evidence.json'))}`);
  }
  console.log(`통과 ${cases.filter(item => item.pass).length}/${cases.length}; 정리 ${JSON.stringify(cleanup)}`);
  if (cases.some(item => !item.pass) || !cleanup.databaseStopped || !cleanup.databaseDeleted || !cleanup.passwordFileDeleted) process.exitCode = 1;
}
