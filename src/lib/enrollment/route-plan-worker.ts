import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { sendTrackedSms } from '@/lib/notification';
import { dispatchRouteNotice, recordRouteNoticeDelivery, type RouteNoticeProvider } from './route-plan-outbox';
import type { PlanStore } from './route-plan-query';
import type { SmsSendResult } from '@/lib/sms';
/** 발송 전 정책 차단은 실패로, 접수 여부를 모르는 결과만 확인 대기로 둔다. */
export function classifyTrackedRouteResult(result:SmsSendResult):Awaited<ReturnType<RouteNoticeProvider['send']>> {
 if(result.ok&&result.messageId)return {status:'ACCEPTED',providerId:result.messageId};
 const reason=result.reason??'';
 if(!result.ok&&(reason==='AUTOMATION_DISABLED'||reason==='Invalid SMS recipient.'||reason.includes('SMS environment variables are missing:')||reason.startsWith('문자 장부를 만들지 못해 발송 전 중단')||reason.includes('채널이 연결되지 않아 발송하지 않았습니다')))return {status:'FAILED',errorCode:'SEND_BLOCKED_BEFORE_PROVIDER'};
 return {status:'UNKNOWN',errorCode:'PROVIDER_RESULT_UNCONFIRMED'};
}
/** 기존 문자 정책·기록기를 사용한다. 공급자 접수는 실제 전달로 취급하지 않는다. */
export const trackedRouteNoticeProvider:RouteNoticeProvider={kind:'LIVE',async send(input){const result=await sendTrackedSms({eventType:'REGULAR_SHUTTLE_CHANGE',trigger:'REGULAR_SHUTTLE_CHANGE',recipientRole:'PARENT',recipientPhone:input.recipient,body:input.message,eventId:`ROUTE_PLAN:${input.idempotencyKey}`,source:'MANUAL',audienceScope:'EXTERNAL'});return classifyTrackedRouteResult(result);}};
/** 확정 후 실행기 진입점. 기본 OFF이며 실행/예약을 새로 등록하지 않는다. */
export async function dispatchConfirmedRouteVersion(versionId:string,store:PlanStore=prisma as unknown as PlanStore,provider:RouteNoticeProvider=trackedRouteNoticeProvider,syntheticOnly=false){if((syntheticOnly&&provider.kind!=='SYNTHETIC')||(!syntheticOnly&&(provider.kind!=='LIVE'||process.env.STIZ_ROUTE_NOTICE_SEND!=='enabled')))return {status:'BLOCKED',results:[]};const approved=await store.$queryRawUnsafe<{id:string}[]>(`SELECT v.id FROM "RegularRoutePlanVersion" v JOIN "RegularRoutePlanDraft" d ON d.id=v."draftId" WHERE v.id=$1 AND d.status='CONFIRMED'`,versionId);if(!approved.length)return {status:'NOT_CONFIRMED',results:[]};const rows=await store.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "RegularRouteNoticeOutbox" WHERE "versionId"=$1 AND status='PENDING' ORDER BY "createdAt",id LIMIT 100`,versionId);const results=[];for(const row of rows)results.push(await dispatchRouteNotice(store,row.id,provider,{syntheticOnly,approvedVersionId:versionId}));return {status:'PROCESSED',results};}
/** 기존 공급자 전달 기록을 읽는 후속 실행기. 수신 결과 불명이면 재전송하지 않는다. */
export async function reconcileRouteNoticeDeliveries(store:PlanStore=prisma as unknown as PlanStore){if(process.env.STIZ_ROUTE_NOTICE_SEND!=='enabled')return {status:'BLOCKED',updated:0};const rows=await store.$queryRawUnsafe<{id:string;providerId:string;message:string;bodyHash:string}[]>(`SELECT DISTINCT o.id,o."providerId",o.message,d."bodyHash" FROM "RegularRouteNoticeOutbox" o JOIN "NotificationDelivery" d ON d."providerMessageId"=o."providerId" AND d."stableEventKey"='REGULAR_SHUTTLE_CHANGE:REGULAR_SHUTTLE_CHANGE:ROUTE_PLAN:'||o.id AND d."recipientPhone"=o."recipientPhone" WHERE o.status='ACCEPTED' AND o."providerId" IS NOT NULL AND d.status='SENT' AND d."providerStatus" IN ('DELIVERED','DELIVERY_SUCCESS','4000') LIMIT 100`);let updated=0;for(const row of rows){if(row.bodyHash!==createHash('sha256').update(row.message,'utf8').digest('hex'))continue;const result=await recordRouteNoticeDelivery(store,{outboxId:row.id,providerId:row.providerId,delivered:true});if(result.accepted)updated++;}return {status:'PROCESSED',updated};}
