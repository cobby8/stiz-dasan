import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError, validFlow } from "@/lib/native-auth/policy";
import { bindingCookie, clearNativeBrowserCookies, nativeBrowserClient, nativeBrowserError, nativeContext, noStoreHeaders } from "@/lib/native-auth/http";
import { requireNativeAccount } from "@/lib/native-auth/store";
import type { NativeBrowserFailure, NativeFlow } from "@/lib/native-auth/service";
export const runtime = "nodejs";
export async function GET(request:NextRequest) {
  const flow=request.nextUrl.searchParams.get("flow");
  let bound=false;
  // 실패하면 앱에 알려 줄 이유. 브라우저가 묶인 뒤의 실패만 앱으로 돌려보낸다.
  let reason:NativeBrowserFailure="failed";
  let row:NativeFlow|null=null;
  let context:ReturnType<typeof nativeContext>|null=null;
  try {
    context=nativeContext(request,true);
    const {service}=context;
    if(!validFlow(flow))throw new NativeAuthError();
    const binding=request.cookies.get(bindingCookie(flow))?.value;
    row=await service.browserFlow(flow,binding);
    bound=true;
    // 카카오·구글 화면에서 «취소»를 누르면 error 가 붙어 돌아온다
    if(request.nextUrl.searchParams.has("error")){reason="cancelled";throw new NativeAuthError();}
    const code=request.nextUrl.searchParams.get("code");
    if(!code || code.length>4096 || row.provider!==request.nextUrl.searchParams.get("provider"))throw new NativeAuthError();
    const browser=nativeBrowserClient(request,flow);
    const exchanged=await browser.client.auth.exchangeCodeForSession(code);
    const session=exchanged.data?.session;
    if(exchanged.error||!session)throw new NativeAuthError();
    // JWT의 사용자 지정 role이나 이메일이 아닌 실제 Auth ID와 학원 원장을 다시 대조한다.
    const verified=await browser.client.auth.getUser(session.access_token);
    if(verified.error||!verified.data.user||verified.data.user.id!==session.user.id)throw new NativeAuthError(403);
    // 간편로그인은 됐지만 학원 계정과 연결 안 됨(처음 쓰는 학부모·탈퇴 등) — 앱이 «아이디·비밀번호/회원가입» 안내를 띄운다
    if(!await requireNativeAccount(verified.data.user.id)){reason="no_account";throw new NativeAuthError(403);}
    const callback=await service.finishBrowser(row,binding!,{access_token:session.access_token,refresh_token:session.refresh_token,authUserId:verified.data.user.id});
    const response=NextResponse.redirect(callback);
    for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
    // 교환 중 생성된 브라우저 세션 쿠키를 앱으로 복사하지 않는다. 암호화 원장만 사용한다.
    return clearNativeBrowserCookies(request,response,flow);
  }catch(error){
    // 이 브라우저가 묶인 요청이면 앱으로 돌려보내(코드 없이 이유만) 브라우저 창이 닫히고 앱이 안내하게 한다.
    if(bound&&row&&context&&validFlow(flow)){
      const back=await context.service.failBrowser(row,reason).catch(()=>null);
      if(back){
        const response=NextResponse.redirect(back);
        for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
        return clearNativeBrowserCookies(request,response,flow);
      }
    }
    const response=nativeBrowserError(error);return bound&&validFlow(flow)?clearNativeBrowserCookies(request,response,flow):response;
  }
}
