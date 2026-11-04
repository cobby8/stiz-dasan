import 'server-only';
import { randomUUID } from 'node:crypto';
import { confirmedEtaMin } from '@/lib/shuttle/confirmedEta';
import { planLocationKey } from '@/lib/shuttle/routePlanning';
import { routeRecipientKey } from './route-plan-recipient';
import type { PlanTimeEntry } from '@/lib/shuttle/routePlanningTypes';
import type { PlanDb, PlanStore } from './route-plan-query';
type NoticeRow={id:string;versionId:string;studentId:string;recipientPhone:string;recipientKey:string;message:string;status:string;entries:PlanTimeEntry[]};
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const arr=(v:unknown):Record<string,unknown>[]=>Array.isArray(v)?v.map(obj):[];
/** 학생별 해당 구간의 시각·위치를 비교해 관련 없는 다른 반 수정은 허용한다. */
export function noticeEntriesMatchRoutes(studentId:string,entries:PlanTimeEntry[],routes:unknown):boolean {
 if(!Array.isArray(entries)||!entries.length||new Set(entries.map(e=>`${e.dayOfWeek}/${e.direction}`)).size!==entries.length)return false;
 return entries.every(e=>{
  if(e.studentId!==studentId||!Number.isInteger(e.timeMin)||e.timeMin<0||e.timeMin>1439)return false;
  const stops=arr(routes).filter(r=>r.dayOfWeek===e.dayOfWeek&&r.direction===e.direction).flatMap(r=>arr(obj(r.payload).vehicles)).flatMap(v=>arr(v.stops)).filter(s=>arr(s.students).some(p=>p.requestId===studentId));
  if(stops.length!==1)return false;const stop=stops[0];
  if(typeof stop.lat!=='number'||typeof stop.lng!=='number'||typeof stop.label!=='string')return false;
  return confirmedEtaMin(stop)===e.timeMin&&planLocationKey({id:'',label:stop.label,lat:stop.lat,lng:stop.lng})===e.locationKey;
 });
}
async function eligibilityError(db:PlanDb,row:NoticeRow):Promise<string|null>{
 const parents=await db.$queryRawUnsafe<{parentId:string;phone:string|null;withdrawnAt:unknown;mergedIntoStudentId:string|null}[]>(`SELECT s."parentId",s."mergedIntoStudentId",u.phone,u."withdrawnAt" FROM "Student" s JOIN "User" u ON u.id=s."parentId" WHERE s.id=$1 FOR SHARE OF s,u`,row.studentId);const p=parents[0];
 if(!p||p.withdrawnAt||p.mergedIntoStudentId||routeRecipientKey(p.parentId,p.phone??'')!==row.recipientKey||(p.phone??'').replace(/\D/g,'')!==row.recipientPhone)return 'CURRENT_RECIPIENT_CHANGED';
 const versions=await db.$queryRawUnsafe<{serviceMonth:string;afterSnapshot:unknown;draftData:unknown;confirmed:boolean}[]>(`SELECT v."serviceMonth",v."afterSnapshot",d.data AS "draftData",(d.status='CONFIRMED') AS confirmed FROM "RegularRoutePlanVersion" v JOIN "RegularRoutePlanDraft" d ON d.id=v."draftId" WHERE v.id=$1`,row.versionId);const v=versions[0];
 // 전체 전달 기준에는 기존 다른 요일도 보존한다. 이번 문안의 실제 변경 구간만 재검증한다.
 const scope=new Set(arr(obj(v?.draftData).runs).filter(run=>arr(run.stops).some(stop=>arr(stop.students).some(student=>student.studentId===row.studentId))).map(run=>`${run.dayOfWeek}/${run.direction}`));
 const proof=Array.isArray(row.entries)?row.entries.filter(entry=>scope.has(`${entry.dayOfWeek}/${entry.direction}`)):[];
 if(!v?.confirmed||!proof.length||!noticeEntriesMatchRoutes(row.studentId,proof,obj(v.afterSnapshot).routes))return 'VERSION_NOT_CONFIRMED';
 const latest=await db.$queryRawUnsafe<{afterSnapshot:unknown}[]>(`SELECT "afterSnapshot" FROM "RegularRoutePlanVersion" WHERE "serviceMonth"=$1 ORDER BY "confirmedAt" DESC,id DESC LIMIT 1`,v.serviceMonth);
 if(!latest[0]||!noticeEntriesMatchRoutes(row.studentId,proof,obj(latest[0].afterSnapshot).routes))return 'CURRENT_ROUTE_VERSION_CHANGED';
 const routes=await db.$queryRawUnsafe<unknown[]>(`SELECT "dayOfWeek",direction,payload FROM "RegularDispatchRoute" WHERE "serviceMonth"=$1 ORDER BY id`,v.serviceMonth);
 return noticeEntriesMatchRoutes(row.studentId,proof,routes)?null:'CURRENT_ROUTE_CHANGED';
}
export type RouteNoticeProvider={kind:'SYNTHETIC'|'LIVE';send(input:{recipient:string;message:string;idempotencyKey:string}):Promise<{status:'ACCEPTED'|'DELIVERED'|'FAILED'|'UNKNOWN';providerId?:string;errorCode?:string}>};
/** 기본 차단. 운영 전송은 별도 승인된 실행기에서만 opt-in하며 이 모듈은 예약 작업을 만들지 않는다. */
export async function dispatchRouteNotice(store:PlanStore,id:string,provider:RouteNoticeProvider,options?:{syntheticOnly?:boolean;approvedVersionId?:string}){
 const synthetic=options?.syntheticOnly===true&&provider.kind==='SYNTHETIC';
 if(!options?.approvedVersionId||(!synthetic&&(process.env.STIZ_ROUTE_NOTICE_SEND!=='enabled'||provider.kind!=='LIVE')))return {status:'BLOCKED' as const};
 const claimed=await store.$transaction(async db=>{const rows=await db.$queryRawUnsafe<NoticeRow[]>(`SELECT * FROM "RegularRouteNoticeOutbox" WHERE id=$1 FOR UPDATE`,id);const row=rows[0];if(!row||row.status!=='PENDING'||row.versionId!==options.approvedVersionId)return null;
const reason=await eligibilityError(db,row);
if(reason){await db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status='FAILED',"errorCode"=$2,"updatedAt"=clock_timestamp() WHERE id=$1`,id,reason);return null;}await db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status='SENDING',"updatedAt"=clock_timestamp() WHERE id=$1`,id);return row;},{isolationLevel:'Serializable',timeout:15000});
 if(!claimed)return {status:'NOT_PENDING' as const};
 // 점유 직후 바뀐 계정·배차도 공급자 호출 직전에 다시 확인한다.
 const stillEligible=await store.$transaction(async db=>{const reason=await eligibilityError(db,claimed);if(reason)await db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status='FAILED',"errorCode"=$2,"updatedAt"=clock_timestamp() WHERE id=$1 AND status='SENDING'`,id,reason);return !reason;},{isolationLevel:'Serializable',timeout:15000});
 if(!stillEligible)return {status:'NOT_PENDING' as const};
 let result:Awaited<ReturnType<RouteNoticeProvider['send']>>;try{result=await provider.send({recipient:claimed.recipientPhone,message:claimed.message,idempotencyKey:claimed.id});if(!['ACCEPTED','DELIVERED','FAILED','UNKNOWN'].includes(result.status)||(['ACCEPTED','DELIVERED'].includes(result.status)&&!result.providerId))result={status:'UNKNOWN',errorCode:'INVALID_PROVIDER_RESULT'};}catch{result={status:'UNKNOWN',errorCode:'PROVIDER_RESULT_UNKNOWN'};}
 await store.$transaction(async db=>{await db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status=$2,"providerId"=$3,"errorCode"=$4,"updatedAt"=clock_timestamp() WHERE id=$1 AND status='SENDING'`,id,result.status,result.providerId??null,result.errorCode??null);if(result.status==='DELIVERED')await saveDelivered(db,id);},{isolationLevel:'Serializable',timeout:15000});return {status:result.status};
}
async function saveDelivered(db:PlanDb,id:string){await db.$executeRawUnsafe(`INSERT INTO "RegularRouteNoticeSnapshot"(id,"studentId","serviceMonth",source,entries,"outboxId","recipientKey") SELECT $2,o."studentId",v."serviceMonth",'DELIVERED',o.entries,o.id,o."recipientKey" FROM "RegularRouteNoticeOutbox" o JOIN "RegularRoutePlanVersion" v ON v.id=o."versionId" WHERE o.id=$1 AND o.status='DELIVERED' ON CONFLICT("outboxId") DO NOTHING`,id,randomUUID());}
/** 공급자 확인은 전송 요청 수락과 분리한다. 중복 통지는 기존 snapshot을 재사용한다. */
export async function recordRouteNoticeDelivery(store:PlanStore,input:{outboxId:string;providerId:string;delivered:boolean}){return store.$transaction(async db=>{const rows=await db.$queryRawUnsafe<{status:string;providerId:string|null}[]>(`SELECT status,"providerId" FROM "RegularRouteNoticeOutbox" WHERE id=$1 FOR UPDATE`,input.outboxId);const row=rows[0];if(!row||row.providerId!==input.providerId||!['ACCEPTED','DELIVERED'].includes(row.status))return {accepted:false};if(input.delivered){await db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status='DELIVERED',"updatedAt"=clock_timestamp() WHERE id=$1`,input.outboxId);await saveDelivered(db,input.outboxId);}return {accepted:true};},{isolationLevel:'Serializable',timeout:15000});}
/** 프로세스가 전송 도중 종료되면 재발송하지 않고 운영자 확인으로 남긴다. */
export async function markInterruptedRouteNoticesUnknown(db:PlanDb,olderThan:Date){return db.$executeRawUnsafe(`UPDATE "RegularRouteNoticeOutbox" SET status='UNKNOWN',"errorCode"='INTERRUPTED_SEND',"updatedAt"=clock_timestamp() WHERE status='SENDING' AND "updatedAt"<$1`,olderThan);}
