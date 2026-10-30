import { NextRequest, NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import { toSupabaseProvider } from "@/lib/parent-oauth";
import { NativeAuthError } from "@/lib/native-auth/policy";
import { bindingCookie, nativeBrowserClient, nativeContext, nativeError, noStoreHeaders } from "@/lib/native-auth/http";
export const runtime = "nodejs";
export async function GET(request:NextRequest) {
  try {
    const {service,config}=nativeContext(request);
    const {row,binding}=await service.beginBrowser(request.nextUrl.searchParams.get("flow"));
    if(!(await getEnabledParentOAuthProviders()).includes(row.provider))throw new NativeAuthError(503);
    const callback=new URL("/auth/native/callback",config.origin);
    callback.searchParams.set("flow",row.id);callback.searchParams.set("provider",row.provider);
    const browser=nativeBrowserClient(request,row.id);
    const {data,error}=await browser.client.auth.signInWithOAuth({provider:toSupabaseProvider(row.provider),options:{redirectTo:callback.toString(),skipBrowserRedirect:true}});
    if(error||!data.url)throw new NativeAuthError();
    // 반환 주소는 Supabase SDK가 만든 HTTPS 공급자 인증 주소여야 한다.
    const authorization=new URL(data.url);const configured=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
    if(authorization.origin!==configured.origin || authorization.protocol!=="https:" || authorization.username || authorization.password || authorization.pathname!=="/auth/v1/authorize")throw new NativeAuthError();
    const response=NextResponse.redirect(authorization);
    for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
    response.cookies.set(bindingCookie(row.id),binding,{secure:true,httpOnly:true,sameSite:"lax",path:"/auth/native",maxAge:300});
    return browser.apply(response);
  }catch(error){return nativeError(error);}
}
