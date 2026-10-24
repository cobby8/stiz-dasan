"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { POLICY_DOCUMENT_MAX } from "@/lib/kakao-policy-qa";

// 카카오 정책 답변 관리자 액션 — 원장(관리자) 전용. 화면에서 숨겨도 서버에서 다시 권한을 확인한다.

export type PolicyAdminResult = { ok: true } | { ok: false; error: string };

/** 정책 문서 저장 = 새 버전 한 줄 추가(이전 버전은 지우지 않는다 — 누가·언제·이전 내용이 남는다). */
export async function saveKakaoPolicyDocument(content: string): Promise<PolicyAdminResult> {
  const admin = await requireAdmin();
  const text = typeof content === "string" ? content.replace(/\r\n/g, "\n").trim() : "";
  if ([...text].length > POLICY_DOCUMENT_MAX) return { ok: false, error: `정책 문서는 ${POLICY_DOCUMENT_MAX.toLocaleString()}자까지 저장할 수 있어요.` };
  // 바로 직전 버전과 같으면 새 버전을 만들지 않는다(같은 내용이 이력을 가득 채우지 않게)
  const latest = await prisma.$queryRawUnsafe<Array<{ content: string }>>(
    `SELECT content FROM "KakaoPolicyDocumentVersion" ORDER BY "createdAt" DESC LIMIT 1`,
  );
  if (latest[0]?.content === text) return { ok: true };
  await prisma.$executeRawUnsafe(
    `INSERT INTO "KakaoPolicyDocumentVersion" (content, "editorUserId", "editorName") VALUES ($1, $2, $3)`,
    text, admin.appUserId, admin.appUserName,
  );
  revalidatePath("/admin/kakao-policy");
  return { ok: true };
}

/** 정책 답변 켜기/끄기(킬 스위치). 끄면 카카오 챗봇이 기존 동작과 100% 같아진다. */
export async function setKakaoPolicyQaEnabled(enabled: boolean): Promise<PolicyAdminResult> {
  const admin = await requireAdmin();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "KakaoPolicyQaSetting" (id, enabled, "updatedByUserId", "updatedByName", "updatedAt")
     VALUES ('default', $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, "updatedByUserId" = EXCLUDED."updatedByUserId",
       "updatedByName" = EXCLUDED."updatedByName", "updatedAt" = now()`,
    enabled === true, admin.appUserId, admin.appUserName,
  );
  revalidatePath("/admin/kakao-policy");
  return { ok: true };
}
