import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(file,deps={}) {
  const exports={};const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('require','exports','process','Buffer',js)(name=>name in deps?deps[name]:name.startsWith('node:')?require(name):(()=>{throw Error(`Unexpected dependency ${name}`)})(),exports,process,Buffer);return exports;
}
const policy=load('src/lib/native-auth/policy.ts');
const {createNativeAuthService}=load('src/lib/native-auth/service.ts',{'./policy':policy});
const env={NODE_ENV:'development',NATIVE_AUTH_ENABLED:'true',NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED:'true',NATIVE_AUTH_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64url')};
const config=policy.nativeConfig(env);
const verifier='V'.repeat(43),state='S'.repeat(43),session={access_token:'synthetic-access',refresh_token:'synthetic-refresh',authUserId:'synthetic-auth'};
function harness() {
  let clock=new Date('2026-10-28T00:00:00Z');const rows=new Map();
  const store={async create(row){rows.set(row.id,{...row})},async read(id){return rows.get(id)??null},
    async bindBrowser(id,hash,now){const row=rows.get(id);if(!row||row.status!=='CREATED'||row.expiresAt<=now)return false;Object.assign(row,{status:'BROWSER',browserHash:hash});return true},
    async ready(id,browserHash,codeHash,codeExpiresAt,sealedSession,now){const r=rows.get(id);if(!r||r.status!=='BROWSER'||r.browserHash!==browserHash||r.expiresAt<=now)return false;Object.assign(r,{status:'READY',codeHash,codeExpiresAt,sealedSession});return true},
    async consume(id,challenge,state,codeHash,now){const r=rows.get(id);if(!r||r.status!=='READY'||r.challenge!==challenge||r.state!==state||r.codeHash!==codeHash||r.expiresAt<=now||r.codeExpiresAt<=now)return null;const claimed={...r};Object.assign(r,{status:'CONSUMED',codeHash:null,sealedSession:null});return claimed},
    async cancel(id,challenge,state,now){const r=rows.get(id);if(!r||!['CREATED','BROWSER','READY'].includes(r.status)||r.challenge!==challenge||r.state!==state||r.expiresAt<=now)return false;Object.assign(r,{status:'CANCELLED',codeHash:null,sealedSession:null});return true}};
  const service=createNativeAuthService(store,config,()=>clock);
  return {service,rows,advance(ms){clock=new Date(clock.getTime()+ms)}};
}
async function ready(h,platform='ios') {const started=await h.service.start({platform,provider:'google',codeChallenge:policy.digest(verifier),state});const browser=await h.service.beginBrowser(started.flowId);const row=await h.service.browserFlow(started.flowId,browser.binding);const callback=new URL(await h.service.finishBrowser(row,browser.binding,session));return {...started,browser,callback,proof:{flowId:started.flowId,codeVerifier:verifier,state,code:callback.searchParams.get('code')}};}

test('네이티브 인증은 기본 비활성이고 운영에서 개발 scheme을 활성화할 수 없다',()=>{
  for(const change of [{},{...env,NATIVE_AUTH_ENABLED:'false'},{...env,NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED:'false'},{...env,NODE_ENV:'production'},{...env,NATIVE_AUTH_ENCRYPTION_KEY:'bad'}])assert.throws(()=>policy.nativeConfig(change));
  assert.equal(config.callback('ios'),'stiz-academy-dev://auth/return');assert.equal(config.callback('android'),'stiz-academy-android-dev://auth/return');
});
test('start는 고정 브라우저 주소·5분 만료만 발급하고 redirect·가입·연결 우회는 거부한다',async()=>{
  const h=harness();const input={platform:'ios',provider:'google',codeChallenge:policy.digest(verifier),state};
  for(const extra of [{intent:'link'},{intent:'parent-signup'},{redirect:'https://attacker.invalid'},{next:'/admin'},{callback:'evil://return'},{enrollmentHandoff:'synthetic'}])await assert.rejects(h.service.start({...input,...extra}));
  const r=await h.service.start(input);assert.match(r.browserUrl,/^https:\/\/www\.stiz-dasan\.kr\/auth\/native\/browser\?flow=[A-Za-z0-9_-]{43}$/);assert.equal(r.expiresAt,'2026-10-28T00:05:00.000Z');
});
test('플랫폼·제공자·S256 challenge·충분한 state를 검증한다',()=>{
  const base={platform:'ios',provider:'google',codeChallenge:policy.digest(verifier),state};
  for(const change of [{platform:'web'},{provider:'attacker'},{codeChallenge:'x'},{state:'short'},{state:'a'.repeat(129)},{codeChallenge:'?'.repeat(43)}])assert.throws(()=>policy.parseStart({...base,...change}));
});
test('브라우저 바인딩은 최초 한 번만 가능하고 다른 브라우저·다른 flow는 거절한다',async()=>{
  const h=harness();const r=await h.service.start({platform:'ios',provider:'google',codeChallenge:policy.digest(verifier),state});const b=await h.service.beginBrowser(r.flowId);
  await assert.rejects(h.service.beginBrowser(r.flowId));await assert.rejects(h.service.browserFlow(r.flowId,'X'.repeat(43)));await assert.rejects(h.service.browserFlow('X'.repeat(43),b.binding));
  assert.equal((await h.service.browserFlow(r.flowId,b.binding)).provider,'google');
});
test('반환 URL은 플랫폼별 고정 scheme과 flow/code/state만 포함하며 세션을 노출하지 않는다',async()=>{
  for(const platform of ['ios','android']){const h=harness(),r=await ready(h,platform);assert.equal(r.callback.protocol,platform==='ios'?'stiz-academy-dev:':'stiz-academy-android-dev:');assert.deepEqual([...r.callback.searchParams.keys()],['flow','code','state']);assert.doesNotMatch(r.callback.toString(),/synthetic|access_token|refresh_token|authUserId/);assert.doesNotMatch(h.rows.get(r.flowId).sealedSession,/synthetic/);}
});
test('정확한 verifier·state·code·flow만 소비하며 오답이 정상 요청을 먼저 태우지 않는다',async()=>{
  const h=harness(),r=await ready(h);
  for(const change of [{codeVerifier:'X'.repeat(43)},{state:'X'.repeat(43)},{code:'X'.repeat(43)},{flowId:'X'.repeat(43)},{codeVerifier:'short'}])await assert.rejects(h.service.consume({...r.proof,...change}));
  assert.deepEqual(await h.service.consume(r.proof),session);assert.equal(h.rows.get(r.flowId).sealedSession,null);assert.equal(h.rows.get(r.flowId).codeHash,null);await assert.rejects(h.service.consume(r.proof));
});
test('동시에 같은 코드를 소비하면 정확히 한 건만 성공한다',async()=>{
  const h=harness(),r=await ready(h);const outcomes=await Promise.allSettled(Array.from({length:12},()=>h.service.consume(r.proof)));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
});
test('발급 후 60초 또는 flow 5분 만료를 경계값까지 거부한다',async()=>{
  const h=harness(),r=await ready(h);h.advance(60_000);await assert.rejects(h.service.consume(r.proof));
  const h2=harness(),s=await h2.service.start({platform:'ios',provider:'google',codeChallenge:policy.digest(verifier),state});h2.advance(300_000);await assert.rejects(h2.service.beginBrowser(s.flowId));
});
test('취소는 소유 증명이 필요하며 완료·취소 후 재소비와 재완료를 거절한다',async()=>{
  const h=harness(),r=await ready(h);await assert.rejects(h.service.cancel({...r.proof,codeVerifier:'X'.repeat(43)}));await h.service.cancel(r.proof);assert.equal(h.rows.get(r.flowId).sealedSession,null);await assert.rejects(h.service.consume(r.proof));await assert.rejects(h.service.finishBrowser(r.browser.row,r.browser.binding,session));await assert.rejects(h.service.cancel(r.proof));
});
test('암호문은 flow·키·내용에 묶여 다른 요청과 바꾸거나 변조할 수 없다',()=>{
  const sealed=policy.sealSession(session,'flow-A',config.encryptionKey);assert.deepEqual(policy.openSession(sealed,'flow-A',config.encryptionKey),session);
  for(const args of [[sealed,'flow-B',config.encryptionKey],[sealed,'flow-A',Buffer.alloc(32,8)],[sealed.slice(0,-6)+'XXXXXX','flow-A',config.encryptionKey]])assert.throws(()=>policy.openSession(...args));
});
test('학원 계정은 직접 Auth 연결·활성·탈퇴 미접수·검증된 부모만 인정한다',async()=>{
  let rows=[];let sql='';const store=load('src/lib/native-auth/store.ts',{'server-only':{},'@/lib/prisma':{prisma:{$queryRawUnsafe:async(q,...args)=>{sql=q;assert.equal(args[0],'auth');return rows}}}});
  for(const value of [[],[{role:'PARENT',username:'member',phoneVerifiedAt:null}],[{role:'UNKNOWN'}],[{role:'ADMIN'},{role:'ADMIN'}]]){rows=value;assert.equal(await store.requireNativeAccount('auth'),false)}
  for(const role of ['ADMIN','VICE_ADMIN','INSTRUCTOR','DRIVER']){rows=[{role}];assert.equal(await store.requireNativeAccount('auth'),true)}
  rows=[{role:'PARENT',username:null,phoneVerifiedAt:null}];assert.equal(await store.requireNativeAccount('auth'),true);
  assert.match(sql,/"withdrawnAt" IS NULL AND "withdrawRequestedAt" IS NULL/);assert.doesNotMatch(sql,/email|phone\s*=|metadata/);
});
test('새 SQL은 공개 권한을 회수하고 RLS를 활성화한다',()=>{
  const sql=fs.readFileSync('src/lib/native-auth/schema.sql','utf8');assert.match(sql,/ENABLE ROW LEVEL SECURITY/);for(const role of ['PUBLIC','anon','authenticated'])assert.match(sql,new RegExp('REVOKE ALL ON "NativeAuthFlow" FROM '+role));assert.doesNotMatch(sql,/SECURITY DEFINER|CREATE POLICY/);
});

const next=require('next/server');
function httpHarness() {
  const h=harness();const cookies=[];let accessUser='synthetic-auth',existingUser=null,existingError=null,allowed=true;
  const server={createServerClient:(_url,_key,options)=>({auth:{
    async getUser(token){return token?{data:{user:accessUser?{id:accessUser}:null},error:null}:{data:{user:existingUser?{id:existingUser}:null},error:existingError}},
    async setSession(){options.cookies.setAll([{name:'sb-synthetic-auth-token',value:'synthetic-cookie',options:{path:'/',domain:'.stiz-dasan.kr',maxAge:400*24*60*60}}]);return{data:{user:{id:accessUser}},error:null}},
  }})};
  const http=load('src/lib/native-auth/http.ts',{'server-only':{},'@supabase/ssr':server,'next/server':next,'./policy':{...policy,nativeConfig:()=>config},'./service':{createNativeAuthService:()=>h.service},'./store':{postgresNativeFlowStore:{}}});
  const consume=load('src/app/auth/native/consume/route.ts',{'@supabase/ssr':server,'next/server':next,'@/lib/native-auth/policy':policy,'@/lib/native-auth/http':http,'@/lib/native-auth/store':{requireNativeAccount:async()=>allowed},'@/lib/native-session-cookies':load('src/lib/native-session-cookies.ts')});
  return {h,http,consume,cookies,setExisting(id,error=null){existingUser=id;existingError=error},setAllowed(value){allowed=value},setAccess(value){accessUser=value}};
}
test('정확한 OAuth GET callback만 교차 사이트 복귀를 허용하고 POST 우회는 거부한다',()=>{
  const {http}=httpHarness();const request=(path,method='GET')=>new next.NextRequest('https://www.stiz-dasan.kr'+path,{method,headers:{'sec-fetch-site':'cross-site',origin:'https://synthetic.supabase.co'}});
  assert.doesNotThrow(()=>http.nativeContext(request('/auth/native/callback'),true));
  for(const [path,method,flag]of [['/auth/native/consume','POST',true],['/auth/native/start','POST',false],['/auth/native/browser','GET',true],['/auth/native/callback','POST',true]])assert.throws(()=>http.nativeContext(request(path,method),flag));
  assert.throws(()=>http.nativeContext(new next.NextRequest('https://attacker.invalid/auth/native/callback'),true));
});
test('네이티브 POST 본문은 형식·크기·중복 필드를 검증한다',async()=>{
  const {http}=httpHarness();const request=(body,type)=>new next.NextRequest('https://www.stiz-dasan.kr/auth/native/consume',{method:'POST',headers:{'content-type':type},body});
  assert.deepEqual(await http.nativeBody(request('code=a&state=b','application/x-www-form-urlencoded')),{code:'a',state:'b'});
  for(const [body,type]of [['a=1&a=2','application/x-www-form-urlencoded'],['[]','application/json'],['{bad','application/json'],['x','text/plain'],['X'.repeat(4097),'application/json']])await assert.rejects(http.nativeBody(request(body,type)));
});
test('소비 HTTP는 토큰을 노출하지 않고 HttpOnly 세션·표식과 303 역할 분기를 반환한다',async()=>{
  const original=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://synthetic.supabase.co';
  try{const f=httpHarness(),r=await ready(f.h);const request=new next.NextRequest('https://www.stiz-dasan.kr/auth/native/consume',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(r.proof)});const result=await f.consume.POST(request);assert.equal(result.status,303);assert.equal(result.headers.get('location'),'https://www.stiz-dasan.kr/auth/continue');assert.equal(result.headers.get('cache-control'),'no-store, private');const cookie=result.cookies.get('sb-synthetic-auth-token');assert.equal(cookie.httpOnly,true);assert.equal(cookie.secure,true);assert.equal(result.cookies.get('__Host-stiz-native-session').value,'1');assert.doesNotMatch(await result.text(),/synthetic-access|synthetic-refresh/);}finally{if(original===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=original;}
});
test('기존 앱의 다른 계정·유효성 불명확 쿠키·탈퇴 계정은 새 로그인으로 교체하지 않는다',async()=>{
  const original=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://synthetic.supabase.co';
  try{for(const mode of ['other-account','invalid-cookie','withdrawn','identity-mismatch']){const f=httpHarness(),r=await ready(f.h);let cookie='';if(mode==='other-account')f.setExisting('another-auth');if(mode==='invalid-cookie'){f.setExisting(null,{message:'expired'});cookie='sb-synthetic-auth-token=stale'}if(mode==='withdrawn')f.setAllowed(false);if(mode==='identity-mismatch')f.setAccess('different-auth');const result=await f.consume.POST(new next.NextRequest('https://www.stiz-dasan.kr/auth/native/consume',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(r.proof)}));assert.equal(result.status,403,mode);assert.equal(result.cookies.get('sb-synthetic-auth-token'),undefined);assert.doesNotMatch(await result.text(),/synthetic-access|synthetic-refresh/);}}finally{if(original===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=original;}
});

test('실제 browser/callback 라우트는 flow별 PKCE 쿠키를 분리하고 정상 교차 사이트 복귀를 완료한다',async()=>{
  const saved=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://synthetic.supabase.co';
  try {
    const h=harness();let oauthOptions;let cookieNamespace;let exchangeCalls=0;
    const server={createServerClient:(_url,_key,options)=>{cookieNamespace=options.cookieOptions.name;return {auth:{
      async signInWithOAuth(input){oauthOptions=input;options.cookies.setAll([{name:`${options.cookieOptions.name}-code-verifier`,value:'synthetic-pkce',options:{maxAge:400*24*60*60}}]);return {data:{url:'https://synthetic.supabase.co/auth/v1/authorize?provider=google'},error:null}},
      async exchangeCodeForSession(code){exchangeCalls++;assert.equal(code,'synthetic-oauth-code');assert.ok(options.cookies.getAll().some(c=>c.name===`${options.cookieOptions.name}-code-verifier`));return {data:{session:{...session,user:{id:session.authUserId}}},error:null}},
      async getUser(){return {data:{user:{id:session.authUserId}},error:null}},
    }}}};
    const http=load('src/lib/native-auth/http.ts',{'server-only':{},'@supabase/ssr':server,'next/server':next,'./policy':{...policy,nativeConfig:()=>config},'./service':{createNativeAuthService:()=>h.service},'./store':{postgresNativeFlowStore:{}}});
    const deps={'next/server':next,'@/lib/native-auth/policy':policy,'@/lib/native-auth/http':http};
    const browser=load('src/app/auth/native/browser/route.ts',{...deps,'@/lib/auth-providers':{getEnabledParentOAuthProviders:async()=>['google']},'@/lib/parent-oauth':{toSupabaseProvider:p=>p}});
    const callback=load('src/app/auth/native/callback/route.ts',{...deps,'@/lib/native-auth/store':{requireNativeAccount:async()=>true}});
    const flow=await h.service.start({platform:'ios',provider:'google',codeChallenge:policy.digest(verifier),state});
    const result=await browser.GET(new next.NextRequest(flow.browserUrl));assert.equal(result.status,307);assert.equal(cookieNamespace,`stiz-native-oauth-${flow.flowId}`);assert.equal(oauthOptions.options.skipBrowserRedirect,true);assert.equal(oauthOptions.provider,'google');
    const pkce=result.cookies.get(`${cookieNamespace}-code-verifier`);assert.equal(pkce.httpOnly,true);assert.equal(pkce.secure,true);assert.equal(pkce.maxAge,300);
    const expectedCallback=new URL(oauthOptions.options.redirectTo);assert.equal(expectedCallback.pathname,'/auth/native/callback');expectedCallback.searchParams.set('code','synthetic-oauth-code');
    const cookies=result.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
    const finished=await callback.GET(new next.NextRequest(expectedCallback,{headers:{cookie:cookies,'sec-fetch-site':'cross-site'}}));assert.equal(finished.status,307);assert.equal(exchangeCalls,1);const returned=new URL(finished.headers.get('location'));assert.equal(returned.protocol,'stiz-academy-dev:');assert.equal(returned.searchParams.get('state'),state);assert.equal(finished.cookies.get(`${cookieNamespace}-code-verifier`).maxAge,0);assert.equal(finished.headers.get('referrer-policy'),'no-referrer');
    assert.deepEqual(await h.service.consume({flowId:flow.flowId,codeVerifier:verifier,state,code:returned.searchParams.get('code')}),session);
  }finally{if(saved===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=saved;}
});

test('브라우저 임시 쿠키 정리는 해당 flow의 session·code-verifier와 chunk만 지운다',()=>{
  const {http}=httpHarness();const id='F'.repeat(43),prefix=`stiz-native-oauth-${id}`;const others=`stiz-native-oauth-${'G'.repeat(43)}-code-verifier`;
  const request=new next.NextRequest('https://www.stiz-dasan.kr/auth/native/callback',{headers:{cookie:[prefix,`${prefix}.0`,`${prefix}-code-verifier`,`${prefix}-code-verifier.0`,others,'sb-web-auth-token'].map(name=>`${name}=synthetic`).join('; ')}});
  const response=http.clearNativeBrowserCookies(request,new next.NextResponse(null),id);
  for(const name of [prefix,`${prefix}.0`,`${prefix}-code-verifier`,`${prefix}-code-verifier.0`])assert.equal(response.cookies.get(name).maxAge,0);
  assert.equal(response.cookies.get(others),undefined);assert.equal(response.cookies.get('sb-web-auth-token'),undefined);
});
