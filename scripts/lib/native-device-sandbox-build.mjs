import { mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url);

export async function buildSandbox(root, output) {
  const aliases = {};
  const files = {
    'entry.js': `import React from 'react';import{createRoot}from'react-dom/client';import Shell from'@/app/admin/AdminShellClient';import Dashboard from'@/app/admin/AdminDashboardClient';import Home from'@/app/staff/StaffHomeClient';import Session from'@/app/staff/sessions/[sessionId]/SessionInProgressClient';import Parent from'@/app/mypage/MyPageClient';import Change from'@/app/mypage/enrollment-change/EnrollmentChangeClient';import Driver from'@/components/shuttle/UnifiedDriverClient';import Theme from'@/components/academy/AcademyTheme';import{sandboxFixtures}from'@sandbox-fixtures';
const f=sandboxFixtures();const p=location.pathname;const h=React.createElement;document.documentElement.classList.add('material-symbols-ready');const views=[{key:'admin',label:'관리자',href:'/admin'},{key:'teacher',label:'선생님',href:'/staff'},{key:'parent',label:'학부모',href:'/mypage'}];
function Media(){const[result,setResult]=React.useState('합성 수신: 파일 내용은 보관하지 않습니다.');async function selected(event){const files=Array.from(event.target.files||[]);setResult(files.length+'개 선택');for(const file of files){const form=new FormData();form.append('file',file);const r=await fetch('/__sandbox/upload',{method:'POST',body:form});const data=await r.json();setResult(r.ok?'합성 수신 확인: '+data.bytes+' bytes / '+data.type:'수신 차단: '+data.error);}event.target.value='';}return h('section',{className:'sandbox-media'},h('h1',null,'앱 파일 선택 시험'),h('p',null,'개인 사진 대신 시험용 이미지를 사용하세요. 운영 저장·발송은 없습니다.'),h('label',null,'사진 선택 ',h('input',{type:'file',accept:'image/jpeg,image/png,image/webp,image/heic',multiple:true,onChange:selected})),h('label',null,'촬영 ',h('input',{type:'file',accept:'image/*',capture:'environment',onChange:selected})),h('label',null,'문서 선택 ',h('input',{type:'file',accept:'.json,.csv,.pdf,.xlsx',multiple:true,onChange:selected})),h('p',{role:'status'},result));}
let view;if(p==='/store-app')view=h('section',{className:'sandbox-media'},h('h1',null,'STIZ 격리 시험'),h('p',null,'합성 화면입니다. 실제 로그인·권한·DB·발송·결제는 검증하지 않습니다.'),...['admin','teacher','parent','driver'].map((role,i)=>h('p',{key:role},h('a',{href:'/__entry/'+role},['관리자','선생님','학부모','기사님'][i]))),h('a',{href:'/__sandbox/media'},'사진·문서 선택 시험'));
else if(p==='/admin'||p==='/__entry/admin')view=h(Shell,{initialUserName:'합성 관리자',initialUserEmail:'',accountViews:views},h(Dashboard,{initialData:f.dashboard}));
else if(p==='/staff/sessions/sandbox-session')view=h(Theme,{role:'teacher'},h(Session,f.session));
else if(p==='/staff'||p==='/__entry/teacher')view=h(Theme,{role:'teacher'},h(Home,f.teacher));
else if(p==='/mypage/enrollment-change')view=h(Theme,{role:'parent'},h(Change,f.change));
else if(p==='/mypage'||p==='/__entry/parent')view=h(Theme,{role:'parent'},h(Parent,f.parent));
else if(p==='/__sandbox/media')view=h(Media);else view=h(Driver,f.driver);
createRoot(document.getElementById('root')).render(view);`,
    'loader.cjs': `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(source){return ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;};`,
    'css-loader.cjs': `module.exports=function(source){const names=[...source.matchAll(/\\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match=>match[1]);return 'export default '+JSON.stringify(Object.fromEntries(names.map(name=>[name,name])))+';';};`,
    'navigation.js': `const allowed=new Set(['/store-app','/admin','/staff','/staff/sessions/sandbox-session','/mypage','/mypage/enrollment-change','/driver/sandbox-only','/__sandbox/media']);function go(url){const u=new URL(url,location.href);if(u.origin!==location.origin||!allowed.has(u.pathname)||u.search)throw new Error('격리 시험에서 지원하지 않는 이동입니다.');location.assign(u.pathname);}export function useRouter(){return{push:go,replace:go,back(){location.assign('/store-app')},refresh(){location.reload()}};}export function usePathname(){return location.pathname.startsWith('/__entry/')?({admin:'/admin',teacher:'/staff',parent:'/mypage',driver:'/driver/sandbox-only'}[location.pathname.split('/').pop()]||'/store-app'):location.pathname;}export function useSearchParams(){return new URLSearchParams(location.search);}`,
    'link.js': `import{createElement}from'react';export default function Link({children,prefetch,replace,scroll,...props}){return createElement('a',props,children);}`,
    'image.js': `import{createElement}from'react';export default function Image({src,priority,fill,unoptimized,...props}){return createElement('img',{...props,src:src==='/stiz-logo.png'?src:'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='});}`,
    'dynamic.js': `export default function dynamic(){return function NotIncluded(){return null;}}`,
    'voice.js': `import{createElement}from'react';export function VoiceToTextButton(){return createElement('span',{className:'text-xs'},'격리 시험: 마이크·음성 전송 차단');}`,
    'gps.js': `import{useState}from'react';export function useGpsShare(){const[state,setState]=useState('off');return{state,transmission:'idle',lastSentAt:null,accuracy:null,mode:'web',nativeRunning:false,nativeMessage:'합성 운행(위치 수집 없음)',start(){setState('denied')},async stop(){setState('off');return true;}};}`,
    'auth.js': `export async function logout(){location.assign('/store-app');}`,
    'staff-actions.js': ['savePlannedClassContent','startClassSession','cancelClassSession','completeClassSession','saveSessionMemo','saveStaffAttendance'].map(name=>`export async function ${name}(){return{ok:false,message:'격리 시험에서는 운영 저장·수업 종료를 하지 않습니다.'};}`).join('\n'),
    'notice-actions.js': ['createStaffClassNotice','getStaffClassNoticeStatus'].map(name=>`export async function ${name}(){return{ok:false,message:'격리 시험에서는 발송하지 않습니다.'};}`).join('\n'),
    'admin-actions.js': ['markNotificationRead','markAllNotificationsRead','createParentRequest'].map(name=>`export async function ${name}(){return{success:false,ok:false,error:'격리 시험에서는 요청·발송을 저장하지 않습니다.',message:'격리 시험 차단'};}`).join('\n'),
    'billing-actions.js': `import{sandboxFixtures}from'@sandbox-fixtures';export async function loadStaffSessionMonthlyFees(){const f=sandboxFixtures();return{month:f.today.slice(0,7),items:[f.summary]};}export async function loadStaffAttendanceBilling(){const f=sandboxFixtures();return{month:f.today.slice(0,7),summary:f.summary,items:[]};}export async function loadStaffClassBilling(){return{items:[]};}export async function requestStaffPaymentConfirmation(){return{ok:false,message:'격리 시험: 결제·납부 처리 차단'};}`,
    'people-actions.js': `export async function loadStaffClassPeople(){return{ok:false,message:'이 시험은 합성 명단만 사용합니다.'};}`,
  };
  const mocks = { 'next/navigation':'navigation.js','next/link':'link.js','next/image':'image.js','next/dynamic':'dynamic.js','@/components/staff/VoiceToTextButton':'voice.js','@/hooks/useGpsShare':'gps.js','@/app/actions/auth':'auth.js','@/app/actions/admin':'admin-actions.js','@/app/actions/staff-sessions':'staff-actions.js','@/app/actions/staff-notices':'notice-actions.js','@/app/actions/staff-billing':'billing-actions.js','@/app/actions/staff-class-people':'people-actions.js' };
  for (const [module, file] of Object.entries(mocks)) aliases[module+'$'] = path.join(output,file);
  aliases['@'] = path.join(root,'src');
  aliases['@sandbox-fixtures$'] = path.join(root,'scripts/lib/native-device-sandbox-fixtures.mjs');
  await mkdir(output,{recursive:true});
  for(const[name,text]of Object.entries(files))await writeFile(path.join(output,name),text,{flag:'wx'});
  const {webpack}=require('next/dist/compiled/webpack/webpack');
  let dependencies=[];
  const compiler=webpack({mode:'development',context:output,target:'web',devtool:false,cache:false,entry:path.join(output,'entry.js'),output:{path:output,filename:'bundle.js'},resolve:{extensions:['.tsx','.ts','.mjs','.js'],modules:[path.join(root,'node_modules')],alias:aliases},module:{rules:[{test:/\.tsx?$/,use:[path.join(output,'loader.cjs')]},{test:/\.css$/,use:[path.join(output,'css-loader.cjs')]}]},plugins:[{apply(current){current.hooks.compilation.tap('SandboxBoundary',compilation=>compilation.hooks.finishModules.tap('SandboxBoundary',modules=>{for(const module of modules){const resource=module.resource?.replaceAll('\\','/')||'';if(/\/src\/app\/actions\/|\/src\/lib\/(?:prisma|supabase|auth-guard|notification|staff-notifications)|\/node_modules\/(?:pg|@prisma|@supabase)\//.test(resource))throw new Error('격리 번들에 서버·운영 모듈이 포함되었습니다.');}}));}}]});
  try{await new Promise((resolve,reject)=>compiler.run((error,stats)=>{if(error||!stats||stats.hasErrors())return reject(new Error(stats?.toString({all:false,errors:true})||'격리 화면 컴파일 실패'));dependencies=[...stats.compilation.fileDependencies].filter(file=>file.startsWith(path.join(root,'src')+path.sep));resolve();}));}finally{await new Promise(resolve=>compiler.close(resolve));}
  const globals=await readFile(path.join(root,'src/app/globals.css'),'utf8');
  const cssInput=globals.replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./admin";\n@source "./staff";\n@source "./mypage";\n@source "../components";');
  const css=(await postcss([tailwind({base:root})]).process(cssInput,{from:path.join(root,'src/app/globals.css')})).css;
  const modules=(await Promise.all(dependencies.filter(file=>file.endsWith('.module.css')).map(file=>readFile(file,'utf8')))).join('\n').replace(/:global\(([^)]+)\)/g,'$1');
  // 이전 로컬 시각 검사에 보관된 공개 폰트만 복사한다. 외부 폰트 서버에 접속하지 않는다.
  const fontPath=path.join(root,'.tmp/staff-header/material-full.woff2');const fontInfo=await lstat(fontPath);
  if(fontInfo.isSymbolicLink()||!fontInfo.isFile()||fontInfo.size>8*1024*1024||(await realpath(fontPath)).toLowerCase()!==fontPath.toLowerCase())throw new Error('로컬 공개 아이콘 폰트 준비가 필요합니다. 외부 다운로드는 하지 않습니다.');
  const font=await readFile(fontPath);const isWoff2=font.toString('ascii',0,4)==='wOF2',isTtf=font.subarray(0,4).equals(Buffer.from([0,1,0,0]));if(!isWoff2&&!isTtf)throw new Error('로컬 공개 폰트 형식 오류');
  const fontName=isWoff2?'material.woff2':'material.ttf',fontFormat=isWoff2?'woff2':'truetype';
  await writeFile(path.join(output,fontName),font);
  await writeFile(path.join(output,'screen.css'),css+'\n'+await readFile(path.join(root,'src/app/academy-theme.css'),'utf8')+'\n'+modules+`\n@font-face{font-family:"Material Symbols Outlined";font-style:normal;font-weight:100 700;src:url("/${fontName}") format("${fontFormat}")} .material-symbols-outlined{font-family:"Material Symbols Outlined";font-weight:normal;font-style:normal;font-size:24px;line-height:1;display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;font-feature-settings:"liga";-webkit-font-smoothing:antialiased}body{margin:0;font-family:system-ui,sans-serif}#sandbox-banner{position:relative;z-index:9999;background:#fff3d1;color:#32281c;padding:8px 12px;font-size:14px}#sandbox-banner a{display:inline-block;margin:4px 8px;min-height:32px}#root{min-width:0}.sandbox-media{max-width:900px;margin:auto;padding:20px}.sandbox-media label{display:block;padding:12px 0}.sandbox-media input{max-width:100%}`);
  const sourceFiles=[...new Set([...dependencies,...['src/app/globals.css','src/app/academy-theme.css','scripts/native-device-sandbox.mjs','scripts/lib/native-device-sandbox-build.mjs','scripts/lib/native-device-sandbox-fixtures.mjs','scripts/lib/native-device-sandbox-policy.mjs'].map(file=>path.join(root,file)),fontPath])].sort();
  const sourceHashes={};for(const file of sourceFiles){const info=await lstat(file);if(info.isDirectory())continue;if(!info.isFile()||info.isSymbolicLink())throw new Error('시험 원본은 일반 파일만 허용합니다.');const actual=await realpath(file);if(!actual.toLowerCase().startsWith(root.toLowerCase()+path.sep))throw new Error('원본 경로 연결은 허용하지 않습니다.');sourceHashes[path.relative(root,file).replaceAll('\\','/')]=createHash('sha256').update(await readFile(file)).digest('hex');}
  await writeFile(path.join(output,'source-hashes.json'),JSON.stringify(sourceHashes,null,2));
  await writeFile(path.join(output,'stiz-logo.png'),await readFile(path.join(root,'public/stiz-logo.png')));
  const assetHashes={};for(const name of ['bundle.js','screen.css','stiz-logo.png',fontName])assetHashes[name]=createHash('sha256').update(await readFile(path.join(output,name))).digest('hex');
  return {fixtureVersion:1,fontName,sourceCount:Object.keys(sourceHashes).length,sourceHash:createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex'),assetHashes};
}
