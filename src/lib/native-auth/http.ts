import "server-only";
import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError, nativeConfig, validFlow } from "./policy";
import { createNativeAuthService } from "./service";
import { postgresNativeFlowStore } from "./store";

export function nativeContext(request: NextRequest, browserCallback = false) {
  const config = nativeConfig();
  // 임의 Host를 복귀 주소나 쿠키 경계로 사용하지 않는다.
  if (request.nextUrl.origin !== config.origin) throw new NativeAuthError(403);
  const callbackNavigation = browserCallback && request.method === "GET" && request.nextUrl.pathname === "/auth/native/callback";
  // 공급자→callback의 최상위 GET은 정상적인 교차 사이트 이동이다. 그 경로만 PKCE·바인딩 쿠키로 검증한다.
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
export function clearNativeBrowserCookies(request:NextRequest,response:NextResponse,flowId:string) {
  const prefix=`stiz-native-oauth-${flowId}`;
  const keys=[prefix,`${prefix}-code-verifier`];
  for(const cookie of request.cookies.getAll())if(keys.some(key=>cookie.name===key || cookie.name.startsWith(`${key}.`)))response.cookies.set(cookie.name,"",{maxAge:0,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"});
  response.cookies.set(bindingCookie(flowId),"",{maxAge:0,path:"/auth/native",secure:true,httpOnly:true,sameSite:"lax"});
  return response;
}
