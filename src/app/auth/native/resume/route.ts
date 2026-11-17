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
    // 바로 앱 주소로 넘기지 않고 화면을 한 번 보여 준다(검수 반영): 본인인증에서 돌아온 직후처럼 «누름 없이» 이어진 이동은
    // 크롬이 앱 열기를 막을 수 있다. 화면이 자동으로 한 번 시도하고, 막히면 사용자가 버튼을 눌러 앱으로 돌아간다.
    // 1회용 code 는 60초 동안만 유효하다 — 화면에 그렇게 적는다.
    const response=page(`<h1>거의 다 됐어요</h1><p>아래 버튼을 누르면 앱으로 돌아가 로그인됩니다.</p><a class="go" id="go" href="${escapeHtml(callback)}">앱으로 돌아가기</a><p class="sub">1분 안에 눌러 주세요. 지나면 이 창을 닫고 앱에서 다시 로그인하시면 됩니다.</p><script>setTimeout(function(){location.href=document.getElementById("go").href},300)</script>`);
    clearNativeBrowserCookies(request,response,flow);
    clearNativeResumeCookie(response);
    return clearWebSessionCookies(request,response);
  }catch{
    // 가입·연결 자체는 끝났다. 앱 밖 브라우저에 로그인이 남지 않게 이때도 웹 로그인 쿠키를 지운다(보안 검수 반영).
    const response=page(`<h1>가입(연결)은 끝났어요</h1><p>이 창을 닫고 앱에서 다시 로그인해 주세요.</p><p class="sub">창 왼쪽 위의 ×(아이폰은 «취소»)를 누르면 닫힙니다.</p>`);
    clearNativeResumeCookie(response);
    return clearWebSessionCookies(request,response);
  }
}
function escapeHtml(value:string) { return value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]!)); }
/**
 * 읽을 수 있는 한 화면. 내용은 서버가 정한 고정 문구와 앱 복귀 주소뿐이다.
 * 이 화면은 앱의 화면 틀 밖(스타일 토큰이 없는 단독 문서)이라 색 코드를 쓰지 않고 브라우저 기본 색(color-scheme + Canvas·CanvasText)만 쓴다
 * — 밝은·어두운 화면 모두에서 글자와 버튼이 자동으로 대비된다.
 */
function page(body:string) {
  const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>스티즈농구교실</title><style>body{margin:0;padding:32px 20px;font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;line-height:1.6}h1{font-size:22px;font-weight:700;margin:0 0 8px}p{font-size:16px;margin:0 0 16px}.sub{font-size:14px;opacity:.7}.go{display:flex;align-items:center;justify-content:center;min-height:52px;margin:20px 0 12px;border-radius:12px;background:CanvasText;color:Canvas;font-size:17px;font-weight:600;text-decoration:none}</style></head><body>${body}</body></html>`;
  return new NextResponse(html,{status:200,headers:{...noStoreHeaders,"Content-Type":"text/html; charset=utf-8"}});
}
