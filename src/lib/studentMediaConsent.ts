import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mapDraft } from "@/lib/socialDrafts";
import type { SocialPostDraft } from "@/lib/socialDrafts";
import {
  evaluateMediaConsent,
  type MediaConsentCheck,
  type MediaConsentRow,
  type MediaConsentScope,
} from "@/lib/studentMediaConsentPolicy";

export { evaluateMediaConsent } from "@/lib/studentMediaConsentPolicy";
export type { MediaConsentCheck, MediaConsentScope } from "@/lib/studentMediaConsentPolicy";

/**
 * 공개 게시(갤러리·인스타) 전에 사진 공개 동의를 검사할지 — 2026-11-14 원장 결정으로 끔(false).
 *
 * 왜: 사진 공개 동의 화면·«나온 학생» 선택을 없앴다(수업 사진은 그 수업 참여 학생 보호자만 본다).
 *     검사를 켜 둔 채면 새 수업 사진은 학생 태그가 비어 «학생 미지정»으로 공개 게시가 영원히 막힌다.
 * 대신: 공개 게시는 지금도 사람 손을 거친다 — 갤러리 = 관리자 승인(requireAdmin),
 *       인스타그램 = 원장 승인(requireOwner), 대기열도 원장이 승인한 건(PUBLISHING)만 처리한다.
 *       원장이 사진을 보고 올릴지 직접 판단한다.
 * 되돌리기: true 로 바꾸면 아래 기존 검사(최신 동의·철회·소속 확인)가 그대로 다시 돈다. 동의 기록 표는 지우지 않았다.
 */
export const PUBLIC_POST_CONSENT_GATE_ENABLED = false;

/** 게시 대상 학생 전원의 최신 동의를 읽으며, 누락이나 조회 오류는 공개 차단합니다(검사가 켜져 있을 때). */
export async function checkSocialDraftMediaConsent(
  draft: Pick<SocialPostDraft, "sessionId" | "classId" | "subjectStudentIds">,
  scope: MediaConsentScope,
  db: Pick<Prisma.TransactionClient, "$queryRawUnsafe"> = prisma,
): Promise<MediaConsentCheck> {
  if (!PUBLIC_POST_CONSENT_GATE_ENABLED) {
    // 동의 검사 없이 통과 — 공개 여부는 관리자·원장 수동 승인이 정한다(위 설명)
    return { ok: true, scope, studentCount: draft.subjectStudentIds.length, blockedStudents: [] };
  }
  if ((!draft.sessionId && !draft.classId) || draft.subjectStudentIds.length === 0) {
    return { ok: false, scope, studentCount: 0, blockedStudents: [
      { id: "UNKNOWN", name: "학생 미지정", reason: "수업 연결 정보 없음" },
    ] };
  }

  try {
    const rows = await db.$queryRawUnsafe<MediaConsentRow[]>(
      `WITH requested AS (
         SELECT DISTINCT value AS id FROM jsonb_array_elements_text($3::jsonb)
       ), target_class AS (
         SELECT s."classId" FROM "Session" s
          WHERE s.id = $1 AND ($2::text IS NULL OR s."classId" = $2)
         UNION ALL
         SELECT $2::text WHERE $1::text IS NULL AND $2::text IS NOT NULL
       ), eligible_students AS (
         SELECT a."studentId" AS id
           FROM "Attendance" a
           JOIN target_class tc ON tc."classId" = (
             SELECT s."classId" FROM "Session" s WHERE s.id = a."sessionId"
           )
          WHERE a."sessionId" = $1
         UNION
         SELECT e."studentId" FROM "Enrollment" e
          WHERE e."classId" IN (SELECT "classId" FROM target_class) AND e.status = 'ACTIVE'
       ), latest_consent AS (
         SELECT DISTINCT ON (c."studentId") c."studentId", c."internalAllowed",
                c."galleryAllowed", c."instagramAllowed", c."revokedAt"
           FROM "StudentMediaConsent" c
          ORDER BY c."studentId", c."recordedAt" DESC, c.id DESC
       )
       SELECT q.id AS "studentId", COALESCE(s.name, '알 수 없는 학생') AS "studentName",
              COALESCE(c."internalAllowed", false) AS "internalAllowed",
              COALESCE(c."galleryAllowed", false) AS "galleryAllowed",
              COALESCE(c."instagramAllowed", false) AS "instagramAllowed", c."revokedAt",
              (e.id IS NOT NULL AND s.id IS NOT NULL) AS "isRelated"
         FROM requested q
         LEFT JOIN "Student" s ON s.id = q.id
         LEFT JOIN eligible_students e ON e.id = q.id
         LEFT JOIN latest_consent c ON c."studentId" = q.id
        ORDER BY s.name, q.id`,
      draft.sessionId ?? null,
      draft.classId ?? null,
      JSON.stringify(draft.subjectStudentIds),
    );
    if (rows.length === 0) {
      return { ok: false, scope, studentCount: 0, blockedStudents: [
        { id: "UNKNOWN", name: "학생 미확인", reason: "게시 대상 학생을 확인할 수 없음" },
      ] };
    }
    return evaluateMediaConsent(rows, scope);
  } catch (error) {
    console.error("[media-consent] fail-closed", {
      scope, sessionId: draft.sessionId, classId: draft.classId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, scope, studentCount: 0, blockedStudents: [
      { id: "SYSTEM", name: "동의 원장", reason: "동의 정보를 확인할 수 없음" },
    ] };
  }
}

export async function withSocialDraftMediaConsentLock<T>(
  draft: Pick<SocialPostDraft, "sessionId" | "classId" | "subjectStudentIds">,
  scope: MediaConsentScope,
  work: () => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    for (const studentId of [...new Set(draft.subjectStudentIds)].sort()) {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, studentId);
    }
    const result = await checkSocialDraftMediaConsent(draft, scope, tx);
    if (!result.ok) {
      const names = result.blockedStudents.slice(0, 3).map((student) => student.name).join(", ");
      throw new Error(`사진 공개 동의를 확인할 수 없습니다 (${names || "대상 미확인"}).`);
    }
    return work();
  }, { maxWait: 10_000, timeout: 120_000 });
}

export async function withSocialDraftPublicationReservation<T>(
  draftId: string,
  scope: Extract<MediaConsentScope, "GALLERY" | "INSTAGRAM">,
  work: (snapshot: SocialPostDraft, attemptId: string) => Promise<T>,
) {
  const reserved = await prisma.$transaction(async (tx) => {
    const preliminaryRows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "SocialPostDraft" WHERE id=$1`, draftId);
    if (!preliminaryRows[0]) throw new Error("게시할 초안을 찾지 못했습니다.");
    const preliminary = mapDraft(preliminaryRows[0]);
    for (const studentId of [...new Set(preliminary.subjectStudentIds)].sort()) {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, studentId);
    }
    const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "SocialPostDraft" WHERE id=$1 FOR UPDATE`, draftId);
    if (!rows[0] || typeof rows[0].status !== "string" || !["READY", "FAILED", "PUBLISHING"].includes(rows[0].status)) throw new Error("게시할 수 있는 초안이 아닙니다.");
    const snapshot = mapDraft(rows[0]);
    const subjects = [...new Set(snapshot.subjectStudentIds)].sort();
    if (JSON.stringify(subjects) !== JSON.stringify([...new Set(preliminary.subjectStudentIds)].sort())) {
      throw new Error("게시 대상 학생이 변경되어 다시 시도해야 합니다.");
    }
    const subjectJSON = JSON.stringify(subjects);
    const subjectHash = createHash("sha256").update(subjectJSON).digest("hex");
    const attemptId = randomUUID();
    const idempotencyKey = `${scope.toLowerCase()}:${draftId}:${attemptId}`;
    await tx.$executeRawUnsafe(`
      UPDATE "SocialPostDraft" SET status='PUBLISHING', "publicationSubjectsJSON"=$2,
        "publicationSubjectHash"=$3, "publishReservationId"=$4, "updatedAt"=NOW() WHERE id=$1
    `, draftId, subjectJSON, subjectHash, attemptId);
    await tx.$executeRawUnsafe(`
      INSERT INTO "SocialPublishAttempt" (id,"draftId",channel,"idempotencyKey","subjectSnapshotJSON","subjectSnapshotHash",state,"createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'PUBLISHING',NOW(),NOW())
    `, attemptId, draftId, scope, idempotencyKey, subjectJSON, subjectHash);
    return { snapshot: { ...snapshot, status: "PUBLISHING" as const, subjectStudentIds: subjects }, attemptId, subjectHash };
  });

  return prisma.$transaction(async (tx) => {
    for (const studentId of reserved.snapshot.subjectStudentIds) {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, studentId);
    }
    const rows = await tx.$queryRawUnsafe<Array<{ publishReservationId: string | null; publicationSubjectHash: string | null }>>(
      `SELECT "publishReservationId", "publicationSubjectHash" FROM "SocialPostDraft" WHERE id=$1`, draftId,
    );
    if (rows[0]?.publishReservationId !== reserved.attemptId || rows[0]?.publicationSubjectHash !== reserved.subjectHash) {
      throw new Error("게시 대상 학생 정보가 변경되어 게시를 중단했습니다.");
    }
    const consent = await checkSocialDraftMediaConsent(reserved.snapshot, scope, tx);
    if (!consent.ok) throw new Error("게시 직전 사진 공개 동의를 확인할 수 없습니다.");
    return work(reserved.snapshot, reserved.attemptId);
  }, { maxWait: 10_000, timeout: 120_000 });
}

export async function assertSocialDraftMediaConsent(
  draft: Pick<SocialPostDraft, "sessionId" | "classId" | "subjectStudentIds">,
  scope: MediaConsentScope,
) {
  const result = await checkSocialDraftMediaConsent(draft, scope);
  if (!result.ok) {
    const names = result.blockedStudents.slice(0, 3).map((student) => student.name).join(", ");
    throw new Error(`사진 공개 동의를 확인할 수 없습니다 (${names || "대상 미확인"}). 동의 상태를 확인해 주세요.`);
  }
  return result;
}
