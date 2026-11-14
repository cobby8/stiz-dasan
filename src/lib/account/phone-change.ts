import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { fetchPortoneIdentityVerification, getPortoneConfig } from "@/lib/identity/portone";
import { isUsablePhoneKey } from "@/lib/enrollment/parentIdentity";
import { ChildConnectionError, childConnectionsConfigured, type ChildActor } from "./child-links";
import { childConnectionsAvailable } from "./child-access";
import { identityName, identityPhone, isSerializationConflict } from "./child-link-policy";
import { phoneChangeOutcome, PHONE_CHANGE_ID_PREFIX } from "./phone-change-rules";

/**
 * 보호자 «연락처 바꾸기» (2026-11-14 원장 결정 b6).
 *
 * 왜: 계정 전화번호(User.phone)는 «가입할 때 학원이 만든 계정을 찾는 열쇠»이자 «자녀 연결의 본인 확인 번호»다
 *   (parent-account-claim · child-links 가 User.phone 과 Guardian.phone 을 숫자만 비교한다).
 *   그래서 예전에는 «변경은 학원 문의»였다. 이제 본인 명의 휴대폰 인증(포트원 — 자녀 연결과 같은 흐름)을
 *   통과한 번호로만 학부모가 직접 바꾼다.
 *
 * 지키는 것:
 *   · 인증 없이 번호를 바꾸는 길은 없다 — 새 번호는 화면이 아니라 포트원 재조회 결과에서만 온다.
 *   · 인증 건은 이 계정·이 기기(쿠키 해시)에서 시작한 1회용(10분)이고, 자녀 연결 인증 건과 섞이지 않는다
 *     (id 머리말 stizphone_ + 기기 해시 종류가 다르다 + 쓰자마자 proofUsedAt 을 찍어 «연결 요청 증명»이 되지 않는다).
 *   · 인증한 이름이 계정 이름과 같아야 한다(phoneVerifiedAt = «이름·번호 모두 본인» 이라는 기존 뜻을 지킨다).
 *   · 다른 계정이 이미 쓰는 번호면 거절한다(같은 번호 계정이 둘이면 가입·연결이 막힌다).
 *   · 바꾼 뒤 — 내 아이들의 보호자 연락처(Guardian) 중 «내 이름 + 옛 내 번호»인 줄만 새 번호로 맞춘다
 *     (자동 연결 규칙 child-links 와 같은 «이름+번호» 기준 — 같은 번호를 적어 둔 배우자 줄은 덮지 않는다).
 *   · 이력: OperationsAuditLog 에 PARENT_PHONE_CHANGED(옛·새 번호 끝 4자리·계정 id·시각)를 같은 트랜잭션에서 남긴다.
 *   · 번호 원문은 로그에 남기지 않는다.
 */

/** 본인인증 설정이 켜져 있고 인증 원장(ChildIdentityChallenge)이 준비된 환경인가 — 아니면 화면은 기존 안내를 유지한다 */
export async function phoneChangeAvailable(): Promise<boolean> {
  return childConnectionsConfigured() && await childConnectionsAvailable();
}

async function requirePhoneChange() {
  if (!await phoneChangeAvailable()) throw new ChildConnectionError("연락처 바꾸기를 준비 중입니다.", 503);
}

/** 이 계정·이 기기에서만 쓸 수 있는 1회용 인증 건을 발급한다(시간당 5건 — 자녀 연결 인증과 합산) */
export async function startPhoneChange(actor: ChildActor, sessionHash: string) {
  await requirePhoneChange();
  const id = `${PHONE_CHANGE_ID_PREFIX}${randomUUID()}`;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, `child-verify:${actor.id}`);
    const counts = await tx.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM "ChildIdentityChallenge" WHERE "userId"=$1 AND "createdAt">NOW()-INTERVAL '1 hour'`,
      actor.id,
    );
    if (counts[0].count >= 5) throw new ChildConnectionError("요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429);
    await tx.$executeRawUnsafe(
      `INSERT INTO "ChildIdentityChallenge"(id,"userId","sessionHash","expiresAt") VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`,
      id,
      actor.id,
      sessionHash,
    );
  }, { isolationLevel: "Serializable" });
  return { identityVerificationId: id };
}

/** 인증 결과를 포트원에서 다시 읽어 확인하고, 통과하면 계정 번호를 인증된 번호로 바꾼다 */
export type PhoneChangeDone = {
  ok: true;
  changed: boolean;
  /** 관리자 알림용(화면 응답에는 싣지 않는다) — 계정 이름·새 번호 끝 4자리·내 아이 한 명(학생 상세 링크) */
  notify: { accountName: string; newLast4: string; studentId: string | null } | null;
};

export async function confirmPhoneChange(actor: ChildActor, sessionHash: string, id: string): Promise<PhoneChangeDone> {
  await requirePhoneChange();
  if (!id.startsWith(PHONE_CHANGE_ID_PREFIX)) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
  // 시도 횟수 먼저 올린다(5회) — 이 계정·이 기기에서 시작한, 아직 안 쓴, 10분 안의 건만
  const attempts = await prisma.$queryRawUnsafe<{ id: string; createdAt: Date }[]>(
    `UPDATE "ChildIdentityChallenge" SET "verifyAttempts"="verifyAttempts"+1
      WHERE id=$1 AND "userId"=$2 AND "sessionHash"=$3 AND "usedAt" IS NULL AND "expiresAt">NOW() AND "verifyAttempts"<5
      RETURNING id, "createdAt"`,
    id,
    actor.id,
    sessionHash,
  );
  const challenge = attempts[0];
  if (!challenge) throw new ChildConnectionError("본인인증을 다시 진행해 주세요.");
  const config = getPortoneConfig();
  if (!config) throw new ChildConnectionError("본인인증을 준비 중입니다.", 503);
  const lookup = await fetchPortoneIdentityVerification(id, config).catch(() => null);
  if (!lookup?.ok) throw new ChildConnectionError("본인인증 결과를 확인하지 못했습니다. 다시 시도해 주세요.", 503);
  // 자녀 연결(verifyChildIdentity)과 같은 확인: 건 번호·채널·상태·인증 시각(시작 이후 10분 안)
  const v = lookup.data as typeof lookup.data & { id?: string; channel?: { key?: string } };
  const at = Date.parse(v.verifiedAt ?? v.statusChangedAt ?? "");
  const name = identityName(v.verifiedCustomer?.name);
  const phone = identityPhone(v.verifiedCustomer?.phoneNumber);
  if (v.id !== id || !v.channel?.key || v.channel.key !== process.env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY
    || v.status !== "VERIFIED" || !Number.isFinite(at) || at < new Date(challenge.createdAt).getTime() - 60_000
    || at > Date.now() + 60_000 || Date.now() - at > 600_000 || !name || !/^01\d{8,9}$/.test(phone) || !isUsablePhoneKey(phone)) {
    throw new ChildConnectionError("본인인증 정보를 확인하지 못했습니다. 다시 인증해 주세요.");
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // 같은 번호로 동시에 바꾸는 두 계정을 줄 세운다
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, `phone-change:${phone}`);
      const consumed = await tx.$executeRawUnsafe(
        // proofUsedAt 을 함께 찍는다 — 이 인증 건은 «가족 연결 요청 증명»으로는 쓰이지 않는다
        `UPDATE "ChildIdentityChallenge" SET "usedAt"=NOW(), "proofUsedAt"=NOW(), "phoneLast4"=$4
          WHERE id=$1 AND "userId"=$2 AND "sessionHash"=$3 AND "usedAt" IS NULL AND "expiresAt">NOW()`,
        id,
        actor.id,
        sessionHash,
        phone.slice(-4),
      );
      if (consumed !== 1) throw new ChildConnectionError("이미 사용했거나 만료된 본인인증입니다.", 409);
      const me = await tx.$queryRawUnsafe<{ name: string | null; phone: string | null }[]>(
        `SELECT name, phone FROM "User" WHERE id=$1 AND "withdrawnAt" IS NULL FOR UPDATE`,
        actor.id,
      );
      if (!me[0]) throw new ChildConnectionError("학원 계정으로 로그인해 주세요.", 401);
      const taken = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "User"
          WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$1 AND id<>$2 AND "withdrawnAt" IS NULL LIMIT 1`,
        phone,
        actor.id,
      );
      const oldPhone = identityPhone(me[0].phone);
      const outcome = phoneChangeOutcome({
        accountName: identityName(me[0].name),
        verifiedName: name,
        currentPhone: oldPhone,
        verifiedPhone: phone,
        takenByOther: taken.length > 0,
      });
      if (!outcome.ok) throw new ChildConnectionError(outcome.error, outcome.status);
      await tx.$executeRawUnsafe(
        `UPDATE "User" SET phone=$1, "phoneVerifiedAt"=NOW(), "updatedAt"=NOW() WHERE id=$2 AND "withdrawnAt" IS NULL`,
        phone,
        actor.id,
      );
      if (!outcome.changed) return { ok: true as const, changed: false, notify: null };
      // 이력(감사 기록) — 번호 원문은 남기지 않는다(끝 4자리만). 같은 트랜잭션이라 변경과 함께 남거나 함께 되돌아간다
      await tx.$executeRawUnsafe(
        `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
         VALUES (gen_random_uuid()::text, 'PARENT_PHONE_CHANGED', 'PARENT', $1, $2::jsonb)`,
        actor.id,
        JSON.stringify({ oldLast4: oldPhone.slice(-4) || null, newLast4: phone.slice(-4), via: "IDENTITY_VERIFICATION" }),
      );
      if (isUsablePhoneKey(oldPhone)) {
        // 내 아이(대표 보호자이거나 연결된 가족)의 보호자 연락처 중 «내 이름 + 옛 내 번호» 줄만 새 번호로
        //  — 다른 가정 학생·같은 번호를 적어 둔 다른 사람(배우자) 줄은 건드리지 않는다
        await tx.$executeRawUnsafe(
          `UPDATE "Guardian" g SET phone=$1, "updatedAt"=NOW()
            WHERE regexp_replace(COALESCE(g.phone,''),'[^0-9]','','g')=$2
              AND regexp_replace(lower(normalize(g.name,NFC)), '\\s','','g')=$4
              -- 그 학생에 이미 새 번호 줄이 있으면 같은 번호가 두 줄이 되지 않게 그대로 둔다
              AND NOT EXISTS (SELECT 1 FROM "Guardian" o WHERE o."studentId"=g."studentId" AND o.id<>g.id
                               AND regexp_replace(COALESCE(o.phone,''),'[^0-9]','','g')=$1)
              AND g."studentId" IN (
                SELECT s.id FROM "Student" s
                 WHERE s."mergedIntoStudentId" IS NULL AND (s."parentId"=$3 OR EXISTS(
                   SELECT 1 FROM "ParentStudentAccess" a WHERE a."studentId"=s.id AND a."userId"=$3 AND a.status='ACTIVE')))`,
          phone,
          oldPhone,
          actor.id,
          name,
        );
      }
      // 관리자 알림에 붙일 학생 상세 링크용 — 내가 대표 보호자인 아이 한 명(없으면 링크 없이)
      const kid = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT s.id FROM "Student" s WHERE s."parentId"=$1 AND s."mergedIntoStudentId" IS NULL ORDER BY s."createdAt" LIMIT 1`,
        actor.id,
      );
      return { ok: true as const, changed: true, notify: { accountName: String(me[0].name ?? "").trim() || "보호자", newLast4: phone.slice(-4), studentId: kid[0]?.id ?? null } };
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (isSerializationConflict(error)) throw new ChildConnectionError("잠시 후 다시 시도해 주세요.", 409);
    throw error;
  }
}
