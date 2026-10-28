// 합성 UI 전용 HTTPS 서버. 운영 Next 서버·DB·인증·공급자를 실행하거나 중계하지 않는다.
import { createServer } from 'node:https';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile, lstat, realpath, open, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sandboxFixtures } from './lib/native-device-sandbox-fixtures.mjs';
import { BODY_LIMIT, ROLE_PATHS, SANDBOX_HEADERS, SANDBOX_PORT, browserGuard, privateIpv4, requestTarget, routeDecision, sameOriginWrite, sandboxOrigin } from './lib/native-device-sandbox-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = path.join(ROOT, '.tmp', 'native-device-sandbox');
const MIME = { '/bundle.js': 'application/javascript; charset=utf-8', '/guard.js': 'application/javascript; charset=utf-8', '/screen.css': 'text/css; charset=utf-8', '/stiz-logo.png': 'image/png', '/__sandbox/sample.png': 'image/png', '/material.woff2': 'font/woff2', '/material.ttf': 'font/ttf' };
// 고정된 32×32 합성 PNG. 개인 사진·외부 이미지·파일 시스템을 사용하지 않는다.
function syntheticPng() {
  const chunk=(kind,data)=>{const body=Buffer.concat([Buffer.from(kind),data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,checksum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(32,0);header.writeUInt32BE(32,4);header[8]=8;header[9]=6;
  const row=Buffer.concat([Buffer.from([0]),Buffer.from(Array.from({length:32},()=>[120,80,180,255]).flat())]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(Array(32).fill(row)))),chunk('IEND',Buffer.alloc(0))]);
}
const SAMPLE_PNG = syntheticPng();
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STIZ 합성 시험</title><link rel="stylesheet" href="/screen.css"></head><body><aside id="sandbox-banner"><b>격리 시험 · 합성 자료</b> <span id="sandbox-status">운영 연결·발송·결제·위치 수집 없음</span><nav><a href="/store-app">역할 선택</a><a href="/__entry/admin">관리자</a><a href="/__entry/teacher">선생님</a><a href="/__entry/parent">학부모</a><a href="/__entry/driver">기사님</a><a href="/__sandbox/media">첨부 시험</a></nav></aside><div id="root"></div><script src="/guard.js"></script><script src="/bundle.js"></script></body></html>`;
const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };

async function bodyBytes(request) {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) { request.resume(); throw Object.assign(new Error('BODY_LIMIT'), { status: 413 }); }
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) { request.resume(); throw Object.assign(new Error('BODY_LIMIT'), { status: 413 }); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validFile(type, bytes) {
  if (type === 'image/png') return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/webp') return bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (type === 'image/heic' || type === 'image/heif') {
    if(bytes.length<16||bytes.toString('ascii',4,8)!=='ftyp')return false;
    const size=bytes.readUInt32BE(0);if(size<16||size>bytes.length||size>256)return false;
    const brands=[bytes.toString('ascii',8,12)];for(let at=16;at+4<=size;at+=4)brands.push(bytes.toString('ascii',at,at+4));
    return brands.some(brand=>['heic','heix','hevc','hevx','mif1','msf1'].includes(brand));
  }
  if (type === 'application/pdf') return bytes.toString('ascii',0,5) === '%PDF-';
  if (type === 'application/json') { try { JSON.parse(bytes.toString('utf8')); return true; } catch { return false; } }
  if (type === 'text/csv' || type === 'text/plain') return !bytes.includes(0);
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return bytes[0] === 80 && bytes[1] === 75 && bytes[2] === 3 && bytes[3] === 4;
  return false;
}

export function createSandboxHandler({ origins, assets = {}, fixtures = sandboxFixtures() }) {
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => new URL(origin).origin !== sandboxOrigin(new URL(origin).hostname, Number(new URL(origin).port)))) throw new Error('시험 origin 설정 오류');
  const counters = { page: 0, denied: 0, uploadCount: 0, uploadBytes: 0 };
  const handler = async (request, response) => {
    for (const [key,value] of Object.entries(SANDBOX_HEADERS)) response.setHeader(key,value);
    const target = requestTarget(request.url, request.headers.host, origins);
    if (!target || request.headers['x-forwarded-host'] || request.headers['x-forwarded-proto']) { counters.denied++; request.resume(); json(response,403,{error:'SANDBOX_HOST_OR_PATH_BLOCKED'}); return; }
    const route = routeDecision(request.method,target.pathname);
    if (route === 'deny') { counters.denied++; request.resume(); json(response,403,{error:'SANDBOX_OPERATION_BLOCKED',synthetic:true}); return; }
    if (route === 'page') { counters.page++; response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}); response.end(html); return; }
    if (route === 'asset') {
      const asset = target.pathname === '/guard.js' ? Buffer.from(browserGuard) : target.pathname === '/__sandbox/sample.png' ? SAMPLE_PNG : assets[target.pathname];
      if (!asset) { json(response,404,{error:'SANDBOX_ASSET_MISSING'}); return; }
      response.writeHead(200,{'Content-Type':MIME[target.pathname],...(target.pathname === '/__sandbox/sample.png' ? {'Content-Disposition':'attachment; filename="stiz-synthetic-sample.png"','Content-Length':String(asset.length)} : {})}); response.end(asset); return;
    }
    if (route === 'synthetic-read') {
      if (target.pathname === '/__sandbox/health') return json(response,200,{sandbox:true,data:'synthetic-only',database:false,externalDispatch:false,payments:false,geolocation:false,roles:ROLE_PATHS.filter(item=>item.startsWith('/__entry/'))});
      if (target.pathname === '/__sandbox/counters') return json(response,200,{...counters,storedFileBytes:0,storedLocationPoints:0});
      if (target.pathname === '/api/admin/dashboard') return json(response,200,fixtures.dashboard);
      if (target.pathname === '/api/admin/students') return json(response,200,{...fixtures.adminStudents,synthetic:true});
      if (target.pathname === '/api/admin/dashboard/system') return json(response,200,{dbOk:false,backup:{lastBackupAt:null,backupCount:0},synthetic:true});
      if (target.pathname === '/api/account/child-links') return json(response,200,{enabled:false,verified:false,outgoing:[],incoming:[],synthetic:true});
      return json(response,200,{photos:[],synthetic:true});
    }
    if (!sameOriginWrite(request.headers,target.origin)) { counters.denied++; request.resume(); json(response,403,{error:'SANDBOX_ORIGIN_BLOCKED'}); return; }
    try {
      const contentType = request.headers['content-type'] || '';
      if (!/^multipart\/form-data;\s*boundary=[\w'()+_,.\/:=? -]{1,100}$/i.test(contentType)) { request.resume(); return json(response,415,{error:'SANDBOX_MULTIPART_REQUIRED'}); }
      const bytes = await bodyBytes(request);
      const form = await new Request(`${target.origin}/__sandbox/upload`, {method:'POST',headers:{'Content-Type':contentType},body:bytes}).formData();
      const files = form.getAll('file');
      if (files.length !== 1 || typeof files[0] === 'string' || [...form.keys()].some(key=>!['file','folder','subjectStudentIds'].includes(key))) return json(response,400,{error:'SANDBOX_ONE_FILE_REQUIRED'});
      const file=files[0]; const fileBytes=Buffer.from(await file.arrayBuffer());
      if (!fileBytes.length || fileBytes.length > 5*1024*1024) return json(response,413,{error:'SANDBOX_FILE_LIMIT'});
      if (!validFile(file.type,fileBytes) || (target.pathname.startsWith('/api/') && !['image/png','image/jpeg','image/webp'].includes(file.type))) return json(response,415,{error:'SANDBOX_FILE_TYPE_REJECTED'});
      counters.uploadCount++; counters.uploadBytes+=fileBytes.length;
      // 수신 바이트는 반환 뒤 버리고 파일·이름·좌표·인증 정보를 저장하지 않는다.
      return json(response,200,{synthetic:true,bytes:fileBytes.length,type:file.type,sha256:createHash('sha256').update(fileBytes).digest('hex'),url:'/stiz-logo.png',stored:false});
    } catch (error) { if (!response.headersSent) json(response,error.status===413?413:400,{error:error.status===413?'SANDBOX_BODY_LIMIT':'SANDBOX_UPLOAD_REJECTED'}); }
  };
  return { handler, counters };
}

async function ownedDirectory(directory,{create=false}={}) {
  if (create) await mkdir(directory,{recursive:true});
  const actual=await realpath(directory);const expected=path.resolve(directory);
  if(actual.toLowerCase()!==expected.toLowerCase() || (await lstat(directory)).isSymbolicLink())throw new Error('시험 경로가 외부로 연결되어 있습니다.');
  const relative=path.relative(WORKSPACE,actual);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('시험 작업 폴더 범위 밖입니다.');
  return actual;
}
function runDirectory(id){if(!/^run-[0-9a-f]{16}$/.test(id))throw new Error('시험 실행 ID 형식 오류');return path.join(WORKSPACE,id);}
const minimalEnv=()=>Object.fromEntries(['PATH','PATHEXT','SystemRoot','WINDIR','TEMP','TMP'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));

export async function prepareSandbox({lanHost=null}={}) {
  if(lanHost!==null&&!privateIpv4(lanHost))throw new Error('LAN은 명시한 사설 IPv4만 허용합니다.');
  await ownedDirectory(WORKSPACE,{create:true});
  const id=`run-${randomBytes(8).toString('hex')}`,directory=runDirectory(id);
  await mkdir(directory,{mode:0o700});await ownedDirectory(directory);
  const output=path.join(directory,'web');
  const {buildSandbox}=await import('./lib/native-device-sandbox-build.mjs');
  const build=await buildSandbox(ROOT,output);
  const config=`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1${lanHost?`,IP:${lanHost}`:''}\n`;
  await writeFile(path.join(directory,'tls.cnf'),config,{flag:'wx'});
  const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
  const command=async args=>promisify(execFile)(openssl,args,{env:minimalEnv(),cwd:directory,windowsHide:true,shell:false,timeout:30000,maxBuffer:16384});
  try{
    await command(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','2','-subj','/CN=STIZ Synthetic Sandbox CA','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',path.join(directory,'ca.key'),'-out',path.join(directory,'ca.crt')]);
    await command(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-subj','/CN=STIZ Synthetic Sandbox','-keyout',path.join(directory,'server.key'),'-out',path.join(directory,'server.csr')]);
    await command(['x509','-req','-in',path.join(directory,'server.csr'),'-CA',path.join(directory,'ca.crt'),'-CAkey',path.join(directory,'ca.key'),'-CAcreateserial','-days','2','-sha256','-extfile',path.join(directory,'tls.cnf'),'-out',path.join(directory,'server.crt')]);
  }catch{throw new Error('새 로컬 시험 TLS 생성 실패. 하위 출력은 표시하지 않습니다.');}
  finally{for(const name of ['ca.key','server.csr','ca.srl'])await unlink(path.join(directory,name)).catch(()=>{});}
  const origins=[sandboxOrigin('localhost'),sandboxOrigin('127.0.0.1'),...(lanHost?[sandboxOrigin(lanHost)]:[])];
  const ca=new X509Certificate(await readFile(path.join(directory,'ca.crt')));
  const metadata={kind:'STIZ_SYNTHETIC_SANDBOX_V1',id,origins,lanHost,port:SANDBOX_PORT,createdAt:new Date().toISOString(),publicCaSha256:ca.fingerprint256,...build};
  await writeFile(path.join(directory,'ready.json'),JSON.stringify(metadata,null,2),{flag:'wx',mode:0o600});
  return metadata;
}

export async function startSandbox(id) {
  const directory=await ownedDirectory(runDirectory(id));
  async function readOwned(name) { const file=path.join(directory,name);const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size>40*1024*1024)throw new Error('시험 파일 검증 실패');const actual=await realpath(file);if(!actual.toLowerCase().startsWith(directory.toLowerCase()+path.sep))throw new Error('시험 파일 범위 오류');return readFile(file); }
  const metadata=JSON.parse((await readOwned('ready.json')).toString('utf8'));
  if(metadata.kind!=='STIZ_SYNTHETIC_SANDBOX_V1'||metadata.id!==id||metadata.port!==SANDBOX_PORT||metadata.lanHost!==null&&!privateIpv4(metadata.lanHost))throw new Error('시험 설정 검증 실패');
  const expected=[sandboxOrigin('localhost'),sandboxOrigin('127.0.0.1'),...(metadata.lanHost?[sandboxOrigin(metadata.lanHost)]:[])];
  if(JSON.stringify(expected)!==JSON.stringify(metadata.origins))throw new Error('시험 호스트 검증 실패');
  const cert=await readOwned('server.crt');const x509=new X509Certificate(cert),ca=new X509Certificate(await readOwned('ca.crt'));
  if(Date.parse(x509.validTo)<=Date.now()||Date.parse(ca.validTo)<=Date.now()||!ca.ca||x509.ca||!x509.checkIssued(ca)||!x509.verify(ca.publicKey)||!x509.checkHost('localhost')||!x509.checkIP('127.0.0.1')||metadata.lanHost&&!x509.checkIP(metadata.lanHost)||metadata.publicCaSha256!==ca.fingerprint256)throw new Error('시험 인증서 만료·발급 체인·호스트 불일치');
  const sourceHashes=JSON.parse((await readOwned('web/source-hashes.json')).toString('utf8'));
  if(metadata.fixtureVersion!==1||metadata.sourceCount!==Object.keys(sourceHashes).length||metadata.sourceHash!==createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'))throw new Error('시험 소스 원장 검증 실패');
  const extraSources=new Set(['src/app/globals.css','src/app/academy-theme.css','scripts/native-device-sandbox.mjs','scripts/lib/native-device-sandbox-build.mjs','scripts/lib/native-device-sandbox-fixtures.mjs','scripts/lib/native-device-sandbox-policy.mjs','.tmp/staff-header/material-full.woff2']);
  for(const[name,hash]of Object.entries(sourceHashes)){
    if(!extraSources.has(name)&&!/^src\/[A-Za-z0-9_@/.[\]()-]+\.(?:tsx?|css)$/.test(name)||name.includes('..'))throw new Error('허용되지 않은 시험 소스 경로');
    const file=path.join(ROOT,name);const actual=await realpath(file);if(actual.toLowerCase()!==file.toLowerCase()||(await lstat(file)).isSymbolicLink())throw new Error('시험 소스 연결 경로 오류');
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==hash)throw new Error('시험 준비 뒤 원본이 바뀌었습니다. 새 prepare가 필요합니다.');
  }
  if(!['material.woff2','material.ttf'].includes(metadata.fontName))throw new Error('시험 폰트 종류 오류');
  const assets={};for(const name of ['bundle.js','screen.css','stiz-logo.png',metadata.fontName]){const bytes=await readOwned('web/'+name);if(createHash('sha256').update(bytes).digest('hex')!==metadata.assetHashes?.[name])throw new Error('시험 산출물 해시 불일치');assets['/'+name]=bytes;}
  const tlsOptions={key:await readOwned('server.key'),cert,minVersion:'TLSv1.2',maxHeaderSize:8192};
  const lock=await open(path.join(WORKSPACE,'server.lock'),'wx',0o600);await lock.writeFile(JSON.stringify({id,pid:process.pid}));
  const {handler,counters}=createSandboxHandler({origins:expected,assets});
  const servers=[];
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;for(const server of servers)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await lock.close();await unlink(path.join(WORKSPACE,'server.lock'));};
  try{for(const host of ['127.0.0.1',...(metadata.lanHost?[metadata.lanHost]:[])]){
    const server=createServer(tlsOptions,(request,response)=>{void handler(request,response).catch(()=>{if(!response.headersSent)json(response,500,{error:'SANDBOX_INTERNAL_ERROR'});else response.end();});});
    server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;server.maxHeadersCount=30;server.maxConnections=32;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(SANDBOX_PORT,host,()=>{server.off('error',reject);resolve();});});servers.push(server);
  }}catch(error){await close();throw error;}
  return{server:servers[0],servers,counters,metadata,close};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  try{
    if(args[0]==='prepare'&&(args.length===1||args.length===3&&args[1]==='--lan-host'))console.log(JSON.stringify(await prepareSandbox({lanHost:args[2]||null}),null,2));
    else if(args[0]==='serve'&&args.length===2){const instance=await startSandbox(args[1]);console.log(JSON.stringify({running:true,id:instance.metadata.id,origins:instance.metadata.origins,syntheticOnly:true}));let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await instance.close();};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());}
    else throw new Error('사용법: node scripts/native-device-sandbox.mjs prepare [--lan-host 사설IPv4] | serve run-ID');
  }catch(error){console.error(error.code==='EADDRINUSE'?'시험 포트를 이미 사용 중입니다. 다른 프로세스를 종료하지 않았습니다.':error.message);process.exitCode=1;}
}
