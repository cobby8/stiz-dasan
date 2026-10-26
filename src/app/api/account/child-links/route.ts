import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireAuth } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { childConnectionsAvailable } from "@/lib/account/child-access";
import { ChildConnectionError, childIdentityHash, childConnectionsConfigured, getChildConnectionState, startChildVerification,
  verifyChildIdentity, requestChildConnection, decideChildConnection, cancelChildConnection, type ChildActor } from "@/lib/account/child-links";

export const dynamic = "force-dynamic";
const COOKIE = "stiz-child-device";
async function actor(): Promise<ChildActor> {
  let user;
  try { user = await requireAuth(); } catch { throw new ChildConnectionError("로그인이 필요합니다.",401); }
  const rows=await prisma.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "User" WHERE ("authUserId"=$1 OR ("authUserId" IS NULL AND id=$1))
    AND "withdrawnAt" IS NULL LIMIT 1`,user.id);
  if(!rows[0]) throw new ChildConnectionError("학원 계정으로 로그인해 주세요.",401);
  return {id:rows[0].id,authUserId:user.id};
}
function deviceHash(user:ChildActor,token:string) { return childIdentityHash(`child-device:${user.authUserId}:${token}`); }
function response(value:unknown,status=200) { return NextResponse.json(value,{status,headers:{"Cache-Control":"no-store"}}); }
function failure(error:unknown) {
  if(error instanceof ChildConnectionError) return response({error:error.message},error.status);
  // 내부 오류·명의 정보·DB 원문은 화면이나 로그로 전달하지 않는다.
  return response({error:"처리하지 못했습니다. 잠시 후 다시 시도해 주세요."},503);
}
export async function GET(request:NextRequest) {
  try {
    const current=await actor();
    if(!childConnectionsConfigured() || !await childConnectionsAvailable()) return response({enabled:false,verified:false,outgoing:[],incoming:[]});
    const token=request.cookies.get(COOKIE)?.value || "";
    return response(await getChildConnectionState(current,token?deviceHash(current,token):""));
  } catch(error){return failure(error);}
}
export async function POST(request:NextRequest) {
  try {
    if(request.headers.get("origin")!==request.nextUrl.origin) throw new ChildConnectionError("요청 출처를 확인하지 못했습니다.",403);
    if(!request.headers.get("content-type")?.startsWith("application/json")) throw new ChildConnectionError("요청 형식을 확인해 주세요.");
    const text=await request.text();
    if(text.length>4096) throw new ChildConnectionError("요청 내용이 너무 깁니다.",413);
    let body;
    try {body=JSON.parse(text);} catch {throw new ChildConnectionError("요청 형식을 확인해 주세요.");}
    if(!body || typeof body!=="object" || Array.isArray(body)) throw new ChildConnectionError("요청 형식을 확인해 주세요.");
    const current=await actor();
    if(body.action==="start-verification") {
      const token=randomBytes(32).toString("base64url");
      const result=await startChildVerification(current,deviceHash(current,token));
      const res=response(result);
      res.cookies.set(COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/api/account/child-links",maxAge:1800});
      return res;
    }
    if(body.action==="decide" && typeof body.requestId==="string" && body.requestId.length<=64)
      return response(await decideChildConnection(current,body.requestId,String(body.decision)));
    if(body.action==="cancel" && typeof body.requestId==="string" && body.requestId.length<=64)
      return response(await cancelChildConnection(current,body.requestId));
    const token=request.cookies.get(COOKIE)?.value || "";
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
    const sessionHash=deviceHash(current,token);
    if(body.action==="verify" && typeof body.identityVerificationId==="string" && body.identityVerificationId.length<100)
      return response(await verifyChildIdentity(current,sessionHash,body.identityVerificationId));
    if(body.action==="request") return response(await requestChildConnection(current,sessionHash,body));
    throw new ChildConnectionError("요청 방법을 확인해 주세요.");
  }catch(error){return failure(error);}
}
