import { prisma } from "@/lib/prisma";
import { publishGalleryPostToInstagram } from "@/lib/instagram";
import { ensureGalleryPostInstagramColumns } from "@/lib/instagramGallerySync";
import { getAcademySettings } from "@/lib/queries";
import {
  armSocialPostDraftInstagramQueue,
  getQueuedSocialPostDrafts,
  getSocialPostDraftById,
  markSocialPostDraftFailed,
  markSocialPostDraftPublishAttempt,
  markSocialPostDraftPublished,
  markSocialPostDraftPublishing,
  markSocialPostDraftRetryScheduled,
  parseSocialDraftMedia,
  replaceSocialPostDraftMediaJSON,
  type SocialPostDraft,
} from "@/lib/socialDrafts";
import { materializePrivateMediaJSON, plannedPublishedMediaCopyPaths, PUBLIC_GALLERY_BUCKET } from "@/lib/sessionPhotoStorage";
import { assertSocialDraftMediaConsent, withSocialDraftPublicationReservation } from "@/lib/studentMediaConsent";
import {
  CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL,
  FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL,
  HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL,
  MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL,
  PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL,
} from "@/lib/socialPublishQueueRules";

/**
 * 인스타 게시 실행 옵션.
 * - queueMode: 실패하면 재시도 대기열에 넣는다(원장 버튼·5분 크론 모두 켠다).
 * - ownerApproved: «원장이 방금 인스타 게시를 눌렀다» — 이때만 꺼져 있던 인스타 대기열을 켠다.
 *   5분 크론은 이 값을 주지 않는다. 그래서 부원장이 갤러리만 올린 초안을 크론이 원장 승인 없이
 *   인스타에 올리는 일이 없다(2026-11-14 사진·인스타 점검).
 */
type InstagramPublishOptions = { queueMode?: boolean; ownerApproved?: boolean };

const MAX_QUEUE_ATTEMPTS = 3;
const RETRY_DELAYS_MINUTES = [1, 5];

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

function nextRetryDate(attempts: number) {
  const delayMinutes = RETRY_DELAYS_MINUTES[Math.max(0, attempts - 1)] ?? RETRY_DELAYS_MINUTES.at(-1) ?? 5;
  return new Date(Date.now() + delayMinutes * 60 * 1000);
}

async function updateGalleryInstagramError(galleryPostId: string, error: string | null) {
  await prisma.$executeRawUnsafe(
    `UPDATE "GalleryPost"
     SET "instagramPublishError" = $1
     WHERE id = $2`,
    error,
    galleryPostId,
  );
}

export async function publishSocialDraftToInstagramNow(
  id: string,
  options: InstagramPublishOptions = {},
) {
  return withSocialDraftPublicationReservation(id, "INSTAGRAM", async (snapshot, attemptId) => {
    // 2026-11-14 검수 권장 1: «결과 불명확(AMBIGUOUS)» 표시는 여기서 하지 않고 인스타를 부르기 직전에 한다.
    try {
      return await publishSocialDraftToInstagramNowLocked(snapshot, attemptId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Instagram result unknown";
      // 인스타를 부르기 전에 난 실패(동의 철회·사진 0장·사본 실패 등)는 일반 실패다.
      // 시도가 아직 «예약됨»이면 닫히고(행이 돌아온다), 이미 호출을 시작했으면 아래 «결과 불명확» 처리로 간다.
      const closedBeforeCall = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL, attemptId, message,
      );
      if (closedBeforeCall[0]) {
        await prisma.$executeRawUnsafe(FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL, id, message);
        throw error;
      }
      await prisma.$executeRawUnsafe(`UPDATE "SocialPublishAttempt" SET "lastError"=$2, "updatedAt"=NOW() WHERE id=$1`, attemptId, message);
      await prisma.$executeRawUnsafe(`
        WITH attempt AS (SELECT * FROM "SocialPublishAttempt" WHERE id=$1), subjects AS (
          SELECT jsonb_array_elements_text(stiz_try_jsonb(a."subjectSnapshotJSON")) AS "studentId", a.* FROM attempt a
        ), latest AS (
          SELECT DISTINCT ON (c."studentId") c."studentId", c.id AS "consentId" FROM "StudentMediaConsent" c
          JOIN subjects s ON s."studentId"=c."studentId" ORDER BY c."studentId", c."recordedAt" DESC, c.id DESC
        )
        INSERT INTO "MediaRevocationJob" (id,"studentId","consentId","draftId",channel,"resourceId","resourceUrl",status,attempts,"nextAttemptAt","lastError","createdAt","updatedAt")
        SELECT gen_random_uuid()::text,l."studentId",l."consentId",a."draftId",'INSTAGRAM',a.id,a."providerPermalink",'MANUAL_REQUIRED',0,NOW(),
          'Instagram 게시 결과가 불명확합니다. Meta에서 게시 여부를 직접 확인하세요. providerMediaId='||COALESCE(a."providerMediaId",'unknown'),NOW(),NOW()
        FROM attempt a CROSS JOIN latest l
        ON CONFLICT ("consentId","draftId",channel) DO UPDATE SET status='MANUAL_REQUIRED', "resourceId"=EXCLUDED."resourceId", "resourceUrl"=EXCLUDED."resourceUrl", "lastError"=EXCLUDED."lastError", "updatedAt"=NOW()
      `, attemptId);
      // 2026-11-14 사진·인스타 점검: 결과가 불명확하면 대기열을 꺼서 5분 크론이 다시 발행하지 않게 한다.
      // 예전에는 크론 경로만 이렇게 멈췄고, 원장 버튼 경로는 «5분 뒤 재시도»가 남아 중복 게시가 될 수 있었다.
      await prisma.$executeRawUnsafe(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, id);
      throw error;
    }
  });
}

/** 인스타를 호출하지 않고 끝난 시도는 «결과 불명확»으로 남기지 않는다(원장에게 «직접 확인» 일이 헛되이 생긴다). */
async function closeAttemptWithoutProviderCall(attemptId: string, reason: string) {
  await prisma.$queryRawUnsafe(CLOSE_ATTEMPT_BEFORE_PROVIDER_CALL_SQL, attemptId, reason);
}

async function publishSocialDraftToInstagramNowLocked(
  currentDraft: SocialPostDraft,
  attemptId: string,
  options: InstagramPublishOptions = {},
) {
  const id = currentDraft.id;
  if (currentDraft?.status === "PUBLISHED") {
    await closeAttemptWithoutProviderCall(attemptId, "이미 게시된 초안이라 인스타그램을 호출하지 않았습니다.");
    return { ok: true as const, draft: currentDraft, skipped: true as const };
  }

  if (!currentDraft || !["READY", "FAILED", "PUBLISHING"].includes(currentDraft.status)) {
    throw new Error("게시할 수 있는 초안을 찾지 못했습니다.");
  }

  // 대기 중 동의가 철회될 수 있으므로 실제 외부 발행 직전에 다시 확인합니다.
  await assertSocialDraftMediaConsent(currentDraft, "INSTAGRAM");

  currentDraft = await ensureDraftMediaIsPublic(currentDraft);

  const mediaItems = parseSocialDraftMedia(currentDraft.mediaJSON).filter((item) => item.type === "image");
  if (mediaItems.length === 0) {
    throw new Error("인스타그램 자동 게시에는 사진이 최소 1장 필요합니다.");
  }

  const galleryPostId = currentDraft.galleryPostId || await upsertGalleryPostFromSocialDraft(currentDraft, { consentLocked: true });
  let workingDraft = currentDraft;
  if (!currentDraft.galleryPostId || (options.queueMode && currentDraft.status !== "PUBLISHING")) {
    workingDraft = await markSocialPostDraftPublishing(id, { galleryPostId });
  }

  // 2026-11-14 검수 필수 2: 5분 크론(원장이 방금 누른 것이 아닌 자동 재시도)은 인스타를 부르기 전에
  // 이 초안의 이전 시도를 본다. 결과 불명확(서버 함수가 호출 도중 시간 초과로 죽은 경우 포함)이거나
  // 이미 게시됨으로 기록된 시도가 있으면 인스타에 올라가 있을 수 있다 — 다시 올리지 않고 사람이 확인하게 멈춘다.
  if (options.queueMode && !options.ownerApproved) {
    const prior = await prisma.$queryRawUnsafe<Array<{ id: string; state: string }>>(
      PRIOR_UNRESOLVED_INSTAGRAM_ATTEMPT_SQL, id, attemptId,
    );
    if (prior[0]) {
      await closeAttemptWithoutProviderCall(attemptId, "이전 게시 시도의 결과가 확인되지 않아 인스타그램을 호출하지 않았습니다.");
      await prisma.$executeRawUnsafe(HALT_AMBIGUOUS_INSTAGRAM_DRAFT_SQL, id);
      const halted = (await getSocialPostDraftById(id)) ?? currentDraft;
      return {
        ok: false as const,
        draft: halted,
        error: "Instagram 게시 결과가 불명확하여 자동 재발행을 중단했습니다.",
        halted: true as const,
      };
    }
  }

  // 2026-11-14 사진·인스타 점검: 원장이 누른 경우에만 꺼져 있던 대기열을 켠다.
  // 이 줄이 없으면 «다음 시도 시각»이 비어 있어 아래 «시도 잡기»가 항상 실패하고,
  // 인스타 호출 없이 «건너뜀»이 성공으로 돌아와 초안이 «게시 처리 중»에 멈춘다.
  if (options.queueMode && options.ownerApproved) {
    await armSocialPostDraftInstagramQueue(id);
  }

  const attemptDraft = options.queueMode
    ? await markSocialPostDraftPublishAttempt(id)
    : workingDraft;

  if (options.queueMode && !attemptDraft) {
    // 시도를 잡지 못했다 = 다른 처리가 이미 진행 중이거나 대기열이 꺼져 있다. 인스타를 호출하지 않는다.
    await closeAttemptWithoutProviderCall(attemptId, "다른 게시 처리가 진행 중이라 인스타그램을 호출하지 않았습니다.");
    const latest = await getSocialPostDraftById(id);
    // ok 는 «실제로 게시됐는가»다. 예전에는 건너뛰어도 true 라 화면이 «게시 완료»로 잘못 알렸다.
    const skippedDraft = latest ?? currentDraft;
    return { ok: skippedDraft.status === "PUBLISHED", draft: skippedDraft, skipped: true as const };
  }

  const settings = await getAcademySettings();
  const caption = fullSocialCaption(currentDraft.caption, currentDraft.hashtags);
  // 여기부터 «인스타를 불렀다». 이 표시가 남은 채로 끝나면(예외·시간 초과) 결과를 모르는 시도다.
  await prisma.$executeRawUnsafe(MARK_ATTEMPT_PROVIDER_CALL_STARTED_SQL, attemptId);
  const result = await publishGalleryPostToInstagram({
    businessAccountId: settings.instagramBusinessAccountId,
    caption,
    mediaJSON: currentDraft.mediaJSON,
  });

  if (result.attempted && result.ok) {
    // Persist the provider identity before any derived DB updates; later failures remain recoverable.
    await prisma.$executeRawUnsafe(`
      UPDATE "SocialPublishAttempt" SET state='PUBLISHED', "providerMediaId"=$2, "providerPermalink"=$3,
        "providerResultJSON"=$4, "updatedAt"=NOW() WHERE id=$1
    `, attemptId, result.instagramMediaId || null, result.permalink || null, JSON.stringify(result));
    await prisma.$executeRawUnsafe(
      `UPDATE "GalleryPost"
       SET "instagramMediaId" = $1,
           "instagramPermalink" = $2,
           "instagramPublishedAt" = NOW(),
           "instagramPublishError" = NULL
       WHERE id = $3`,
      result.instagramMediaId || null,
      result.permalink || null,
      galleryPostId,
    );

    const draft = await markSocialPostDraftPublished(id, {
      galleryPostId,
      instagramMediaId: result.instagramMediaId || null,
      instagramPermalink: result.permalink || null,
    });

    return { ok: true as const, draft };
  }

  const error = result.attempted
    ? result.error || "인스타그램 게시에 실패했습니다."
    : result.skippedReason || "인스타그램 게시 설정이 아직 준비되지 않았습니다.";

  await prisma.$executeRawUnsafe(
    `UPDATE "SocialPublishAttempt" SET state='FAILED', "lastError"=$2, "providerResultJSON"=$3, "updatedAt"=NOW() WHERE id=$1`,
    attemptId, error, JSON.stringify(result),
  );
  await updateGalleryInstagramError(galleryPostId, error);

  const attempts = attemptDraft?.instagramPublishAttempts ?? currentDraft.instagramPublishAttempts;
  if (options.queueMode && result.attempted && attempts < MAX_QUEUE_ATTEMPTS) {
    const draft = await markSocialPostDraftRetryScheduled(id, {
      galleryPostId,
      error,
      nextRetryAt: nextRetryDate(attempts),
    });

    return { ok: false as const, draft, error, retryScheduled: true as const };
  }

  const draft = await markSocialPostDraftFailed(id, { galleryPostId, error });
  return { ok: false as const, draft, error };
}

export async function processSocialPostPublishQueue(limit = 1) {
  const drafts = await getQueuedSocialPostDrafts(limit);
  const results = [];

  for (const draft of drafts) {
    try {
      const result = await publishSocialDraftToInstagramNow(draft.id, { queueMode: true });
      results.push({
        id: draft.id,
        // 다른 처리가 먼저 잡아 건너뛴 것은 실패가 아니다(그쪽이 결과를 남긴다).
        ok: result.ok || ("skipped" in result && result.skipped === true),
        status: result.draft.status,
        retryScheduled: "retryScheduled" in result ? result.retryScheduled === true : false,
        error: "error" in result ? result.error : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "인스타그램 게시 처리 중 오류가 발생했습니다.";
      const ambiguous = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT id FROM "SocialPublishAttempt" WHERE "draftId"=$1 AND channel='INSTAGRAM' AND state='AMBIGUOUS' LIMIT 1
      `, draft.id);
      if (ambiguous[0]) {
        await prisma.$executeRawUnsafe(`
          UPDATE "SocialPostDraft" SET status='FAILED', "instagramNextRetryAt"=NULL,
            "instagramPublishError"='Instagram 게시 결과 확인 필요', "updatedAt"=NOW() WHERE id=$1
        `, draft.id);
        results.push({ id: draft.id, ok: false, status: "FAILED", retryScheduled: false, error: "Instagram 게시 결과가 불명확하여 자동 재발행을 중단했습니다." });
        continue;
      }
      // 호출 전 실패(예약 단계의 동의 확인 실패 포함)는 일반 실패로 둔다. 자동으로 계속 다시 돌리지 않는다.
      // 우리가 방금 잡은 시도가 있으면(다음 시도 시각이 미래) 이 SQL 은 아무것도 바꾸지 않고 아래 재시도 예약으로 간다.
      await prisma.$executeRawUnsafe(FAIL_DRAFT_BEFORE_PROVIDER_CALL_SQL, draft.id, message.slice(0, 1000));
      const latest = await getSocialPostDraftById(draft.id);
      if (latest && latest.status !== "PUBLISHING") {
        results.push({ id: draft.id, ok: false, status: latest.status, retryScheduled: false, error: message });
        continue;
      }
      const attempts = draft.instagramPublishAttempts + 1;

      if (draft.galleryPostId && attempts < MAX_QUEUE_ATTEMPTS) {
        const scheduled = await markSocialPostDraftRetryScheduled(draft.id, {
          galleryPostId: draft.galleryPostId,
          error: message,
          nextRetryAt: nextRetryDate(attempts),
        });

        results.push({
          id: draft.id,
          ok: false,
          status: scheduled.status,
          retryScheduled: true,
          error: message,
        });
        continue;
      }

      if (draft.galleryPostId) {
        const failed = await markSocialPostDraftFailed(draft.id, {
          galleryPostId: draft.galleryPostId,
          error: message,
        });

        results.push({
          id: draft.id,
          ok: false,
          status: failed.status,
          retryScheduled: false,
          error: message,
        });
        continue;
      }

      results.push({
        id: draft.id,
        ok: false,
        status: draft.status,
        retryScheduled: false,
        error: message,
      });
    }
  }

  return {
    ok: results.every((result) => result.ok || result.retryScheduled),
    processed: results.length,
    succeeded: results.filter((result) => result.ok).length,
    retryScheduled: results.filter((result) => result.retryScheduled).length,
    failed: results.filter((result) => !result.ok && !result.retryScheduled).length,
    results,
  };
}
