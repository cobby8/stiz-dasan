"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { requireAdmin, requireOwner, requireStaff } from "@/lib/auth-guard";
import { generateSocialCaptionDraft } from "@/lib/socialCaptionAI";
import {
  publishSocialDraftToInstagramNow,
  upsertGalleryPostFromSocialDraft,
} from "@/lib/socialPostPublishing";
import {
  createSocialPostDraftRecord,
  getSocialPostDraftById,
  markSocialPostDraftPublishing,
  parseSocialDraftMedia,
  rejectSocialPostDraftRecord,
  safeSocialDraftMediaJSON,
  updateSocialPostDraftRecord,
  type SocialPostDraft,
  normalizeSubjectStudentIds,
} from "@/lib/socialDrafts";
import { assertSocialDraftMediaConsent } from "@/lib/studentMediaConsent";
import { SUBJECT_UNASSIGNED_PUBLISH_MESSAGE } from "@/lib/socialPostMessages";

type SaveDraftInput = {
  title?: string | null;
  caption?: string | null;
  hashtags?: string | null;
  lessonType?: string | null;
  memo?: string | null;
  isPublic?: boolean;
  subjectStudentIds?: string[];
};

function revalidateSocialPostPaths() {
  revalidateTag("admin-gallery", { expire: 0 });
  revalidatePath("/staff/quick-post");
  revalidatePath("/admin/gallery");
  revalidatePath("/gallery");
  revalidatePath("/mypage");
  revalidatePath("/");
}

export async function createSocialPostDraft(data: {
  mediaJSON: string;
  lessonType?: string | null;
  memo?: string | null;
  isPublic?: boolean;
  sessionId?: string | null;
  classId?: string | null;
  source?: string | null;
  subjectStudentIds?: string[];
}) {
  const staff = await requireStaff();
  // 일반 빠른 업로드에서는 클라이언트가 보낸 저장소 메타데이터를 신뢰하지 않습니다.
  const mediaJSON = JSON.stringify(
    parseSocialDraftMedia(safeSocialDraftMediaJSON(data.mediaJSON)).map((item) => ({
      type: item.type,
      url: item.url,
    })),
  );
  const mediaItems = parseSocialDraftMedia(mediaJSON).filter((item) => item.type === "image");

  if (mediaItems.length === 0) {
    throw new Error("사진을 최소 1장 이상 올려주세요. 현재 자동 인스타 업로드는 사진만 지원합니다.");
  }

  const aiDraft = await generateSocialCaptionDraft({
    mediaItems,
    lessonType: data.lessonType,
    memo: data.memo,
  });

  const draft = await createSocialPostDraftRecord({
    authorUserId: staff.appUserId,
    authorName: staff.appUserName,
    authorRole: staff.appUserRole,
    lessonType: data.lessonType,
    memo: data.memo,
    title: aiDraft.title,
    caption: aiDraft.caption,
    hashtags: aiDraft.hashtags,
    mediaJSON,
    // 선생님 초안은 관리자 검토 전 공개 상태가 될 수 없습니다.
    isPublic: isReviewRequiredAuthor(staff) ? false : data.isPublic !== false,
    sessionId: data.sessionId,
    classId: data.classId,
    source: data.source,
    subjectStudentIds: normalizeSubjectStudentIds(data.subjectStudentIds),
  });

  revalidateSocialPostPaths();
  // captionSource: "AI" = AI 가 쓴 초안, "FALLBACK" = AI 연결이 안 돼 준비된 기본 문구(화면이 구분해 알린다).
  return { ok: true, draft, captionSource: aiDraft.source };
}

/**
 * 관리자 검토 없이 공개·게시할 수 없는 작성자인가 — 관리자가 아닌 직원 전부.
 *
 * 예전에는 역할 값이 선생님(INSTRUCTOR)일 때만 막았다. 다중 역할(2026-10-25) 이후에는
 * 「주 역할 기사님 + 승인된 선생님」인 사람의 appUserRole 이 "DRIVER" 라서 이 제한을
 * **통째로 빠져나갔다** — 기사님이 사진 화면에 못 들어와서 드러나지 않던 구멍이다.
 * 관리자 권한은 추가 역할로 줄 수 없으므로(DB CHECK) appUserRole 이 ADMIN·VICE_ADMIN 인 경우만 자유롭다.
 */
function isReviewRequiredAuthor(actor: { appUserRole: string }) {
  return actor.appUserRole !== "ADMIN" && actor.appUserRole !== "VICE_ADMIN";
}

export async function saveSocialPostDraft(id: string, data: SaveDraftInput) {
  const staff = await requireStaff();
  const authorUserId = isReviewRequiredAuthor(staff) ? staff.appUserId : null;

  const normalizedData = data.subjectStudentIds === undefined
    ? data
    : { ...data, subjectStudentIds: normalizeSubjectStudentIds(data.subjectStudentIds) };
  const safeData = isReviewRequiredAuthor(staff)
    ? { ...normalizedData, isPublic: false }
    : normalizedData;
  const draft = await updateSocialPostDraftRecord(id, safeData, { authorUserId });
  revalidateSocialPostPaths();
  return { ok: true, draft };
}

export async function rejectSocialPostDraft(id: string) {
  await requireAdmin();
  const result = await rejectSocialPostDraftRecord(id);
  revalidateSocialPostPaths();
  return { ok: true, ...result };
}

/**
 * 학생이 지정되지 않은 초안인가 — 동의 검사(studentMediaConsent)가 «학생 미지정»으로 막는 것과 같은 조건.
 * 여기서는 규칙을 바꾸지 않는다. 같은 조건을 먼저 보고 알아듣기 쉬운 안내로 바꿀 뿐이며,
 * 이 함수를 지나쳐도 갤러리·인스타 단계의 동의 검사가 그대로 다시 막는다.
 */
function isSubjectUnassignedDraft(draft: Pick<SocialPostDraft, "sessionId" | "classId" | "subjectStudentIds">) {
  return (!draft.sessionId && !draft.classId) || draft.subjectStudentIds.length === 0;
}

function canPublishDraftStatus(status: SocialPostDraft["status"]) {
  return status === "READY" || status === "FAILED" || status === "PUBLISHING";
}

function assertCanPublishDraft(draft: SocialPostDraft | null, staff: { appUserId: string; appUserRole: string }) {
  if (!draft || !canPublishDraftStatus(draft.status)) {
    throw new Error("게시할 수 있는 초안을 찾지 못했습니다.");
  }

  if (isReviewRequiredAuthor(staff) && draft.authorUserId !== staff.appUserId) {
    throw new Error("본인이 작성한 초안만 바로 게시할 수 있습니다.");
  }
}

export async function publishSocialPostDraftToGallery(id: string) {
  const staff = await requireAdmin();

  const currentDraft = await getSocialPostDraftById(id);
  assertCanPublishDraft(currentDraft, staff);
  const consent = await assertSocialDraftMediaConsent(currentDraft!, "GALLERY");

  const mediaItems = parseSocialDraftMedia(currentDraft!.mediaJSON).filter((item) => item.type === "image");
  if (mediaItems.length === 0) {
    throw new Error("인스타그램 자동 게시에는 사진이 최소 1장 필요합니다.");
  }

  const galleryPostId = await upsertGalleryPostFromSocialDraft(currentDraft!);
  const draft = await markSocialPostDraftPublishing(id, { galleryPostId });

  console.info("[media-consent] gallery-approved", {
    draftId: id,
    galleryPostId,
    approvedByUserId: staff.appUserId,
    scope: consent.scope,
    studentCount: consent.studentCount,
  });

  revalidateSocialPostPaths();
  return { ok: true, draft, galleryPostId, consent };
}

export async function publishSocialPostDraftToInstagram(id: string) {
  // 외부 SNS 게시 권한은 현재 역할 체계에서 최고 관리자(원장)에게만 부여합니다.
  const owner = await requireOwner();

  const currentDraft = await getSocialPostDraftById(id);
  if (currentDraft?.status === "PUBLISHED") {
    return { ok: true, draft: currentDraft };
  }

  if (!currentDraft || !canPublishDraftStatus(currentDraft.status)) {
    throw new Error("게시할 수 있는 초안을 찾지 못했습니다.");
  }
  const consent = await assertSocialDraftMediaConsent(currentDraft, "INSTAGRAM");

  const mediaItems = parseSocialDraftMedia(currentDraft!.mediaJSON).filter((item) => item.type === "image");
  if (mediaItems.length === 0) {
    throw new Error("인스타그램 자동 게시에는 사진이 최소 1장 필요합니다.");
  }

  // ownerApproved: 원장 확인(requireOwner)을 통과한 이 경로에서만 인스타 대기열을 켠다.
  const result = await publishSocialDraftToInstagramNow(id, { queueMode: true, ownerApproved: true });
  console.info("[media-consent] instagram-approved", {
    draftId: id,
    approvedByAuthUserId: owner.id,
    scope: consent.scope,
    studentCount: consent.studentCount,
  });
  revalidateSocialPostPaths();
  return { ...result, consent };
}

/**
 * 화면의 «게시» 버튼이 부르는 한 묶음: 홈페이지 갤러리 → 인스타그램.
 *
 * 2026-11-14 사진·인스타 점검:
 * - 학생이 지정되지 않은 초안(빠른 업로드)은 공개 동의를 확인할 수 없어 게시할 수 없다. 규칙은 그대로 두고,
 *   오류를 던지는 대신 «다음에 할 일»이 담긴 안내를 값으로 돌려준다(던진 오류 문구는 운영 화면에서 가려질 수 있다).
 * - 부원장은 갤러리까지만 된다. 예전에는 갤러리가 올라간 뒤 인스타 단계에서 권한 오류가 나 «게시 실패»로만 보였다.
 *   서버 권한(인스타 = 원장)은 그대로이고, 결과에 그 사실을 담아 화면이 정확히 말하게 한다.
 */
export async function publishSocialPostDraft(id: string) {
  const staff = await requireAdmin();

  const currentDraft = await getSocialPostDraftById(id);
  if (currentDraft && canPublishDraftStatus(currentDraft.status) && isSubjectUnassignedDraft(currentDraft)) {
    return {
      ok: false as const,
      draft: currentDraft,
      blocked: true as const,
      error: SUBJECT_UNASSIGNED_PUBLISH_MESSAGE,
    };
  }

  const gallery = await publishSocialPostDraftToGallery(id);
  if (staff.appUserRole !== "ADMIN") {
    return { ok: false as const, draft: gallery.draft, instagramOwnerOnly: true as const };
  }
  return publishSocialPostDraftToInstagram(id);
}
