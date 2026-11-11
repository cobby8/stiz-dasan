"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { processMediaRevocationQueue } from "@/lib/mediaRevocationQueue";

export async function runMediaRevocationQueue() {
  await requireAdmin();
  const result = await processMediaRevocationQueue(20);
  revalidatePath("/admin/media-revocations");
  revalidatePath("/admin/gallery");
  revalidatePath("/gallery");
  revalidatePath("/");
  return result;
}

export async function confirmInstagramMediaRemoved(formData: FormData) {
  const admin = await requireAdmin();
  const jobId = formData.get("jobId");
  const evidence = String(formData.get("evidence") || "").trim().slice(0, 500);
  const safeId = typeof jobId === "string" ? jobId.trim().slice(0, 100) : "";
  if (!safeId) throw new Error("회수 작업 ID가 필요합니다.");
  if (evidence.length < 5) throw new Error("Instagram 삭제 확인 근거를 5자 이상 입력해 주세요.");
  const changed = await prisma.$transaction(async (tx) => {
    const jobs = await tx.$queryRawUnsafe<Array<{ studentId: string; resourceId: string | null }>>(`
      SELECT "studentId", "resourceId" FROM "MediaRevocationJob"
       WHERE id = $1 AND channel = 'INSTAGRAM' AND status = 'MANUAL_REQUIRED'
    `, safeId);
    if (!jobs[0]) return 0;
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text`, jobs[0].studentId);
    const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT id FROM "MediaRevocationJob"
       WHERE id = $1 AND channel = 'INSTAGRAM' AND status = 'MANUAL_REQUIRED' FOR UPDATE
    `, safeId);
    if (!locked[0]) return 0;
    const latest = await tx.$queryRawUnsafe<Array<{ revoked: boolean }>>(`
      SELECT ("revokedAt" IS NOT NULL) AS revoked FROM "StudentMediaConsent"
       WHERE "studentId" = $1 ORDER BY "recordedAt" DESC, id DESC LIMIT 1
    `, jobs[0].studentId);
    const ambiguous = jobs[0].resourceId
      ? await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "SocialPublishAttempt" WHERE id=$1 AND state='AMBIGUOUS'`, jobs[0].resourceId)
      : [];
    if (!latest[0]?.revoked && !ambiguous[0]) throw new Error("학생이 다시 동의하여 회수 확인을 완료할 수 없습니다.");
    return tx.$executeRawUnsafe(`
      UPDATE "MediaRevocationJob" SET status = 'REMOVED', "removedAt" = NOW(), "lastError" = NULL,
        "confirmationEvidenceJSON" = $2, "confirmedByUserId" = $3, "updatedAt" = NOW()
      WHERE id = $1 AND status = 'MANUAL_REQUIRED'
    `, safeId, JSON.stringify({ note: evidence, confirmedAt: new Date().toISOString() }), admin.appUserId);
  });
  if (changed !== 1) throw new Error("수동 회수 대기 작업을 찾을 수 없습니다.");
  revalidatePath("/admin/media-revocations");
}
