import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { NativeAuthError } from "@/lib/native-auth/policy";
import { nativeBody, nativeContext, nativeError, noStoreHeaders } from "@/lib/native-auth/http";
import { requireNativeAccount } from "@/lib/native-auth/store";
import { NATIVE_SESSION_COOKIE, nativeSessionCookieOptions } from "@/lib/native-session-cookies";
export const runtime = "nodejs";
export async function POST(request:NextRequest) {
  try {
    const {service,config}=nativeContext(request);
    const session=await service.consume(await nativeBody(request));
    const response=NextResponse.redirect(new URL("/auth/continue",config.origin),303);
    for(const [key,value]of Object.entries(noStoreHeaders))response.headers.set(key,value);
    const client=createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{
      cookieOptions:{httpOnly:true,secure:true,sameSite:"lax",path:"/"},
      cookies:{getAll:()=>request.cookies.getAll(),setAll:items=>{for(const item of items)response.cookies.set(item.name,item.value,nativeSessionCookieOptions(item.options,true));}},
    });
    const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
    const sessionCookie=`sb-${project}-auth-token`;
    const hasExistingCookie=request.cookies.getAll().some(item=>item.name===sessionCookie || item.name.startsWith(`${sessionCookie}.`));
    const existing=await client.auth.getUser();
    if((hasExistingCookie && (existing.error || !existing.data.user)) || (existing.data.user && existing.data.user.id!==session.authUserId))throw new NativeAuthError(403);
    const verified=await client.auth.getUser(session.access_token);
    if(verified.error||verified.data.user?.id!==session.authUserId||!await requireNativeAccount(session.authUserId))throw new NativeAuthError(403);
    const installed=await client.auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token});
    if(installed.error||installed.data.user?.id!==session.authUserId)throw new NativeAuthError();
    response.cookies.set(NATIVE_SESSION_COOKIE,"1",{httpOnly:true,secure:true,sameSite:"lax",path:"/",maxAge:400*24*60*60});
    return response;
  }catch(error){return nativeError(error);}
}
