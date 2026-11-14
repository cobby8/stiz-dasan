import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth-guard";
// 부원장 차단(2026-11-14 원장 결정): 원장(ADMIN)만 — requireOwner 가 부원장을 거절한다
import { prisma } from "@/lib/prisma";
import { WorkbenchError, validateWorkbenchMonth } from "@/lib/billing/workbench";
import { mutateWorkbench, readWorkbench } from "@/lib/billing/workbench-service";
import { resolveWorkbenchAbsence } from "@/lib/billing/workbench-absence";
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const enabled = () => process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";
const fail = (e: unknown) => NextResponse.json({ error: e instanceof WorkbenchError ? e.message : "청구 준비를 처리하지 못했습니다. 다시 조회해 주세요.",refreshRequired:e instanceof WorkbenchError?e.refreshRequired:false },{status:e instanceof WorkbenchError ? e.status : 500,headers});
export async function GET(request: NextRequest) {
  try { await requireOwner(); } catch { return NextResponse.json({error:"원장 권한이 필요합니다."},{status:403,headers}); }
  try {
    const month = validateWorkbenchMonth(request.nextUrl.searchParams.get("month"));
    // 공식 일정(달력)은 DB 읽기와 동시에 불러온다(2026-11-14 속도 개선 — 예전엔 달력을 다 받은 뒤에 읽기를 시작했다).
    // 읽기 쪽이 먼저 실패해도 달력 오류가 «처리 안 된 거절»로 남지 않게 빈 처리기를 붙여 둔다(오류 자체는 readWorkbench 가 그대로 받는다).
    const calendar=loadWorkbenchCalendar();
    // 달력을 기다리는 동안 거래가 열려 있으므로(캐시가 비어 구글 일정 응답이 느릴 때) 거래 시간제한을 기본 5초보다 넉넉히 둔다.
    calendar.catch(()=>{});
    const view = await prisma.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); return readWorkbench(tx,month,enabled(),calendar); },{isolationLevel:"RepeatableRead",timeout:15000});
    return NextResponse.json(view,{headers});
  } catch(e) { return fail(e); }
}
async function readBody(request: NextRequest) {
  const limit=512*1024,reader=request.body?.getReader();
  if (!reader) throw new WorkbenchError("요청 내용이 없습니다.");
  const chunks:Uint8Array[]=[];let length=0;
  try { while(true) {const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new WorkbenchError("요청 내용이 너무 큽니다.",413);}chunks.push(value);} } finally {reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw new WorkbenchError("요청 형식을 확인해 주세요.");}
}
export async function POST(request: NextRequest) {
  let admin;try{admin=await requireOwner();}catch{return NextResponse.json({error:"원장 권한이 필요합니다."},{status:403,headers});}
  try{
    if(!enabled())throw new WorkbenchError("청구 준비 저장은 운영 적용 승인 전까지 잠겨 있습니다.",503);
    if(request.headers.get("origin")!==request.nextUrl.origin||request.headers.get("sec-fetch-site")==="cross-site")throw new WorkbenchError("사이트에서 다시 요청해 주세요.",403);
    if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw new WorkbenchError("요청 형식을 확인해 주세요.",415);
    const body=await readBody(request);
    const calendar=await loadWorkbenchCalendar(true);
    const result=body?.action==="RESOLVE_ABSENCE"?await resolveWorkbenchAbsence(prisma,body,admin.appUserId,enabled(),calendar):await mutateWorkbench(prisma,body,admin.appUserId,enabled(),calendar);
    return NextResponse.json(result,{headers});
  }catch(e){return fail(e);}
}
