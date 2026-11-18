import "server-only";
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { NATIVE_ORIGIN, NativeAuthError, nativeConfig, validFlow } from "./policy";
import { createNativeAuthService } from "./service";
import { postgresNativeFlowStore } from "./store";

export function nativeContext(request: NextRequest, browserCallback = false) {
  const config = nativeConfig();
  // 임의 Host를 복귀 주소나 쿠키 경계로 사용하지 않는다.
  if (request.nextUrl.origin !== config.origin) throw new NativeAuthError(403);
  const path = request.nextUrl.pathname;
  const callbackNavigation = browserCallback && request.method === "GET" && (path === "/auth/native/callback" || path === "/auth/native/browser" || path === "/auth/native/resume");
  // 공급자→callback의 최상위 GET은 정상적인 교차 사이트 이동이다. 그 경로만 PKCE·바인딩 쿠키로 검증한다.
  // /auth/native/browser 도 같다(2026-11-17 운영 사고): 앱이 연 크롬 맞춤 탭은 이 주소를 «Sec-Fetch-Site: cross-site»로
  // 열 수 있어, 1.0.5 앱의 구글·카카오 로그인이 첫 단계에서 403 맨글자(다크 모드에선 검은) 화면으로 막혔다.
  // 안전 근거: 이 단계는 «새로 만든(CREATED) 요청 하나»에 이 브라우저를 한 번만 묶고 공급자로 보낼 뿐이다.
  // 결과 1회용 code 는 그 기기의 앱 복귀 주소로만 가고, 교환(consume)에는 요청을 만든 앱 메모리의 PKCE 비밀값과
  // state 가 필요하다(consume·start·cancel 은 지금처럼 출처를 검사한다). 문자 속 링크로 열면 원래 «none»이라 이 검사가 막던 것도 없었다.
  // /auth/native/resume 도 같다: 간편로그인 연결을 마치고 오면 «공급자 → /auth/callback → resume» 로 이어진 이동이라
  // cross-site 로 표시된다. 이 단계는 바인딩 쿠키(요청을 연 브라우저) + 살려 둔 요청 번호 + 이 브라우저의 로그인으로 검증한다.
  if (!callbackNavigation && !trustedRequestSource(request, config.origin)) throw new NativeAuthError(403);
  return { config, service: createNativeAuthService(postgresNativeFlowStore,config) };
}
/**
 * 요청 출처 확인. Origin "null"(출처를 숨긴 요청 — 샌드박스 iframe·data: 문서 등에서도 나온다)을
 * 예전엔 무조건 통과시켜 위조 요청이 들어올 틈이 있었다.
 * 이제 "null"은 앱 껍데기가 직접 연 consume POST 이동(WebView.postUrl / WKWebView.load)만 인정한다.
 * 그 경우 브라우저가 Sec-Fetch-Site: none 을 붙이며, 이 헤더는 웹 페이지 스크립트가 바꿀 수 없다.
 * Origin 이 아예 없는 요청은 브라우저가 아닌 앱 네트워크 호출(start/cancel)이라 위조 요청 대상이 아니다.
 */
export function trustedRequestSource(request: NextRequest, expectedOrigin: string) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (origin === null || origin === expectedOrigin) return true;
  if (origin === "null") {
    return fetchSite === "none" && request.method === "POST" && request.nextUrl.pathname === "/auth/native/consume";
  }
  return false;
}
export const noStoreHeaders = { "Cache-Control":"no-store, private", "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff", "X-Frame-Options":"DENY" };
export function nativeError(error: unknown) {
  const known = error instanceof NativeAuthError;
  return NextResponse.json({error:known ? error.message : "로그인을 완료하지 못했습니다. 앱에서 다시 시도해 주세요."},{status:known?error.status:503,headers:noStoreHeaders});
}
/**
 * 시스템 브라우저(크롬 탭·사파리 인증창)에서 보이는 오류 — JSON 대신 읽을 수 있는 한 줄 안내.
 * 앱으로 돌려보낼 수 없는 단계(요청 확인 전)에서만 쓴다.
 */
export function nativeBrowserError(error: unknown) {
  const known = error instanceof NativeAuthError;
  const message = known ? error.message : "로그인을 완료하지 못했습니다. 앱에서 다시 시도해 주세요.";
  // 2026-11-17 긴급: 가입 전 학부모가 이 화면에서 막혀 «로그인 오류»로 신고했다 — 처음이면 가입부터 하라고 알려 준다(고정 문구·고정 주소).
  return new NextResponse(`${message}
이 창을 닫고 앱으로 돌아가 주세요.

처음이시면 먼저 회원가입이 필요합니다.
${NATIVE_ORIGIN}/signup/parent`, { status: known ? error.status : 503, headers: { ...noStoreHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}
export async function nativeBody(request: NextRequest) {
  if (Number(request.headers.get("content-length") || 0)>4096) throw new NativeAuthError(413);
  const reader=request.body?.getReader(); if(!reader) throw new NativeAuthError();
  const chunks:Uint8Array[]=[]; let length=0;
  while(true) { const {done,value}=await reader.read(); if(done)break; length+=value.length; if(length>4096){await reader.cancel();throw new NativeAuthError(413);} chunks.push(value); }
  const body=Buffer.concat(chunks).toString("utf8"); const type=request.headers.get("content-type")?.split(";")[0];
  try {
    const form=type==="application/x-www-form-urlencoded"?new URLSearchParams(body):null;
    if(form && [...form.keys()].some((key,index,keys)=>keys.indexOf(key)!==index))throw new NativeAuthError();
    const value=type==="application/json"?JSON.parse(body):form?Object.fromEntries(form):null;
    if(!value || typeof value!=="object" || Array.isArray(value))throw new NativeAuthError();
    return value as Record<string,unknown>;
  } catch { throw new NativeAuthError(); }
}
export function bindingCookie(flowId:string) { if(!validFlow(flowId))throw new NativeAuthError(); return `stiz-native-${flowId}`; }
export function nativeBrowserClient(request:NextRequest,flowId:string) {
  const pending:{name:string;value:string;options:Record<string,unknown>}[]=[];
  const client=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{
    // 브라우저의 기존 웹 로그인 쿠키와 flow별 PKCE verifier를 분리한다.
    cookieOptions:{name:`stiz-native-oauth-${flowId}`,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"},
    cookies:{getAll:()=>request.cookies.getAll(),setAll:items=>{for(const item of items)pending.push(item);}},
  });
  return {client,apply(response:NextResponse){for(const item of pending)response.cookies.set(item.name,item.value,{...item.options,httpOnly:true,secure:true,sameSite:"lax",path:"/auth/native",maxAge:Math.min(Number(item.options.maxAge??300),300)});return response;}};
}
/**
 * 가입 전 학부모용(2026-11-17 긴급·원장 지시 «연결된 계정이 없으면 바로 가입으로»).
 * 앱 간편로그인으로 방금 확인한 간편로그인 세션을 «이 브라우저의 웹 로그인»으로 옮겨 적어,
 * 가입 화면(/signup/parent?social=1)이 카카오·구글 로그인을 다시 시키지 않고 휴대폰 인증부터 이어 가게 한다.
 * 웹 간편가입(/auth/callback)이 끝난 직후와 같은 상태다 — 학원 계정과 연결되기 전이라 이 세션만으로는 아무 화면도 열리지 않는다.
 * 이 브라우저에 이미 웹 로그인이 있어도 방금 확인한 간편로그인으로 «바꿔 적는다»(2026-11-18 원장 지시).
 * 예전에는 덮어쓰지 않고 로그인 안 된 가입 화면으로 보냈는데, 그러면 «카카오로 계속»을 한 번 더 눌러야 했고
 * 앱 로그인 요청도 취소돼 가입 뒤 앱으로 돌아오지 못했다(가입하다 말고 다시 시도한 학부모·브라우저에 로그인해 둔 사람).
 * 바꿔 적는 사람은 방금 «이 브라우저에서» 간편로그인을 통과한 본인이다(바인딩 쿠키로 같은 브라우저임을 확인한 뒤에만 온다).
 * 옛 로그인 쿠키 조각(sb-…-auth-token·.0·.1…) 가운데 새로 적지 않는 것은 지운다 — 남으면 옛 로그인이 다시 읽힌다.
 */
export function webSignupSessionClient(request:NextRequest) {
  const stale=request.cookies.getAll().map(cookie=>cookie.name).filter(name=>/^sb-.+-auth-token(\.\d+)?$/.test(name));
  const pending:{name:string;value:string;options:Record<string,unknown>}[]=[];
  const client=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{
    // 기본 쿠키 이름·경로(웹 로그인과 같은 자리). 요청 쿠키는 읽지 않는다 — 새 세션만 적는다.
    cookies:{getAll:()=>[],setAll:items=>{for(const item of items)pending.push(item);}},
  });
  return {client,apply(response:NextResponse){
    for(const name of stale)if(!pending.some(item=>item.name===name))response.cookies.set(name,"",{maxAge:0,path:"/",secure:true,sameSite:"lax"});
    for(const item of pending)response.cookies.set(item.name,item.value,{...item.options,secure:true,sameSite:"lax",path:"/"});
    return response;
  }};
}
export function clearNativeBrowserCookies(request:NextRequest,response:NextResponse,flowId:string) {
  const prefix=`stiz-native-oauth-${flowId}`;
  const keys=[prefix,`${prefix}-code-verifier`];
  for(const cookie of request.cookies.getAll())if(keys.some(key=>cookie.name===key || cookie.name.startsWith(`${key}.`)))response.cookies.set(cookie.name,"",{maxAge:0,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"});
  response.cookies.set(bindingCookie(flowId),"",{maxAge:0,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"});
  return response;
}

/**
 * «가입·연결을 마치면 앱으로 돌아가 로그인까지» 표식(2026-11-17 원장 지시 — 연결이 끝나도 브라우저에 머물렀다).
 * 학원 계정이 없어 가입 화면으로 보낼 때 앱 로그인 요청(flow)을 취소하지 않고 살려 두고, 그 번호를 이 쿠키에 적는다.
 * 가입·연결이 끝나면 /auth/native/resume 이 이 쿠키 + 바인딩 쿠키(같은 브라우저 증명)로 요청을 마무리해 앱으로 돌려보낸다.
 * 값은 flow 번호뿐이다 — 바인딩 쿠키 없이는 쓸 수 없고, 5분 뒤 요청과 함께 만료된다.
 */
// 이름은 ./resume-cookie.ts 와 같아야 한다(웹 라우트는 그 순수 모듈에서 읽는다 — 테스트가 두 값을 대조한다).
export const NATIVE_RESUME_COOKIE = "stiz-native-resume";
export function setNativeResumeCookie(response:NextResponse,flowId:string) {
  if(!validFlow(flowId))throw new NativeAuthError();
  response.cookies.set(NATIVE_RESUME_COOKIE,flowId,{maxAge:300,path:"/",secure:true,httpOnly:true,sameSite:"lax"});
  return response;
}
export function clearNativeResumeCookie(response:NextResponse) {
  response.cookies.set(NATIVE_RESUME_COOKIE,"",{maxAge:0,path:"/",secure:true,httpOnly:true,sameSite:"lax"});
  return response;
}
/** 교환에 쓴 PKCE 쿠키만 지운다 — 바인딩 쿠키는 남겨 가입 뒤 복귀(/auth/native/resume)가 같은 브라우저임을 증명하게 한다. */
export function clearNativeExchangeCookies(request:NextRequest,response:NextResponse,flowId:string) {
  const prefix=`stiz-native-oauth-${flowId}`;
  const keys=[prefix,`${prefix}-code-verifier`];
  for(const cookie of request.cookies.getAll())if(keys.some(key=>cookie.name===key || cookie.name.startsWith(`${key}.`)))response.cookies.set(cookie.name,"",{maxAge:0,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"});
  return response;
}
/** 이 브라우저의 웹 로그인 쿠키를 지운다(로그아웃 요청은 보내지 않는다 — 같은 세션을 앱이 이어 쓰기 때문). */
export function clearWebSessionCookies(request:NextRequest,response:NextResponse) {
  for(const cookie of request.cookies.getAll())if(/^sb-.+-auth-token(\.\d+)?$/.test(cookie.name))response.cookies.set(cookie.name,"",{maxAge:0,path:"/",secure:true,sameSite:"lax"});
  return response;
}
