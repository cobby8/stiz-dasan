import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { createSandboxHandler } from '../scripts/native-device-sandbox.mjs';
import { sandboxFixtures } from '../scripts/lib/native-device-sandbox-fixtures.mjs';
import { BODY_LIMIT, ROLE_PATHS, SANDBOX_HEADERS, browserGuard, privateIpv4, requestTarget, routeDecision, sandboxOrigin } from '../scripts/lib/native-device-sandbox-policy.mjs';

const origin='https://localhost:8453';
const originHeaders={host:'localhost:8453',origin,'sec-fetch-site':'same-origin'};
async function send(instance,{method='GET',url='/__sandbox/health',headers={},body=Buffer.alloc(0)}={}){
  const request=Readable.from([body]);request.method=method;request.url=url;request.headers={host:'localhost:8453',...headers};
  const response={status:200,headers:{},headersSent:false,setHeader(key,value){this.headers[key.toLowerCase()]=value},writeHead(status,headers={}){this.status=status;this.headersSent=true;for(const[key,value]of Object.entries(headers))this.setHeader(key,value)},end(body=''){this.bytes=Buffer.isBuffer(body)?body:Buffer.from(String(body));this.body=this.bytes.toString('utf8')}};
  await instance.handler(request,response);return{...response,json:()=>JSON.parse(response.body)};
}
const instance=()=>createSandboxHandler({origins:[origin],assets:{'/bundle.js':Buffer.from('/* synthetic */'),'/screen.css':Buffer.from('body{}')},fixtures:sandboxFixtures(new Date('2026-10-28T00:00:00Z'))});

test('명시한 로컬·사설 IPv4만 origin에 사용할 수 있다',()=>{
  assert.equal(sandboxOrigin(),origin);for(const ip of ['10.0.0.1','172.20.10.6','192.168.0.5'])assert.equal(privateIpv4(ip),true);
  for(const ip of ['8.8.8.8','0.0.0.0','127.0.0.1','169.254.1.1','172.32.0.1','192.168.1.1.evil','stiz-dasan.kr'])assert.equal(privateIpv4(ip),false);
  for(const host of ['www.stiz-dasan.kr','localhost.evil','0.0.0.0','[::]'])assert.throws(()=>sandboxOrigin(host));
});
test('Host·경로·절대 URL·역슬래시·인코딩 우회를 차단한다',()=>{
  assert.equal(requestTarget('/store-app','localhost:8453',[origin]).pathname,'/store-app');
  for(const url of ['https://www.stiz-dasan.kr/','//www.stiz-dasan.kr/','/../.env.local','/%2e%2e/.env','/%252e%252e/.env','/foo\\bar','/%2f%2fstiz','/a\nb','/%zz'])assert.equal(requestTarget(url,'localhost:8453',[origin]),null,url);
  for(const host of ['www.stiz-dasan.kr','localhost:8454','evil.local:8453','localhost:8453@evil'])assert.equal(requestTarget('/store-app',host,[origin]),null);
});
test('네 역할 페이지는 실제 UI 번들을 제공하되 인증 성공으로 표시하지 않는다',async()=>{
  const app=instance();for(const url of ROLE_PATHS){const response=await send(app,{url});assert.equal(response.status,200,url);assert.match(response.body,/격리 시험 · 합성 자료/);assert.match(response.body,/운영 연결·발송·결제·위치 수집 없음/);assert.doesNotMatch(response.body,/location\.replace|http-equiv="refresh"/i)}
  assert.equal((await send(app)).json().database,false);
});
test('운영·발송·결제·위치·인증·DB 경로는 메서드와 무관하게 기본 거부한다',async()=>{
  const app=instance();
  const paths=['/api/payments/confirm','/api/payments/toss/confirm','/api/admin/sms','/api/push','/api/staff/transcribe','/api/shuttle/location','/api/driver/mobile/session','/auth/callback','/api/account/child-links','/api/admin/site-ops-bot','/api/unknown','/.env.local','/server.key','/ready.json'];
  for(const url of paths)for(const method of ['POST','PUT','DELETE','OPTIONS','CONNECT']){const response=await send(app,{url,method,headers:originHeaders,body:Buffer.from('{"operation":"send"}')});assert.equal(response.status,403,method+' '+url);assert.equal(response.headers.location,undefined);}
  assert.equal((await send(app,{url:'/__sandbox/counters'})).json().uploadCount,0);
});
test('합성 조회는 최소 자료만 반환하고 숨은 운영 조회는 없다',async()=>{
  const app=instance();const dashboard=(await send(app,{url:'/api/admin/dashboard'})).json();assert.equal(dashboard.stats.studentCount,1);assert.match(dashboard.todayClasses[0].name,/합성/);
  assert.deepEqual((await send(app,{url:'/api/account/child-links'})).json(),{enabled:false,verified:false,outgoing:[],incoming:[],synthetic:true});
  assert.deepEqual((await send(app,{url:'/api/staff/sessions/sandbox-session/photos'})).json(),{photos:[],synthetic:true});
});

test('원생 검색과 학생 연락·청구 창은 합성 자료를 쓰고 전화번호는 없다',async()=>{
  const data=sandboxFixtures();
  assert.equal(data.adminStudents.students.length,1);
  assert.equal(data.adminStudents.students[0].currentStatus,'ACTIVE');
  assert.equal(data.adminStudents.students[0].parent.phone,null);
  assert.equal(data.people[0].billing.unpaidAmount,120000);
  assert.equal(data.people[0].guardians[0].phone,null);
  const app=instance();const response=await send(app,{url:'/api/admin/students'});
  assert.equal(response.status,200);assert.equal(response.json().synthetic,true);
  for(const url of ['/api/admin/students','/api/admin/students/sandbox-student','/api/mypage/enrollment-change']){
    for(const method of ['POST','PATCH','DELETE'])assert.equal((await send(app,{url,method,headers:originHeaders})).status,403);
  }
});

test('기존 신청 취소 시나리오는 고정 합성 요청이며 저장 경로를 열지 않는다',()=>{
  const normal=sandboxFixtures();const pending=sandboxFixtures(new Date('2026-10-28T00:00:00Z'),{pendingChange:true});
  assert.equal(normal.change.initial.children[0].pending,null);
  assert.equal(pending.change.initial.children[0].pending.id,'sandbox-change');
  assert.equal(pending.change.initial.children[0].pending.kind,'CLASS_CHANGE');
  assert.equal(routeDecision('POST','/api/mypage/enrollment-change'),'deny');
});

test('합성 PNG만 내려받을 수 있고 파일 선택 수신도 비저장으로 유지한다',async()=>{
  const app=instance();const sample=await send(app,{url:'/__sandbox/sample.png'});
  assert.equal(sample.status,200);assert.equal(sample.headers['content-type'],'image/png');
  assert.equal(sample.headers['content-disposition'],'attachment; filename="stiz-synthetic-sample.png"');
  assert.deepEqual([...sample.bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  assert.equal(sample.bytes.readUInt32BE(16),32);assert.equal(sample.bytes.readUInt32BE(20),32);
  const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;};
  const compressed=[];for(let at=8;at<sample.bytes.length;){const length=sample.bytes.readUInt32BE(at);const body=sample.bytes.subarray(at+4,at+8+length);assert.equal(crc32(body),sample.bytes.readUInt32BE(at+8+length));if(body.toString('ascii',0,4)==='IDAT')compressed.push(body.subarray(4));at+=length+12;}
  assert.equal(inflateSync(Buffer.concat(compressed)).length,(32*4+1)*32);
  const upload=await multipart('image/png',sample.bytes);
  const result=await send(app,{method:'POST',url:'/__sandbox/upload',headers:{...originHeaders,'content-type':upload.type},body:upload.body});
  assert.equal(result.status,200);assert.equal(result.json().stored,false);
  assert.equal(result.json().bytes,sample.bytes.length);
  assert.equal((await send(app,{url:'/__sandbox/counters'})).json().storedFileBytes,0);
  assert.equal((await send(app,{url:'/__sandbox/sample-private.png'})).status,403);
});
async function multipart(fileType='image/png',content=Buffer.from([137,80,78,71,13,10,26,10,0])){
  const form=new FormData();form.append('file',new Blob([content],{type:fileType}),'synthetic-file');
  const req=new Request(origin+'/__sandbox/upload',{method:'POST',body:form});return{body:Buffer.from(await req.arrayBuffer()),type:req.headers.get('content-type')};
}
test('첨부는 같은 origin의 한 파일만 메모리 수신하고 내용·이름을 저장하지 않는다',async()=>{
  const app=instance();const upload=await multipart();const response=await send(app,{method:'POST',url:'/__sandbox/upload',headers:{...originHeaders,'content-type':upload.type},body:upload.body});
  assert.equal(response.status,200);assert.equal(response.json().bytes,9);assert.equal(response.json().stored,false);assert.equal(response.json().url,'/stiz-logo.png');assert.equal(response.json().sha256.length,64);assert.doesNotMatch(response.body,/synthetic-file/);
  assert.deepEqual((await send(app,{url:'/__sandbox/counters'})).json(),{page:0,denied:0,uploadCount:1,uploadBytes:9,storedFileBytes:0,storedLocationPoints:0});
  assert.deepEqual((await send(app,{url:'/api/staff/sessions/sandbox-session/photos'})).json().photos,[]);
});
test('외부·누락 Origin 및 프록시 헤더는 합성 업로드도 차단한다',async()=>{
  const app=instance(),upload=await multipart();for(const headers of [{},{origin:'https://www.stiz-dasan.kr'},{origin,'sec-fetch-site':'cross-site'},{origin,'x-forwarded-host':'www.stiz-dasan.kr'}]){
    const response=await send(app,{method:'POST',url:'/__sandbox/upload',headers:{'content-type':upload.type,...headers},body:upload.body});assert.equal(response.status,403);
  }assert.equal(app.counters.uploadCount,0);
});
test('MIME 위장·허용하지 않은 형식·큰 본문을 거부한다',async()=>{
  const app=instance();for(const[type,bytes]of [['image/png',Buffer.from('not image')],['text/html',Buffer.from('<script>')],['application/json',Buffer.from('{bad')]]){
    const upload=await multipart(type,bytes);assert.equal((await send(app,{method:'POST',url:'/__sandbox/upload',headers:{...originHeaders,'content-type':upload.type},body:upload.body})).status,415);
  }
  const upload=await multipart();assert.equal((await send(app,{method:'POST',url:'/__sandbox/upload',headers:{...originHeaders,'content-type':upload.type,'content-length':String(BODY_LIMIT+1)},body:upload.body})).status,413);
  assert.equal(app.counters.uploadCount,0);
});
test('HEIC는 형식 머리글을 확인해 raw 수신만 시험하고 수업사진 변환 완료로 취급하지 않는다',async()=>{
  const app=instance();const heic=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypheic'),Buffer.alloc(4),Buffer.from('mif1')]);
  const upload=await multipart('image/heic',heic);
  const options={method:'POST',headers:{...originHeaders,'content-type':upload.type},body:upload.body};
  const response=await send(app,{...options,url:'/__sandbox/upload'});assert.equal(response.status,200);assert.equal(response.json().type,'image/heic');assert.equal(response.json().stored,false);
  assert.equal((await send(app,{...options,url:'/api/staff/sessions/sandbox-session/photos'})).status,415);
  const bad=await multipart('image/heic',Buffer.from('not-heic'));
  assert.equal((await send(app,{method:'POST',url:'/__sandbox/upload',headers:{...originHeaders,'content-type':bad.type},body:bad.body})).status,415);
});
test('실제 형식에 맞춘 로컬 TTF·WOFF2 MIME을 제공한다',async()=>{
  const app=createSandboxHandler({origins:[origin],assets:{'/material.ttf':Buffer.from([0,1,0,0]),'/material.woff2':Buffer.from('wOF2')}});
  assert.equal((await send(app,{url:'/material.ttf'})).headers['content-type'],'font/ttf');
  assert.equal((await send(app,{url:'/material.woff2'})).headers['content-type'],'font/woff2');
});
test('CSP·권한·브라우저 가드와 서버 정책으로 외부 전송·이동을 제한한다',async()=>{
  const response=await send(instance());for(const[key,value]of Object.entries(SANDBOX_HEADERS))assert.equal(response.headers[key.toLowerCase()],value);
  assert.match(response.headers['content-security-policy'],/connect-src 'self'/);assert.match(response.headers['content-security-policy'],/form-action 'none'/);assert.match(response.headers['permissions-policy'],/geolocation=\(\).*microphone=\(\).*payment=\(\)/);
  assert.match(browserGuard,/SANDBOX_EXTERNAL_BLOCKED/);assert.match(browserGuard,/window\.open/);assert.match(browserGuard,/serviceWorker\.register/);
  assert.equal(routeDecision('POST','/api/shuttle/regular-boarding'),'deny');
});
test('서버는 환경·운영 DB·기존 인증 파일을 로드하거나 운영 HTTP를 중계하지 않는다',async()=>{
  const server=await readFile(new URL('../scripts/native-device-sandbox.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(server,/dotenv|PrismaClient|from ['"]pg['"]|httpsRequest|httpRequest|\.env\.local|AuthKey_/);
  const builder=await readFile(new URL('../scripts/lib/native-device-sandbox-build.mjs',import.meta.url),'utf8');
  assert.match(builder,/SandboxBoundary/);assert.match(builder,/서버·운영 모듈/);assert.match(builder,/useGpsShare/);assert.match(builder,/마이크·음성 전송 차단/);
});
