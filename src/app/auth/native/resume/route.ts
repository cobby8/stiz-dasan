import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError, validFlow } from "@/lib/native-auth/policy";
import { NATIVE_RESUME_COOKIE, bindingCookie, clearNativeBrowserCookies, clearNativeResumeCookie, clearWebSessionCookies, nativeContext, noStoreHeaders } from "@/lib/native-auth/http";
import { requireNativeAccount } from "@/lib/native-auth/store";
import { createClient } from "@/lib/supabase/server";
export const runtime = "nodejs";

/**
 * 가입·연결을 마친 브라우저를 앱으로 돌려보내 로그인까지 끝낸다(2026-11-17 원장 지시).
 *
 * 앱 간편로그인에 학원 계정이 없으면 callback 이 요청(flow)을 살려 둔 채 가입 화면으로 보낸다. 가입·연결이 끝나면
 * 화면이 여기로 온다. 확인하는 것:
 *  1. 살려 둔 요청 번호(쿠키) + 그 요청을 연 브라우저라는 증명(바인딩 쿠키) + 요청이 아직 유효(5분 안·BROWSER 상태)
 *  2. 이 브라우저의 웹 로그인이 «학원 계정과 연결된» 사용자(requireNativeAccount — 앱 로그인과 같은 판정)
 * 통과하면 평소 앱 로그인과 똑같이 1회용 code 로 앱에 돌려보낸다(토큰은 주소에 싣지 않는다 — 암호화 원장에만).
 * 이 브라우저의 웹 로그인 쿠키는 지운다(앱 밖 브라우저에 로그인이 남지 않게). 로그아웃 요청은 보내지 않는다 —
 * 같은 세션을 앱이 이어 쓴다.
 * 실패하면(시간 초과·요청 없음) 읽을 수 있는 한 줄 안내만 — 가입·연결 자체는 이미 끝났으므로 앱에서 다시 로그인하면 된다.
 */
export async function GET(request:NextRequest) {
  const flow=request.cookies.get(NATIVE_RESUME_COOKIE)?.value;
  try {
    const {service}=nativeContext(request,true);
    if(!validFlow(flow))throw new NativeAuthError();
    const binding=request.cookies.get(bindingCookie(flow))?.value;
    const row=await service.browserFlow(flow,binding);
    const supabase=await createClient();
    const {data:{session}}=await supabase.auth.getSession();
    // 쿠키의 세션을 그대로 믿지 않고 Auth 서버에 다시 확인한다
    const verified=session?await supabase.auth.getUser(session.access_token):null;
    const user=verified?.data.user;
    if(!session||!user||verified?.error||user.id!==session.user.id)throw new NativeAuthError(401);
    if(!await requireNativeAccount(user.id))throw new NativeAuthError(403);
    const callback=await service.finishBrowser(row,binding!,{access_token:session.access_token,refresh_token:session.refresh_token,authUserId:user.id});
    const response=NextResponse.redirect(callback);
    for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
    clearNativeBrowserCookies(request,response,flow);
    clearNativeResumeCookie(response);
    return clearWebSessionCookies(request,response);
  }catch{
    const response=new NextResponse(`가입(연결)은 끝났어요.\n이 창을 닫고 앱에서 다시 로그인해 주세요.`,{status:200,headers:{...noStoreHeaders,"Content-Type":"text/plain; charset=utf-8"}});
    return clearNativeResumeCookie(response);
  }
}
