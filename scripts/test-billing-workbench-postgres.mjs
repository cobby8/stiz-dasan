// 운영 설정을 읽지 않고 소유한 임시 PostgreSQL만 사용하는 실행기.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { runBillingWorkbenchPostgresTests } from '../tests/billing-workbench-postgres.integration.mjs';
// Prisma는 timezone 없는 timestamp를 UTC Date로 돌려주므로 같은 계약을 맞춘다.
pg.types.setTypeParser(1114,value=>new Date(value.replace(' ','T')+'Z'));
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
const bin = 'C:/Program Files/PostgreSQL/16/bin', port = 55477;
const password = randomBytes(32).toString('hex'), user = 'workbench_test_owner';
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$)/i.test(k)));
async function command(name,args) { try { return await exec(path.join(bin,name+'.exe'),args,{env:childEnv,windowsHide:true,shell:false,timeout:45000}); } catch(e) { throw new Error(`${name}: ${String(e.stderr??e.code).replaceAll(password,'[REDACTED]').slice(0,1000)}`); } }
if(process.platform!=='win32'||process.argv.length!==2)throw new Error('Windows local-only runner; no connection arguments accepted');
await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen({host:'127.0.0.1',port,exclusive:true},()=>s.close(resolve));});
const temporary=path.join(root,'.tmp');await mkdir(temporary,{recursive:true});
const owned=await mkdtemp(path.join(temporary,'billing-workbench-pg-')),data=path.join(owned,'data'),pw=path.join(owned,'password');
let pool,started=false,starting,cleaning,cancelled=false;
async function cleanup(){if(cleaning)return cleaning;cleaning=(async()=>{
 if(starting)await starting.catch(()=>{});
 if(pool)await pool.end();
 if(started){await command('pg_ctl',['stop','-D',data,'-m','fast','-w','-t','30']);started=false;}
 const absolute=await realpath(owned),parent=await realpath(temporary);
 assert.equal(path.dirname(absolute).toLowerCase(),parent.toLowerCase());assert.ok(path.basename(absolute).startsWith('billing-workbench-pg-'));
 await rm(absolute,{recursive:true,force:false});console.log('소유 임시 PostgreSQL 종료·자료 삭제 확인');
})();return cleaning;}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{cancelled=true;cleanup().finally(()=>process.exit(1));});
try{
 await writeFile(pw,password,{flag:'wx',mode:0o600});
 await command('initdb',['-D',data,'-U',user,'--auth-host=scram-sha-256','--auth-local=scram-sha-256',`--pwfile=${pw}`,'--encoding=UTF8','--no-locale']);await unlink(pw);
 if(cancelled)throw Error('임시 DB 검사 중단');
 started=true;starting=command('pg_ctl',['start','-D',data,'-l',path.join(owned,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','-t','30']);await starting;
 if(cancelled)throw Error('임시 DB 검사 중단');
 pool=new pg.Pool({host:'127.0.0.1',port,user,password,database:'postgres',ssl:false,max:8,connectionTimeoutMillis:5000});pool.on('error',()=>{});
 const {rows:[identity]}=await pool.query(`SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS dir`);
 assert.equal(identity.host,'127.0.0.1');assert.equal(identity.port,port);assert.equal((await realpath(identity.dir)).toLowerCase(),(await realpath(data)).toLowerCase());
 const database={$transaction:async(work,options={})=>{const c=await pool.connect();try{assert.ok(['Serializable','RepeatableRead'].includes(options.isolationLevel));await c.query(options.isolationLevel==='Serializable'?'BEGIN ISOLATION LEVEL SERIALIZABLE':'BEGIN ISOLATION LEVEL REPEATABLE READ');await c.query("SET LOCAL statement_timeout='15s'");await c.query("SET LOCAL lock_timeout='8s'");const result=await work({$queryRawUnsafe:async(sql,...v)=>(await c.query(sql,v)).rows,$executeRawUnsafe:async(sql,...v)=>(await c.query(sql,v)).rowCount});await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};
 const result=await runBillingWorkbenchPostgresTests({pool,database,root});
 for(const check of result.checks)console.log(`PASS ${check}`);
 console.log(`실제 PostgreSQL 청구 통합 검증 ${result.checks.length}개 통과`);
}catch(e){console.error(`실DB 검증 실패: ${String(e.message).slice(0,1600)}`);process.exitCode=1;}finally{await cleanup();}
