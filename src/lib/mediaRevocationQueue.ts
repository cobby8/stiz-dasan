import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { MEDIA_REVOCATION_MAX_ATTEMPTS, mediaRevocationRetryDelayMs } from "@/lib/mediaRevocationPolicy";
import { collectPublishedMediaCopyPaths, PUBLIC_GALLERY_BUCKET, removePublishedStoragePaths } from "@/lib/sessionPhotoStorage";

export type MediaRevocationStatus = "PENDING" | "PROCESSING" | "REMOVED" | "FAILED" | "MANUAL_REQUIRED";
export type MediaRevocationJob = {
  id: string; studentId: string; draftId: string; channel: "GALLERY" | "INSTAGRAM";
  resourceId: string | null; resourceUrl: string | null; status: MediaRevocationStatus; attempts: number;
  lastError: string | null; lockedAt: Date | null; consentSnapshotJSON: string; draftSnapshotJSON: string;
  createdAt: Date; updatedAt: Date;
};

function snapshotConsentIsRevoked(snapshotJSON: string) {
  try {
    const snapshot = JSON.parse(snapshotJSON) as { revokedAt?: unknown };
    return typeof snapshot.revokedAt === "string" && snapshot.revokedAt.length > 0;
  } catch { return false; }
}

function snapshotDraftMediaJSON(snapshotJSON: string) {
  try {
    const snapshot = JSON.parse(snapshotJSON) as { mediaJSON?: unknown };
    return typeof snapshot.mediaJSON === "string" ? snapshot.mediaJSON : null;
  } catch { return null; }
}

export async function enqueueMediaRevocationsForStudent(
  tx: Prisma.TransactionClient,
  studentId: string,
  consentId: string,
) {
  return tx.$executeRawUnsafe(`
    INSERT INTO "MediaRevocationJob" (
      id, "studentId", "consentId", "draftId", channel, "resourceId", "resourceUrl", status,
      attempts, "nextAttemptAt", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid()::text, $1, $2, d.id, c.channel, c."resourceId", c."resourceUrl", 'PENDING', 0, NOW(), NOW(), NOW()
      FROM "SocialPostDraft" d
      CROSS JOIN LATERAL (VALUES
        ('GALLERY', d."galleryPostId", NULL::text),
        ('INSTAGRAM', d."instagramMediaId", d."instagramPermalink")
      ) AS c(channel, "resourceId", "resourceUrl")
     WHERE COALESCE(stiz_try_jsonb(d."subjectStudentIdsJSON") ? $1, false)
       AND c."resourceId" IS NOT NULL
    ON CONFLICT ("consentId", "draftId", channel) DO NOTHING
  `, studentId, consentId);
}

/** 관리자 화면용 목록 — UUID 대신 사람이 읽을 수 있는 학생 이름/반 이름/초안 제목을 함께 실어 준다. */
export type MediaRevocationJobListItem = Pick<
  MediaRevocationJob,
  "id" | "studentId" | "draftId" | "channel" | "resourceId" | "resourceUrl" | "status" | "attempts" | "lastError" | "createdAt" | "updatedAt"
> & { studentName: string | null; className: string | null; draftTitle: string | null };

export async function listMediaRevocationJobs(limit = 100) {
  return prisma.$queryRawUnsafe<MediaRevocationJobListItem[]>(`
    SELECT j.id, j."studentId", j."draftId", j.channel, j."resourceId", j."resourceUrl", j.status, j.attempts,
           j."lastError", j."createdAt", j."updatedAt",
           s.name AS "studentName",
           -- 이미 삭제된 학생이면 LEFT JOIN 결과가 NULL 이므로 화면에서 "학생 정보 없음"으로 처리한다.
           (SELECT c.name FROM "Enrollment" e JOIN "Class" c ON c.id = e."classId"
             WHERE e."studentId" = j."studentId" AND e.status = 'ACTIVE'
             ORDER BY e."updatedAt" DESC LIMIT 1) AS "className",
           d.title AS "draftTitle"
      FROM "MediaRevocationJob" j
      LEFT JOIN "Student" s ON s.id = j."studentId"
      LEFT JOIN "SocialPostDraft" d ON d.id = j."draftId"
     ORDER BY CASE j.status WHEN 'MANUAL_REQUIRED' THEN 0 WHEN 'FAILED' THEN 1 ELSE 2 END, j."createdAt" DESC
     LIMIT $1
  `, Math.max(1, Math.min(limit, 200)));
}

/** Recovers a publish/withdrawal race and jobs missed during an older deployment. */
export async function reconcileMediaRevocationJobs() {
  await prisma.$executeRawUnsafe(`UPDATE "SocialPublishAttempt" SET state='AMBIGUOUS', "lastError"=COALESCE("lastError",'게시 처리 중 응답이 중단되었습니다.'), "updatedAt"=NOW() WHERE state='PUBLISHING' AND "updatedAt" < NOW()-INTERVAL '5 minutes'`);
  await prisma.$executeRawUnsafe(`
    WITH attempts AS (SELECT * FROM "SocialPublishAttempt" WHERE channel='INSTAGRAM' AND state='AMBIGUOUS'), subjects AS (
      SELECT jsonb_array_elements_text(stiz_try_jsonb(a."subjectSnapshotJSON")) AS "studentId", a.* FROM attempts a
    ), latest AS (
      SELECT DISTINCT ON (c."studentId",s.id) s.id AS "attemptId",c."studentId",c.id AS "consentId",s."draftId",s."providerMediaId",s."providerPermalink"
      FROM subjects s JOIN "StudentMediaConsent" c ON c."studentId"=s."studentId"
      ORDER BY c."studentId",s.id,c."recordedAt" DESC,c.id DESC
    )
    INSERT INTO "MediaRevocationJob" (id,"studentId","consentId","draftId",channel,"resourceId","resourceUrl",status,attempts,"nextAttemptAt","lastError","createdAt","updatedAt")
    SELECT gen_random_uuid()::text,l."studentId",l."consentId",l."draftId",'INSTAGRAM',l."attemptId",l."providerPermalink",'MANUAL_REQUIRED',0,NOW(),
      'Instagram 게시 결과가 불명확합니다. Meta에서 게시 여부를 직접 확인하세요. providerMediaId='||COALESCE(l."providerMediaId",'unknown'),NOW(),NOW() FROM latest l
    ON CONFLICT ("consentId","draftId",channel) DO UPDATE SET status='MANUAL_REQUIRED',"resourceId"=EXCLUDED."resourceId","resourceUrl"=EXCLUDED."resourceUrl","lastError"=EXCLUDED."lastError","updatedAt"=NOW()
  `);
  await prisma.$executeRawUnsafe(`
    WITH latest AS (
      SELECT DISTINCT ON ("studentId") "studentId", "revokedAt"
        FROM "StudentMediaConsent"
       ORDER BY "studentId", "recordedAt" DESC, id DESC
    )
    DELETE FROM "MediaRevocationJob" j USING latest l
     WHERE j."studentId" = l."studentId" AND l."revokedAt" IS NULL AND j.status <> 'REMOVED'
  `);
  return prisma.$executeRawUnsafe(`
    WITH latest AS (
      SELECT DISTINCT ON ("studentId") id, "studentId", "revokedAt"
        FROM "StudentMediaConsent"
       ORDER BY "studentId", "recordedAt" DESC, id DESC
    )
    INSERT INTO "MediaRevocationJob" (
      id, "studentId", "consentId", "draftId", channel, "resourceId", "resourceUrl", status,
      attempts, "nextAttemptAt", "createdAt", "updatedAt"
    )
    SELECT gen_random_uuid()::text, l."studentId", l.id, d.id, c.channel, c."resourceId", c."resourceUrl",
           'PENDING', 0, NOW(), NOW(), NOW()
      FROM latest l
      JOIN "SocialPostDraft" d
        ON COALESCE(stiz_try_jsonb(d."subjectStudentIdsJSON") ? l."studentId", false)
      CROSS JOIN LATERAL (VALUES
        ('GALLERY', d."galleryPostId", NULL::text),
        ('INSTAGRAM', d."instagramMediaId", d."instagramPermalink")
      ) AS c(channel, "resourceId", "resourceUrl")
     WHERE l."revokedAt" IS NOT NULL AND c."resourceId" IS NOT NULL
    ON CONFLICT ("consentId", "draftId", channel) DO NOTHING
  `);
}

async function claimJob(jobId: string | null) {
  const rows = await prisma.$queryRawUnsafe<MediaRevocationJob[]>(`
    WITH candidate AS (
      SELECT id FROM "MediaRevocationJob"
       WHERE ((status IN ('PENDING', 'FAILED') AND "nextAttemptAt" <= NOW())
          OR (status = 'PROCESSING' AND "lockedAt" < NOW() - INTERVAL '5 minutes'))
         AND attempts < $1
         AND ($2::text IS NULL OR id = $2)
         AND COALESCE((
           SELECT c."revokedAt" IS NOT NULL FROM "StudentMediaConsent" c
            WHERE c."studentId" = "MediaRevocationJob"."studentId"
            ORDER BY c."recordedAt" DESC, c.id DESC LIMIT 1
         ), (stiz_try_jsonb("MediaRevocationJob"."consentSnapshotJSON") ->> 'revokedAt') IS NOT NULL, false)
       ORDER BY "nextAttemptAt", "createdAt"
       FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "MediaRevocationJob" j
       SET status = 'PROCESSING', attempts = attempts + 1, "lockedAt" = date_trunc('milliseconds', NOW()), "updatedAt" = NOW()
      FROM candidate c WHERE j.id = c.id RETURNING j.*
  `, MEDIA_REVOCATION_MAX_ATTEMPTS, jobId);
  return rows[0] ?? null;
}

export async function processMediaRevocationQueue(limit = 10, jobId: string | null = null) {
  if (jobId === null) await reconcileMediaRevocationJobs();
  const result = { processed: 0, removed: 0, manualRequired: 0, failed: 0 };
  for (let index = 0; index < Math.max(1, Math.min(limit, 50)); index += 1) {
    const job = await claimJob(jobId);
    if (!job) break;
    result.processed += 1;
    try {
      if (job.channel === "INSTAGRAM") {
        await prisma.$executeRawUnsafe(`
          UPDATE "MediaRevocationJob" SET status = 'MANUAL_REQUIRED', "lockedAt" = NULL,
            "lastError" = 'Instagram 게시물은 관리자 확인 후 Meta에서 직접 삭제해야 합니다.', "updatedAt" = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND "lockedAt" = $2
        `, job.id, job.lockedAt);
        result.manualRequired += 1;
        continue;
      }
      const removed = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text`, job.studentId);
        const latest = await tx.$queryRawUnsafe<Array<{ revoked: boolean }>>(`
          SELECT ("revokedAt" IS NOT NULL) AS revoked FROM "StudentMediaConsent"
           WHERE "studentId" = $1 ORDER BY "recordedAt" DESC, id DESC LIMIT 1
        `, job.studentId);
        const consentStillRevoked = latest[0]
          ? latest[0].revoked
          : snapshotConsentIsRevoked(job.consentSnapshotJSON);
        if (!consentStillRevoked) {
          await tx.$executeRawUnsafe(`DELETE FROM "MediaRevocationJob" WHERE id = $1`, job.id);
          return false;
        }
        const draftRows = await tx.$queryRawUnsafe<Array<{ mediaJSON: string }>>(
          `SELECT "mediaJSON" FROM "SocialPostDraft" WHERE id = $1 LIMIT 1`, job.draftId,
        );
        const durableMediaJSON = draftRows[0]?.mediaJSON ?? snapshotDraftMediaJSON(job.draftSnapshotJSON);
        if (!durableMediaJSON) throw new Error("회수 작업에 공개 미디어 스냅샷이 없습니다.");
        const publicPaths = collectPublishedMediaCopyPaths(job.draftId, durableMediaJSON);
        for (const path of publicPaths) {
          await tx.$executeRawUnsafe(`
            INSERT INTO "StorageDeletionJob" (id, bucket, path, status, attempts, "nextAttemptAt", "createdAt", "updatedAt")
            VALUES (gen_random_uuid()::text, $1, $2, 'PENDING', 0, NOW(), NOW(), NOW())
            ON CONFLICT (bucket, path) DO NOTHING
          `, PUBLIC_GALLERY_BUCKET, path);
        }
        await tx.$executeRawUnsafe(`UPDATE "GalleryPost" SET "isPublic" = false, "mediaJSON" = '[]', "updatedAt" = NOW() WHERE id = $1`, job.resourceId);
        await tx.$executeRawUnsafe(`UPDATE "SocialPostDraft" SET "mediaJSON" = '[]', "isPublic" = false, "updatedAt" = NOW() WHERE id = $1`, job.draftId);
        await tx.$executeRawUnsafe(`
          UPDATE "MediaRevocationJob" SET status = 'REMOVED', "removedAt" = NOW(), "lockedAt" = NULL,
            "lastError" = NULL, "updatedAt" = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND "lockedAt" = $2
        `, job.id, job.lockedAt);
        return true;
      });
      if (removed) result.removed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown revocation error";
      const terminal = job.attempts >= MEDIA_REVOCATION_MAX_ATTEMPTS;
      await prisma.$executeRawUnsafe(`
        UPDATE "MediaRevocationJob" SET status = 'FAILED', "lockedAt" = NULL, "lastError" = $2,
          "nextAttemptAt" = CASE WHEN $3 THEN "nextAttemptAt" ELSE NOW() + ($4 * INTERVAL '1 millisecond') END,
          "updatedAt" = NOW() WHERE id = $1 AND status = 'PROCESSING' AND "lockedAt" = $5
      `, job.id, message, terminal, mediaRevocationRetryDelayMs(job.attempts), job.lockedAt);
      result.failed += 1;
    }
  }
  if (jobId === null) await processStorageDeletionQueue(limit);
  return result;
}

export async function processStorageDeletionQueue(limit = 10) {
  for (let index = 0; index < Math.max(1, Math.min(limit, 50)); index += 1) {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; path: string; attempts: number; lockedAt: Date }>>(`
      WITH candidate AS (
        SELECT id FROM "StorageDeletionJob"
        WHERE ((status IN ('PENDING','FAILED') AND "nextAttemptAt" <= NOW())
          OR (status='PROCESSING' AND "lockedAt" < NOW()-INTERVAL '5 minutes')) AND attempts < 5
        ORDER BY "nextAttemptAt" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "StorageDeletionJob" j SET status='PROCESSING', attempts=attempts+1, "lockedAt"=date_trunc('milliseconds', NOW()), "updatedAt"=NOW()
      FROM candidate c WHERE j.id=c.id RETURNING j.id,j.path,j.attempts,j."lockedAt"
    `);
    const storageJob = rows[0];
    if (!storageJob) break;
    try {
      await removePublishedStoragePaths([storageJob.path]);
      await prisma.$executeRawUnsafe(`UPDATE "StorageDeletionJob" SET status='DELETED', "deletedAt"=NOW(), "lockedAt"=NULL, "lastError"=NULL, "updatedAt"=NOW() WHERE id=$1 AND status='PROCESSING' AND "lockedAt"=$2`, storageJob.id, storageJob.lockedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Storage deletion failed";
      await prisma.$executeRawUnsafe(`UPDATE "StorageDeletionJob" SET status='FAILED', "lockedAt"=NULL, "lastError"=$2, "nextAttemptAt"=NOW()+INTERVAL '5 minutes', "updatedAt"=NOW() WHERE id=$1 AND status='PROCESSING' AND "lockedAt"=$3`, storageJob.id, message, storageJob.lockedAt);
    }
  }
}
