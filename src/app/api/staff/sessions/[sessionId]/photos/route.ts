import { userFacingError } from "@/lib/user-facing-error";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaffSessionAccess } from "@/lib/staff-class-access";
import { ensureSocialPostDraftTable } from "@/lib/socialDrafts";
import { canManageSessionMedia, photoWindowMessage, sessionKstDateSql, TODAY_KST_SQL } from "@/lib/feed/rules";
import {
  ensurePrivateSessionPhotoBucket,
  parseSessionPhotoEntries,
  PRIVATE_SESSION_PHOTO_BUCKET,
  type StoredSessionPhoto,
} from "@/lib/sessionPhotoStorage";
import { createSessionPhotoDraftInTransaction, listManagedSessionPhotos, type SessionPhotoDraftRow } from "@/lib/sessionPhotoManagement";
import {
  cancelSessionPhotoCleanup,
  ensureSessionPhotoDeletionQueue,
  processSessionPhotoDeletionQueue,
  releaseSessionPhotoCleanup,
  reserveSessionPhotoCleanup,
} from "@/lib/sessionPhotoDeletionQueue";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 1024 * 1024;
/**
 * 사진 관리 가능 기간 판정용 수업 행(2026-11-14 원장 결정) — 영상과 같은 규칙:
 * 수업 중 또는 끝난 수업, 선생님은 수업일 포함 7일·원장·부원장은 제한 없음. 오늘(KST)은 DB 시계로(NOW() 는 timestamptz 라 한 번만 변환).
 * 수업일은 무tz 칼럼 Session.date 를 «두 번» 변환(sessionKstDateSql) — 옛 기록 모양에서도 하루 밀리지 않게.
 */
const MEDIA_WINDOW_COLUMNS = `"classId", status, "photosJSON", ${sessionKstDateSql('"Session"')}::text AS "sessionYmd",
        ${TODAY_KST_SQL}::text AS "todayYmd"`;
type MediaWindowRow = { classId: string; status: string; photosJSON: string | null; sessionYmd: string; todayYmd: string };

export async function GET(_req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    await processSessionPhotoDeletionQueue(3).catch(() => undefined);
    const { sessionId } = await context.params;
    const sessions = await prisma.$queryRawUnsafe<MediaWindowRow[]>(
      `SELECT ${MEDIA_WINDOW_COLUMNS} FROM "Session" WHERE id = $1 LIMIT 1`,
      sessionId,
    );
    const session = sessions[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    // 수업 시작·출석과 같은 권한 함수(특강 회차면 특강 담당 강사 기준) — 2026-11-13 G11
    const { access: viewer } = await requireStaffSessionAccess(sessionId);
    // 목록은 읽기만이라 언제든 보여 주고, 올리기·지우기 가능 여부를 함께 알려 준다(화면이 버튼을 잠근다)
    // 원장·부원장은 수정 기간 제한이 없다(선생님은 수업일 포함 7일)
    const window = canManageSessionMedia({ ...session, unlimited: viewer.canAccessAllClasses });
    const drafts = await prisma.$queryRawUnsafe<SessionPhotoDraftRow[]>(
      `SELECT id, status, "mediaJSON", "subjectStudentIdsJSON", "galleryPostId", "instagramMediaId"
         FROM "SocialPostDraft"
        WHERE "sessionId" = $1 AND source = 'SESSION_PHOTO'
        ORDER BY "createdAt" ASC`,
      sessionId,
    );
    return NextResponse.json({
      photos: listManagedSessionPhotos(drafts),
      canUpload: window.ok,
      windowMessage: window.ok ? null : photoWindowMessage(window.reason),
    });
  } catch (error) {
    const message = userFacingError(error, "사진 목록을 불러오지 못했습니다.");
    return NextResponse.json({ error: message }, { status: 403 });
  }
}

export async function POST(req: Request, context: { params: Promise<{ sessionId: string }> }) {
  try {
    const { sessionId } = await context.params;
    const sessions = await prisma.$queryRawUnsafe<MediaWindowRow[]>(
      `SELECT ${MEDIA_WINDOW_COLUMNS} FROM "Session" WHERE id = $1 LIMIT 1`, sessionId,
    );
    const session = sessions[0];
    if (!session) return NextResponse.json({ error: "수업 기록을 찾을 수 없습니다." }, { status: 404 });
    // 수업 시작·출석과 같은 권한 함수(특강 회차면 특강 담당 강사 기준) — 2026-11-13 G11
    const { access } = await requireStaffSessionAccess(sessionId);
    const unlimited = access.canAccessAllClasses;
    const window = canManageSessionMedia({ ...session, unlimited });
    if (!window.ok) return NextResponse.json({ error: photoWindowMessage(window.reason) }, { status: 409 });

    await ensureSocialPostDraftTable();
    await ensureSessionPhotoDeletionQueue();
    const form = await req.formData();
    const file = form.get("file");
    // 2026-11-14: «사진에 나온 학생» 선택은 없앴다 — 학부모 보기는 수업 참여 기준(동의·태그 불필요, 원장 결정).
    // 예전 화면이 보낸 subjectStudentIds 칸은 읽지 않는다.
    if (!(file instanceof File)) return NextResponse.json({ error: "사진을 선택해 주세요." }, { status: 400 });
    if (!ALLOWED_TYPES.has(file.type) || file.type === "image/gif") {
      return NextResponse.json({ error: "수업 사진은 JPEG, PNG, WebP만 사용할 수 있습니다." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "압축된 사진은 1MB 이하여야 합니다." }, { status: 400 });

    // API 직접 호출도 GPS/기기 EXIF를 남기지 못하도록 서버에서 다시 인코딩합니다.
    const encoded = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if (encoded.byteLength > MAX_BYTES) return NextResponse.json({ error: "사진 압축 결과가 1MB를 초과했습니다." }, { status: 400 });
    const ext = "jpg";
    const photoId = randomUUID();
    const storagePath = `staff-sessions/${session.classId}/${sessionId}/${photoId}.${ext}`;
    const supabase = createAdminClient();
    const bucket = PRIVATE_SESSION_PHOTO_BUCKET;
    await ensurePrivateSessionPhotoBucket();
    // 파일 생성보다 먼저 cleanup 예약을 영구 기록합니다.
    await reserveSessionPhotoCleanup({ photoId, storageBucket: bucket, storagePath });
    const { error: uploadError } = await supabase.storage.from(bucket).upload(
      storagePath, encoded,
      { contentType: "image/jpeg", cacheControl: "31536000", upsert: false },
    );
    if (uploadError) throw new Error("사진 저장소 업로드에 실패했습니다.");
    const url = `/api/staff/sessions/${sessionId}/photos/${photoId}`;
    const storedPhoto: StoredSessionPhoto = {
      id: photoId,
      type: "image",
      url,
      storageBucket: bucket,
      storagePath,
      visibility: "PRIVATE",
    };

    try {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRawUnsafe<MediaWindowRow[]>(
          `SELECT ${MEDIA_WINDOW_COLUMNS} FROM "Session" WHERE id = $1 FOR UPDATE`, sessionId,
        );
        // 잠근 뒤 한 번 더 — 올리는 사이 수정 기간이 끝났거나 수업이 취소됐으면 저장하지 않는다
        const lockedWindow = locked[0] ? canManageSessionMedia({ ...locked[0], unlimited }) : null;
        if (!lockedWindow?.ok || locked[0]?.classId !== session.classId) {
          throw new Error(lockedWindow && !lockedWindow.ok ? photoWindowMessage(lockedWindow.reason) : "수업 기록을 다시 확인해 주세요.");
        }
        const photos = parseSessionPhotoEntries(locked[0]?.photosJSON);
        if (!photos.some((photo) => photo === url)) photos.push(url);
        await tx.$executeRawUnsafe(
          `UPDATE "Session" SET "photosJSON" = $1, "updatedAt" = NOW() WHERE id = $2`,
          JSON.stringify(photos), sessionId,
        );
        await createSessionPhotoDraftInTransaction(tx, {
          authorUserId: access.staff.appUserId,
          authorName: access.staff.appUserName,
          authorRole: access.staff.appUserRole,
          sessionId,
          classId: session.classId,
          subjectStudentIds: [],
          photo: storedPhoto,
        });
        await cancelSessionPhotoCleanup(tx, photoId);
      });
    } catch (error) {
      // 외부 저장소와 DB는 한 번에 묶을 수 없으므로 실패 시 방금 URL을 되돌립니다.
      await releaseSessionPhotoCleanup(photoId).catch(() => undefined);
      // 예약은 DB에 남아 있으며 삭제 실패도 lastError와 다음 재시도 시각으로 기록됩니다.
      await processSessionPhotoDeletionQueue(3).catch(() => undefined);
      throw error;
    }

    return NextResponse.json({ url, type: "image", reviewStatus: "READY" });
  } catch (error) {
    const message = userFacingError(error, "사진 등록에 실패했습니다.");
    return NextResponse.json({ error: message }, { status: error instanceof Error && error.message.includes("권한") ? 403 : error instanceof Error && /수정 기간|수업 날짜부터|시작한 뒤/.test(error.message) ? 409 : 500 });
  }
}
