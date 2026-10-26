import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { childConnectionsAvailable, childAccessSql } from "./child-access";
import { canConnectSelf, identityName, identityPhone, validBirth, CHILD_LINK_UNAVAILABLE } from "./child-link-policy";
import { fetchPortoneIdentityVerification, getPortoneConfig } from "@/lib/identity/portone";

type Db = Prisma.TransactionClient;
export type ChildActor = { id: string; authUserId: string };
type Challenge = { id: string; userId: string; sessionHash: string; createdAt: Date; expiresAt: Date;
  usedAt: Date | null; verifiedName: string | null; phoneLast4: string | null;
  proofExpiresAt: Date | null; proofUsedAt: Date | null; verifyAttempts: number; requestAttempts: number };
export class ChildConnectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function childIdentityHash(value: string) {
  const key = process.env.CHILD_CONNECTIONS_SECRET || process.env.PARENT_SIGNUP_SECRET;
  if (!key) throw new ChildConnectionError("자녀 연결 기능을 준비 중입니다.", 503);
  return createHmac("sha256", key).update(value).digest("hex");
}
export async function requireChildConnections() {
  if (!childConnectionsConfigured() || !await childConnectionsAvailable()) throw new ChildConnectionError("자녀 연결 기능을 준비 중입니다.", 503);
}
export function childConnectionsConfigured() {
  return Boolean((process.env.CHILD_CONNECTIONS_SECRET || process.env.PARENT_SIGNUP_SECRET)
    && getPortoneConfig() && process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY);
}
function todayKst() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()); }
/** 옛 직접 ID 로그인도 이 계정에서 발급·검증한 인증 원장이 있어야 가족 승인자로 인정한다. */
function trustedFamilyLoginSql(alias: "u" | "reviewer") {
  return `(${alias}."authUserId" IS NOT NULL OR EXISTS(SELECT 1 FROM "ChildIdentityChallenge" family_identity
    WHERE family_identity."userId"=${alias}.id AND family_identity."usedAt" IS NOT NULL))`;
}
function assertChallenge(c: Challenge | undefined, actor: ChildActor, sessionHash: string) {
  if (!c || c.userId !== actor.id || c.sessionHash !== sessionHash) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
  return c;
}
async function lockProof(tx: Db, actor: ChildActor, sessionHash: string) {
  const rows = await tx.$queryRawUnsafe<Challenge[]>(`SELECT * FROM "ChildIdentityChallenge"
    WHERE "userId"=$1 AND "sessionHash"=$2 AND "usedAt" IS NOT NULL
      AND "proofExpiresAt">NOW() AND "proofUsedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`, actor.id, sessionHash);
  const c = assertChallenge(rows[0], actor, sessionHash);
  if (!c.verifiedName || !c.proofExpiresAt || c.proofExpiresAt <= new Date() || c.proofUsedAt) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
  return c;
}
/** 외부 발송 없이 이 계정·이 기기에만 쓸 수 있는 단회 인증 건을 발급한다. */
export async function startChildVerification(actor: ChildActor, sessionHash: string) {
  await requireChildConnections();
  if (!getPortoneConfig() || !process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY) throw new ChildConnectionError("본인인증을 준비 중입니다.", 503);
  const id = `stizchild_${randomUUID()}`;
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, `child-verify:${actor.id}`);
    const counts = await tx.$queryRawUnsafe<{ count: number }[]>(`SELECT COUNT(*)::int AS count FROM "ChildIdentityChallenge"
      WHERE "userId"=$1 AND "createdAt">NOW()-INTERVAL '1 hour'`, actor.id);
    if (counts[0].count >= 5) throw new ChildConnectionError("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429);
    await tx.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "verifiedName"=NULL
      WHERE "userId"=$1 AND "proofExpiresAt"<NOW()`, actor.id);
    await tx.$executeRawUnsafe(`INSERT INTO "ChildIdentityChallenge"(id,"userId","sessionHash","expiresAt")
      VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`, id, actor.id, sessionHash);
  }, { isolationLevel: "Serializable" });
  return { identityVerificationId: id };
}
async function grant(tx: Db, studentId: string, actorId: string, source: string, approver: string | null, restore = false) {
  return tx.$executeRawUnsafe(`INSERT INTO "ParentStudentAccess"(id,"studentId","userId",status,source,"approvedBy")
    VALUES($1,$2,$3,'ACTIVE',$4,$5) ON CONFLICT("studentId","userId") ${restore
      ? `DO UPDATE SET status='ACTIVE',source=EXCLUDED.source,"approvedBy"=EXCLUDED."approvedBy","updatedAt"=NOW()`
      : `DO NOTHING`}`, randomUUID(), studentId, actorId, source, approver);
}
/** 명의 자료는 브라우저에서 받지 않고 포트원에서 다시 읽는다. 기존 로그인·역할·대표 보호자는 바꾸지 않는다. */
export async function verifyChildIdentity(actor: ChildActor, sessionHash: string, id: string) {
  await requireChildConnections();
  const attempts = await prisma.$queryRawUnsafe<Challenge[]>(`UPDATE "ChildIdentityChallenge" SET "verifyAttempts"="verifyAttempts"+1
    WHERE id=$1 AND "userId"=$2 AND "sessionHash"=$3 AND "usedAt" IS NULL AND "expiresAt">NOW()
      AND "verifyAttempts"<5 RETURNING *`, id, actor.id, sessionHash);
  const challenge = assertChallenge(attempts[0], actor, sessionHash);
  const config = getPortoneConfig();
  if (!config) throw new ChildConnectionError("본인인증을 준비 중입니다.", 503);
  const lookup = await fetchPortoneIdentityVerification(id, config).catch(() => null);
  if (!lookup?.ok) throw new ChildConnectionError("본인인증 결과를 확인하지 못했습니다. 다시 시도해 주세요.", 503);
  // PortOne 공식 V2 응답의 id·SelectedChannel.key를 함께 확인한다. 공유 스토어의 다른 채널 결과는 거부한다.
  const v = lookup.data as typeof lookup.data & { id?: string; channel?: { key?: string } };
  const at = Date.parse(v.verifiedAt ?? v.statusChangedAt ?? "");
  const name = identityName(v.verifiedCustomer?.name);
  const phone = identityPhone(v.verifiedCustomer?.phoneNumber);
  const birth = v.verifiedCustomer?.birthDate;
  if (v.id !== id || !v.channel?.key || v.channel.key !== process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY
    || v.status !== "VERIFIED" || !Number.isFinite(at) || at < new Date(challenge.createdAt).getTime()-60_000
    || at > Date.now()+60_000 || Date.now()-at > 600_000 || !name || !/^01\d{8,9}$/.test(phone) || !validBirth(birth)) {
    throw new ChildConnectionError("본인인증 정보를 확인하지 못했습니다. 다시 인증해 주세요.");
  }
  const adult = canConnectSelf(birth, todayKst());
  const linkedCount = await prisma.$transaction(async tx => {
    const consumed = await tx.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "usedAt"=NOW(),"verifiedName"=$4,
      "phoneHash"=$5,"phoneLast4"=$6,"birthHash"=$7,"proofExpiresAt"=NOW()+INTERVAL '20 minutes'
      WHERE id=$1 AND "userId"=$2 AND "sessionHash"=$3 AND "usedAt" IS NULL AND "expiresAt">NOW()`,
      id, actor.id, sessionHash, String(v.verifiedCustomer!.name).trim().slice(0,100), childIdentityHash(`phone:${phone}`), phone.slice(-4), childIdentityHash(`birth:${birth}`));
    if (consumed !== 1) throw new ChildConnectionError("이미 사용했거나 만료된 본인인증입니다.", 409);
    // 이미 등록된 현재 계정의 이름·번호도 명의 정보와 같을 때만 인증 사실을 기록한다.
    // 번호나 이름을 바꾸거나 다른 계정으로 로그인시키지 않는다.
    await tx.$executeRawUnsafe(`UPDATE "User" SET "phoneVerifiedAt"=NOW(),"updatedAt"=NOW()
      WHERE id=$1 AND "withdrawnAt" IS NULL
       AND regexp_replace(lower(normalize(name,NFC)), '\\s','','g')=$2
       AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$3`,actor.id,name,phone);
    // 성인 본인: 학생 자신의 이름·생일·학생 연락처만 인정한다. 보호자 번호로 성인 본인을 판단하지 않는다.
    const self = adult ? await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT s.id FROM "Student" s
      WHERE s."mergedIntoStudentId" IS NULL AND regexp_replace(lower(normalize(s.name,NFC)), '\\s','','g')=$1
       AND s."birthDate"::date=$2::date AND regexp_replace(COALESCE(s.phone,''),'[^0-9]','','g')=$3`, name, birth, phone) : [];
    // 학원이 이미 등록한 연락처만 자동 연결한다. 미등록 부모는 기존 연결 가족의 승인으로만 연결한다.
    const children = await tx.$queryRawUnsafe<{ id: string; parentId: string }[]>(`SELECT DISTINCT s.id,s."parentId" FROM "Student" s JOIN "User" p ON p.id=s."parentId"
      WHERE s."mergedIntoStudentId" IS NULL AND p."withdrawnAt" IS NULL
       AND s."birthDate"::date > ($3::date - INTERVAL '19 years') AND s."birthDate"::date <= $3::date AND (
       (regexp_replace(COALESCE(p.phone,''),'[^0-9]','','g')=$2 AND regexp_replace(lower(normalize(p.name,NFC)), '\\s','','g')=$1)
       OR EXISTS(SELECT 1 FROM "Guardian" g WHERE g."studentId"=s.id
        AND regexp_replace(COALESCE(g.phone,''),'[^0-9]','','g')=$2 AND regexp_replace(lower(normalize(g.name,NFC)), '\\s','','g')=$1))`, name, phone, todayKst());
    let count = 0;
    if (self.length === 1) count += await grant(tx,self[0].id,actor.id,"ADULT_SELF",null);
    // 형제는 함께 연결하지만 같은 연락처가 여러 가족 계정에 겹치면 추측하지 않는다.
    if (new Set(children.map(row => row.parentId)).size === 1) {
      for (const row of children) count += await grant(tx,row.id,actor.id,"REGISTERED_CONTACT",null);
    }
    return count;
  }, { isolationLevel: "Serializable" });
  return { verified: true, linkedCount };
}

type FamilyInput = { familyName?: unknown; familyPhone?: unknown; childName?: unknown; childBirthDate?: unknown; relation?: unknown };
export async function requestChildConnection(actor: ChildActor, sessionHash: string, input: FamilyInput) {
  await requireChildConnections();
  // 실패한 이름·번호 대조도 횟수에 포함한다. 응답을 바꿔가며 학생/가족을 검색할 수 없게 한다.
  const proof = await prisma.$transaction(async tx => {
    const c = await lockProof(tx,actor,sessionHash);
    if (c.requestAttempts >= 5) throw new ChildConnectionError("요청이 많습니다. 잠시 후 다시 인증해 주세요.",429);
    await tx.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "requestAttempts"="requestAttempts"+1 WHERE id=$1`,c.id);
    return c;
  });
  const familyName=identityName(input.familyName), familyPhone=identityPhone(input.familyPhone), childName=identityName(input.childName);
  if (!familyName || familyName.length>100 || !/^01\d{8,9}$/.test(familyPhone) || !childName || childName.length>100
      || !["PARENT","OTHER"].includes(String(input.relation)) || (input.childBirthDate && !validBirth(input.childBirthDate))) throw new ChildConnectionError(CHILD_LINK_UNAVAILABLE);
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,`child-request:${actor.id}`);
    const current = await lockProof(tx,actor,sessionHash);
    if (current.id !== proof.id) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
    const rows = await tx.$queryRawUnsafe<{ studentId:string; approverId:string }[]>(`SELECT DISTINCT s.id AS "studentId", u.id AS "approverId"
      FROM "User" u JOIN "Student" s ON (s."parentId"=u.id OR EXISTS(SELECT 1 FROM "ParentStudentAccess" a
         WHERE a."studentId"=s.id AND a."userId"=u.id AND a.status='ACTIVE'))
      WHERE u.id<>$1 AND ${trustedFamilyLoginSql("u")} AND u."withdrawnAt" IS NULL AND u."phoneVerifiedAt" IS NOT NULL
       AND regexp_replace(lower(normalize(u.name,NFC)), '\\s','','g')=$2
       AND regexp_replace(COALESCE(u.phone,''),'[^0-9]','','g')=$3
       AND s."mergedIntoStudentId" IS NULL AND regexp_replace(lower(normalize(s.name,NFC)), '\\s','','g')=$4
       AND ($5::date IS NULL OR s."birthDate"::date=$5::date)
       AND s."birthDate"::date > ($6::date - INTERVAL '19 years') AND s."birthDate"::date <= $6::date
       LIMIT 2`,actor.id,familyName,familyPhone,childName,input.childBirthDate || null,todayKst());
    if (rows.length!==1) throw new ChildConnectionError(CHILD_LINK_UNAVAILABLE);
    const row=rows[0];
    // 이미 연결된 본인·중복 요청은 같은 안내로 끝낸다. 대표 보호자와 수신자는 변경하지 않는다.
    const existing=await tx.$queryRawUnsafe<{ found:boolean }[]>(`SELECT EXISTS(SELECT 1 FROM "Student" s WHERE s.id=$1 AND s."mergedIntoStudentId" IS NULL
      AND (s."parentId"=$2 OR EXISTS(SELECT 1 FROM "ParentStudentAccess" a WHERE a."studentId"=s.id AND a."userId"=$2 AND a.status='ACTIVE'))
      UNION ALL SELECT 1 FROM "ChildLinkRequest" WHERE "studentId"=$1 AND "requesterId"=$2 AND status='PENDING' AND "expiresAt">NOW()) AS found`,row.studentId,actor.id);
    if(existing[0].found) throw new ChildConnectionError(CHILD_LINK_UNAVAILABLE);
    await tx.$executeRawUnsafe(`UPDATE "ChildLinkRequest" SET status='EXPIRED',"decidedAt"=NOW()
      WHERE "requesterId"=$1 AND status='PENDING' AND "expiresAt"<=NOW()`,actor.id);
    await tx.$executeRawUnsafe(`INSERT INTO "ChildLinkRequest"(id,"studentId","requesterId","approverId","challengeId",
      "requesterName","requesterPhoneLast4",relation,"expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+INTERVAL '7 days')`,
      randomUUID(),row.studentId,actor.id,row.approverId,current.id,current.verifiedName,current.phoneLast4,String(input.relation));
    await tx.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "proofUsedAt"=NOW(),"verifiedName"=NULL WHERE id=$1`,current.id);
  },{isolationLevel:"Serializable"});
  return {ok:true};
}
export async function decideChildConnection(actor:ChildActor,requestId:string,decision:string) {
  await requireChildConnections();
  if(!["APPROVE","REJECT"].includes(decision)) throw new ChildConnectionError("처리 방법을 확인해 주세요.");
  await prisma.$transaction(async tx=>{
    const rows=await tx.$queryRawUnsafe<{studentId:string;requesterId:string;approverId:string;status:string;expiresAt:Date}[]>(
      `SELECT * FROM "ChildLinkRequest" WHERE id=$1 FOR UPDATE`,requestId);
    const row=rows[0];
    if(!row || row.approverId!==actor.id || row.requesterId===actor.id || row.status!=="PENDING" || row.expiresAt<=new Date()) throw new ChildConnectionError("처리할 연결 요청이 없습니다.",409);
    const permission=await tx.$queryRawUnsafe<{id:string}[]>(`SELECT s.id FROM "Student" s JOIN "User" u ON u.id=$2
      WHERE s.id=$1 AND s."mergedIntoStudentId" IS NULL AND u."withdrawnAt" IS NULL AND ${trustedFamilyLoginSql("u")}
       AND u."phoneVerifiedAt" IS NOT NULL AND s."birthDate"::date > ($3::date - INTERVAL '19 years') AND s."birthDate"::date <= $3::date
       AND (s."parentId"=$2 OR EXISTS(SELECT 1 FROM "ParentStudentAccess" a
         WHERE a."studentId"=s.id AND a."userId"=$2 AND a.status='ACTIVE')) FOR UPDATE OF s,u`,row.studentId,actor.id,todayKst());
    if(permission.length!==1) throw new ChildConnectionError("현재 자녀 연결 상태를 확인할 수 없습니다.",403);
    const requester=await tx.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "User" WHERE id=$1 AND "withdrawnAt" IS NULL FOR UPDATE`,row.requesterId);
    if(!requester.length) throw new ChildConnectionError("처리할 연결 요청이 없습니다.",409);
    if(decision==="APPROVE") await grant(tx,row.studentId,row.requesterId,"FAMILY_APPROVAL",actor.id,true);
    await tx.$executeRawUnsafe(`UPDATE "ChildLinkRequest" SET status=$2,"decidedAt"=NOW(),"decidedBy"=$3 WHERE id=$1`,requestId,decision==="APPROVE"?"APPROVED":"REJECTED",actor.id);
  },{isolationLevel:"Serializable"});
  return {ok:true};
}
export async function cancelChildConnection(actor:ChildActor,requestId:string) {
  await requireChildConnections();
  const count=await prisma.$executeRawUnsafe(`UPDATE "ChildLinkRequest" SET status='CANCELED',"decidedAt"=NOW(),"decidedBy"=$2
    WHERE id=$1 AND "requesterId"=$2 AND status='PENDING' AND "expiresAt">NOW()`,requestId,actor.id);
  if(count!==1) throw new ChildConnectionError("취소할 연결 요청이 없습니다.",409);
  return {ok:true};
}
export async function getChildConnectionState(actor:ChildActor,sessionHash:string) {
  if(!childConnectionsConfigured() || !await childConnectionsAvailable()) return {enabled:false,verified:false,outgoing:[],incoming:[]};
  await prisma.$executeRawUnsafe(`UPDATE "ChildIdentityChallenge" SET "verifiedName"=NULL WHERE "userId"=$1 AND "proofExpiresAt"<NOW()`,actor.id);
  const proof=await prisma.$queryRawUnsafe<{found:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "ChildIdentityChallenge" WHERE "userId"=$1
    AND "sessionHash"=$2 AND "proofExpiresAt">NOW() AND "proofUsedAt" IS NULL AND "usedAt" IS NOT NULL AND "requestAttempts"<5) AS found`,actor.id,sessionHash);
  const outgoing=await prisma.$queryRawUnsafe(`SELECT id,CASE WHEN status='PENDING' AND "expiresAt"<=NOW() THEN 'EXPIRED' ELSE status END AS status,
    relation,"createdAt" FROM "ChildLinkRequest" WHERE "requesterId"=$1 ORDER BY "createdAt" DESC LIMIT 30`,actor.id);
  const incoming=await prisma.$queryRawUnsafe(`SELECT r.id,r.status,r.relation,r."createdAt",s.name AS "childName",r."requesterName",
    r."requesterPhoneLast4" FROM "ChildLinkRequest" r JOIN "Student" s ON s.id=r."studentId"
    JOIN "User" applicant ON applicant.id=r."requesterId" AND applicant."withdrawnAt" IS NULL
    WHERE r."approverId"=$1 AND r.status='PENDING' AND r."expiresAt">NOW() AND s."mergedIntoStudentId" IS NULL
      AND EXISTS(SELECT 1 FROM "User" reviewer WHERE reviewer.id=$1 AND reviewer."withdrawnAt" IS NULL
        AND ${trustedFamilyLoginSql("reviewer")} AND reviewer."phoneVerifiedAt" IS NOT NULL)
      AND ${await childAccessSql("s","$1")} ORDER BY r."createdAt" DESC LIMIT 30`,actor.id);
  return {enabled:true,verified:proof[0].found,outgoing,incoming};
}
