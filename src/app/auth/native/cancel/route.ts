import { NextRequest, NextResponse } from "next/server";
import { nativeBody, nativeContext, nativeError, noStoreHeaders } from "@/lib/native-auth/http";
export const runtime = "nodejs";
export async function POST(request:NextRequest) {
  try { const {service}=nativeContext(request);await service.cancel(await nativeBody(request));return NextResponse.json({ok:true},{headers:noStoreHeaders}); }
  catch(error){return nativeError(error);}
}
