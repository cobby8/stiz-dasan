import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError, validFlow } from "@/lib/native-auth/policy";
import { bindingCookie, clearNativeBrowserCookies, nativeBrowserClient, nativeContext, nativeError, noStoreHeaders } from "@/lib/native-auth/http";
import { requireNativeAccount } from "@/lib/native-auth/store";
export const runtime = "nodejs";
export async function GET(request:NextRequest) {
  const flow=request.nextUrl.searchParams.get("flow");
  let bound=false;
  try {
    const {service}=nativeContext(request,true);
    if(!validFlow(flow))throw new NativeAuthError();
    const binding=request.cookies.get(bindingCookie(flow))?.value;
    const row=await service.browserFlow(flow,binding);
    bound=true;
    const code=request.nextUrl.searchParams.get("code");
    if(request.nextUrl.searchParams.has("error") || !code || code.length>4096 || row.provider!==request.nextUrl.searchParams.get("provider"))throw new NativeAuthError();
    const browser=nativeBrowserClient(request,flow);
    const exchanged=await browser.client.auth.exchangeCodeForSession(code);
    const session=exchanged.data?.session;
    if(exchanged.error||!session)throw new NativeAuthError();
    // JWT의 사용자 지정 role이나 이메일이 아닌 실제 Auth ID와 학원 원장을 다시 대조한다.
    const verified=await browser.client.auth.getUser(session.access_token);
    if(verified.error||!verified.data.user||verified.data.user.id!==session.user.id || !await requireNativeAccount(verified.data.user.id))throw new NativeAuthError(403);
    const callback=await service.finishBrowser(row,binding!,{access_token:session.access_token,refresh_token:session.refresh_token,authUserId:verified.data.user.id});
    const response=NextResponse.redirect(callback);
    for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
    // 교환 중 생성된 브라우저 세션 쿠키를 앱으로 복사하지 않는다. 암호화 원장만 사용한다.
    return clearNativeBrowserCookies(request,response,flow);
  }catch(error){const response=nativeError(error);return bound&&validFlow(flow)?clearNativeBrowserCookies(request,response,flow):response;}
}
