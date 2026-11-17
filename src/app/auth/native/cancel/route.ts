import { NextRequest, NextResponse } from "next/server";
import { nativeBody, nativeContext, nativeError, noStoreHeaders } from "@/lib/native-auth/http";
import { nativeCancelReason } from "@/lib/native-auth/service";
export const runtime = "nodejs";
export async function POST(request:NextRequest) {
  // 앱이 그만둔 이유(1.0.6~, 정해진 한 단어만 — 그 밖은 unknown). 원인 추적용 기록이며 flow·state·비밀값은 남기지 않는다.
  let reason="unknown";
  try {
    const {service}=nativeContext(request);
    const body=await nativeBody(request);
    reason=nativeCancelReason(body.reason);
    await service.cancel(body);
    console.info(`[native-auth] cancel reason=${reason} result=ok`);
    return NextResponse.json({ok:true},{headers:noStoreHeaders});
  }
  catch(error){
    // 이미 끝난 요청(서버가 먼저 취소한 경우 등)도 이유는 남긴다
    console.info(`[native-auth] cancel reason=${reason} result=rejected`);
    return nativeError(error);
  }
}
