/* eslint-disable @typescript-eslint/no-explicit-any -- Raw SQL rows are normalized at the database boundary. */
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-guard";
import type { SocialMediaItem } from "@/lib/socialCaptionAI";
import { normalizeSubjectStudentIds } from "@/lib/studentMediaConsentPolicy";
import { createHash } from "node:crypto";
import { collectPublishedMediaCopyPaths, PUBLIC_GALLERY_BUCKET } from "@/lib/sessionPhotoStorage";
import {
  ARM_INSTAGRAM_QUEUE_SQL,
  CLAIM_INSTAGRAM_ATTEMPT_SQL,
  MARK_GALLERY_PUBLISHING_SQL,
  QUEUED_INSTAGRAM_DRAFTS_SQL,
} from "./socialPublishQueueRules";

export { normalizeSubjectStudentIds } from "@/lib/studentMediaConsentPolicy";

export type SocialPostDraftStatus = "DRAFT" | "READY" | "PUBLISHING" | "PUBLISHED" | "REJECTED" | "FAILED";

export type SocialPostDraft = {
  id: string;
  authorUserId: string | null;
  authorName: string | null;
  authorRole: string | null;
  sessionId: string | null;
  classId: string | null;
  subjectStudentIds: string[];
  publicationSubjectsJSON: string | null;
  publicationSubjectHash: string | null;
  publishReservationId: string | null;
  source: string | null;
  status: SocialPostDraftStatus;
  lessonType: string | null;
  memo: string | null;
  title: string | null;
  caption: string | null;
  hashtags: string | null;
  mediaJSON: string;
  isPublic: boolean;
  galleryPostId: string | null;
  instagramMediaId: string | null;
  instagramPermalink: string | null;
  instagramPublishError: string | null;
  instagramPublishAttempts: number;
  instagramLastAttemptAt: string | null;
  instagramNextRetryAt: string | null;
  submittedAt: string | null;
  publishedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

let tableEnsured = false;

function toIso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapDraft(row: any): SocialPostDraft {
  return {
    id: row.id,
    authorUserId: row.authorUserId ?? null,
    authorName: row.authorName ?? null,
    authorRole: row.authorRole ?? null,
    sessionId: row.sessionId ?? null,
    classId: row.classId ?? null,
    subjectStudentIds: normalizeSubjectStudentIds(row.subjectStudentIdsJSON),
    publicationSubjectsJSON: row.publicationSubjectsJSON ?? null,
    publicationSubjectHash: row.publicationSubjectHash ?? null,
    publishReservationId: row.publishReservationId ?? null,
    source: row.source ?? null,
    status: row.status,
    lessonType: row.lessonType ?? null,
    memo: row.memo ?? null,
    title: row.title ?? null,
    caption: row.caption ?? null,
    hashtags: row.hashtags ?? null,
    mediaJSON: row.mediaJSON || "[]",
    isPublic: row.isPublic !== false,
    galleryPostId: row.galleryPostId ?? null,
    instagramMediaId: row.instagramMediaId ?? null,
    instagramPermalink: row.instagramPermalink ?? null,
    instagramPublishError: row.instagramPublishError ?? null,
    instagramPublishAttempts: Number(row.instagramPublishAttempts ?? 0),
    instagramLastAttemptAt: toIso(row.instagramLastAttemptAt),
    instagramNextRetryAt: toIso(row.instagramNextRetryAt),
    submittedAt: toIso(row.submittedAt),
    publishedAt: toIso(row.publishedAt),
    rejectedAt: toIso(row.rejectedAt),
    createdAt: toIso(row.createdAt) || new Date().toISOString(),
    updatedAt: toIso(row.updatedAt) || new Date().toISOString(),
  };
}

export function parseSocialDraftMedia(mediaJSON: string): SocialMediaItem[] {
  try {
    const parsed = JSON.parse(mediaJSON);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SocialMediaItem => {
      return typeof item?.url === "string" && (item.type === "image" || item.type === "video");
    });
  } catch {
    return [];
  }
}

export function safeSocialDraftMediaJSON(mediaJSON: string) {
  return JSON.stringify(parseSocialDraftMedia(mediaJSON));
}

export async function replaceSocialPostDraftMediaJSON(id: string, mediaJSON: string) {
  await ensureSocialPostDraftTable();
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `UPDATE "SocialPostDraft" SET "mediaJSON" = $2, "updatedAt" = NOW() WHERE id = $1 RETURNING *`,
    id,
    safeSocialDraftMediaJSON(mediaJSON),
  );
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function ensureSocialPostDraftTable() {
  if (tableEnsured) return;

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SocialPostDraft" (
      id TEXT PRIMARY KEY DEFAULT (gen_random_uuid())::text,
      "authorUserId" TEXT,
      "authorName" TEXT,
      "authorRole" TEXT,
      "sessionId" TEXT,
      "classId" TEXT,
      "subjectStudentIdsJSON" TEXT NOT NULL DEFAULT '[]',
      "publicationSubjectsJSON" TEXT,
      "publicationSubjectHash" TEXT,
      "publishReservationId" TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      "lessonType" TEXT,
      memo TEXT,
      title TEXT,
      caption TEXT,
      hashtags TEXT,
      "mediaJSON" TEXT NOT NULL DEFAULT '[]',
      "isPublic" BOOLEAN NOT NULL DEFAULT true,
      "galleryPostId" TEXT,
      "instagramMediaId" TEXT,
      "instagramPermalink" TEXT,
      "instagramPublishError" TEXT,
      "instagramPublishAttempts" INTEGER NOT NULL DEFAULT 0,
      "instagramLastAttemptAt" TIMESTAMPTZ,
      "instagramNextRetryAt" TIMESTAMPTZ,
      "submittedAt" TIMESTAMPTZ,
      "publishedAt" TIMESTAMPTZ,
      "rejectedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const columns: [string, string][] = [
    ["sessionId", "TEXT"],
    ["classId", "TEXT"],
    ["source", "TEXT"],
    ["subjectStudentIdsJSON", "TEXT NOT NULL DEFAULT '[]'"],
    ["instagramPublishAttempts", "INTEGER NOT NULL DEFAULT 0"],
    ["instagramLastAttemptAt", "TIMESTAMPTZ"],
    ["instagramNextRetryAt", "TIMESTAMPTZ"],
    ["publicationSubjectsJSON", "TEXT"],
    ["publicationSubjectHash", "TEXT"],
    ["publishReservationId", "TEXT"],
  ];

  for (const [col, type] of columns) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "SocialPostDraft" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
    );
  }

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "SocialPostDraft_status_idx" ON "SocialPostDraft" (status)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "SocialPostDraft_author_idx" ON "SocialPostDraft" ("authorUserId")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "SocialPostDraft_createdAt_idx" ON "SocialPostDraft" ("createdAt" DESC)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "SocialPostDraft_queue_idx" ON "SocialPostDraft" (status, "instagramNextRetryAt", "updatedAt")`
  );

  tableEnsured = true;
}

export async function createSocialPostDraftRecord(data: {
  authorUserId: string;
  authorName: string;
  authorRole: string;
  lessonType?: string | null;
  memo?: string | null;
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  mediaJSON: string;
  isPublic?: boolean;
  sessionId?: string | null;
  classId?: string | null;
  subjectStudentIds?: string[];
  source?: string | null;
}) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `INSERT INTO "SocialPostDraft" (
       id, "authorUserId", "authorName", "authorRole", status,
       "lessonType", memo, title, caption, hashtags, "mediaJSON", "isPublic",
       "sessionId", "classId", source, "subjectStudentIdsJSON", "submittedAt", "createdAt", "updatedAt"
     )
     VALUES (
       (gen_random_uuid())::text, $1, $2, $3, 'READY',
       $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, NOW(), NOW(), NOW()
     )
     RETURNING *`,
    data.authorUserId,
    data.authorName,
    data.authorRole,
    data.lessonType || null,
    data.memo || null,
    data.title || null,
    data.caption || null,
    data.hashtags || null,
    safeSocialDraftMediaJSON(data.mediaJSON),
    data.isPublic !== false,
    data.sessionId || null,
    data.classId || null,
    data.source || null,
    JSON.stringify(normalizeSubjectStudentIds(data.subjectStudentIds)),
  );

  return mapDraft(rows[0]);
}

export async function readPendingSocialPostDrafts(limit = 30) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "SocialPostDraft"
     WHERE status IN ('READY', 'PUBLISHING', 'FAILED')
     ORDER BY "createdAt" DESC
     LIMIT $1`,
    limit,
  );

  return rows.map(mapDraft);
}

export async function getPendingSocialPostDrafts(limit = 30) {
  await requireAdmin();
  return readPendingSocialPostDrafts(limit);
}

export async function getSocialPostDraftById(id: string) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM "SocialPostDraft" WHERE id = $1 LIMIT 1`,
    id,
  );

  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function getQueuedSocialPostDrafts(limit = 1) {
  await ensureSocialPostDraftTable();

  // 2026-11-14 사진·인스타 점검: 대기열이 켜진(원장이 인스타 게시를 누른) 초안만 집는다.
  // 예전에는 COALESCE(다음 시도 시각, 수정 시각)이라 꺼진 초안도 5분마다 집어 «건너뜀»만 반복했다.
  const rows = await prisma.$queryRawUnsafe<any[]>(QUEUED_INSTAGRAM_DRAFTS_SQL, limit);

  return rows.map(mapDraft);
}

export async function updateSocialPostDraftRecord(
  id: string,
  data: {
    title?: string | null;
    caption?: string | null;
    hashtags?: string | null;
    lessonType?: string | null;
    memo?: string | null;
    isPublic?: boolean;
    subjectStudentIds?: string[];
  },
  options?: { authorUserId?: string | null },
) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM "SocialPostDraft" WHERE id=$1 FOR UPDATE`, id,
    );
    if (!locked[0] || !["DRAFT", "READY", "FAILED"].includes(locked[0].status)) return [];
    return tx.$queryRawUnsafe<any[]>(
    `UPDATE "SocialPostDraft"
     SET title = $1,
         caption = $2,
         hashtags = $3,
         "lessonType" = $4,
         memo = $5,
         "isPublic" = $6,
         "subjectStudentIdsJSON" = CASE WHEN $7::boolean THEN $8 ELSE "subjectStudentIdsJSON" END,
         "updatedAt" = NOW()
     WHERE id = $9
       AND status IN ('DRAFT', 'READY', 'FAILED')
       AND ($10::text IS NULL OR "authorUserId" = $10)
     RETURNING *`,
    data.title || null,
    data.caption || null,
    data.hashtags || null,
    data.lessonType || null,
    data.memo || null,
    data.isPublic !== false,
    data.subjectStudentIds !== undefined,
    JSON.stringify(normalizeSubjectStudentIds(data.subjectStudentIds)),
    id,
    options?.authorUserId || null,
    );
  });

  if (!rows[0]) {
    throw new Error("수정할 수 있는 초안을 찾지 못했습니다.");
  }

  return mapDraft(rows[0]);
}

export async function rejectSocialPostDraftRecord(id: string) {
  await ensureSocialPostDraftTable();

  const result = await prisma.$transaction(async (tx) => {
    const preliminaryRows = await tx.$queryRawUnsafe<any[]>(`SELECT * FROM "SocialPostDraft" WHERE id=$1`, id);
    const preliminary = preliminaryRows[0] ? mapDraft(preliminaryRows[0]) : null;
    if (!preliminary) return { draft: null, removedGalleryPostId: null };
    for (const studentId of [...new Set(preliminary.subjectStudentIds)].sort()) {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, studentId);
    }
    const lockedRows = await tx.$queryRawUnsafe<any[]>(`SELECT * FROM "SocialPostDraft" WHERE id=$1 FOR UPDATE`, id);
    const lockedDraft = lockedRows[0] ? mapDraft(lockedRows[0]) : null;
    if (!lockedDraft || JSON.stringify(lockedDraft.subjectStudentIds.slice().sort()) !== JSON.stringify(preliminary.subjectStudentIds.slice().sort())) {
      throw new Error("게시 대상 학생이 변경되어 반려를 다시 시도해야 합니다.");
    }
    if (lockedDraft.status === "PUBLISHING") {
      const hash = createHash("sha256").update(JSON.stringify(lockedDraft.subjectStudentIds.slice().sort())).digest("hex");
      if (!lockedDraft.publishReservationId || lockedDraft.publicationSubjectHash !== hash) throw new Error("게시 예약 검증에 실패하여 반려할 수 없습니다.");
    }
    const rows = await tx.$queryRawUnsafe<any[]>(
      `UPDATE "SocialPostDraft"
       SET status = 'REJECTED',
           "rejectedAt" = COALESCE("rejectedAt", NOW()),
           "instagramNextRetryAt" = NULL,
           "updatedAt" = NOW()
       WHERE id = $1 AND status IN ('DRAFT', 'READY', 'FAILED', 'PUBLISHING', 'REJECTED')
       RETURNING *`,
      id,
    );

    const draft = rows[0] ? mapDraft(rows[0]) : null;
    if (draft?.galleryPostId) {
      for (const path of collectPublishedMediaCopyPaths(draft.id, draft.mediaJSON)) {
        await tx.$executeRawUnsafe(`
          INSERT INTO "StorageDeletionJob" (id,bucket,path,status,attempts,"nextAttemptAt","createdAt","updatedAt")
          VALUES (gen_random_uuid()::text,$1,$2,'PENDING',0,NOW(),NOW(),NOW()) ON CONFLICT (bucket,path) DO NOTHING
        `, PUBLIC_GALLERY_BUCKET, path);
      }
      await tx.$executeRawUnsafe(`UPDATE "GalleryPost" SET "isPublic"=false,"mediaJSON"='[]',"updatedAt"=NOW() WHERE id=$1`, draft.galleryPostId);
      await tx.$executeRawUnsafe(`UPDATE "SocialPostDraft" SET "isPublic"=false,"mediaJSON"='[]',"updatedAt"=NOW() WHERE id=$1`, draft.id);
    }

    return {
      draft,
      removedGalleryPostId: draft?.galleryPostId ?? null,
    };
  });

  if (!result.draft) {
    throw new Error("반려할 수 있는 초안을 찾지 못했습니다.");
  }

  return result;
}

export async function markSocialPostDraftPublished(
  id: string,
  data: {
    galleryPostId: string;
    instagramMediaId?: string | null;
    instagramPermalink?: string | null;
  },
) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE "SocialPostDraft"
     SET status = 'PUBLISHED',
         "galleryPostId" = $1,
         "instagramMediaId" = $2,
         "instagramPermalink" = $3,
         "instagramPublishError" = NULL,
         "publishedAt" = NOW(),
         "updatedAt" = NOW()
     WHERE id = $4
     RETURNING *`,
    data.galleryPostId,
    data.instagramMediaId || null,
    data.instagramPermalink || null,
    id,
  );

  return mapDraft(rows[0]);
}

export async function markSocialPostDraftPublishing(
  id: string,
  data: {
    galleryPostId: string;
  },
) {
  await ensureSocialPostDraftTable();

  // 2026-11-14 검수 필수 1: 게시할 수 있는 상태일 때만 바꾸고, 여기서는 대기열을 켜지 않는다.
  const rows = await prisma.$queryRawUnsafe<any[]>(MARK_GALLERY_PUBLISHING_SQL, data.galleryPostId, id);
  if (rows[0]) return mapDraft(rows[0]);

  // 바뀐 행이 없다 = 그 사이에 다른 처리가 게시를 끝냈거나(PUBLISHED) 반려했다. 되돌리지 않고 지금 상태를 돌려준다.
  const current = await getSocialPostDraftById(id);
  if (!current) throw new Error("게시할 초안을 찾지 못했습니다.");
  return current;
}

/**
 * 원장이 인스타 게시를 눌렀을 때만 부른다 — 꺼져 있던 인스타 대기열을 켠다.
 * 2026-11-14 사진·인스타 점검: 이 단계가 없어 초안이 «게시 처리 중»에 멈췄다(규칙은 socialPublishQueueRules.ts).
 * 이미 켜져 있으면(다른 처리가 시도를 잡았으면) 아무것도 바꾸지 않고 null 을 돌려준다.
 */
export async function armSocialPostDraftInstagramQueue(id: string) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(ARM_INSTAGRAM_QUEUE_SQL, id);
  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function markSocialPostDraftPublishAttempt(id: string) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(CLAIM_INSTAGRAM_ATTEMPT_SQL, id);

  return rows[0] ? mapDraft(rows[0]) : null;
}

export async function markSocialPostDraftRetryScheduled(
  id: string,
  data: {
    galleryPostId: string;
    error: string;
    nextRetryAt: Date;
  },
) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE "SocialPostDraft"
     SET status = 'PUBLISHING',
         "galleryPostId" = $1,
         "instagramPublishError" = $2,
         "instagramNextRetryAt" = $3,
         "updatedAt" = NOW()
     WHERE id = $4
     RETURNING *`,
    data.galleryPostId,
    data.error,
    data.nextRetryAt,
    id,
  );

  return mapDraft(rows[0]);
}

export async function markSocialPostDraftFailed(
  id: string,
  data: {
    galleryPostId: string;
    error: string;
  },
) {
  await ensureSocialPostDraftTable();

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE "SocialPostDraft"
     SET status = 'FAILED',
         "galleryPostId" = $1,
         "instagramPublishError" = $2,
         "instagramNextRetryAt" = NULL,
         "updatedAt" = NOW()
     WHERE id = $3
     RETURNING *`,
    data.galleryPostId,
    data.error,
    id,
  );

  return mapDraft(rows[0]);
}
