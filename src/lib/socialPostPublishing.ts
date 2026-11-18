import { prisma } from "@/lib/prisma";
import { ensureGalleryPostInstagramColumns } from "@/lib/instagramGallerySync";
import {
  replaceSocialPostDraftMediaJSON,
  type SocialPostDraft,
} from "@/lib/socialDrafts";
import { materializePrivateMediaJSON, plannedPublishedMediaCopyPaths, PUBLIC_GALLERY_BUCKET } from "@/lib/sessionPhotoStorage";
import { assertSocialDraftMediaConsent, withSocialDraftPublicationReservation } from "@/lib/studentMediaConsent";

// 2026-11-18 결정표 insta-auto-publish «안 쓴다»: 인스타그램 게시·재시도 대기열은 지웠다.
// 이 파일에는 초안을 «홈페이지 갤러리»에 올리는 부분만 남는다.

export function fullSocialCaption(caption?: string | null, hashtags?: string | null) {
  return [caption?.trim(), hashtags?.trim()].filter(Boolean).join("\n\n");
}

async function ensureDraftMediaIsPublic(draft: SocialPostDraft) {
  try {
    const mediaJSON = await materializePrivateMediaJSON(draft.id, draft.mediaJSON, {
      classId: draft.classId,
      sessionId: draft.sessionId,
    });
    if (mediaJSON === draft.mediaJSON) return draft;
    const updated = await replaceSocialPostDraftMediaJSON(draft.id, mediaJSON);
    if (!updated) throw new Error("게시용 사진 정보를 저장하지 못했습니다.");
    return updated;
  } catch (error) {
    for (const path of plannedPublishedMediaCopyPaths(draft.id, draft.mediaJSON)) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "StorageDeletionJob" (id,bucket,path,status,attempts,"nextAttemptAt","createdAt","updatedAt")
        VALUES (gen_random_uuid()::text,$1,$2,'PENDING',0,NOW(),NOW(),NOW()) ON CONFLICT (bucket,path) DO NOTHING
      `, PUBLIC_GALLERY_BUCKET, path);
    }
    throw error;
  }
}

async function upsertGalleryPostFromSocialDraftLocked(draft: SocialPostDraft) {
  await assertSocialDraftMediaConsent(draft, "GALLERY");
  draft = await ensureDraftMediaIsPublic(draft);
  await ensureGalleryPostInstagramColumns();

  const caption = fullSocialCaption(draft.caption, draft.hashtags);

  if (draft.galleryPostId) {
    await prisma.$executeRawUnsafe(
      `UPDATE "GalleryPost"
       SET title = $1,
           caption = $2,
           "mediaJSON" = $3,
           "isPublic" = $4,
           source = 'STAFF_UPLOAD',
           "updatedAt" = NOW()
       WHERE id = $5`,
      draft.title || "STIZ 수업 스케치",
      caption || null,
      draft.mediaJSON,
      draft.isPublic !== false,
      draft.galleryPostId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "SocialPostDraft" SET status = 'PUBLISHING', "updatedAt" = NOW() WHERE id = $1 AND status IN ('READY', 'FAILED')`,
      draft.id,
    );
    return draft.galleryPostId;
  }

  // 초안 ID에서 결정되는 고정 Gallery ID를 사용해 중복 클릭도 한 게시물로 합칩니다.
  const galleryPostId = `social-draft-${draft.id}`;
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO "GalleryPost" (
       id, title, caption, "mediaJSON", "isPublic", source, "createdAt", "updatedAt"
     )
     VALUES (
       $1, $2, $3, $4, $5, 'STAFF_UPLOAD', NOW(), NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       caption = EXCLUDED.caption,
       "mediaJSON" = EXCLUDED."mediaJSON",
       "isPublic" = EXCLUDED."isPublic",
       "updatedAt" = NOW()
     RETURNING id`,
    galleryPostId,
    draft.title || "STIZ 수업 스케치",
    caption || null,
    draft.mediaJSON,
    draft.isPublic !== false,
  );

  await prisma.$executeRawUnsafe(
    `UPDATE "SocialPostDraft" SET "galleryPostId" = $2, status = 'PUBLISHING', "updatedAt" = NOW()
      WHERE id = $1 AND status IN ('READY', 'FAILED', 'PUBLISHING')`,
    draft.id,
    rows[0].id,
  );

  return rows[0].id;
}

export async function upsertGalleryPostFromSocialDraft(
  draft: SocialPostDraft,
  options: { consentLocked?: boolean } = {},
) {
  if (options.consentLocked) return upsertGalleryPostFromSocialDraftLocked(draft);
  return withSocialDraftPublicationReservation(draft.id, "GALLERY", async (snapshot, attemptId) => {
    try {
      const galleryPostId = await upsertGalleryPostFromSocialDraftLocked(snapshot);
      await prisma.$executeRawUnsafe(`UPDATE "SocialPublishAttempt" SET state='PUBLISHED', "providerMediaId"=$2, "updatedAt"=NOW() WHERE id=$1`, attemptId, galleryPostId);
      return galleryPostId;
    } catch (error) {
      await prisma.$executeRawUnsafe(`UPDATE "SocialPublishAttempt" SET state='FAILED', "lastError"=$2, "updatedAt"=NOW() WHERE id=$1`, attemptId, error instanceof Error ? error.message.slice(0, 1000) : "Gallery publish failed");
      throw error;
    }
  });
}
