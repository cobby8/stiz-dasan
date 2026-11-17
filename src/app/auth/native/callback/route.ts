import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError, validFlow } from "@/lib/native-auth/policy";
import { bindingCookie, clearNativeBrowserCookies, nativeBrowserClient, nativeBrowserError, nativeContext, noStoreHeaders, webSignupSessionClient } from "@/lib/native-auth/http";
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
  // 학원 계정이 없을 때 가입 화면으로 넘겨줄 간편로그인 세션(그 밖의 실패에서는 비어 있다)
  let signup:{access_token:string;refresh_token:string}|null=null;
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
    if(!await requireNativeAccount(verified.data.user.id)){reason="no_account";signup={access_token:session.access_token,refresh_token:session.refresh_token};throw new NativeAuthError(403);}
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
        // 2026-11-17 긴급(원장 지시): 가입 전 학부모가 앱에서 간편로그인부터 누르면 앱이 짧은 안내만 띄우고 끝나
        // «로그인 오류»로 신고가 들어왔다. 이 브라우저 창을 닫지 않고 가입 화면으로 이어 준다.
        // 요청은 위 failBrowser 가 이미 취소했고, 주소에는 고정 값과 제공자 이름만 싣는다(토큰·flow·state 없음).
        if(reason==="no_account"){
          const target=new URL("/signup/parent",context.config.origin);
          target.searchParams.set("fromApp","1");
          // 방금 확인한 간편로그인을 웹 간편가입으로 이어 준다 — 카카오·구글 로그인을 다시 시키지 않는다.
          // 옮겨 적지 못하면(이미 다른 웹 로그인이 있음·세션 설정 실패) 로그인 안 된 가입 화면으로 간다.
          const web=signup?webSignupSessionClient(request):null;
          const moved=web&&signup?!(await web.client.auth.setSession(signup).catch(()=>({error:true}))).error:false;
          if(moved){target.searchParams.set("social","1");target.searchParams.set("provider",row.provider);target.searchParams.set("next","/mypage");}
          const response=NextResponse.redirect(target);
          for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
          clearNativeBrowserCookies(request,response,flow);
          return moved&&web?web.apply(response):response;
        }
        const response=NextResponse.redirect(back);
        for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
        return clearNativeBrowserCookies(request,response,flow);
      }
    }
    const response=nativeBrowserError(error);return bound&&validFlow(flow)?clearNativeBrowserCookies(request,response,flow):response;
  }
}
