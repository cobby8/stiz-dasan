"use server";

import { userFacingError } from "@/lib/user-facing-error";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import { STUDENT_MEDIA_POLICY_VERSION } from "@/lib/studentMediaConsentAdmin";
import { validateStudentMediaConsentScopes } from "@/lib/studentMediaConsentAdminPolicy";
import { enqueueMediaRevocationsForStudent } from "@/lib/mediaRevocationQueue";

export type StudentMediaConsentActionResult = { ok: boolean; message: string };
const CONSENT_METHODS = new Set(["PHONE", "WRITTEN", "IN_PERSON", "DIGITAL"]);

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function getStudentGuardian(studentId: string) {
  const rows = await prisma.$queryRaw<Array<{ guardianUserId: string }>>`
    SELECT "parentId" AS "guardianUserId" FROM "Student" WHERE id = ${studentId} LIMIT 1
  `;
  if (!rows[0]) throw new Error("학생 정보를 찾을 수 없습니다.");
  return rows[0];
}

function refresh(studentId: string) {
  revalidatePath(`/admin/students/${studentId}`);
  revalidatePath(`/admin/students/${studentId}/media-consent`);
}

export async function recordStudentMediaConsent(input: {
  studentId: string;
  internalAllowed: boolean;
  galleryAllowed: boolean;
  instagramAllowed: boolean;
  method: string;
  guardianName?: string;
  note?: string;
}): Promise<StudentMediaConsentActionResult> {
  try {
    const admin = await requireAdmin();
    const studentId = cleanText(input.studentId, 100);
    const method = cleanText(input.method, 30);
    if (!studentId || !CONSENT_METHODS.has(method)) return { ok: false, message: "동의 확인 방법이 올바르지 않습니다." };
    if (typeof input.internalAllowed !== "boolean"
      || typeof input.galleryAllowed !== "boolean"
      || typeof input.instagramAllowed !== "boolean") {
      return { ok: false, message: "동의 범위 값이 올바르지 않습니다." };
    }
    const scopeError = validateStudentMediaConsentScopes(input);
    if (scopeError) return { ok: false, message: scopeError };

    const guardian = await getStudentGuardian(studentId);
    const evidenceJSON = JSON.stringify({
      method,
      guardianName: cleanText(input.guardianName, 60) || undefined,
      note: cleanText(input.note, 500) || undefined,
    });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${studentId}, 0))`;
      await tx.$executeRaw`
      INSERT INTO "StudentMediaConsent" (
        id, "studentId", "guardianUserId", "internalAllowed", "galleryAllowed", "instagramAllowed",
        "policyVersion", "evidenceJSON", "recordedByUserId", "recordedAt", "revokedAt"
      ) VALUES (
        gen_random_uuid()::text, ${studentId}, ${guardian.guardianUserId}, ${input.internalAllowed},
        ${input.galleryAllowed}, ${input.instagramAllowed}, ${STUDENT_MEDIA_POLICY_VERSION},
        ${evidenceJSON}, ${admin.appUserId}, now(), NULL
      )
      `;
    });
    refresh(studentId);
    return { ok: true, message: "사진 사용 동의를 새 이력으로 기록했습니다." };
  } catch (error) {
    console.error("Failed to record student media consent", error);
    return { ok: false, message: userFacingError(error, "동의를 기록하지 못했습니다.") };
  }
}

export async function revokeStudentMediaConsent(input: {
  studentId: string;
  note?: string;
}): Promise<StudentMediaConsentActionResult> {
  try {
    const admin = await requireAdmin();
    const studentId = cleanText(input.studentId, 100);
    if (!studentId) return { ok: false, message: "학생 정보가 올바르지 않습니다." };
    const guardian = await getStudentGuardian(studentId);
    const evidenceJSON = JSON.stringify({ method: "WITHDRAWAL", note: cleanText(input.note, 500) || undefined });
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${studentId}, 0))`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "StudentMediaConsent" (
        id, "studentId", "guardianUserId", "internalAllowed", "galleryAllowed", "instagramAllowed",
        "policyVersion", "evidenceJSON", "recordedByUserId", "recordedAt", "revokedAt"
      ) VALUES (
        gen_random_uuid()::text, ${studentId}, ${guardian.guardianUserId}, false, false, false,
        ${STUDENT_MEDIA_POLICY_VERSION}, ${evidenceJSON}, ${admin.appUserId}, now(), now()
      ) RETURNING id
      `;
      if (!rows[0]) throw new Error("동의 철회 기록을 저장하지 못했습니다.");
      await enqueueMediaRevocationsForStudent(tx, studentId, rows[0].id);
    });
    refresh(studentId);
    return { ok: true, message: "동의를 철회했습니다. 새 사진 공개는 즉시 차단됩니다." };
  } catch (error) {
    console.error("Failed to revoke student media consent", error);
    return { ok: false, message: userFacingError(error, "동의를 철회하지 못했습니다.") };
  }
}
