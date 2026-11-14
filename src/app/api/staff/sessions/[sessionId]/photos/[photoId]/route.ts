import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffClassAccess, requireStaffSessionAccess } from "@/lib/staff-class-access";
import { isValidPrivateSessionPhotoRef, parseSessionPhotoEntries, parseStoredSessionPhotos } from "@/lib/sessionPhotoStorage";
import { requireVerifiedParent } from "@/lib/auth-guard";
import { parentCanViewSession } from "@/lib/feed/server";
import { canManageSessionMedia, photoWindowMessage, sessionKstDateSql, TODAY_KST_SQL } from "@/lib/feed/rules";
import {
  findManagedSessionPhoto,
  isEmptyMediaJSON,
  removePhotoFromMediaJSON,
  type SessionPhotoDraftRow,
} from "@/lib/sessionPhotoManagement";
import {
  enqueueSessionPhotoDeletion,
  ensureSessionPhotoDeletionQueue,
  processSessionPhotoDeletionQueue,
} from "@/lib/sessionPhotoDeletionQueue";
import { isSinglePhotoDraft } from "@/lib/sessionPhotoManagementPolicy";

/**
 * 사진을 볼 수 있는 사람 — 그 반 선생님(대타 포함) 또는 수업 피드 공용 판정을 통과한 보호자.
 * 2026-11-14 원장 결정: 사진 공개 동의(StudentMediaConsent)·«나온 학생» 태그는 더 이상 보지 않는다.
 * 보호자 = 끝났고 발행된 수업 + 그 수업에 참여한 내 아이(출결 기록 또는 ACTIVE 수강) — 영상·소식 상세와 같은 함수.
 */
async function requirePhotoViewer(sessionId: string, classId: string, sessionDate: string): Promise<void> {
  try {
    // f4: 그 수업 날짜의 대타 선생님도 출석부에서 사진을 볼 수 있다(출석 저장과 같은 날짜 기준).
    await requireStaffClassAccess(classId, undefined, { substituteDate: sessionDate });
  } catch {
    const parent = await requireVerifiedParent();
    if (!await parentCanViewSession(parent.appUserId, sessionId)) throw new Error("사진 접근 권한이 없습니다.");
  }
}

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string; photoId: string }> }) {
  try {
    const { sessionId, photoId } = await context.params;
    const rows = await prisma.$queryRawUnsafe<Array<{ classId: string; status: string; date: string }>>(
      `SELECT "classId", status, date::date::text AS date FROM "Session" WHERE id = $1 LIMIT 1`,
      sessionId,
    );
    const session = rows[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    await requirePhotoViewer(sessionId, session.classId, session.date);
    const drafts = await prisma.$queryRawUnsafe<Array<{ mediaJSON: string }>>(
      `SELECT "mediaJSON" FROM "SocialPostDraft" WHERE "sessionId" = $1 ORDER BY "createdAt" DESC`,
      sessionId,
    );
    const matchedDraft = drafts.find((draft) => parseStoredSessionPhotos(draft.mediaJSON).some((item) => item.id === photoId));
    const photo = matchedDraft && parseStoredSessionPhotos(matchedDraft.mediaJSON).find((item) => item.id === photoId);
    if (!photo) return NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404 });
    if (!isValidPrivateSessionPhotoRef(photo as unknown as Record<string, unknown>, { classId: session.classId, sessionId })) {
      return NextResponse.json({ error: "사진 경로가 올바르지 않습니다." }, { status: 400 });
    }

    const { data, error } = await createAdminClient().storage.from(photo.storageBucket).download(photo.storagePath);
    if (error || !data) return NextResponse.json({ error: "사진을 불러오지 못했습니다." }, { status: 404 });
    return new Response(await data.arrayBuffer(), {
      headers: {
        "Content-Type": data.type || "image/jpeg",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "사진 접근 권한이 없습니다." }, { status: 403 });
  }
}

/** 사진 관리 가능 시간 판정용 수업 행 — 오늘(KST)은 서버 시계가 아니라 DB 시계로(NOW() 는 timestamptz 라 한 번만 변환) */
const MEDIA_WINDOW_SQL = `SELECT "classId", status, ${sessionKstDateSql('"Session"')}::text AS "sessionYmd",
        ${TODAY_KST_SQL}::text AS "todayYmd"
   FROM "Session" WHERE id = $1`;
type MediaWindowRow = { classId: string; status: string; sessionYmd: string; todayYmd: string };

async function requireManageablePhoto(sessionId: string, photoId: string) {
  const sessions = await prisma.$queryRawUnsafe<MediaWindowRow[]>(`${MEDIA_WINDOW_SQL} LIMIT 1`, sessionId);
  const session = sessions[0];
  if (!session) return { response: NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 }) };
  // 사진 등록과 같은 권한 함수(특강 회차면 특강 담당 강사 기준) — 2026-11-13 G11
  const { access } = await requireStaffSessionAccess(sessionId);
  // 2026-11-14: 영상과 같은 기간 규칙 — 수업 중 또는 끝난 수업(선생님 수업일 포함 7일·원장·부원장 제한 없음)
  const unlimited = access.canAccessAllClasses;
  const window = canManageSessionMedia({ ...session, unlimited });
  if (!window.ok) {
    return { response: NextResponse.json({ error: photoWindowMessage(window.reason) }, { status: 409 }) };
  }
  const drafts = await prisma.$queryRawUnsafe<SessionPhotoDraftRow[]>(
    `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
       FROM "SocialPostDraft"
      WHERE "sessionId" = $1 AND source = 'SESSION_PHOTO'`,
    sessionId,
  );
  const photo = findManagedSessionPhoto(drafts, photoId);
  if (!photo) return { response: NextResponse.json({ error: "사진을 찾을 수 없습니다." }, { status: 404 }) };
  const owningDraft = drafts.find((draft) => draft.id === photo.draftId);
  if (!owningDraft || !isSinglePhotoDraft(parseStoredSessionPhotos(owningDraft.mediaJSON).length)) {
    return { response: NextResponse.json({ error: "여러 사진이 묶인 이전 초안은 관리자가 분리한 뒤 수정할 수 있습니다." }, { status: 409 }) };
  }
  if (!photo.canManage) {
    return {
      response: NextResponse.json(
        { error: "이미 공개 처리된 사진은 삭제 대기열을 통해 회수해야 합니다.", requiresDeletionQueue: true },
        { status: 409 },
      ),
    };
  }
  return { session, photo, unlimited };
}

// 2026-11-14: «나온 학생» 수정(PATCH)은 없앴다 — 학부모 보기는 수업 참여 기준이라 학생 태그가 필요 없다(원장 결정).

export async function DELETE(_request: Request, context: { params: Promise<{ sessionId: string; photoId: string }> }) {
  try {
    const { sessionId, photoId } = await context.params;
    const manageable = await requireManageablePhoto(sessionId, photoId);
    if ("response" in manageable) return manageable.response;

    if (!isValidPrivateSessionPhotoRef(manageable.photo as unknown as Record<string, unknown>, {
      classId: manageable.session.classId,
      sessionId,
    })) {
      return NextResponse.json({ error: "검증되지 않은 사진 저장 경로입니다." }, { status: 400 });
    }
    await ensureSessionPhotoDeletionQueue();

    await prisma.$transaction(async (tx) => {
      const sessionRows = await tx.$queryRawUnsafe<Array<MediaWindowRow & { photosJSON: string | null }>>(
        `SELECT "classId", status, "photosJSON", ${sessionKstDateSql('"Session"')}::text AS "sessionYmd",
                ${TODAY_KST_SQL}::text AS "todayYmd"
           FROM "Session" WHERE id = $1 FOR UPDATE`,
        sessionId,
      );
      // 잠근 뒤 한 번 더 — 그 사이 수정 기간이 끝났거나 수업 상태가 바뀌었으면 지우지 않는다
      const lockedWindow = sessionRows[0] ? canManageSessionMedia({ ...sessionRows[0], unlimited: manageable.unlimited }) : null;
      if (!lockedWindow?.ok) throw new Error(lockedWindow ? photoWindowMessage(lockedWindow.reason) : "수업 기록을 찾을 수 없습니다.");
      const draftRows = await tx.$queryRawUnsafe<SessionPhotoDraftRow[]>(
        `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
           FROM "SocialPostDraft" WHERE id = $1 AND "sessionId" = $2 FOR UPDATE`,
        manageable.photo.draftId,
        sessionId,
      );
      const lockedPhoto = findManagedSessionPhoto(draftRows, photoId);
      if (!lockedPhoto?.canManage || !isSinglePhotoDraft(parseStoredSessionPhotos(draftRows[0]?.mediaJSON).length)) {
        throw new Error("사진 상태가 변경되어 삭제 대기열 확인이 필요합니다.");
      }
      if (!isValidPrivateSessionPhotoRef(lockedPhoto as unknown as Record<string, unknown>, {
        classId: manageable.session.classId,
        sessionId,
      })) throw new Error("검증되지 않은 사진 저장 경로입니다.");

      const nextPhotos = parseStoredSessionPhotos(sessionRows[0]?.photosJSON)
        .filter((photo) => photo.id !== photoId)
        .map((photo) => photo.url);
      // 구버전 수업 기록에는 URL 문자열만 있으므로 해당 URL도 함께 제거합니다.
      const rawPhotos = parseSessionPhotoEntries(sessionRows[0]?.photosJSON)
        .filter((entry) => typeof entry === "string" ? entry !== lockedPhoto.url : entry.id !== photoId)
        .map((entry) => typeof entry === "string" ? entry : entry.url);
      await tx.$executeRawUnsafe(
        `UPDATE "Session" SET "photosJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
        JSON.stringify(rawPhotos.length ? rawPhotos : nextPhotos),
        sessionId,
      );
      const nextMediaJSON = removePhotoFromMediaJSON(draftRows[0].mediaJSON, photoId);
      if (isEmptyMediaJSON(nextMediaJSON)) {
        await tx.$executeRawUnsafe(`DELETE FROM "SocialPostDraft" WHERE id = $1`, manageable.photo.draftId);
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE "SocialPostDraft" SET "mediaJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
          nextMediaJSON,
          manageable.photo.draftId,
        );
      }
      await enqueueSessionPhotoDeletion(tx, {
        photoId,
        storageBucket: lockedPhoto.storageBucket,
        storagePath: lockedPhoto.storagePath,
      });
    });
    // DB 참조 제거가 먼저 확정됩니다. 저장소 오류는 outbox에 남아 다음 요청에서 재시도됩니다.
    await processSessionPhotoDeletionQueue(3).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = userFacingError(error, "사진을 삭제하지 못했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && /대기열|수정 기간|수업 날짜부터|시작한 뒤/.test(error.message) ? 409 : 403 });
  }
}
